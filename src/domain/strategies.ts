import type { PoolClient } from "pg";
import type { DecrementResult, Strategy } from "./types";

/**
 * Three ways to decrement inventory safely under concurrency. Each runs inside
 * an already-open transaction (the caller owns BEGIN/COMMIT) and must guarantee
 * `available` never goes negative no matter how many callers race.
 *
 * Trade-offs (the whole point of the project — benchmarked in test/benchmark):
 *   atomic      — one conditional UPDATE. No app-side read, no held lock window.
 *                 Highest throughput; the default.
 *   pessimistic — SELECT ... FOR UPDATE then UPDATE. Serializes the hot row;
 *                 simple to reason about; lock contention is the cost.
 *   optimistic  — read version, compare-and-swap, retry on miss. No lock held
 *                 across the read; great when contention is low, retry-heavy
 *                 when it's high.
 */

const MAX_OPTIMISTIC_RETRIES = 20;

/** atomic conditional decrement — the WHERE clause is the guard. */
export async function decrementAtomic(
  client: PoolClient,
  sku: string,
  qty: number,
): Promise<DecrementResult> {
  const res = await client.query<{ available: number }>(
    `UPDATE inventory
        SET available = available - $2,
            reserved  = reserved + $2,
            version   = version + 1
      WHERE sku = $1 AND available >= $2
      RETURNING available`,
    [sku, qty],
  );
  if (res.rowCount === 1) {
    return { ok: true, remaining: res.rows[0]!.available };
  }
  // Either the row doesn't exist or there wasn't enough stock. Disambiguate.
  return classifyMiss(client, sku);
}

/** pessimistic lock — take the row lock, then decrement. */
export async function decrementPessimistic(
  client: PoolClient,
  sku: string,
  qty: number,
): Promise<DecrementResult> {
  const locked = await client.query<{ available: number }>(
    `SELECT available FROM inventory WHERE sku = $1 FOR UPDATE`,
    [sku],
  );
  if (locked.rowCount === 0) return { ok: false, reason: "NOT_FOUND" };
  if (locked.rows[0]!.available < qty) {
    return { ok: false, reason: "INSUFFICIENT_STOCK" };
  }
  const upd = await client.query<{ available: number }>(
    `UPDATE inventory
        SET available = available - $2,
            reserved  = reserved + $2,
            version   = version + 1
      WHERE sku = $1
      RETURNING available`,
    [sku, qty],
  );
  return { ok: true, remaining: upd.rows[0]!.available };
}

/** optimistic compare-and-swap — retry until the version we read still holds. */
export async function decrementOptimistic(
  client: PoolClient,
  sku: string,
  qty: number,
): Promise<DecrementResult> {
  for (let attempt = 1; attempt <= MAX_OPTIMISTIC_RETRIES; attempt++) {
    const read = await client.query<{ available: number; version: number }>(
      `SELECT available, version FROM inventory WHERE sku = $1`,
      [sku],
    );
    if (read.rowCount === 0) return { ok: false, reason: "NOT_FOUND" };
    const { available, version } = read.rows[0]!;
    if (available < qty) return { ok: false, reason: "INSUFFICIENT_STOCK" };

    const swap = await client.query<{ available: number }>(
      `UPDATE inventory
          SET available = available - $2,
              reserved  = reserved + $2,
              version   = version + 1
        WHERE sku = $1 AND version = $3 AND available >= $2
        RETURNING available`,
      [sku, qty, version],
    );
    if (swap.rowCount === 1) {
      return { ok: true, remaining: swap.rows[0]!.available, attempts: attempt };
    }
    // Lost the race (version moved). Loop re-reads the freshly committed row.
  }
  return { ok: false, reason: "RETRY_EXHAUSTED" };
}

async function classifyMiss(
  client: PoolClient,
  sku: string,
): Promise<DecrementResult> {
  const exists = await client.query(
    `SELECT 1 FROM inventory WHERE sku = $1`,
    [sku],
  );
  return {
    ok: false,
    reason: exists.rowCount === 0 ? "NOT_FOUND" : "INSUFFICIENT_STOCK",
  };
}

export function decrementFor(strategy: Strategy) {
  switch (strategy) {
    case "atomic":
      return decrementAtomic;
    case "pessimistic":
      return decrementPessimistic;
    case "optimistic":
      return decrementOptimistic;
  }
}
