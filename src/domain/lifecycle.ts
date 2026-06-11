import type { Pool } from "pg";

/**
 * Reservation lifecycle: HELD → CONFIRMED (kept) or → RELEASED (stock returned).
 * A HELD order has decremented `available` and bumped `reserved`. Confirming
 * leaves the ledger as-is (the unit is sold); releasing/expiring gives it back.
 */

export async function confirmOrder(
  pool: Pool,
  orderId: string,
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE orders SET status = 'CONFIRMED'
      WHERE id = $1 AND status = 'HELD'`,
    [orderId],
  );
  return (r.rowCount ?? 0) === 1;
}

/**
 * Release every HELD order past its TTL, returning its stock to `available`.
 * `FOR UPDATE SKIP LOCKED` lets multiple sweepers (or a sweeper racing a
 * confirm) run without blocking each other. Returns how many were released.
 */
export async function sweepExpired(pool: Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const expired = await client.query<{ id: string; sku: string; qty: number }>(
      `SELECT id, sku, qty FROM orders
        WHERE status = 'HELD' AND expires_at < now()
        FOR UPDATE SKIP LOCKED`,
    );
    for (const row of expired.rows) {
      await client.query(
        `UPDATE inventory
            SET available = available + $2,
                reserved  = reserved - $2,
                version   = version + 1
          WHERE sku = $1`,
        [row.sku, row.qty],
      );
      await client.query(`UPDATE orders SET status = 'RELEASED' WHERE id = $1`, [
        row.id,
      ]);
    }
    await client.query("COMMIT");
    return expired.rowCount ?? 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
