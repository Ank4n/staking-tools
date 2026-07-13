/**
 * Reconstruction of point-in-time "health" reads at an era's boundary block.
 *
 * Most era-health metrics (election score, nominator/validator counts, min
 * stakes, unbonding totals, all-validator self-stake, the DAP pot balances) are
 * NOT kept as per-era history on-chain — they are live storage that only
 * reflects the moment you query. To attach them to a historical era we:
 *
 *   1. Find that era's FIRST block via Subscan (`/scan/block` by the era's
 *      `ActiveEra.start` timestamp). Sparse: one Subscan call per era.
 *   2. Read state a few blocks BEFORE that block. The DAP general pots drain
 *      into era-specific pots exactly at the transition block, so the full
 *      accumulated inflation is only visible just before. See `BALANCE_OFFSET`.
 *
 * Public Asset Hub RPC retains historical state well past 7 eras; for deeper
 * history point `RPC_PAH` at an archive node (e.g. Dwellir).
 */
import type { TypedApi } from "polkadot-api";
import { AccountId } from "polkadot-api";
import { descriptors } from "../chains/index.js";
import { mapPool, RPC_CONCURRENCY } from "../util/pool.js";
import type {
  EraHealth,
  EraBoundary,
  ElectionScore,
  PotBalances,
  TreasuryBalances,
  UnbondingSummary,
} from "./types.js";

type Api = TypedApi<typeof descriptors>;

/**
 * Blocks subtracted from an era's first block to read pre-drain state. The
 * Subscan timestamp→block mapping isn't exact to the transition block, and the
 * general pots drain AT the transition, so we step back a safe margin to land
 * inside the previous era while the pots still hold the full accumulated value.
 * The pot value is stable across the whole era until drain, so any comfortably-
 * pre-transition block works. Verified against era 2214→2215 on PAH.
 */
export const BALANCE_OFFSET = 10;

/**
 * Derive a PalletId sub-account: `b"modl" ++ palletId(8) ++ SCALE(arg)`,
 * zero-padded to 32 bytes. `palletId` must be 8 ASCII bytes; `argBytes` is the
 * SCALE encoding of the sub-account argument (empty for `into_account`).
 */
function palletSubAccount(palletId: string, argBytes: number[]): Uint8Array {
  const enc = new TextEncoder();
  const modl = enc.encode("modl");
  const pid = enc.encode(palletId);
  if (pid.length !== 8) throw new Error(`palletId must be 8 bytes: "${palletId}"`);
  const out = new Uint8Array(32);
  out.set(modl, 0);
  out.set(pid, 4);
  out.set(new Uint8Array(argBytes), 12);
  return out;
}

/**
 * The three DAP issuance pots on Asset Hub, as SS58 addresses for `ss58Prefix`.
 *  - staker rewards general pot: `py/stkng` + RewardPot::General(StakerRewards)
 *  - validator incentive general pot: `py/stkng` + General(ValidatorSelfStake)
 *  - DAP buffer: `dap/buff` + into_account() (empty arg)
 * SCALE: RewardPot::General = index 0; RewardKind::StakerRewards = 0,
 * ValidatorSelfStake = 1.
 */
export function potAccounts(ss58Prefix: number): {
  buffer: string;
  stakerReward: string;
  validatorIncentive: string;
} {
  const codec = AccountId(ss58Prefix);
  return {
    stakerReward: codec.dec(palletSubAccount("py/stkng", [0x00, 0x00])),
    validatorIncentive: codec.dec(palletSubAccount("py/stkng", [0x00, 0x01])),
    buffer: codec.dec(palletSubAccount("dap/buff", [])),
  };
}

/**
 * The treasury: the `py/trsry` PalletId account (`into_account_truncating`,
 * empty arg). On PAH this is 13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB
 * (verified against live balances: ~24M DOT + USDT/USDC holdings).
 */
export function treasuryAccount(ss58Prefix: number): string {
  return AccountId(ss58Prefix).dec(palletSubAccount("py/trsry", []));
}

/** Asset Hub asset IDs for the stablecoins the treasury holds. */
export const ASSET_IDS = { usdt: 1984, usdc: 1337 } as const;

/** Subscan endpoint host per chain key. */
function subscanBase(chainKey: string): string {
  switch (chainKey) {
    case "pah":
      return "https://assethub-polkadot.api.subscan.io";
    case "wah":
      return "https://assethub-westend.api.subscan.io";
    default:
      throw new Error(`No Subscan endpoint for chain "${chainKey}"`);
  }
}

/**
 * Find the block at (or just after) a given epoch-ms timestamp via Subscan.
 * Returns the block number Subscan reports for that timestamp. One API call.
 */
export async function subscanBlockAtTimestamp(
  chainKey: string,
  timestampMs: string,
  apiKey: string,
): Promise<number> {
  const seconds = Math.floor(Number(timestampMs) / 1000);
  const res = await fetch(`${subscanBase(chainKey)}/api/scan/block`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({ block_timestamp: seconds, only_head: false }),
  });
  const json = (await res.json()) as {
    code: number;
    message: string;
    data?: { block_num?: number };
  };
  if (json.code !== 0 || json.data?.block_num == null) {
    throw new Error(`Subscan /scan/block failed: code=${json.code} msg=${json.message}`);
  }
  return json.data.block_num;
}

function score(raw: {
  minimal_stake: bigint;
  sum_stake: bigint;
  sum_stake_squared: bigint;
} | null | undefined): ElectionScore | null {
  if (!raw) return null;
  return {
    minimalStake: raw.minimal_stake.toString(),
    sumStake: raw.sum_stake.toString(),
    sumStakeSquared: raw.sum_stake_squared.toString(),
  };
}

/** Low-level JSON-RPC passthrough, as provided by the snapshot connection. */
export type RpcRequest = <Reply = unknown>(
  method: string,
  params: unknown[],
) => Promise<Reply>;

/** Block-hash lookup via the substrate `chain_getBlockHash` RPC. */
async function blockHash(request: RpcRequest, block: number): Promise<string> {
  return request<string>("chain_getBlockHash", [block]);
}

/**
 * Read every health metric at `balanceBlock` (= boundary block - offset).
 * Iterates all `Validators` keys for self-stake and all `Ledger` entries for
 * unbonding — heavier reads, but bounded to one historical block per era.
 */
export async function reconstructEraHealth(
  api: Api,
  request: RpcRequest,
  chainKey: string,
  ss58Prefix: number,
  eraStartMs: string,
  subscanApiKey: string,
): Promise<EraHealth> {
  const boundaryBlock = await subscanBlockAtTimestamp(chainKey, eraStartMs, subscanApiKey);
  const balanceBlock = boundaryBlock - BALANCE_OFFSET;

  const [boundaryHash, balanceHash] = await Promise.all([
    blockHash(request, boundaryBlock),
    blockHash(request, balanceBlock),
  ]);
  const at = { at: balanceHash } as const;

  const observed = await api.query.Staking.ActiveEra.getValue(at);

  // Election (live storage at the boundary).
  const [electionRound, minimumScore, queuedScore] = await Promise.all([
    api.query.MultiBlockElection.Round.getValue(at).catch(() => null),
    api.query.MultiBlockElectionVerifier.MinimumScore.getValue(at).catch(() => null),
    // QueuedSolutionScore is keyed by page; page 0 holds the final score.
    api.query.MultiBlockElectionVerifier.QueuedSolutionScore.getValue(0, at).catch(
      () => null,
    ),
  ]);

  // Staking counters + min bonds.
  const [
    nominatorCount,
    validatorCount,
    minimumActiveStake,
    minNominatorBond,
    minValidatorBond,
  ] = await Promise.all([
    api.query.Staking.CounterForNominators.getValue(at),
    api.query.Staking.CounterForValidators.getValue(at),
    api.query.Staking.MinimumActiveStake.getValue(at),
    api.query.Staking.MinNominatorBond.getValue(at),
    api.query.Staking.MinValidatorBond.getValue(at),
  ]);

  // All registered validators' self-stake: enumerate Validators keys, read each
  // stash's Ledger.active. (Bonded maps stash->controller; in staking-async the
  // ledger is keyed by the stash itself.)
  const validatorEntries = await api.query.Staking.Validators.getEntries(at);
  const validatorStashes = validatorEntries.map((e) => e.keyArgs[0] as string);
  const allValidatorOwnStakes = await readOwnStakes(api, validatorStashes, balanceHash);

  // Unbonding across all ledgers.
  const unbonding = await readUnbonding(api, balanceHash);

  // DAP pot + treasury balances (independent reads at the same block).
  const [pots, treasury] = await Promise.all([
    readPotBalances(api, ss58Prefix, balanceHash),
    readTreasuryBalances(api, ss58Prefix, balanceHash),
  ]);

  const boundary: EraBoundary = {
    block: boundaryBlock,
    hash: boundaryHash,
    offset: BALANCE_OFFSET,
    balanceBlock,
    balanceHash,
    observedEra: observed?.index ?? null,
  };

  return {
    boundary,
    electionRound: electionRound ?? null,
    minimumScore: score(minimumScore),
    queuedSolutionScore: score(queuedScore),
    nominatorCount,
    validatorCount,
    minimumActiveStake: minimumActiveStake.toString(),
    minNominatorBond: minNominatorBond.toString(),
    minValidatorBond: minValidatorBond.toString(),
    unbonding,
    allValidatorOwnStakes,
    pots,
    treasury,
  };
}

async function readOwnStakes(
  api: Api,
  stashes: string[],
  hash: string,
): Promise<string[]> {
  const at = { at: hash } as const;
  const stakes = await mapPool(stashes, RPC_CONCURRENCY, async (stash) => {
    const ledger = await api.query.Staking.Ledger.getValue(stash, at);
    return (ledger?.active ?? 0n).toString();
  });
  return stakes;
}

async function readUnbonding(api: Api, hash: string): Promise<UnbondingSummary> {
  const at = { at: hash } as const;
  const entries = await api.query.Staking.Ledger.getEntries(at);
  let ledgerCount = 0;
  let chunkCount = 0;
  let total = 0n;
  for (const e of entries) {
    const unlocking = e.value?.unlocking ?? [];
    if (unlocking.length === 0) continue;
    ledgerCount++;
    for (const chunk of unlocking) {
      chunkCount++;
      total += chunk.value;
    }
  }
  return { ledgerCount, chunkCount, totalValue: total.toString() };
}

async function readPotBalances(
  api: Api,
  ss58Prefix: number,
  hash: string,
): Promise<PotBalances> {
  const at = { at: hash } as const;
  const accts = potAccounts(ss58Prefix);
  const [buffer, stakerReward, validatorIncentive] = await Promise.all([
    api.query.System.Account.getValue(accts.buffer, at),
    api.query.System.Account.getValue(accts.stakerReward, at),
    api.query.System.Account.getValue(accts.validatorIncentive, at),
  ]);
  return {
    buffer: buffer.data.free.toString(),
    stakerReward: stakerReward.data.free.toString(),
    validatorIncentive: validatorIncentive.data.free.toString(),
  };
}

async function readTreasuryBalances(
  api: Api,
  ss58Prefix: number,
  hash: string,
): Promise<TreasuryBalances> {
  const at = { at: hash } as const;
  const treasury = treasuryAccount(ss58Prefix);
  const [acct, usdt, usdc] = await Promise.all([
    api.query.System.Account.getValue(treasury, at),
    api.query.Assets.Account.getValue(ASSET_IDS.usdt, treasury, at),
    api.query.Assets.Account.getValue(ASSET_IDS.usdc, treasury, at),
  ]);
  return {
    dot: acct.data.free.toString(),
    usdt: (usdt?.balance ?? 0n).toString(),
    usdc: (usdc?.balance ?? 0n).toString(),
  };
}
