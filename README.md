# staking-tools

Tools for Polkadot **staking-async** (DAP mode), served as a static site.

```
shared/        reusable core — chain config, snapshot reader/store, APY calculator
validator/     validator APY calculator (web UI + CLIs + tests)
tools/         site builder (landing page + per-app subpaths)
snapshots/     on-chain era data, one JSON file per era (shared)
```

## Layout

| Path | What |
| --- | --- |
| `shared/chains/` | Chain config (`pah`, `wah`), PAPI descriptors, endpoints |
| `shared/snapshot/` | RPC reader, per-era JSON store, schema types |
| `shared/apy/` | Pure BigInt APY calculator (mirrors the pallet math) |
| `validator/` | The validator app — see `validator/README.md` |
| `snapshots/<chain>/<era>.json` | One file per era + `index.json` |

New tools go beside `validator/` and import from `shared/`.

## Setup

```bash
pnpm install
```

## Commands

```bash
pnpm snapshot --chain pah        # snapshot last 28 ended eras to JSON
pnpm apy --chain pah --top 10    # validator APY from a snapshot (CLI)
pnpm build-web                   # rebuild the validator app HTML
pnpm build-site                  # build the full static site -> site/
pnpm test                        # golden tests vs on-chain values
pnpm typecheck
```

Endpoints override via env: `RPC_PAH`, `RPC_WAH`.

## Static site / GitHub Pages

`pnpm build-site` writes `site/`:

```
site/
  index.html            landing page (one card per app)
  validator/index.html  the validator app (data baked in)
  .nojekyll
```

Links are relative, so it works under a project-pages base path
(`/staking-tools/`) with no config. `.github/workflows/pages.yml` builds and
deploys `site/` to Pages on push to `main` — no network needed at build time
(the site is built from committed snapshots + offline-regenerated PAPI
descriptors).

**Adding a tool:** build its self-contained HTML, then add one entry to `APPS`
in `tools/build-site.ts` (slug, title, blurb, icon, `build()`). The landing card
and routing follow automatically.

**One-time setup:** in the repo's GitHub settings → Pages → Source, select
**GitHub Actions**.

## Snapshot format

One self-describing JSON per era under `snapshots/<chain>/`. Balances are u128
planck as decimal strings (parse with `BigInt`); `Perbill` carries `raw`
(0..=1e9) and `fraction`. Schema: `shared/snapshot/types.ts`.

Only **DAP (non-minting)** mode is modeled. Era duration = `SessionsPerEra × 4h`
(relay session) = 24h → 365 eras/year. `MaxEraDuration` is a cap, not the length.

## APY model (DAP mode)

Two reward streams, commission = 0:

```
staker share = stakerPot × (points/totalPoints) × own/(own+nominator)
incentive    = incentivePot × w(own) / Σ w(all validators)
APY          = (staker share + incentive) × 365 / own
```

`w` is the piecewise-√ self-stake curve (verified against on-chain
`ErasValidatorIncentiveWeight`). Pots come from era issuance × budget split.
Math: `shared/apy/calculator.ts`.
