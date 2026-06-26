/**
 * Open, human-readable snapshot schema for staking-async (DAP mode).
 *
 * Design goals:
 *  - **Self-describing**: every shard carries the chain + units + curve params
 *    it depends on, so a consumer never has to cross-reference another file.
 *  - **Lossless for APY**: all inputs needed to compute validator/nominator APY
 *    are present (era reward pots, points, exposures, commission, incentive
 *    weights + sum, the self-stake curve params).
 *  - **Plain numbers as strings**: balances are u128 planck values serialized as
 *    decimal strings to avoid JS number precision loss. Consumers parse with
 *    BigInt. Perbill values are kept as raw integers (0..=1e9) AND as a float
 *    fraction for convenience.
 *
 * Sharding: one file per era (`<era>.json`) plus an `index.json` describing the
 * chain and listing known eras. See `src/snapshot/store.ts`.
 */

export const SCHEMA_VERSION = 1;

/** A Perbill value, captured both raw (0..=1_000_000_000) and as a fraction. */
export interface Perbill {
  /** Raw parts-per-billion integer, exactly as stored on-chain. */
  raw: number;
  /** Convenience float in [0, 1]. Derived from `raw`. */
  fraction: number;
}

/** Metadata shared by every shard so each file stands alone. */
export interface ChainMeta {
  /** Snapshot schema version. */
  schemaVersion: number;
  /** Chain key (e.g. "wah", "pah"). */
  chainKey: string;
  /** Human-readable chain name. */
  chainName: string;
  /** Genesis hash, to unambiguously identify the chain. */
  genesisHash: string;
  /** Token symbol (e.g. "DOT", "WND"). */
  tokenSymbol: string;
  /** Token decimals; token = planck / 10^decimals. */
  tokenDecimals: number;
  /** SS58 prefix for address interpretation. */
  ss58Prefix: number;
}

/** Self-stake incentive curve params (chain-wide; can change via governance). */
export interface IncentiveParams {
  /** Self-stake at/below which weight grows as sqrt(s). Planck string. */
  optimumSelfStake: string;
  /** Self-stake above which weight plateaus. Planck string. */
  hardCapSelfStake: string;
  /** Slope factor k for the dampened zone (Perbill). */
  selfStakeSlopeFactor: Perbill;
}

/** DAP issuance/budget config (chain-wide). */
export interface DapParams {
  /**
   * Budget allocation: budget key -> share of minted issuance. Keys are the
   * `BudgetKey` enum variant names (e.g. "StakerRewards", "ValidatorIncentive",
   * "Dap"). Values are Perbill and should sum to 100%.
   */
  budgetAllocation: Record<string, Perbill>;
  /** Min elapsed ms between issuance drips (constant). */
  issuanceCadenceMs: string;
  /** Safety ceiling on elapsed ms per drip (constant). */
  maxElapsedPerDripMs: string;
  /** Last issuance drip timestamp (ms since epoch), if available. */
  lastIssuanceTimestampMs: string;
}

/** One nominator's stake backing a validator, within a page. */
export interface NominatorExposure {
  /** Nominator stash address. */
  who: string;
  /** Stake backing this validator (planck string). */
  value: string;
}

/**
 * An NPoS election score, exactly as stored on-chain
 * (`sp_npos_elections::ElectionScore`). All values are planck strings.
 */
export interface ElectionScore {
  /** Minimal backing stake among all winners (maximize). */
  minimalStake: string;
  /** Sum of total backing across all winners (maximize). */
  sumStake: string;
  /** Sum of squared backings (variance; minimize). */
  sumStakeSquared: string;
}

/** Summary of all unbonding chunks across every staking ledger. */
export interface UnbondingSummary {
  /** Number of ledgers that have at least one unlocking chunk. */
  ledgerCount: number;
  /** Total number of unlocking chunks across all ledgers. */
  chunkCount: number;
  /** Sum of all unlocking chunk values (planck string). */
  totalValue: string;
}

/** Native balances of the three DAP issuance pots, at `balanceBlock`. */
export interface PotBalances {
  /** DAP buffer account free balance (planck string). */
  buffer: string;
  /** Staker-rewards general pot free balance (planck string). */
  stakerReward: string;
  /** Validator-incentive general pot free balance (planck string). */
  validatorIncentive: string;
}

/**
 * Era-boundary reconstruction metadata: where the live (point-in-time) reads
 * for this era were taken. Filled by the `health` reconstruct CLI, which finds
 * the era's first block via Subscan and reads state a few blocks earlier (the
 * general pots drain into era pots exactly at the transition block).
 */
export interface EraBoundary {
  /** First block of this era (from Subscan, by `ActiveEra.start` timestamp). */
  block: number;
  /** Block hash for `block`. */
  hash: string;
  /** Blocks subtracted from `block` to read pre-drain balances/state. */
  offset: number;
  /** The block actually read (`block - offset`). */
  balanceBlock: number;
  /** Block hash for `balanceBlock`. */
  balanceHash: string;
  /** `ActiveEra.index` observed at `balanceBlock` (sanity check; should be era-1's tail). */
  observedEra: number | null;
}

/**
 * Point-in-time "health" reads reconstructed at an era's boundary block. These
 * are NOT per-era on-chain history — they are live storage values captured at
 * the reconstructed boundary block. Optional: present only after the `health`
 * reconstruct CLI has run for this era.
 */
export interface EraHealth {
  /** Where/when these reads were taken. */
  boundary: EraBoundary;

  /** Election round counter (`MultiBlockElection.Round`). */
  electionRound: number | null;
  /** Feasibility threshold (`MultiBlockElectionVerifier.MinimumScore`). */
  minimumScore: ElectionScore | null;
  /** Score of the queued/accepted solution, if present. */
  queuedSolutionScore: ElectionScore | null;

  /** `CounterForNominators`. */
  nominatorCount: number;
  /** `CounterForValidators` (intending validators, not the active set). */
  validatorCount: number;
  /** `MinimumActiveStake` — min stake that got exposed (planck string). */
  minimumActiveStake: string;
  /** `MinNominatorBond` (planck string). */
  minNominatorBond: string;
  /** `MinValidatorBond` (planck string). */
  minValidatorBond: string;

  /** Unbonding across all ledgers. */
  unbonding: UnbondingSummary;

  /**
   * Own self-stake (ledger.active, planck strings) of every account in
   * `Validators` storage — the full registered set, not just the active era's
   * exposed validators. The app buckets these.
   */
  allValidatorOwnStakes: string[];

  /** DAP pot balances at `boundary.balanceBlock`. */
  pots: PotBalances;
}

/** Per-validator data for an era. */
export interface ValidatorEra {
  /** Validator stash address. */
  address: string;
  /** Total stake backing this validator (own + nominators), planck string. */
  totalStake: string;
  /** Validator's own self-stake, planck string. */
  ownStake: string;
  /** Number of nominators backing this validator. */
  nominatorCount: number;
  /** Number of exposure pages. */
  pageCount: number;
  /** Commission this validator charges (Perbill). */
  commission: Perbill;
  /** Whether the validator blocks new nominations. */
  blocked: boolean;
  /** Era reward points earned by this validator. */
  rewardPoints: number;
  /**
   * Incentive weight assigned to this validator's self-stake for the era
   * (planck string, the sqrt-curve output). Null if not stored on-chain.
   */
  incentiveWeight: string | null;
  /**
   * Per-nominator exposure, flattened across all pages. Present when
   * `includeNominators` was requested at snapshot time; otherwise empty.
   */
  nominators: NominatorExposure[];
}

/** A complete per-era snapshot shard. */
export interface EraSnapshot {
  /** Self-describing chain metadata. */
  chain: ChainMeta;
  /** The era index this shard describes. */
  era: number;
  /**
   * When this era's data was captured (ms since epoch), from snapshot time.
   * NOTE: this is the wall-clock capture time, not the era's own start.
   */
  capturedAtMs: string;
  /**
   * Active era start timestamp (ms since epoch) at capture time, for the
   * then-active era. Used together with `eraDurationMs` to annualize. May be
   * null if unavailable. This is the START of the CURRENTLY ACTIVE era at
   * capture, not necessarily of `era` itself (historical eras don't store it).
   */
  activeEraStartMs: string | null;
  /**
   * Estimated era duration in ms (sessions_per_era * session_length, or
   * derived from observed active-era timing). Used for annualization.
   */
  eraDurationMs: string;
  /** Number of sessions per era (constant). */
  sessionsPerEra: number;
  /** History depth: how many eras are retained on-chain. */
  historyDepth: number;

  /** Total staker reward pot for this era (planck string). The DAP snapshot. */
  totalStakerReward: string;
  /** Total validator incentive budget pot for this era (planck string). */
  validatorIncentiveBudget: string;
  /** Total era reward points across all validators. */
  totalRewardPoints: number;
  /** Total stake bonded in this era across all validators (planck string). */
  totalStake: string;
  /** Sum of all validators' incentive weights for this era (planck string). */
  sumIncentiveWeight: string;

  /** Self-stake incentive curve params in effect (captured at snapshot time). */
  incentiveParams: IncentiveParams;
  /** DAP issuance/budget params (captured at snapshot time). */
  dapParams: DapParams;

  /** Per-validator data for the era. */
  validators: ValidatorEra[];

  /**
   * Reconstructed point-in-time health reads at this era's boundary block.
   * Optional: populated by the `health` reconstruct CLI; absent on snapshots
   * taken by the plain `snapshot` CLI.
   */
  health?: EraHealth;
}

/** The index file: one per chain, lists which eras have shards. */
export interface SnapshotIndex {
  chain: ChainMeta;
  /** Most recent active era index observed. */
  currentEra: number | null;
  /** Active era index at last snapshot. */
  activeEra: number | null;
  /** History depth at last snapshot. */
  historyDepth: number;
  /** Sorted list of eras for which a shard file exists. */
  eras: number[];
  /** Last time the index was updated (ms since epoch). */
  updatedAtMs: string;
}
