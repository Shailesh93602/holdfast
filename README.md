# QuickCommerce Core

An inventory-reservation engine that **never oversells under concurrency** — the hardest correctness problem in quick-commerce (Zepto / Blinkit / Instamart). It implements and **benchmarks three concurrency-control strategies** against real Postgres, with idempotent order placement, a reservation lifecycle, and Prometheus observability.

This is a focused backend, not a CRUD app. The interesting part is the concurrency correctness — and it's **proven by tests**, not claimed.

---

## The problem

> 500 customers tap "buy" on the last 50 units of a SKU within the same 200 ms. **Exactly 50 succeed. Never 51. Never a negative balance.**

A naïve `read → check → write` has a race: two requests both read "1 left" and both write. This engine makes that impossible three different ways and measures the trade-offs.

---

## The guarantee, proven

`test/concurrency.test.ts` fires **500 concurrent buyers at 50 units** for every strategy and asserts the invariants that must always hold:

```
winners ≤ stock          // never oversell
available = stock − winners ≥ 0   // conservation; DB CHECK is the backstop
reserved = winners               // ledger matches reality
held_orders = winners            // exactly one order per winner
```

```
✓ never oversells under contention [atomic]
✓ never oversells under contention [pessimistic]
✓ never oversells under contention [optimistic]
✓ sells every unit [atomic|pessimistic|optimistic]      // full utilization
✓ idempotent placement: same key ×100 concurrent → ONE reservation
✓ reservation lifecycle: expired holds return stock; confirmed ones don't
9 passed
```

`available INTEGER NOT NULL CHECK (available >= 0)` is the last line of defense: even a buggy strategy aborts the transaction instead of overselling.

---

## The three strategies (and when each wins)

| Strategy | How | Trade-off |
|---|---|---|
| **atomic** *(default)* | one `UPDATE … SET available = available − qty WHERE available >= qty` — the `WHERE` is the guard | No app-side read, no lock window. Best general default. |
| **pessimistic** | `SELECT … FOR UPDATE`, then `UPDATE` | Dead simple to reason about; serializes the hot row. |
| **optimistic** | read `version`, compare-and-swap `WHERE version = ?`, retry on miss | No lock held across the read; retry-heavy under contention. |

### Benchmark (measured, not guessed)

`tsx src/bench.ts 2000 3` — **2000 buyers all contending on one hot row**, local Postgres 16, pool=32, median of 3 rounds:

| strategy | throughput (res/s) | latency (ms) | avg CAS attempts/win |
|---|---|---|---|
| atomic | ~3,300 | ~610 | 1.00 |
| pessimistic | ~3,700 | ~540 | 1.00 |
| optimistic | ~3,000 | ~670 | **2.00** |

**Reading the result:** when every request hammers the *same* row, pessimistic and atomic serialize efficiently; optimistic loses because it averages 2 CAS attempts per win (it retries the lost races). Optimistic's advantage shows up when contention is *spread across many rows* — the inverse workload. *(Numbers are a single-machine local benchmark; rerun on your hardware.)*

---

## Idempotency (money-movement discipline)

Order placement accepts an `Idempotency-Key`. The `orders.idempotency_key` UNIQUE constraint makes a retried/duplicated request collide instead of reserving twice. The whole thing is one transaction, so a key that loses the race **rolls back its decrement** — net effect: exactly one reservation per key (verified with 100 concurrent identical requests).

## Reservation lifecycle

```
HOLD (TTL 2m) ──confirm──▶ CONFIRMED
   │
   └──expire──▶ RELEASED  (stock returned by the sweeper)
```
A background sweeper (`FOR UPDATE SKIP LOCKED`) returns abandoned holds to stock.

## Observability
`/metrics` exposes `qc_reservations_total{strategy,result}`, `qc_reservation_duration_seconds`, and `qc_optimistic_cas_attempts` for Prometheus/Grafana.

---

## Run it

```bash
# 1. Postgres (local or docker compose up -d)
createdb quickcommerce
export DATABASE_URL=postgresql://localhost:5432/quickcommerce

npm install
npm run migrate
npm test            # the proof (needs Postgres)
npx tsx src/bench.ts 2000 3   # the benchmark

npm run seed && npm start     # HTTP server on :3000
curl -XPOST localhost:3000/reserve -H 'idempotency-key: a1' \
  -H 'content-type: application/json' -d '{"sku":"MILK-1L","qty":2}'
```

## API
| Method | Path | |
|---|---|---|
| POST | `/reserve` | `{sku, qty, strategy?}` + optional `Idempotency-Key` header → 201/200/409/404 |
| POST | `/orders/:id/confirm` | HELD → CONFIRMED |
| GET | `/inventory/:sku` | available / reserved / version |
| GET | `/metrics` | Prometheus |
| GET | `/healthz` | liveness |

---

## Deliberately out of scope (honesty)
Payments (see my `stripe-payments-demo` / `razorpay-patterns-demo`), delivery routing, real auth, and a UI. This is the reservation *core*, kept sharp.

## Stack
TypeScript (strict) · Postgres 16 (raw SQL via `node-postgres` — chosen over an ORM precisely to make the locking/isolation explicit) · Fastify · Zod · prom-client · Vitest.
