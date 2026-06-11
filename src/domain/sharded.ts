import type { Pool } from "pg";
import { randomInt } from "node:crypto";

/**
 * Sharded hot-SKU reservation — the answer to single-row write contention.
 *
 * A hot SKU's stock is split across N shard rows. A reservation hits a RANDOM
 * shard with an atomic conditional decrement; if that shard is empty it falls
 * back through the others. Concurrent buyers therefore contend on N different
 * row locks instead of one, so throughput scales with shard count (see the
 * benchmark in src/sharded-bench.ts). Aggregate correctness is unchanged: total
 * stock = sum of shards, and no shard (so no SKU) can go negative.
 */

/** (Re)create N shards for a SKU, distributing `total` as evenly as possible. */
export async function setupShardedStock(
  pool: Pool,
  sku: string,
  total: number,
  shards: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO products (sku, name) VALUES ($1, $1) ON CONFLICT (sku) DO NOTHING`,
    [sku],
  );
  await pool.query(`DELETE FROM inventory_shards WHERE sku = $1`, [sku]);
  const base = Math.floor(total / shards);
  let remainder = total - base * shards;
  for (let s = 0; s < shards; s++) {
    const amount = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    await pool.query(
      `INSERT INTO inventory_shards (sku, shard, available) VALUES ($1, $2, $3)`,
      [sku, s, amount],
    );
  }
}

/**
 * Reserve `qty` from a sharded SKU. Tries a random shard first, then the rest —
 * so a buyer only fails when EVERY shard is empty (i.e. genuinely out of stock).
 */
export async function reserveSharded(
  pool: Pool,
  sku: string,
  qty: number,
  shards: number,
): Promise<{ ok: true; shard: number } | { ok: false }> {
  const start = randomInt(0, shards);
  const client = await pool.connect();
  try {
    for (let i = 0; i < shards; i++) {
      const shard = (start + i) % shards;
      const r = await client.query(
        `UPDATE inventory_shards
            SET available = available - $3
          WHERE sku = $1 AND shard = $2 AND available >= $3`,
        [sku, shard, qty],
      );
      if (r.rowCount === 1) return { ok: true, shard };
    }
    return { ok: false };
  } finally {
    client.release();
  }
}

/** Total available across all shards of a SKU. */
export async function shardedAvailable(
  pool: Pool,
  sku: string,
): Promise<number> {
  const r = await pool.query<{ total: number }>(
    `SELECT COALESCE(SUM(available), 0)::int AS total
       FROM inventory_shards WHERE sku = $1`,
    [sku],
  );
  return r.rows[0]?.total ?? 0;
}
