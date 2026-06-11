import { Pool, type PoolConfig } from "pg";

export const CONNECTION_STRING =
  process.env.DATABASE_URL ?? "postgresql://localhost:5432/holdfast";

/**
 * Create a connection pool. `max` matters for the concurrency tests/benchmarks:
 * to actually contend on a hot row we need many *real* server connections, not
 * requests queued behind a tiny pool.
 */
export function createPool(overrides: PoolConfig = {}): Pool {
  const pool = new Pool({
    connectionString: CONNECTION_STRING,
    max: Number(process.env.PG_POOL_MAX ?? 24),
    ...overrides,
  });
  // A dropped backend (failover / kill mid-transaction) must not crash the
  // process. The in-flight query already rejects to its caller; these handlers
  // just swallow the connection-teardown signal. Attached once per physical
  // client (via 'connect'), not per checkout, to avoid listener accumulation.
  pool.on("error", () => {});
  pool.on("connect", (client) => client.on("error", () => {}));
  return pool;
}
