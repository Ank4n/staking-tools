import { createClient, type TypedApi } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import {
  descriptors,
  descriptorFor,
  resolveEndpoint,
  type ChainConfig,
} from "../chains/index.js";
import type {
  ChainMeta,
  EraSnapshot,
  IncentiveParams,
  DapParams,
  Perbill,
  ValidatorEra,
  NominatorExposure,
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

type Api = TypedApi<typeof descriptors>;

const PERBILL_DENOM = 1_000_000_000;

/** Max simultaneous per-validator RPC requests against a single node. */
const RPC_CONCURRENCY = 12;

function perbill(raw: number): Perbill {
  return { raw, fraction: raw / PERBILL_DENOM };
}

/**
 * Map `fn` over `items` with at most `concurrency` promises in flight at once,
 * preserving input order in the result. Keeps a busy node saturated without
 * firing hundreds of requests simultaneously.
 */
async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    worker,
  );
  await Promise.all(workers);
  return results;
}

/** Decode a BudgetKey Binary to a readable label: utf8 if printable, else hex. */
function decodeBudgetKey(bin: { asBytes(): Uint8Array; asHex(): string }): string {
  const bytes = bin.asBytes();
  // Keys are short ASCII identifiers padded with zeros (e.g. b"stkrwd\0\0").
  const trimmed = bytes.filter((b) => b !== 0);
  const printable = trimmed.length > 0 && trimmed.every((b) => b >= 0x20 && b < 0x7f);
  if (printable) return new TextDecoder().decode(trimmed);
  return bin.asHex();
}

export interface SnapshotConnection {
  api: Api;
  meta: ChainMeta;
  destroy: () => void;
}

/** Connect to a chain and build its self-describing metadata block. */
export async function connect(chain: ChainConfig): Promise<SnapshotConnection> {
  const endpoint = resolveEndpoint(chain);
  const client = createClient(getWsProvider(endpoint));
  const api = client.getTypedApi(descriptorFor(chain.key));

  const spec = await client.getChainSpecData();

  const meta: ChainMeta = {
    schemaVersion: SCHEMA_VERSION,
    chainKey: chain.key,
    chainName: chain.name,
    genesisHash: spec.genesisHash,
    tokenSymbol: chain.tokenSymbol,
    tokenDecimals: chain.tokenDecimals,
    ss58Prefix: chain.ss58Prefix,
  };

  return { api, meta, destroy: () => client.destroy() };
}

/** Chain-wide state that doesn't vary per era (captured at snapshot time). */
export interface ChainState {
  currentEra: number | null;
  activeEra: number | null;
  activeEraStartMs: string | null;
  historyDepth: number;
  sessionsPerEra: number;
  /** Estimated era duration in ms used for annualization. */
  eraDurationMs: string;
  incentiveParams: IncentiveParams;
  dapParams: DapParams;
}

/**
 * Estimate era duration in ms for annualization.
 *
 * staking-async configures a `MaxEraDuration` ceiling, and rewards are computed
 * against the actual era duration. Era length = SessionsPerEra × session length.
 * On Asset Hub the session length is driven by the relay chain at a fixed 4h, so
 * era = SessionsPerEra × 4h (= 24h with the current SessionsPerEra = 6). NOTE:
 * do NOT use `MaxEraDuration` here — that is only a safety *cap* on era length,
 * not the actual duration (e.g. it's 36h on PAH while real eras run 24h).
 */
const RC_SESSION_MS = 4n * 60n * 60n * 1000n; // relay-chain session: 4 hours

function estimateEraDurationMs(sessionsPerEra: number): bigint {
  return BigInt(sessionsPerEra) * RC_SESSION_MS;
}

export async function readChainState(api: Api): Promise<ChainState> {
  const [
    currentEra,
    activeEra,
    historyDepth,
    sessionsPerEra,
    optimum,
    hardCap,
    slope,
    cadence,
    maxElapsed,
    lastIssuance,
    budgetAlloc,
  ] = await Promise.all([
    api.query.Staking.CurrentEra.getValue(),
    api.query.Staking.ActiveEra.getValue(),
    api.constants.Staking.HistoryDepth(),
    api.constants.Staking.SessionsPerEra(),
    api.query.Staking.OptimumSelfStake.getValue(),
    api.query.Staking.HardCapSelfStake.getValue(),
    api.query.Staking.SelfStakeSlopeFactor.getValue(),
    api.constants.Dap.IssuanceCadence(),
    api.constants.Dap.MaxElapsedPerDrip(),
    api.query.Dap.LastIssuanceTimestamp.getValue(),
    api.query.Dap.BudgetAllocation.getValue(),
  ]);

  const budgetAllocation: Record<string, Perbill> = {};
  for (const [key, raw] of budgetAlloc) {
    budgetAllocation[decodeBudgetKey(key)] = perbill(raw);
  }

  const incentiveParams: IncentiveParams = {
    optimumSelfStake: optimum.toString(),
    hardCapSelfStake: hardCap.toString(),
    selfStakeSlopeFactor: perbill(slope),
  };

  const dapParams: DapParams = {
    budgetAllocation,
    issuanceCadenceMs: cadence.toString(),
    maxElapsedPerDripMs: maxElapsed.toString(),
    lastIssuanceTimestampMs: lastIssuance.toString(),
  };

  const eraDurationMs = estimateEraDurationMs(sessionsPerEra);

  return {
    currentEra: currentEra ?? null,
    activeEra: activeEra?.index ?? null,
    activeEraStartMs: activeEra?.start != null ? activeEra.start.toString() : null,
    historyDepth,
    sessionsPerEra,
    eraDurationMs: eraDurationMs.toString(),
    incentiveParams,
    dapParams,
  };
}

export interface ReadEraOptions {
  /** Include per-nominator exposure (heavier). Default false. */
  includeNominators?: boolean;
}

/** Read the full per-era snapshot for one era. */
export async function readEraSnapshot(
  api: Api,
  meta: ChainMeta,
  state: ChainState,
  era: number,
  capturedAtMs: string,
  opts: ReadEraOptions = {},
): Promise<EraSnapshot> {
  const [
    totalStakerReward,
    incentiveBudget,
    rewardPoints,
    totalStake,
    sumIncentiveWeight,
    overviewEntries,
  ] = await Promise.all([
    api.query.Staking.ErasValidatorReward.getValue(era),
    api.query.Staking.ErasValidatorIncentiveBudget.getValue(era),
    api.query.Staking.ErasRewardPoints.getValue(era),
    api.query.Staking.ErasTotalStake.getValue(era),
    api.query.Staking.ErasSumValidatorIncentiveWeight.getValue(era),
    // Enumerate all validators for the era via the overview double-map.
    api.query.Staking.ErasStakersOverview.getEntries(era),
  ]);

  // Build a points lookup: individual is Array<[address, points]>.
  const pointsByValidator = new Map<string, number>();
  for (const [addr, pts] of rewardPoints.individual) {
    pointsByValidator.set(addr, pts);
  }

  // Fetch each validator's prefs + incentive weight (+ pages if requested).
  // Run with bounded concurrency: a chain may have hundreds of validators, so
  // awaiting them one at a time serializes hundreds of RPC round-trips, but
  // firing them all at once would overwhelm a public node. The pool keeps the
  // node busy without flooding it.
  const validators = await mapPool(overviewEntries, RPC_CONCURRENCY, async (entry) => {
    // Double-map entry keys: [era, validatorAddress].
    const address = entry.keyArgs[1] as string;
    const overview = entry.value;

    const [prefs, incentiveWeight] = await Promise.all([
      api.query.Staking.ErasValidatorPrefs.getValue(era, address),
      api.query.Staking.ErasValidatorIncentiveWeight.getValue(era, address),
    ]);

    const nominators: NominatorExposure[] = [];
    if (opts.includeNominators && overview.page_count > 0) {
      const pages = await Promise.all(
        Array.from({ length: overview.page_count }, (_, page) =>
          api.query.Staking.ErasStakersPaged.getValue(era, address, page),
        ),
      );
      for (const page of pages) {
        if (!page) continue;
        for (const other of page.others) {
          nominators.push({ who: other.who, value: other.value.toString() });
        }
      }
    }

    return {
      address,
      totalStake: overview.total.toString(),
      ownStake: overview.own.toString(),
      nominatorCount: overview.nominator_count,
      pageCount: overview.page_count,
      commission: perbill(prefs.commission),
      blocked: prefs.blocked,
      rewardPoints: pointsByValidator.get(address) ?? 0,
      incentiveWeight: incentiveWeight != null ? incentiveWeight.toString() : null,
      nominators,
    } satisfies ValidatorEra;
  });

  // Stable ordering by descending total stake for human readability.
  validators.sort((a, b) => {
    const d = BigInt(b.totalStake) - BigInt(a.totalStake);
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  });

  return {
    chain: meta,
    era,
    capturedAtMs,
    activeEraStartMs: state.activeEraStartMs,
    eraDurationMs: state.eraDurationMs,
    sessionsPerEra: state.sessionsPerEra,
    historyDepth: state.historyDepth,
    totalStakerReward: (totalStakerReward ?? 0n).toString(),
    validatorIncentiveBudget: incentiveBudget.toString(),
    totalRewardPoints: rewardPoints.total,
    totalStake: totalStake.toString(),
    sumIncentiveWeight: sumIncentiveWeight.toString(),
    incentiveParams: state.incentiveParams,
    dapParams: state.dapParams,
    validators,
  };
}
