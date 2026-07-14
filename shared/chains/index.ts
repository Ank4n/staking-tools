import { wah, pah } from "@polkadot-api/descriptors";

/**
 * Supported chains. Both run the `staking-async` + `dap` pallets in DAP
 * (non-minting) mode. Each chain has its own PAPI descriptor set (`wah`, `pah`),
 * generated from that chain's metadata. The staking-async + dap storage shapes
 * are identical across both, so the snapshot/APY code uses the `wah` descriptor
 * for compile-time types and connects with the chain's own descriptor at runtime
 * (see `descriptorFor`). If the chains' metadata diverge in a way that affects
 * the fields we read, split the typed code path.
 */
export interface ChainConfig {
  /** Short key used for CLI args and the output directory name. */
  readonly key: string;
  /** Human-readable chain name. */
  readonly name: string;
  /** WebSocket RPC endpoint. Override via env (see `resolveEndpoint`). */
  readonly endpoint: string;
  /** Token symbol, for display/units in the snapshot. */
  readonly tokenSymbol: string;
  /** Token decimals (planck -> token divisor is 10^decimals). */
  readonly tokenDecimals: number;
  /** SS58 prefix, recorded in snapshots for address interpretation. */
  readonly ss58Prefix: number;
  /**
   * Per-chain data floor: embeds must not include eras below this. PAH data
   * before era 2220 is not correct (early Ref-1909 rollout; pre-1909 eras
   * also lack the incentive curve entirely). 0 = no floor.
   */
  readonly dataFloorEra: number;
  /**
   * WSS endpoint baked into pages that connect from the visitor's browser
   * (the Balances app). May differ from `endpoint` (used by the snapshot
   * CLIs): Dwellir is preferred for browser traffic.
   */
  readonly browserEndpoint: string;
  /** Subscan web UI base (NOT the API host — see `subscanBase` in health.ts). */
  readonly subscanWeb: string;
}

export const CHAINS = {
  wah: {
    key: "wah",
    name: "Westend Asset Hub",
    endpoint: "wss://westend-asset-hub-rpc.polkadot.io",
    tokenSymbol: "WND",
    tokenDecimals: 12,
    ss58Prefix: 42,
    dataFloorEra: 0,
    browserEndpoint: "wss://asset-hub-westend-rpc.n.dwellir.com",
    subscanWeb: "https://assethub-westend.subscan.io",
  },
  pah: {
    key: "pah",
    name: "Polkadot Asset Hub",
    endpoint: "wss://asset-hub-polkadot-rpc.n.dwellir.com",
    tokenSymbol: "DOT",
    tokenDecimals: 10,
    ss58Prefix: 0,
    dataFloorEra: 2220,
    browserEndpoint: "wss://asset-hub-polkadot-rpc.n.dwellir.com",
    subscanWeb: "https://assethub-polkadot.subscan.io",
  },
} as const satisfies Record<string, ChainConfig>;

export type ChainKey = keyof typeof CHAINS;

/**
 * The typed PAPI descriptors used for compile-time types. Both chains share an
 * identical staking-async + dap storage shape, so one descriptor types the code.
 */
export const descriptors = wah;

/** Runtime descriptor set for a given chain (used at `getTypedApi`). */
export function descriptorFor(key: string): typeof wah {
  switch (key) {
    case "wah":
      return wah;
    case "pah":
      // Same storage shape as `wah`; cast keeps a single typed code path.
      return pah as unknown as typeof wah;
    default:
      throw new Error(`No descriptor for chain "${key}"`);
  }
}

/**
 * Resolve the endpoint, allowing an env override so ops can point at a private
 * / archive node without code changes. Env var: `RPC_<KEY>` (e.g. `RPC_WAH`).
 */
export function resolveEndpoint(chain: ChainConfig): string {
  const override = process.env[`RPC_${chain.key.toUpperCase()}`];
  return override?.trim() || chain.endpoint;
}

export function getChain(key: string): ChainConfig {
  const chain = (CHAINS as Record<string, ChainConfig>)[key];
  if (!chain) {
    const valid = Object.keys(CHAINS).join(", ");
    throw new Error(`Unknown chain "${key}". Valid chains: ${valid}`);
  }
  return chain;
}
