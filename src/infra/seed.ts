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

/** Demo catalog. LOADTEST has huge stock so load demos don't deplete real SKUs. */
export const DEMO_CATALOG: Array<[string, number]> = [
  ["MILK-1L", 100],
  ["EGGS-12", 50],
  ["BREAD-400G", 25],
  ["LOADTEST", 1_000_000],
];

export async function seedDemoCatalog(pool: Pool): Promise<void> {
  for (const [sku, qty] of DEMO_CATALOG) await setStock(pool, sku, qty);
}

/**
 * Seed the demo catalog only if it's empty. Lets hosted deploys self-seed on
 * first boot (no shell needed) without clobbering data on every restart.
 * Returns true if it seeded.
 */
export async function seedDemoIfEmpty(pool: Pool): Promise<boolean> {
  const r = await pool.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM products`,
  );
  if ((r.rows[0]?.c ?? 0) > 0) return false;
  await seedDemoCatalog(pool);
  return true;
}

// `npm run seed` — force-seed the demo catalog.
if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool({ max: 2 });
  seedDemoCatalog(pool)
    .then(() => console.log(`✓ seeded: ${DEMO_CATALOG.map(([s]) => s).join(", ")}`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => pool.end());
}
