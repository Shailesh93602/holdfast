import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool } from "../src/infra/db";
import { migrate } from "../src/infra/migrate";
import {
  setupShardedStock,
  reserveSharded,
  shardedAvailable,
} from "../src/domain/sharded";

const pool = createPool({ max: 24 });

beforeAll(async () => {
  await migrate();
});
afterAll(async () => {
  await pool.end();
});

describe("sharded hot-SKU reservation", () => {
  it("sells every unit across shards (fallback) and never oversells", async () => {
    const sku = "SHARD-A";
    const TOTAL = 50;
    const SHARDS = 8;
    const BUYERS = 300;
    await setupShardedStock(pool, sku, TOTAL, SHARDS);

    const results = await Promise.all(
      Array.from({ length: BUYERS }, () =>
        reserveSharded(pool, sku, 1, SHARDS),
      ),
    );

    const winners = results.filter((r) => r.ok).length;
    const available = await shardedAvailable(pool, sku);

    expect(winners).toBe(TOTAL); // fallback through shards → full utilization
    expect(available).toBe(0);
  });

  it("never oversells when buyers far exceed stock", async () => {
    const sku = "SHARD-B";
    const TOTAL = 20;
    const SHARDS = 4;
    const BUYERS = 200;
    await setupShardedStock(pool, sku, TOTAL, SHARDS);

    const results = await Promise.all(
      Array.from({ length: BUYERS }, () =>
        reserveSharded(pool, sku, 1, SHARDS),
      ),
    );

    expect(results.filter((r) => r.ok).length).toBe(TOTAL);
    expect(await shardedAvailable(pool, sku)).toBe(0);
  });
});
