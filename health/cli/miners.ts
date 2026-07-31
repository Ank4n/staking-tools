/**
 * Miners snapshot pass: fetch the latest `MultiBlockElectionSigned.Rewarded`
 * event for every public chain (Polkadot / Kusama / Westend / Paseo Asset Hub)
 * from Subscan and write `snapshots/miners.json`. Consumed by the Era Health
 * app's "last signed solution" card.
 *
 * Part of the SNAPSHOT process (needs network + SUBSCAN_API_KEY), never the
 * build. Run it alongside the base + health-reconstruct passes:
 *
 *   pnpm snapshot-miners
 *
 * Failure handling: a chain that errors keeps its entry from the previous
 * file (stale beats absent — the card shows the event's own timestamp). The
 * file is rewritten only when some chain's data actually changed, so a no-op
 * run leaves the working tree clean and the driver's "nothing to push" exit
 * intact.
 */
import "../../shared/util/env.js";
import {
  MINER_CHAINS,
  fetchLastSolution,
  readMiners,
  writeMiners,
  type LastSolution,
} from "../../shared/snapshot/miners.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const apiKey = process.env.SUBSCAN_API_KEY;
  if (!apiKey) {
    console.error("SUBSCAN_API_KEY is required (set it in .env)");
    process.exit(1);
  }

  const previous = await readMiners();
  const prevByKey = new Map((previous?.chains ?? []).map((c) => [c.chainKey, c]));

  const chains: LastSolution[] = [];
  let failures = 0;
  for (const chain of MINER_CHAINS) {
    if (chains.length > 0) await sleep(300); // free-key pacing (5 req/s)
    try {
      const sol = await fetchLastSolution(chain, apiKey);
      chains.push(sol);
      console.error(
        `${chain.key}: round ${sol.round} won by ${sol.miner} at block ${sol.blockNum}`,
      );
    } catch (e) {
      failures++;
      const stale = prevByKey.get(chain.key);
      console.error(`${chain.key}: FAILED (${(e as Error).message})` +
        (stale ? " — keeping previous entry" : " — no previous entry, chain omitted"));
      if (stale) chains.push(stale);
    }
  }

  if (chains.length === 0) {
    console.error("No miner data collected for any chain; not writing.");
    process.exit(1);
  }

  // Rewrite only on real change: `fetchedAtMs` marks when the DATA last moved,
  // and mid-era no-op runs stay commit-free.
  if (previous && JSON.stringify(previous.chains) === JSON.stringify(chains)) {
    console.error("Miners snapshot unchanged; leaving file as-is.");
    return;
  }
  const path = await writeMiners({ fetchedAtMs: String(Date.now()), chains });
  console.error(`Wrote ${path} (${chains.length} chains, ${failures} failed)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
