import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool } from "../src/infra/db";
import { migrate } from "../src/infra/migrate";
import { reserveBasket } from "../src/domain/basket";
import { resetSku, inventoryOf } from "./helpers";

const pool = createPool({ max: 32 });

beforeAll(async () => {
  await migrate();
});
afterAll(async () => {
  await pool.end();
});

describe("basket reservation", () => {
  it("is all-or-nothing: one out-of-stock item rolls back the whole basket", async () => {
    await resetSku(pool, "BK-MILK", 5);
    await resetSku(pool, "BK-EGGS", 0); // out of stock

    const r = await reserveBasket(pool, [
      { sku: "BK-MILK", qty: 2 },
      { sku: "BK-EGGS", qty: 1 },
    ]);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failedSku).toBe("BK-EGGS");
    // Milk must be untouched — the basket failed atomically.
    expect((await inventoryOf(pool, "BK-MILK")).available).toBe(5);
  });

  it("no deadlock when baskets lock overlapping SKUs in OPPOSITE order", async () => {
    await resetSku(pool, "BK-A", 200);
    await resetSku(pool, "BK-B", 200);
    const N = 100;

    // Half the baskets request [A,B], half request [B,A] — the classic deadlock
    // setup. Sorted lock ordering inside reserveBasket must prevent any cycle.
    const tasks = Array.from({ length: N }, (_, i) =>
      reserveBasket(
        pool,
        i % 2 === 0
          ? [
              { sku: "BK-A", qty: 1 },
              { sku: "BK-B", qty: 1 },
            ]
          : [
              { sku: "BK-B", qty: 1 },
              { sku: "BK-A", qty: 1 },
            ],
      ),
    );

    // If a deadlock occurred, Postgres would abort a txn → reserveBasket throws →
    // Promise.all rejects → this test fails. Success proves deadlock-freedom.
    const results = await Promise.all(tasks);

    expect(results.every((r) => r.ok)).toBe(true);
    expect((await inventoryOf(pool, "BK-A")).available).toBe(200 - N);
    expect((await inventoryOf(pool, "BK-B")).available).toBe(200 - N);
  });
});
