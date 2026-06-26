# Era Health

Monitors the health of recent staking eras on Polkadot/Westend Asset Hub:
election scores, staking participation, validator self-stake distribution, and
DAP inflation — across the last ~7 eras.

## How it works

Most health metrics (election score, nominator/validator counts, min stakes,
unbonding totals, all-validator self-stake, DAP pot balances) are **live**
on-chain storage with no per-era history. To attach them to historical eras we
**reconstruct** them at each era's boundary block:

1. `health/cli/reconstruct.ts` estimates each era's start time, finds its first
   block via **Subscan** (`/scan/block`, one call per era), and reads state a
   few blocks *before* it — the DAP general pots drain into era-specific pots
   exactly at the era-transition block, so the accumulated inflation is only
   visible just before. Reads merge into the existing `snapshots/<chain>/<era>.json`
   under the optional `health` field (`shared/snapshot/types.ts`).
2. `health/cli/embed.ts` collects the last 7 eras' health + per-era reward pots
   into a compact `health/web/data.json`.
3. `health/cli/build-web.ts` inlines the data + `lib.js` into `health.html` to
   produce the self-contained `health.built.html`.

The per-era reward pots (`ErasValidatorReward`, `ErasValidatorIncentiveBudget`)
*are* real per-era on-chain values and come straight from the base snapshot.

## Commands

```bash
# 1. ensure base snapshots exist
pnpm snapshot --chain pah

# 2. reconstruct health for the last 7 ended eras (needs SUBSCAN_API_KEY in .env)
pnpm health-reconstruct --chain pah

# 3. build the self-contained app
pnpm build-health            # -> health/web/health.built.html
```

`SUBSCAN_API_KEY` is read from the environment (`.env`, gitignored). Used
sparingly: one Subscan call per era. Point `RPC_PAH` at an archive node (e.g.
Dwellir) to reconstruct eras older than the public node's state retention
(~8 days on the public PAH RPC).

## The four cards

1. **Election** — round, min-score threshold, and per-era solution min stake vs
   that threshold.
2. **Staking — participants & unbonding** — nominator count, registered
   validator count, min active stake, unbonding ledger count + total value.
3. **Validator self-stake** — distribution by bucket (`>30k … 0`) with
   cumulative `≥10k` / `>30k`; toggle **active** (era exposures) vs **all**
   (every registered validator's ledger at the boundary block).
4. **Inflation** — per-era total split into staker rewards / validator
   incentive / buffer Δ.

Account-derivation and drain-timing details are documented inline in
`shared/snapshot/health.ts`.
