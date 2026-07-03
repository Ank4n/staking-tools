/**
 * Golden tests for the APY calculator against REAL snapshot data.
 *
 * The strongest guarantee: the calculator reproduces values that the runtime
 * itself stored. Run with `pnpm test` (Node's built-in test runner via tsx).
 *
 * If a future pallet change alters the reward model, re-snapshotting and
 * re-running this suite will fail loudly and point at the drifted invariant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isqrt,
  incentiveWeight,
  computeValidatorApy,
  eraContextForExisting,
} from "../../shared/apy/calculator.js";
import type { EraSnapshot } from "../../shared/snapshot/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS = join(__dirname, "..", "..", "snapshots");

/** Load the newest snapshotted era for a chain, or null if none. */
function loadNewestEra(chain: string): EraSnapshot | null {
  const dir = join(SNAPSHOTS, chain);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort((a, b) => parseInt(a) - parseInt(b));
  if (files.length === 0) return null;
  const file = files[files.length - 1];
  return JSON.parse(readFileSync(join(dir, file), "utf8")) as EraSnapshot;
}

// Run the golden suite against every chain that has snapshot data.
const CHAINS = ["wah", "pah"];

// --- Unit: integer sqrt ---
test("isqrt matches known values", () => {
  assert.equal(isqrt(0n), 0n);
  assert.equal(isqrt(1n), 1n);
  assert.equal(isqrt(100n), 10n);
  assert.equal(isqrt(99n), 9n); // floor
  assert.equal(isqrt(10n ** 18n), 10n ** 9n);
});

// Golden suite, run once per chain that has snapshot data.
for (const chain of CHAINS) {
  const snapshot = loadNewestEra(chain);
  const skip = snapshot
    ? false
    : `no ${chain} snapshot data; run \`pnpm snapshot --chain ${chain}\` first`;

  // --- GOLDEN: incentive weight reproduces on-chain ErasValidatorIncentiveWeight ---
  // When the incentive feature is disabled on a chain (optimum=cap=0, budget=0,
  // weights all null — currently the case on Polkadot Asset Hub), we instead
  // assert the calculator agrees that all weights are zero.
  test(`[${chain}] incentive weight matches on-chain (or feature is off)`, { skip }, () => {
    const s = snapshot!;
    const optimum = BigInt(s.incentiveParams.optimumSelfStake);
    const cap = BigInt(s.incentiveParams.hardCapSelfStake);
    const slope = BigInt(s.incentiveParams.selfStakeSlopeFactor.raw);
    const incentiveDisabled = optimum === 0n && cap === 0n;

    if (incentiveDisabled) {
      assert.equal(s.sumIncentiveWeight, "0", "expected zero sum when off");
      // Calculator must also yield zero weight for any self-stake.
      for (const v of s.validators.slice(0, 5)) {
        assert.equal(incentiveWeight(BigInt(v.ownStake), optimum, cap, slope), 0n);
        assert.equal(v.incentiveWeight, null, `expected null weight for ${v.address}`);
      }
      return;
    }

    let checked = 0;
    let sum = 0n;
    for (const v of s.validators) {
      if (v.incentiveWeight == null) continue;
      const calc = incentiveWeight(BigInt(v.ownStake), optimum, cap, slope);
      assert.equal(calc.toString(), v.incentiveWeight, `weight mismatch for ${v.address}`);
      sum += calc;
      checked++;
    }
    // The incentive params can be configured (optimum/cap non-zero) while the
    // feature is not yet live — every validator's weight is still null and the
    // on-chain sum is zero (currently the case on PAH). Treat that dormant state
    // like "off": there's nothing to reproduce, only the zero sum to confirm.
    if (checked === 0) {
      assert.equal(s.sumIncentiveWeight, "0", "expected zero sum when no weights populated");
      return;
    }
    // The recomputed sum must equal on-chain ErasSumValidatorIncentiveWeight.
    assert.equal(sum.toString(), s.sumIncentiveWeight, "sum weight mismatch");
  });

  // --- GOLDEN: per-validator staker reward conserves the era pot ---
  test(`[${chain}] staker reward split conserves validator+nominator`, { skip }, () => {
    const s = snapshot!;
    for (const v of s.validators) {
      const ctx = eraContextForExisting(s, v);
      const own = BigInt(v.ownStake);
      const nom = BigInt(v.totalStake) - own;
      const r = computeValidatorApy(
        { ownStake: own, nominatorStake: nom, commissionRaw: BigInt(v.commission.raw), rewardPoints: BigInt(v.rewardPoints) },
        ctx,
      );
      // validator-kept + nominator must equal the validator's pot slice exactly.
      assert.equal(
        (r.validatorStakerReward + r.nominatorReward).toString(),
        r.validatorTotalStakerReward.toString(),
        `conservation failed for ${v.address}`,
      );
    }
  });

  // --- GOLDEN: sum of all validators' pot slices ~= total staker reward ---
  test(`[${chain}] validator pot slices sum to total staker reward (floor rounding)`, { skip }, () => {
    const s = snapshot!;
    const totalPot = BigInt(s.totalStakerReward);
    let allocated = 0n;
    for (const v of s.validators) {
      const ctx = eraContextForExisting(s, v);
      const r = computeValidatorApy(
        {
          ownStake: BigInt(v.ownStake),
          nominatorStake: BigInt(v.totalStake) - BigInt(v.ownStake),
          commissionRaw: BigInt(v.commission.raw),
          rewardPoints: BigInt(v.rewardPoints),
        },
        ctx,
      );
      allocated += r.validatorTotalStakerReward;
    }
    // Each slice floors, so allocated <= totalPot, off by < validatorCount.
    assert.ok(allocated <= totalPot, "allocated exceeds pot");
    const dust = totalPot - allocated;
    assert.ok(dust < BigInt(s.validators.length + 1), `dust too large: ${dust}`);
  });

  // --- Sanity: combined staker APY is a plausible positive fraction ---
  // (validator-on-own-stake APY can legitimately be very high for low-self-stake
  // validators, so the plausibility bound is on the combined staker APY.)
  test(`[${chain}] combined staker APY is a finite plausible fraction`, { skip }, () => {
    const s = snapshot!;
    const v = s.validators[0];
    const ctx = eraContextForExisting(s, v);
    const r = computeValidatorApy(
      {
        ownStake: BigInt(v.ownStake),
        nominatorStake: BigInt(v.totalStake) - BigInt(v.ownStake),
        commissionRaw: BigInt(v.commission.raw),
        rewardPoints: BigInt(v.rewardPoints),
      },
      ctx,
    );
    assert.ok(Number.isFinite(r.combinedStakerApy), "APY not finite");
    assert.ok(r.combinedStakerApy > 0, "APY not positive");
    assert.ok(r.combinedStakerApy < 2, `combined APY implausibly high: ${r.combinedStakerApy}`);
  });
}
