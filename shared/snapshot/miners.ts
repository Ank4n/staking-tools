/**
 * Last signed election solution per chain (the "miners" data): the most recent
 * `MultiBlockElectionSigned.Rewarded` event — which submitter's signed solution
 * won the round, and the reward paid out.
 *
 * Sourced entirely from Subscan (two calls per chain: latest-event lookup +
 * event detail for the params), so it also covers chains the snapshot CLIs
 * have no RPC config for (Kusama, Paseo). This is a cross-chain "latest"
 * glance, not per-era history — it lives in its own `snapshots/miners.json`
 * rather than the per-chain era files.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountId, Binary } from "polkadot-api";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MINERS_PATH = join(__dirname, "..", "..", "snapshots", "miners.json");

/**
 * Chains the miners snapshot covers. Deliberately NOT `shared/chains` configs:
 * these need only Subscan hosts + display units (no RPC, no descriptors), and
 * the set (Kusama, Paseo) is wider than the snapshot-able chains.
 */
export interface MinerChain {
  readonly key: string;
  /** Display name — staking lives on the Asset Hub; the relay name suffices. */
  readonly name: string;
  /** Subscan API host. */
  readonly api: string;
  /** Subscan web UI base, for account links. */
  readonly web: string;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  /** SS58 prefix for display — matches what the chain's Subscan shows. */
  readonly ss58Prefix: number;
  /**
   * Era duration — the expected cadence of Rewarded events (one signed
   * solution per era). Verified empirically from the spacing of consecutive
   * Rewarded events on each chain (2026-07): PAH 24 h; KAH/WAH/Paseo 6 h.
   */
  readonly eraMs: number;
}

const HOUR_MS = 3_600_000;

export const MINER_CHAINS: readonly MinerChain[] = [
  {
    key: "pah",
    name: "Polkadot",
    api: "https://assethub-polkadot.api.subscan.io",
    web: "https://assethub-polkadot.subscan.io",
    tokenSymbol: "DOT",
    tokenDecimals: 10,
    ss58Prefix: 0,
    eraMs: 24 * HOUR_MS,
  },
  {
    key: "kah",
    name: "Kusama",
    api: "https://assethub-kusama.api.subscan.io",
    web: "https://assethub-kusama.subscan.io",
    tokenSymbol: "KSM",
    tokenDecimals: 12,
    ss58Prefix: 2,
    eraMs: 6 * HOUR_MS,
  },
  {
    key: "wah",
    name: "Westend",
    api: "https://assethub-westend.api.subscan.io",
    web: "https://assethub-westend.subscan.io",
    tokenSymbol: "WND",
    tokenDecimals: 12,
    ss58Prefix: 42,
    eraMs: 6 * HOUR_MS,
  },
  {
    key: "pas",
    name: "Paseo",
    api: "https://assethub-paseo.api.subscan.io",
    web: "https://assethub-paseo.subscan.io",
    tokenSymbol: "PAS",
    tokenDecimals: 10,
    ss58Prefix: 42,
    eraMs: 6 * HOUR_MS,
  },
];

/** One chain's latest rewarded signed solution, self-contained for the embed. */
export interface LastSolution {
  chainKey: string;
  chainName: string;
  subscanWeb: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Era duration = expected Rewarded cadence (see `MinerChain.eraMs`). */
  eraMs: number;
  /** Election round the solution won. */
  round: number;
  /** Rewarded submitter (SS58, chain's display prefix). */
  miner: string;
  /** Same account as raw hex pubkey. */
  minerHex: string;
  /** Reward paid out (planck string). */
  rewardPlanck: string;
  blockNum: number;
  blockTimestampMs: string;
  /**
   * Timestamps (ms strings, newest-first) of the last `RECENT_EVENTS`
   * Rewarded events — the pulse-timeline history. Comes free with the list
   * call (`block_timestamp` per row), no extra API traffic.
   */
  recentTimestampsMs: string[];
  /** Total Rewarded events Subscan has indexed for the chain. */
  rewardedCount: number;
}

export interface MinersSnapshot {
  /** When the data last CHANGED (not merely refreshed) — see the CLI. */
  fetchedAtMs: string;
  chains: LastSolution[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Gap between Subscan calls — free-key limit is 5 req/s. */
const SUBSCAN_PACE_MS = 300;

/**
 * Rewarded events fetched per chain: enough to cover the pulse card's 7-day
 * window on a 6 h-era chain (28 events) with margin.
 */
const RECENT_EVENTS = 40;

async function subscanPost<T>(
  host: string,
  path: string,
  body: unknown,
  apiKey: string,
): Promise<T> {
  const res = await fetch(`${host}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Subscan ${path} HTTP ${res.status}`);
  const json = (await res.json()) as { code: number; message: string; data?: T };
  if (json.code !== 0 || json.data == null) {
    throw new Error(`Subscan ${path} failed: code=${json.code} msg=${json.message}`);
  }
  return json.data;
}

/**
 * Fetch the recent Rewarded history for one chain (newest-first list; the
 * detail call decodes only the newest). Params of Rewarded (verified identical
 * on all four chains): [round u32, submitter AccountId, reward u128].
 */
export async function fetchLastSolution(
  chain: MinerChain,
  apiKey: string,
): Promise<LastSolution> {
  const list = await subscanPost<{
    count: number;
    events: { event_index: string; block_timestamp: number }[] | null;
  }>(
    chain.api,
    "/api/v2/scan/events",
    { module: "multiblockelectionsigned", event_id: "rewarded", row: RECENT_EVENTS, page: 0 },
    apiKey,
  );
  const head = list.events?.[0];
  if (!head) throw new Error(`${chain.key}: no Rewarded events on Subscan`);

  await sleep(SUBSCAN_PACE_MS);
  const detail = await subscanPost<{
    block_num: number;
    params: { type: string; value: unknown }[];
  }>(chain.api, "/api/scan/event", { event_index: head.event_index }, apiKey);

  const [round, account, reward] = detail.params ?? [];
  if (round?.type !== "U32" || account?.type !== "AccountId" || reward?.type !== "U128") {
    throw new Error(
      `${chain.key}: unexpected Rewarded params shape: ${JSON.stringify(detail.params)}`,
    );
  }
  const minerHex = String(account.value);
  return {
    chainKey: chain.key,
    chainName: chain.name,
    subscanWeb: chain.web,
    tokenSymbol: chain.tokenSymbol,
    tokenDecimals: chain.tokenDecimals,
    eraMs: chain.eraMs,
    round: Number(round.value),
    miner: AccountId(chain.ss58Prefix).dec(Binary.fromHex(minerHex).asBytes()),
    minerHex,
    rewardPlanck: String(reward.value),
    blockNum: detail.block_num,
    blockTimestampMs: String(head.block_timestamp * 1000),
    recentTimestampsMs: (list.events ?? []).map((e) => String(e.block_timestamp * 1000)),
    rewardedCount: list.count,
  };
}

export async function readMiners(): Promise<MinersSnapshot | null> {
  if (!existsSync(MINERS_PATH)) return null;
  return JSON.parse(await readFile(MINERS_PATH, "utf8")) as MinersSnapshot;
}

export async function writeMiners(snapshot: MinersSnapshot): Promise<string> {
  await writeFile(MINERS_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  return MINERS_PATH;
}
