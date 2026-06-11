import type { Pool } from "pg";
import { decrementFor } from "./strategies";
import type { ReserveRequest, ReserveResult } from "./types";

const HOLD_TTL = "2 minutes";

/**
 * Reserve `qty` of `sku`, atomically and idempotently.
 *
 * Everything happens in ONE transaction so the three effects can't tear apart
 * under a crash or a race:
 *   1. idempotency guard (an existing order for the key short-circuits),
 *   2. inventory decrement via the chosen strategy,
 *   3. the HELD order row.
 *
 * If the order insert hits the unique idempotency_key constraint (two identical
 * requests racing), the whole transaction rolls back — including the decrement —
 * and we return the original order. Net effect: exactly one reservation per key.
 */
export async function reserve(
  pool: Pool,
  req: ReserveRequest,
): Promise<ReserveResult> {
  const { sku, qty, idempotencyKey } = req;
  const strategy = req.strategy ?? "atomic";
  const decrement = decrementFor(strategy);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (idempotencyKey) {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM orders WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        await client.query("ROLLBACK");
        return {
          ok: true,
          orderId: existing.rows[0]!.id,
          remaining: -1,
          deduped: true,
        };
      }
    }

    const dec = await decrement(client, sku, qty);
    if (!dec.ok) {
      await client.query("ROLLBACK");
      return { ok: false, reason: dec.reason };
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO orders (idempotency_key, sku, qty, status, expires_at)
       VALUES ($1, $2, $3, 'HELD', now() + interval '${HOLD_TTL}')
       RETURNING id`,
      [idempotencyKey ?? null, sku, qty],
    );

    await client.query("COMMIT");
    return {
      ok: true,
      orderId: inserted.rows[0]!.id,
      remaining: dec.remaining,
      deduped: false,
      ...(dec.attempts !== undefined ? { attempts: dec.attempts } : {}),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // Lost the idempotency-key race: another identical request committed first.
    // The unique constraint fired (23505); return the winner's order.
    if (isUniqueViolation(err) && idempotencyKey) {
      const winner = await pool.query<{ id: string }>(
        `SELECT id FROM orders WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      if (winner.rowCount && winner.rowCount > 0) {
        return { ok: true, orderId: winner.rows[0]!.id, remaining: -1, deduped: true };
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}
