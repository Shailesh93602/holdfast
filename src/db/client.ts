import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "./schema";

/**
 * Typed Drizzle client over an existing pg pool. Used for ordinary reads/writes
 * where type-safety beats raw strings; the reservation hot path stays on raw SQL
 * (src/domain/strategies.ts) where explicit locking matters.
 */
export function makeDrizzle(pool: Pool) {
  return drizzle(pool, { schema });
}

export type DB = ReturnType<typeof makeDrizzle>;
