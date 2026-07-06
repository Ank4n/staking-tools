/**
 * Extracts a compact, self-contained data blob from the newest snapshot of each
 * chain, for embedding into the standalone HTML simulator (which can't fetch).
 *
 * Emits JSON to stdout: per chain, the era-level reward params plus a small
 * sample of real validators (for the "load a real validator" presets).
 *
 *   pnpm tsx validator/cli/embed.ts > validator/web/data.json
 */
import { getChain, CHAINS } from "../../shared/chains/index.js";
import { readEra, listEras, readIndex } from "../../shared/snapshot/store.js";

interface EmbedValidator {
  address: string;
  ownStake: string;
  totalStake: string;
  commissionRaw: number;
  rewardPoints: number;
}

interface EmbedChain {
  chainKey: string;
  chainName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  era: number;
  /** When this snapshot was last refreshed from chain (epoch ms, as string). */
  updatedAtMs: string | null;
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
  /** A handful of real validators spanning the stake range, as presets. */
  sampleValidators: EmbedValidator[];
  /**
   * Every validator's own self-stake (planck strings) for the era. Used to
   * compute the exact incentive-weight denominator under a chosen curve — even
   * on chains where the incentive is currently off and stores no weights.
   */
  ownStakes: string[];
  /**
   * Inflation-per-era (planck strings) for the last few eras, newest first,
   * INCLUDING this era. The UI takes the median of the others as a steady-state
   * baseline to flag DAP drip catch-up eras (whose reward pot carries backlog).
   */
  recentInflation: string[];
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

async function buildChain(key: string): Promise<EmbedChain | null> {
  const chain = getChain(key);
  const eras = await listEras(chain);
  if (eras.length === 0) return null;
  const era = eras[eras.length - 1];
  const s = await readEra(chain, era);
  if (!s) return null;
  const index = await readIndex(chain);

  // Pick samples spanning the own-stake range: min, low-quartile, median, top.
  const byOwn = [...s.validators].sort(
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

  const budgetAllocation: Record<string, number> = {};
  for (const [k, p] of Object.entries(s.dapParams.budgetAllocation)) {
    budgetAllocation[k] = p.raw;
  }

  // Last few eras' inflation, newest first, as a steady-state baseline for the UI.
  const RECENT = 6;
  const recentEras = eras.slice(-RECENT).reverse();
  const recentInflation: string[] = [];
  for (const e of recentEras) {
    const es = e === era ? s : await readEra(chain, e);
    if (es) recentInflation.push(inflationOf(es).toString());
  }

  return {
    chainKey: s.chain.chainKey,
    chainName: s.chain.chainName,
    tokenSymbol: s.chain.tokenSymbol,
    tokenDecimals: s.chain.tokenDecimals,
    era: s.era,
    updatedAtMs: index?.updatedAtMs ?? null,
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
    sampleValidators,
    ownStakes: s.validators.map((v) => v.ownStake),
    recentInflation,
  };
}

async function main() {
  const out: EmbedChain[] = [];
  for (const key of Object.keys(CHAINS)) {
    const c = await buildChain(key);
    if (c) out.push(c);
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
