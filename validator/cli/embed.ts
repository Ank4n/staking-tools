/**
 * Extracts a compact, self-contained data blob from the newest snapshots of
 * each chain, for embedding into the standalone HTML simulator (which can't
 * fetch).
 *
 * Emits JSON to stdout: per chain, static chain metadata plus the newest
 * EMBED_ERAS complete eras (newest first), each carrying the era-level reward
 * params the simulator needs. The app defaults to the newest era and lets the
 * user pick an older one from a dropdown.
 *
 *   pnpm tsx validator/cli/embed.ts > validator/web/data.json
 */
import { getChain } from "../../shared/chains/index.js";
import { readEra, listEras, readIndex } from "../../shared/snapshot/store.js";
import type { EraSnapshot } from "../../shared/snapshot/types.js";

/**
 * Chains baked into the public page. This site is Polkadot-only; `wah` stays
 * snapshot-able for internal testing but is not embedded.
 */
const EMBED_CHAINS = ["pah"];
/** How many eras (newest first) to embed per chain. */
const EMBED_ERAS = 28;
/**
 * Per-chain data floor: don't embed eras below this. PAH data before era 2220
 * is not correct (early Ref-1909 rollout; pre-1909 eras also lack the
 * incentive curve entirely). The window grows daily from the floor until it
 * fills EMBED_ERAS.
 */
const MIN_ERA: Record<string, number> = { pah: 2220 };
/** Window for the per-era inflation baseline (this era + the previous few). */
const RECENT = 6;

interface EmbedValidator {
  address: string;
  ownStake: string;
  totalStake: string;
  commissionRaw: number;
  rewardPoints: number;
}

interface EmbedEra {
  era: number;
  /** When this era's shard was captured from chain (epoch ms, as string). */
  capturedAtMs: string;
  eraDurationMs: string;
  totalStakerReward: string;
  validatorIncentiveBudget: string;
  totalRewardPoints: number;
  totalStake: string;
  sumIncentiveWeight: string;
  validatorCount: number;
  optimumSelfStake: string;
  hardCapSelfStake: string;
  selfStakeSlopeFactorRaw: number;
  budgetAllocation: Record<string, number>;
  /**
   * Every validator's own self-stake (planck strings) for the era. Used to
   * compute the exact incentive-weight denominator under a chosen curve — even
   * on chains where the incentive is currently off and stores no weights.
   */
  ownStakes: string[];
  /**
   * Inflation-per-era (planck strings) for the last few eras, newest first,
   * INCLUDING this era. Computed against the full on-disk history, so eras at
   * the edge of the embed window still get a proper baseline. The UI takes the
   * median of the others to flag DAP drip catch-up eras (whose reward pot
   * carries backlog).
   */
  recentInflation: string[];
}

interface EmbedChain {
  chainKey: string;
  chainName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** When the snapshot index was last refreshed from chain (epoch ms, string). */
  updatedAtMs: string | null;
  /** A handful of real validators (newest era) spanning the stake range. */
  sampleValidators: EmbedValidator[];
  /** Embedded eras, newest first. The app defaults to the first entry. */
  eras: EmbedEra[];
}

/** Inflation issued in an era = staker reward pot scaled up by 1/staker-share. */
function inflationOf(s: {
  totalStakerReward: string;
  validatorIncentiveBudget: string;
  dapParams: { budgetAllocation: Record<string, { raw: number }> };
}): bigint {
  const alloc = s.dapParams.budgetAllocation;
  const stakerRaw = alloc.staker_rewards?.raw ?? 0;
  const incRaw = alloc.validator_incentive?.raw ?? 0;
  if (stakerRaw > 0)
    return (BigInt(s.totalStakerReward) * 1_000_000_000n) / BigInt(stakerRaw);
  if (incRaw > 0)
    return (BigInt(s.validatorIncentiveBudget) * 1_000_000_000n) / BigInt(incRaw);
  return 0n;
}

function buildEra(
  s: EraSnapshot,
  /** All loaded shards, ascending, up to and including `s` (for the baseline). */
  history: EraSnapshot[],
): EmbedEra {
  const budgetAllocation: Record<string, number> = {};
  for (const [k, p] of Object.entries(s.dapParams.budgetAllocation)) {
    budgetAllocation[k] = p.raw;
  }
  const recentInflation = history
    .slice(-RECENT)
    .reverse()
    .map((es) => inflationOf(es).toString());

  return {
    era: s.era,
    capturedAtMs: s.capturedAtMs,
    eraDurationMs: s.eraDurationMs,
    totalStakerReward: s.totalStakerReward,
    validatorIncentiveBudget: s.validatorIncentiveBudget,
    totalRewardPoints: s.totalRewardPoints,
    totalStake: s.totalStake,
    sumIncentiveWeight: s.sumIncentiveWeight,
    validatorCount: s.validators.length,
    optimumSelfStake: s.incentiveParams.optimumSelfStake,
    hardCapSelfStake: s.incentiveParams.hardCapSelfStake,
    selfStakeSlopeFactorRaw: s.incentiveParams.selfStakeSlopeFactor.raw,
    budgetAllocation,
    ownStakes: s.validators.map((v) => v.ownStake),
    recentInflation,
  };
}

async function buildChain(key: string): Promise<EmbedChain | null> {
  const chain = getChain(key);
  const eraIdxs = await listEras(chain);
  if (eraIdxs.length === 0) return null;
  const index = await readIndex(chain);

  // Load the embed window plus enough older eras to seed inflation baselines.
  const loaded: EraSnapshot[] = [];
  for (const e of eraIdxs.slice(-(EMBED_ERAS + RECENT - 1))) {
    const s = await readEra(chain, e);
    if (s) loaded.push(s);
  }
  if (loaded.length === 0) return null;

  // Drop eras below the chain's data floor (see MIN_ERA). Fall back to
  // everything if a chain has nothing at/above its floor yet.
  const usable = loaded.filter((s) => s.era >= (MIN_ERA[key] ?? 0));
  const pool = usable.length > 0 ? usable : loaded;

  const embedded = pool.slice(-EMBED_ERAS);
  const eras = embedded
    .map((s) => buildEra(s, loaded.slice(0, loaded.indexOf(s) + 1)))
    .reverse(); // newest first

  // Pick samples spanning the newest era's own-stake range:
  // min, low-quartile, median, top.
  const newest = pool[pool.length - 1];
  const byOwn = [...newest.validators].sort(
    (a, b) => (BigInt(a.ownStake) < BigInt(b.ownStake) ? -1 : 1),
  );
  const pick = (frac: number) =>
    byOwn[Math.min(byOwn.length - 1, Math.floor(frac * byOwn.length))];
  const samplesRaw = [pick(0), pick(0.33), pick(0.66), byOwn[byOwn.length - 1]];
  const seen = new Set<string>();
  const sampleValidators: EmbedValidator[] = [];
  for (const v of samplesRaw) {
    if (!v || seen.has(v.address)) continue;
    seen.add(v.address);
    sampleValidators.push({
      address: v.address,
      ownStake: v.ownStake,
      totalStake: v.totalStake,
      commissionRaw: v.commission.raw,
      rewardPoints: v.rewardPoints,
    });
  }

  return {
    chainKey: newest.chain.chainKey,
    chainName: newest.chain.chainName,
    tokenSymbol: newest.chain.tokenSymbol,
    tokenDecimals: newest.chain.tokenDecimals,
    updatedAtMs: index?.updatedAtMs ?? null,
    sampleValidators,
    eras,
  };
}

async function main() {
  const out: EmbedChain[] = [];
  for (const key of EMBED_CHAINS) {
    const c = await buildChain(key);
    if (c) out.push(c);
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
