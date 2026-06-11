import { Pool, type PoolConfig } from "pg";

export const CONNECTION_STRING =
  process.env.DATABASE_URL ?? "postgresql://localhost:5432/quickcommerce";

/**
 * Create a connection pool. `max` matters for the concurrency tests/benchmarks:
 * to actually contend on a hot row we need many *real* server connections, not
 * requests queued behind a tiny pool.
 */
export function createPool(overrides: PoolConfig = {}): Pool {
  return new Pool({
    connectionString: CONNECTION_STRING,
    max: Number(process.env.PG_POOL_MAX ?? 24),
    ...overrides,
  });
}
