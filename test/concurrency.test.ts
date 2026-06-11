import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool } from "../src/infra/db";
import { migrate } from "../src/infra/migrate";
import { reserve } from "../src/domain/reservation";
import { STRATEGIES } from "../src/domain/types";
import { resetSku, inventoryOf, heldOrderCount } from "./helpers";

const pool = createPool({ max: 32 });

beforeAll(async () => {
  await migrate();
});
afterAll(async () => {
  await pool.end();
});

/**
 * THE headline guarantee: under a thundering herd, inventory is NEVER oversold.
 * 500 buyers race for STOCK units; at most STOCK win, available never goes
 * negative, reserved exactly equals the winners, and there's one order per win.
 */
describe.each(STRATEGIES)("never oversells under contention [%s]", (strategy) => {
  it("at most STOCK winners; no negative stock; ledger consistent", async () => {
    const sku = `HERD-${strategy}`;
    const STOCK = 50;
    const BUYERS = 500;
    await resetSku(pool, sku, STOCK);

    const results = await Promise.all(
      Array.from({ length: BUYERS }, (_, i) =>
        reserve(pool, {
          sku,
          qty: 1,
          strategy,
          idempotencyKey: `${sku}-buyer-${i}`,
        }),
      ),
    );

    const winners = results.filter((r) => r.ok).length;
    const inv = await inventoryOf(pool, sku);
    const orders = await heldOrderCount(pool, sku);

    // The invariants that must ALWAYS hold, for every strategy:
    expect(winners).toBeLessThanOrEqual(STOCK); // never oversell
    expect(inv.available).toBeGreaterThanOrEqual(0); // DB CHECK also guards this
    expect(inv.available).toBe(STOCK - winners); // conservation of stock
    expect(inv.reserved).toBe(winners); // reserved ledger matches winners
    expect(orders).toBe(winners); // exactly one order per winner

    // No winner should ever report a negative remaining.
    for (const r of results) {
      if (r.ok) expect(r.remaining === -1 || r.remaining >= 0).toBe(true);
    }
  });
});

/**
 * Full utilization: with a generous retry budget, all three strategies should
 * also sell the LAST unit — exactly STOCK winners, zero left on the shelf.
 */
describe.each(STRATEGIES)("sells every unit [%s]", (strategy) => {
  it("exactly STOCK winners under moderate contention", async () => {
    const sku = `FULL-${strategy}`;
    const STOCK = 30;
    const BUYERS = 120;
    await resetSku(pool, sku, STOCK);

    const results = await Promise.all(
      Array.from({ length: BUYERS }, (_, i) =>
        reserve(pool, { sku, qty: 1, strategy, idempotencyKey: `${sku}-${i}` }),
      ),
    );

    const winners = results.filter((r) => r.ok).length;
    const insufficient = results.filter(
      (r) => !r.ok && r.reason === "INSUFFICIENT_STOCK",
    ).length;

    expect(winners).toBe(STOCK);
    expect(insufficient).toBe(BUYERS - STOCK);
    expect((await inventoryOf(pool, sku)).available).toBe(0);
  });
});
