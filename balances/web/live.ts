/**
 * Live chain client for the Balances app — the ONLY code in this project that
 * talks to a node from the browser (deliberate exception: balances move, baked
 * data can't show "now"). Bundled by esbuild into an IIFE exposed as
 * `window.Live`; the ES5 UI (lib.js) calls it and overlays results on the
 * baked view.
 *
 * Uses papi's unsafe API (no descriptors baked — metadata is fetched from the
 * node at runtime, so the page survives runtime upgrades). Every bigint is
 * serialized to a decimal string at this boundary; failures degrade per
 * section so the UI keeps whatever it can.
 */
import { createClient, Enum, type PolkadotClient } from "polkadot-api";
import { getWsProvider, WsEvent, type StatusChange } from "polkadot-api/ws-provider/web";

export type ConnState = "connecting" | "connected" | "error" | "closed";

export interface LiveHandle {
  client: PolkadotClient;
  api: ReturnType<PolkadotClient["getUnsafeApi"]>;
}

export interface ReadOpts {
  /** Eras to read reward-pot balances for (the baked window). */
  eras: number[];
  /** Treasury account (DOT + stablecoin reads). */
  treasury: string;
  /** AssetHub asset ids. */
  assetIds: { usdt: number; usdc: number };
  timeoutMs?: number;
}

export interface EraPotRead {
  era: number;
  staker: { account: string; balance: string } | null;
  validator: { account: string; balance: string } | null;
}

export interface ReadAllResult {
  activeEra: number | null;
  /** Treasury free DOT (planck string); null on failure. */
  treasuryFree: string | null;
  /** 6-decimal unit strings; "0" when the asset account doesn't exist. */
  treasuryAssets: { usdt: string; usdc: string } | null;
  eraPots: EraPotRead[];
  /** USDT per DOT from the AssetConversion pool (float); null if unavailable. */
  dotUsd: number | null;
}

const rewardPot = (era: number, kind: "StakerRewards" | "ValidatorSelfStake") =>
  Enum("Era", [era, Enum(kind)]);

export function connect(
  endpoint: string,
  onStatus: (state: ConnState) => void,
): LiveHandle {
  const provider = getWsProvider({
    endpoints: [endpoint],
    timeout: 10_000,
    onStatusChanged: (status: StatusChange) => {
      const state: ConnState =
        status.type === WsEvent.CONNECTING
          ? "connecting"
          : status.type === WsEvent.CONNECTED
            ? "connected"
            : status.type === WsEvent.ERROR
              ? "error"
              : "closed";
      onStatus(state);
    },
  });
  const client = createClient(provider);
  return { client, api: client.getUnsafeApi() };
}

export function destroy(handle: LiveHandle): void {
  try {
    handle.client.destroy();
  } catch {
    // already torn down
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: timed out`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

async function readEraPot(
  api: LiveHandle["api"],
  era: number,
  kind: "StakerRewards" | "ValidatorSelfStake",
): Promise<{ account: string; balance: string }> {
  const pot = rewardPot(era, kind);
  const [account, balance] = await Promise.all([
    api.view.Staking.pot_account(pot) as Promise<string>,
    api.view.Staking.pot_balance(pot) as Promise<bigint>,
  ]);
  return { account, balance: balance.toString() };
}

/** DOT/USDT spot from the AssetConversion DEX pool: quote 1 DOT in. */
async function quoteDotUsd(api: LiveHandle["api"]): Promise<number | null> {
  const dot = { parents: 1, interior: Enum("Here") };
  const usdt = {
    parents: 0,
    interior: Enum("X2", [
      Enum("PalletInstance", 50),
      Enum("GeneralIndex", 1984n),
    ]),
  };
  const out = (await api.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
    dot,
    usdt,
    10n ** 10n,
    false,
  )) as bigint | undefined;
  return out != null ? Number(out) / 1e6 : null;
}

export async function readAll(handle: LiveHandle, opts: ReadOpts): Promise<ReadAllResult> {
  const { api } = handle;
  const timeoutMs = opts.timeoutMs ?? 25_000;

  // Per-section catch: a failed read degrades that section to null and is
  // logged for debugging; the UI keeps whatever resolved.
  const guard = <T>(p: Promise<T>, what: string): Promise<T | null> =>
    withTimeout(p, timeoutMs, what).catch((e) => {
      console.warn(`[balances live] ${what}:`, e instanceof Error ? e.message : e);
      return null;
    });

  const [activeEra, treasuryAcct, assets, dotUsd, eraPotPairs] = await Promise.all([
    guard(
      api.query.Staking.ActiveEra.getValue() as Promise<{ index: number } | undefined>,
      "active era",
    ),
    guard(
      api.query.System.Account.getValue(opts.treasury) as Promise<{
        data: { free: bigint };
      }>,
      "treasury account",
    ),
    guard(
      Promise.all(
        [opts.assetIds.usdt, opts.assetIds.usdc].map(
          (id) =>
            api.query.Assets.Account.getValue(id, opts.treasury) as Promise<
              { balance: bigint } | undefined
            >,
        ),
      ),
      "treasury assets",
    ),
    guard(quoteDotUsd(api), "dot price"),
    Promise.all(
      opts.eras.map((era) =>
        Promise.all([
          guard(readEraPot(api, era, "StakerRewards"), `era ${era} staker pot`),
          guard(readEraPot(api, era, "ValidatorSelfStake"), `era ${era} incentive pot`),
        ]),
      ),
    ),
  ]);

  return {
    activeEra: activeEra?.index ?? null,
    treasuryFree: treasuryAcct?.data.free.toString() ?? null,
    treasuryAssets: assets
      ? {
          usdt: (assets[0]?.balance ?? 0n).toString(),
          usdc: (assets[1]?.balance ?? 0n).toString(),
        }
      : null,
    eraPots: opts.eras.map((era, i) => ({
      era,
      staker: eraPotPairs[i][0],
      validator: eraPotPairs[i][1],
    })),
    dotUsd,
  };
}

export interface PotInfo {
  era: number;
  staker: { account: string; balance: string; budget: string | null } | null;
  validator: { account: string; balance: string; budget: string | null } | null;
}

/** Full pot info for one (possibly arbitrary) era, budgets included. */
export async function potInfo(handle: LiveHandle, era: number): Promise<PotInfo> {
  const { api } = handle;
  const opt = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
  const [staker, validator, stakerBudget, valBudget] = await Promise.all([
    opt(readEraPot(api, era, "StakerRewards")),
    opt(readEraPot(api, era, "ValidatorSelfStake")),
    opt(api.query.Staking.ErasValidatorReward.getValue(era) as Promise<bigint | undefined>),
    opt(
      api.query.Staking.ErasValidatorIncentiveBudget.getValue(era) as Promise<
        bigint | undefined
      >,
    ),
  ]);
  return {
    era,
    staker: staker && { ...staker, budget: stakerBudget?.toString() ?? null },
    validator: validator && { ...validator, budget: valBudget?.toString() ?? null },
  };
}
