import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool } from "../src/infra/db";
import { migrate } from "../src/infra/migrate";
import { reserve } from "../src/domain/reservation";
import { resetSku, inventoryOf, heldOrderCount } from "./helpers";

// Contended pool for the buyers. A killed backend makes its idle client error;
// without a handler node-postgres would crash the process — so we swallow it.
const pool = createPool({ max: 12 });
pool.on("error", () => {});

// Separate connection used only to terminate the buyers' backends.
const admin = createPool({ max: 2 });
admin.on("error", () => {});

beforeAll(async () => {
  await migrate();
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

/** Terminate every active buyer backend on our DB (not ourselves / the killer). */
async function killActiveBuyers(): Promise<number> {
  const r = await admin.query(
    `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = 'active'
        AND query NOT ILIKE '%pg_terminate_backend%'
        AND query NOT ILIKE '%pg_stat_activity%'`,
  );
  return r.rowCount ?? 0;
}

describe("chaos: fails closed (never oversells) under transaction kills", () => {
  it("violently kills reservations mid-flight; stock stays consistent", async () => {
    const sku = "CHAOS";
    const STOCK = 50;
    const BUYERS = 400;
    await resetSku(pool, sku, STOCK);

    // Run a tight kill loop concurrently with the buyer stampede.
    let terminated = 0;
    let killing = true;
    const chaos = (async () => {
      while (killing) {
        try {
          terminated += await killActiveBuyers();
        } catch {
          /* admin connection raced a kill — ignore */
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    const results = await Promise.allSettled(
      Array.from({ length: BUYERS }, (_, i) =>
        reserve(pool, {
          sku,
          qty: 1,
          strategy: "atomic",
          idempotencyKey: `${sku}-${i}`,
        }),
      ),
    );

    killing = false;
    await chaos;

    const winners = results.filter(
      (r) => r.status === "fulfilled" && r.value.ok,
    ).length;
    const failed = results.filter((r) => r.status === "rejected").length;
    const inv = await inventoryOf(pool, sku);
    const held = await heldOrderCount(pool, sku);

    // THE guarantee: no matter how many transactions were violently killed,
    // inventory is never oversold and the ledger stays perfectly consistent —
    // killed transactions roll back, so they leave no phantom decrements.
    expect(winners).toBeLessThanOrEqual(STOCK);
    expect(inv.available).toBeGreaterThanOrEqual(0);
    expect(inv.available).toBe(STOCK - winners);
    expect(inv.reserved).toBe(winners);
    expect(held).toBe(winners);

    // Sanity: chaos actually happened (some backends were killed / some failed).
    expect(terminated + failed).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log(
      `[chaos] winners=${winners} failed=${failed} terminated=${terminated} → available=${inv.available}, reserved=${inv.reserved}`,
    );
  });
});
