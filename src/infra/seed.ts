import type { Pool } from "pg";
import { createPool } from "./db";

/** Set a SKU to a known stock level and clear its orders. Shared by seed + bench. */
export async function setStock(
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

// `npm run seed` — a tiny demo catalog.
if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool({ max: 2 });
  Promise.all([
    setStock(pool, "MILK-1L", 100),
    setStock(pool, "EGGS-12", 50),
    setStock(pool, "BREAD-400G", 25),
  ])
    .then(() => console.log("✓ seeded demo SKUs: MILK-1L, EGGS-12, BREAD-400G"))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => pool.end());
}
