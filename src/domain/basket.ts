import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { decrementFor } from "./strategies";
import type { ReserveFailure, Strategy } from "./types";

export interface BasketItem {
  sku: string;
  qty: number;
}

export type BasketResult =
  | { ok: true; basketId: string; orderIds: string[] }
  | { ok: false; reason: ReserveFailure; failedSku: string };

/**
 * Reserve every item in a basket atomically — all-or-nothing.
 *
 * The subtle part is DEADLOCK SAFETY. If basket A reserves [milk, eggs] while
 * basket B reserves [eggs, milk] concurrently, naive per-item locking deadlocks:
 * A holds milk waiting on eggs; B holds eggs waiting on milk; Postgres aborts one
 * with `deadlock detected`. We prevent it by acquiring rows in a single GLOBAL
 * ORDER — sorted by sku — so every concurrent basket grabs shared SKUs in the
 * same sequence. No lock cycle can form, so no deadlock.
 */
export async function reserveBasket(
  pool: Pool,
  items: BasketItem[],
  opts: { strategy?: Strategy } = {},
): Promise<BasketResult> {
  // Baskets lock multiple rows; pessimistic (FOR UPDATE) is the clearest fit and
  // the case where lock ordering matters most.
  const strategy: Strategy = opts.strategy ?? "pessimistic";
  const decrement = decrementFor(strategy);

  // Merge duplicate SKUs, then sort — THE deadlock-prevention step.
  const ordered = mergeBySku(items).sort((a, b) => (a.sku < b.sku ? -1 : 1));
  const basketId = randomUUID();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const item of ordered) {
      const dec = await decrement(client, item.sku, item.qty);
      if (!dec.ok) {
        await client.query("ROLLBACK");
        return { ok: false, reason: dec.reason, failedSku: item.sku };
      }
    }

    const orderIds: string[] = [];
    for (const item of ordered) {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO orders (basket_id, sku, qty, status, expires_at)
         VALUES ($1, $2, $3, 'HELD', now() + interval '2 minutes')
         RETURNING id`,
        [basketId, item.sku, item.qty],
      );
      orderIds.push(ins.rows[0]!.id);
    }

    await client.query("COMMIT");
    return { ok: true, basketId, orderIds };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function mergeBySku(items: BasketItem[]): BasketItem[] {
  const totals = new Map<string, number>();
  for (const it of items) totals.set(it.sku, (totals.get(it.sku) ?? 0) + it.qty);
  return [...totals.entries()].map(([sku, qty]) => ({ sku, qty }));
}

export type { ReserveFailure };
