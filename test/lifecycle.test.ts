import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool } from "../src/infra/db";
import { migrate } from "../src/infra/migrate";
import { reserve } from "../src/domain/reservation";
import { sweepExpired, confirmOrder } from "../src/domain/lifecycle";
import { resetSku, inventoryOf } from "./helpers";

const pool = createPool({ max: 8 });

beforeAll(async () => {
  await migrate();
  // Drain any expired holds left behind by other suites / the benchmark so the
  // sweep count below reflects only this test's order.
  await sweepExpired(pool);
});
afterAll(async () => {
  await pool.end();
});

describe("reservation lifecycle", () => {
  it("expired HELD orders return stock; confirmed ones are kept", async () => {
    const sku = "LIFECYCLE";
    await resetSku(pool, sku, 5);

    const a = await reserve(pool, { sku, qty: 2 }); // HELD → available 3
    const b = await reserve(pool, { sku, qty: 1 }); // HELD → available 2
    expect(a.ok && b.ok).toBe(true);
    expect((await inventoryOf(pool, sku)).available).toBe(2);

    // Confirm a — it must survive the sweep.
    if (a.ok) expect(await confirmOrder(pool, a.orderId)).toBe(true);

    // Force b past its TTL.
    if (b.ok) {
      await pool.query(
        `UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`,
        [b.orderId],
      );
    }

    const released = await sweepExpired(pool);
    expect(released).toBe(1); // only b

    const inv = await inventoryOf(pool, sku);
    expect(inv.available).toBe(3); // b's unit came back (2 → 3)
    expect(inv.reserved).toBe(2); // a's 2 still held
  });
});
