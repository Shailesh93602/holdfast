import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool } from "../src/infra/db";
import { migrate } from "../src/infra/migrate";
import { reserve } from "../src/domain/reservation";
import { resetSku, inventoryOf, heldOrderCount } from "./helpers";

const pool = createPool({ max: 32 });

beforeAll(async () => {
  await migrate();
});
afterAll(async () => {
  await pool.end();
});

describe("idempotent placement", () => {
  it("a key retried sequentially reserves exactly once", async () => {
    const sku = "IDEMPO-SEQ";
    await resetSku(pool, sku, 10);

    const first = await reserve(pool, { sku, qty: 1, idempotencyKey: "k1" });
    const second = await reserve(pool, { sku, qty: 1, idempotencyKey: "k1" });

    expect(first.ok && !first.deduped).toBe(true);
    expect(second.ok && second.deduped).toBe(true);
    if (first.ok && second.ok) expect(second.orderId).toBe(first.orderId);

    expect((await inventoryOf(pool, sku)).available).toBe(9); // decremented once
    expect(await heldOrderCount(pool, sku)).toBe(1);
  });

  it("the same key fired 100x CONCURRENTLY still reserves exactly once", async () => {
    const sku = "IDEMPO-RACE";
    await resetSku(pool, sku, 10);

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        reserve(pool, { sku, qty: 1, idempotencyKey: "same-key" }),
      ),
    );

    // Every call "succeeds" (returns the order), but only one actually reserved.
    expect(results.every((r) => r.ok)).toBe(true);
    const orderIds = new Set(results.map((r) => (r.ok ? r.orderId : "x")));
    expect(orderIds.size).toBe(1); // all point at the same order

    expect((await inventoryOf(pool, sku)).available).toBe(9); // decremented ONCE
    expect(await heldOrderCount(pool, sku)).toBe(1);
  });
});
