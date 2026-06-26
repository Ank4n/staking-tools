/**
 * Extracts a compact, self-contained data blob for the era-health app from the
 * most recent snapshots that have reconstructed `health` data.
 *
 * Emits JSON to stdout: per chain, a series of recent eras (oldest→newest) with
 * the health reads plus the per-era reward pots already in the snapshot. The
 * standalone HTML can't fetch, so everything it renders is baked in here.
 *
 *   pnpm tsx health/cli/embed.ts > health/web/data.json
 */
import { getChain, CHAINS } from "../../shared/chains/index.js";
import { readEra, listEras, readIndex } from "../../shared/snapshot/store.js";
import type { EraSnapshot } from "../../shared/snapshot/types.js";

/** How many recent eras to embed. */
const MAX_ERAS = 7;

interface EmbedEra {
  era: number;
  boundaryBlock: number;
  balanceBlock: number;
  observedEra: number | null;
  /** Active-set figures (from the era's own finalized exposures). */
  activeValidatorCount: number;
  totalStake: string;
  /**
   * The elected set's actual minimal validator backing this era (planck string)
   * — i.e. the realized `ElectionScore.minimalStake` for the winners, computed
   * from the era's exposures. The meaningful per-era election-quality signal to
   * compare against `minimumScore` (the governance feasibility floor).
   */
  activeMinBacking: string;
  /** The elected set's total backing this era (planck string). */
  activeSumBacking: string;
  /** Per-era finalized reward pots (these ARE per-era on chain). */
  totalStakerReward: string;
  validatorIncentiveBudget: string;
  // --- health reads (point-in-time at the boundary block) ---
  electionRound: number | null;
  minimumScore: { minimalStake: string; sumStake: string; sumStakeSquared: string } | null;
  queuedSolutionScore:
    | { minimalStake: string; sumStake: string; sumStakeSquared: string }
    | null;
  nominatorCount: number;
  registeredValidatorCount: number;
  minimumActiveStake: string;
  minNominatorBond: string;
  minValidatorBond: string;
  unbonding: { ledgerCount: number; chunkCount: number; totalValue: string };
  pots: { buffer: string; stakerReward: string; validatorIncentive: string };
  /** Own self-stake of every registered validator (planck strings). */
  allValidatorOwnStakes: string[];
  /** Own self-stake of the active-set validators (planck strings). */
  activeValidatorOwnStakes: string[];
}

interface EmbedChain {
  chainKey: string;
  chainName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  updatedAtMs: string | null;
  eraDurationMs: string;
  eras: EmbedEra[];
}

function toEmbedEra(s: EraSnapshot): EmbedEra | null {
  if (!s.health) return null;
  const h = s.health;

  // Realized election score of the elected set: min and sum of validator
  // backings (ElectionScore is over winners' total backing).
  let minBacking: bigint | null = null;
  let sumBacking = 0n;
  for (const v of s.validators) {
    const total = BigInt(v.totalStake);
    sumBacking += total;
    if (minBacking === null || total < minBacking) minBacking = total;
  }

  return {
    era: s.era,
    boundaryBlock: h.boundary.block,
    balanceBlock: h.boundary.balanceBlock,
    observedEra: h.boundary.observedEra,
    activeValidatorCount: s.validators.length,
    totalStake: s.totalStake,
    activeMinBacking: (minBacking ?? 0n).toString(),
    activeSumBacking: sumBacking.toString(),
    totalStakerReward: s.totalStakerReward,
    validatorIncentiveBudget: s.validatorIncentiveBudget,
    electionRound: h.electionRound,
    minimumScore: h.minimumScore,
    queuedSolutionScore: h.queuedSolutionScore,
    nominatorCount: h.nominatorCount,
    registeredValidatorCount: h.validatorCount,
    minimumActiveStake: h.minimumActiveStake,
    minNominatorBond: h.minNominatorBond,
    minValidatorBond: h.minValidatorBond,
    unbonding: h.unbonding,
    pots: h.pots,
    allValidatorOwnStakes: h.allValidatorOwnStakes,
    activeValidatorOwnStakes: s.validators.map((v) => v.ownStake),
  };
}

async function buildChain(key: string): Promise<EmbedChain | null> {
  const chain = getChain(key);
  const eras = await listEras(chain);
  if (eras.length === 0) return null;

  // Walk newest→oldest, collecting eras that have health, up to MAX_ERAS.
  const collected: EmbedEra[] = [];
  for (let i = eras.length - 1; i >= 0 && collected.length < MAX_ERAS; i--) {
    const s = await readEra(chain, eras[i]);
    if (!s) continue;
    const e = toEmbedEra(s);
    if (e) collected.push(e);
  }
  if (collected.length === 0) return null;
  collected.reverse(); // oldest → newest

  const newest = await readEra(chain, eras[eras.length - 1]);
  const index = await readIndex(chain);

  return {
    chainKey: chain.key,
    chainName: chain.name,
    tokenSymbol: chain.tokenSymbol,
    tokenDecimals: chain.tokenDecimals,
    updatedAtMs: index?.updatedAtMs ?? null,
    eraDurationMs: newest?.eraDurationMs ?? "0",
    eras: collected,
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
