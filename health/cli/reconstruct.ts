/**
 * Era-health reconstruction CLI.
 *
 * For the most recent ended eras, reconstructs point-in-time "health" reads at
 * each era's boundary block and merges them into the existing per-era snapshot
 * JSON (`snapshots/<chain>/<era>.json`) under the optional `health` field.
 *
 * Why a separate pass: these metrics (election score, counts, min stakes,
 * unbonding, all-validator self-stake, DAP pot balances) are live storage with
 * no per-era on-chain history. We locate each era's first block via Subscan
 * (sparse: one call per era) and read state a few blocks earlier (the DAP pots
 * drain into era pots at the transition). See `shared/snapshot/health.ts`.
 *
 * Usage:
 *   pnpm health-reconstruct --chain pah            # last 7 ended eras
 *   pnpm health-reconstruct --chain pah --eras 7
 *   pnpm health-reconstruct --chain pah --era 2214 # single era
 *   pnpm health-reconstruct --chain pah --force    # re-read eras already filled
 *
 * Requires SUBSCAN_API_KEY in the environment (see `.env`). Point RPC_PAH /
 * RPC_WAH at an archive node if reconstructing eras older than the public
 * node's state retention (~8 days on the public PAH RPC).
 */
import { getChain } from "../../shared/chains/index.js";
import { connect, readChainState } from "../../shared/snapshot/reader.js";
import { readEra, writeEra, listEras } from "../../shared/snapshot/store.js";
import { reconstructEraHealth } from "../../shared/snapshot/health.js";

interface Args {
  chain: string;
  eras: number;
  era?: number;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { chain: "pah", eras: 7, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--chain":
        args.chain = next();
        break;
      case "--eras":
        args.eras = parseInt(next(), 10);
        break;
      case "--era":
        args.era = parseInt(next(), 10);
        break;
      case "--force":
        args.force = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Reconstruct era-health reads into existing snapshots.",
            "",
            "  --chain <pah|wah>  Chain (default: pah)",
            "  --eras <n>         Most recent N ended eras (default: 7)",
            "  --era <n>          A single era",
            "  --force            Re-read eras already populated",
          ].join("\n"),
        );
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

/**
 * Estimate era N's start (epoch ms) from the latest active era's start and the
 * era duration. Subscan snaps the timestamp to the nearest block, and the
 * read-offset margin absorbs the estimation slack; we still verify the observed
 * era afterward and warn on a mismatch.
 */
function estimateEraStartMs(
  era: number,
  latestActiveEra: number,
  latestActiveEraStartMs: string,
  eraDurationMs: string,
): string {
  const delta = BigInt(latestActiveEra - era) * BigInt(eraDurationMs);
  return (BigInt(latestActiveEraStartMs) - delta).toString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chain = getChain(args.chain);

  const subscanApiKey = process.env.SUBSCAN_API_KEY?.trim();
  if (!subscanApiKey) {
    throw new Error(
      "SUBSCAN_API_KEY is not set. Add it to .env (it is gitignored) and re-run.",
    );
  }

  console.log(`Connecting to ${chain.name} ...`);
  const { api, meta, request, destroy } = await connect(chain);

  try {
    const state = await readChainState(api);
    if (state.activeEra == null || state.activeEraStartMs == null) {
      throw new Error("No active era / start on chain; cannot estimate era timing.");
    }
    console.log(
      `  active era ${state.activeEra}, era duration ${(Number(state.eraDurationMs) / 3_600_000).toFixed(1)}h`,
    );

    const onDisk = await listEras(chain);
    if (onDisk.length === 0) {
      throw new Error("No snapshots on disk; run `pnpm snapshot` first.");
    }

    let eras: number[];
    if (args.era != null) {
      eras = [args.era];
    } else {
      eras = onDisk.slice(-args.eras);
    }
    console.log(`Reconstructing health for ${eras.length} era(s): ${eras.join(", ")}`);

    let filled = 0;
    let skipped = 0;
    for (const era of eras) {
      const snapshot = await readEra(chain, era);
      if (!snapshot) {
        console.log(`  era ${era}: no snapshot file, skipping`);
        skipped++;
        continue;
      }
      if (snapshot.health && !args.force) {
        console.log(`  era ${era}: already has health (use --force), skipping`);
        skipped++;
        continue;
      }

      const eraStartMs = estimateEraStartMs(
        era,
        state.activeEra,
        state.activeEraStartMs,
        state.eraDurationMs,
      );
      process.stdout.write(`  era ${era} ... `);
      const health = await reconstructEraHealth(
        api,
        request,
        chain.key,
        meta.ss58Prefix,
        eraStartMs,
        subscanApiKey,
      );

      const obs = health.boundary.observedEra;
      const note = obs != null && obs !== era - 1 && obs !== era
        ? ` ⚠ observedEra=${obs} (expected ${era - 1}/${era}; estimate may be off)`
        : "";
      snapshot.health = health;
      await writeEra(chain, snapshot);
      filled++;
      const tok = 10 ** meta.tokenDecimals;
      console.log(
        `block ${health.boundary.balanceBlock}, ${health.validatorCount} validators, ` +
          `staker pot ${(Number(health.pots.stakerReward) / tok).toFixed(0)} ${meta.tokenSymbol}${note}`,
      );
    }

    console.log(`Done. Filled ${filled}, skipped ${skipped}.`);
  } finally {
    destroy();
  }
}

main().catch((e) => {
  console.error("\nReconstruct failed:", e?.message ?? e);
  process.exit(1);
});
