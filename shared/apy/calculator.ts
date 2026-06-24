/**
 * Pure APY calculator for staking-async (DAP mode).
 *
 * This file is the maintainable core: no I/O, no UI. Every function is a pure
 * transformation over BigInt planck values, mirroring `pallet-staking-async` +
 * `pallet-dap` exactly. Consumers (CLI, web UI) import from here.
 *
 * Fidelity to on-chain math:
 *  - Reward-point split, commission split, and exposure split use `Perbill`
 *    rounding (`mul_floor` via `from_rational`) the same way the runtime does.
 *  - The incentive weight is the piecewise sqrt curve, integer-sqrt'd. This was
 *    verified to reproduce on-chain `ErasValidatorIncentiveWeight` exactly.
 *
 * Where the runtime computes per-page, we compute the per-era total directly
 * (sum over pages == full era), which is mathematically equivalent.
 */

import type { EraSnapshot, ValidatorEra, IncentiveParams } from "../snapshot/types.js";

const PERBILL = 1_000_000_000n;
const ONE_YEAR_MS = 365n * 24n * 60n * 60n * 1000n;

/** Integer square root (Newton), matching `sp_arithmetic::helpers_128bit::sqrt`. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * `Perbill::from_rational(a, b).mul_floor(value)` == floor(value * a / b).
 * Runtime does the rational and the multiply with saturating/`mul_floor`
 * semantics; for the magnitudes here, floor(value * a / b) is exact-equivalent.
 */
function mulRationalFloor(value: bigint, a: bigint, b: bigint): bigint {
  if (b === 0n) return 0n;
  return (value * a) / b;
}

/** `Perbill(raw).mul_floor(value)` == floor(value * raw / 1e9). */
function mulPerbillFloor(value: bigint, perbillRaw: bigint): bigint {
  return (value * perbillRaw) / PERBILL;
}

/**
 * Piecewise sqrt incentive weight on self-stake. Mirrors `reward::incentive_weight`.
 * `slopeFactorRaw` is a Perbill; the runtime uses k² = slopeFactor.square().
 */
export function incentiveWeight(
  selfStake: bigint,
  optimum: bigint,
  cap: bigint,
  slopeFactorRaw: bigint,
): bigint {
  if (selfStake === 0n) return 0n;
  if (optimum === 0n && cap === 0n) return 0n;

  if (selfStake <= optimum) {
    return isqrt(selfStake);
  }
  // k² applied as a Perbill² fraction: floor(excess * k_raw² / 1e18).
  const k2Num = slopeFactorRaw * slopeFactorRaw;
  const k2Den = PERBILL * PERBILL;
  const excess = (selfStake <= cap ? selfStake : cap) - optimum;
  const arg = optimum + (k2Num * excess) / k2Den;
  return isqrt(arg);
}

/** Inputs for a single validator APY computation. */
export interface ValidatorApyInput {
  /** Validator's own self-stake (planck). */
  ownStake: bigint;
  /** Nominator stake backing the validator (planck). */
  nominatorStake: bigint;
  /** Commission as Perbill raw (0..=1e9). */
  commissionRaw: bigint;
  /**
   * Era reward points for this validator. If omitted, the validator is assumed
   * to earn its "fair share" = totalRewardPoints / validatorCount (i.e. average
   * performance). Useful when simulating a hypothetical validator.
   */
  rewardPoints?: bigint;
}

/** Era-level context the APY depends on (all planck / raw integers). */
export interface EraContext {
  totalStakerReward: bigint;
  validatorIncentiveBudget: bigint;
  totalRewardPoints: bigint;
  /**
   * Number of active validators in the era — used to derive average points for
   * a hypothetical validator and to estimate `sumIncentiveWeight` deltas.
   */
  validatorCount: number;
  /**
   * Sum of incentive weights over the rest of the set (i.e. excluding the
   * validator being simulated). For an existing validator, pass
   * `sumIncentiveWeight - thisValidatorWeight`. For a hypothetical added
   * validator, pass the full `sumIncentiveWeight`.
   */
  sumIncentiveWeightOthers: bigint;
  /** Self-stake incentive curve params. */
  optimumSelfStake: bigint;
  hardCapSelfStake: bigint;
  selfStakeSlopeFactorRaw: bigint;
  /** Era duration in ms, for annualization. */
  eraDurationMs: bigint;
}

/** Breakdown of one era's reward for a validator (planck), plus APY. */
export interface ApyResult {
  /** --- Per-era reward components (planck) --- */
  /** Validator's slice of the staker pot before commission/own split. */
  validatorTotalStakerReward: bigint;
  /** Commission portion the validator keeps. */
  commissionPayout: bigint;
  /** Validator-kept staker reward = commission + own-stake share. */
  validatorStakerReward: bigint;
  /** Nominators' aggregate staker reward. */
  nominatorReward: bigint;
  /** Validator self-stake incentive reward. */
  validatorIncentive: bigint;
  /** Total kept by the validator this era = staker reward + incentive. */
  validatorEraTotal: bigint;

  /** --- Annualized (planck per year) --- */
  erasPerYear: number;
  validatorAnnual: bigint;
  nominatorAnnual: bigint;

  /** --- APY as fractions (e.g. 0.18 == 18%) --- */
  /** Validator APY on own stake (commission + own-stake share + incentive). */
  validatorApy: number;
  /** Nominator APY on nominator stake. */
  nominatorApy: number;
  /** Combined APY on total exposure (staker rewards only, excl. incentive). */
  combinedStakerApy: number;
}

/** Annualization factor as a float; eras don't divide a year evenly. */
function erasPerYear(eraDurationMs: bigint): number {
  return Number(ONE_YEAR_MS) / Number(eraDurationMs);
}

/** Float ratio of two planck bigints (safe for APY-scale magnitudes). */
function ratio(numer: bigint, denom: bigint): number {
  if (denom === 0n) return 0;
  // Scale to preserve precision, then divide as floats.
  const scale = 1_000_000_000n;
  return Number((numer * scale) / denom) / Number(scale);
}

/**
 * Compute one validator's per-era reward breakdown and APY.
 *
 * This is the single source of truth for the APY model. Both the real-data path
 * (from a snapshot validator) and the simulator path (hypothetical params) call
 * this.
 */
export function computeValidatorApy(
  input: ValidatorApyInput,
  ctx: EraContext,
): ApyResult {
  const totalExposure = input.ownStake + input.nominatorStake;

  // --- 1. Staker reward: points-weighted slice of the pot ---
  const points =
    input.rewardPoints ??
    (ctx.validatorCount > 0
      ? ctx.totalRewardPoints / BigInt(ctx.validatorCount)
      : 0n);

  const validatorTotalStakerReward = mulRationalFloor(
    ctx.totalStakerReward,
    points,
    ctx.totalRewardPoints,
  );

  // --- 2. Commission + own-stake split (mirrors calculate_staker_reward) ---
  const commissionPayout = mulPerbillFloor(
    validatorTotalStakerReward,
    input.commissionRaw,
  );
  const leftover = validatorTotalStakerReward - commissionPayout;
  const validatorStakingPayout = mulRationalFloor(
    leftover,
    input.ownStake,
    totalExposure,
  );
  const validatorStakerReward = commissionPayout + validatorStakingPayout;
  const nominatorReward = leftover - validatorStakingPayout;

  // --- 3. Validator self-stake incentive ---
  const weight = incentiveWeight(
    input.ownStake,
    ctx.optimumSelfStake,
    ctx.hardCapSelfStake,
    ctx.selfStakeSlopeFactorRaw,
  );
  const sumWeight = ctx.sumIncentiveWeightOthers + weight;
  const validatorIncentive = mulRationalFloor(
    ctx.validatorIncentiveBudget,
    weight,
    sumWeight,
  );

  const validatorEraTotal = validatorStakerReward + validatorIncentive;

  // --- 4. Annualize ---
  const epy = erasPerYear(ctx.eraDurationMs);
  const annualize = (perEra: bigint): bigint =>
    BigInt(Math.round(Number(perEra) * epy));
  const validatorAnnual = annualize(validatorEraTotal);
  const nominatorAnnual = annualize(nominatorReward);

  return {
    validatorTotalStakerReward,
    commissionPayout,
    validatorStakerReward,
    nominatorReward,
    validatorIncentive,
    validatorEraTotal,
    erasPerYear: epy,
    validatorAnnual,
    nominatorAnnual,
    validatorApy: ratio(validatorAnnual, input.ownStake),
    nominatorApy: ratio(nominatorAnnual, input.nominatorStake),
    combinedStakerApy: ratio(
      annualize(validatorStakerReward + nominatorReward),
      totalExposure,
    ),
  };
}

/**
 * Build an `EraContext` from a snapshot, for an EXISTING validator in that era.
 * Subtracts the validator's own stored incentive weight from the era sum so the
 * incentive denominator is "others", letting the caller vary this validator's
 * self-stake and see the effect on the incentive share.
 */
export function eraContextForExisting(
  snapshot: EraSnapshot,
  validator: ValidatorEra,
): EraContext {
  const thisWeight =
    validator.incentiveWeight != null ? BigInt(validator.incentiveWeight) : 0n;
  return {
    totalStakerReward: BigInt(snapshot.totalStakerReward),
    validatorIncentiveBudget: BigInt(snapshot.validatorIncentiveBudget),
    totalRewardPoints: BigInt(snapshot.totalRewardPoints),
    validatorCount: snapshot.validators.length,
    sumIncentiveWeightOthers: BigInt(snapshot.sumIncentiveWeight) - thisWeight,
    ...incentiveParamsToCtx(snapshot.incentiveParams),
    eraDurationMs: BigInt(snapshot.eraDurationMs),
  };
}

/**
 * Build an `EraContext` for a HYPOTHETICAL validator added to the era (e.g. the
 * simulator's "what if I join with X stake"). Uses the full era sum as "others"
 * since the new validator isn't in it yet, and counts it as one extra validator.
 */
export function eraContextForHypothetical(snapshot: EraSnapshot): EraContext {
  return {
    totalStakerReward: BigInt(snapshot.totalStakerReward),
    validatorIncentiveBudget: BigInt(snapshot.validatorIncentiveBudget),
    totalRewardPoints: BigInt(snapshot.totalRewardPoints),
    validatorCount: snapshot.validators.length + 1,
    sumIncentiveWeightOthers: BigInt(snapshot.sumIncentiveWeight),
    ...incentiveParamsToCtx(snapshot.incentiveParams),
    eraDurationMs: BigInt(snapshot.eraDurationMs),
  };
}

function incentiveParamsToCtx(p: IncentiveParams): {
  optimumSelfStake: bigint;
  hardCapSelfStake: bigint;
  selfStakeSlopeFactorRaw: bigint;
} {
  return {
    optimumSelfStake: BigInt(p.optimumSelfStake),
    hardCapSelfStake: BigInt(p.hardCapSelfStake),
    selfStakeSlopeFactorRaw: BigInt(p.selfStakeSlopeFactor.raw),
  };
}
