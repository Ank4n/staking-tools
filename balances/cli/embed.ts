/**
 * Extracts the baked data blob for the Balances app from committed snapshots.
 *
 * Unlike the other apps, the Balances page ALSO reads live chain state after
 * load (the one deliberate runtime-fetch exception in this project) — this
 * embed provides the offline fallback + historical series: per-era reward-pot
 * budgets and the treasury balances captured by the health pass, plus the
 * fixed accounts and connection defaults the live client needs.
 *
 *   pnpm tsx balances/cli/embed.ts > balances/web/data.json
 */
import { getChain } from "../../shared/chains/index.js";
import { readEra, listEras, readIndex } from "../../shared/snapshot/store.js";
import { treasuryAccount, ASSET_IDS } from "../../shared/snapshot/health.js";
import type { EraSnapshot } from "../../shared/snapshot/types.js";

/** This site is Polkadot-only; `wah` stays snapshot-able but is not embedded. */
const EMBED_CHAINS = ["pah"];
/** How many recent eras of baked series to embed (floored at `dataFloorEra`). */
const MAX_ERAS = 14;

interface EmbedEra {
  era: number;
  /** Era reward-pot budgets (planck strings; per-era on-chain history). */
  totalStakerReward: string;
  validatorIncentiveBudget: string;
  /** Treasury balances at the era-boundary read; null on older snapshots. */
  treasury: { dot: string; usdt: string; usdc: string } | null;
}

interface EmbedChain {
  chainKey: string;
  tokenSymbol: string;
  tokenDecimals: number;
  updatedAtMs: string | null;
  /** Active era at last snapshot (context for the era input). */
  activeEra: number | null;
  defaultEndpoint: string;
  treasuryAccount: string;
  /** AssetHub asset IDs for the treasury stablecoins. */
  assetIds: { usdt: number; usdc: number };
  subscanBase: string;
  eras: EmbedEra[];
}

function toEmbedEra(s: EraSnapshot): EmbedEra | null {
  if (!s.health) return null;
  return {
    era: s.era,
    totalStakerReward: s.totalStakerReward,
    validatorIncentiveBudget: s.validatorIncentiveBudget,
    treasury: s.health.treasury ?? null,
  };
}

async function buildChain(key: string): Promise<EmbedChain | null> {
  const chain = getChain(key);
  const eras = await listEras(chain);
  if (eras.length === 0) return null;

  const collected: EmbedEra[] = [];
  for (let i = eras.length - 1; i >= 0 && collected.length < MAX_ERAS; i--) {
    if (eras[i] < chain.dataFloorEra) break;
    const s = await readEra(chain, eras[i]);
    if (!s) continue;
    const e = toEmbedEra(s);
    if (e) collected.push(e);
  }
  if (collected.length === 0) return null;
  collected.reverse(); // oldest → newest

  const index = await readIndex(chain);

  return {
    chainKey: chain.key,
    tokenSymbol: chain.tokenSymbol,
    tokenDecimals: chain.tokenDecimals,
    updatedAtMs: index?.updatedAtMs ?? null,
    activeEra: index?.activeEra ?? null,
    defaultEndpoint: chain.browserEndpoint,
    treasuryAccount: treasuryAccount(chain.ss58Prefix),
    assetIds: { ...ASSET_IDS },
    subscanBase: chain.subscanWeb,
    eras: collected,
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
