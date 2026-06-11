import type { Pool } from "pg";

/** Reset a SKU to a known stock level and clear its orders — test isolation. */
export async function resetSku(
  pool: Pool,
  sku: string,
  available: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO products (sku, name) VALUES ($1, $1)
     ON CONFLICT (sku) DO NOTHING`,
    [sku],
  );
  await pool.query(`DELETE FROM orders WHERE sku = $1`, [sku]);
  await pool.query(
    `INSERT INTO inventory (sku, available, reserved, version)
     VALUES ($1, $2, 0, 0)
     ON CONFLICT (sku) DO UPDATE
       SET available = EXCLUDED.available, reserved = 0, version = 0`,
    [sku, available],
  );
}

export async function inventoryOf(
  pool: Pool,
  sku: string,
): Promise<{ available: number; reserved: number }> {
  const r = await pool.query<{ available: number; reserved: number }>(
    `SELECT available, reserved FROM inventory WHERE sku = $1`,
    [sku],
  );
  return r.rows[0]!;
}

export async function heldOrderCount(pool: Pool, sku: string): Promise<number> {
  const r = await pool.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM orders WHERE sku = $1 AND status = 'HELD'`,
    [sku],
  );
  return r.rows[0]!.c;
}
