/**
 * Bounded-concurrency helpers shared across the RPC-heavy CLIs.
 *
 * A chain may have hundreds of validators/ledgers. Awaiting them one at a time
 * serializes hundreds of RPC round-trips; firing them all at once overwhelms a
 * public node. `mapPool` keeps a node busy without flooding it.
 */

/** Max simultaneous per-item RPC requests against a single node. */
export const RPC_CONCURRENCY = 12;

/**
 * Map `fn` over `items` with at most `concurrency` promises in flight at once,
 * preserving input order in the result.
 */
export async function mapPool<T, R>(
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
