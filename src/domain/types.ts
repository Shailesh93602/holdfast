export const STRATEGIES = ["atomic", "pessimistic", "optimistic"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export interface ReserveRequest {
  sku: string;
  qty: number;
  /** When set, makes placement idempotent — a retry with the same key never double-reserves. */
  idempotencyKey?: string;
  strategy?: Strategy;
}

export type ReserveFailure =
  | "INSUFFICIENT_STOCK"
  | "RETRY_EXHAUSTED"
  | "NOT_FOUND";

export type ReserveResult =
  | {
      ok: true;
      orderId: string;
      /** Remaining available after this reservation (-1 when returned from the idempotent dedup path). */
      remaining: number;
      deduped: boolean;
      /** Optimistic strategy only: how many CAS attempts it took. */
      attempts?: number;
    }
  | { ok: false; reason: ReserveFailure };

/** Internal result of a strategy's inventory decrement (no order row yet). */
export type DecrementResult =
  | { ok: true; remaining: number; attempts?: number }
  | { ok: false; reason: Exclude<ReserveFailure, never> };
