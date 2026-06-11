# Holdfast

> *hold·fast* — a firm grip that won't let go.

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
| atomic | ~4,200 | ~475 | 1.00 |
| pessimistic | ~4,300 | ~465 | 1.00 |
| optimistic | ~3,400 | ~580 | **2.00** |

**Reading the result:** when every request hammers the *same* row, pessimistic and atomic serialize efficiently; optimistic loses because it averages 2 CAS attempts per win (it retries the lost races). Optimistic's advantage shows up when contention is *spread across many rows* — the inverse workload. *(Numbers are a single-machine local benchmark; rerun on your hardware.)*

---

## Scaling a hot SKU (sharded stock)

A single inventory row is a single lock — the ceiling on a viral SKU. The fix is to **split that SKU's stock across N shard rows**; a reservation hits a random shard (falling back through the rest), so concurrent buyers contend on N locks instead of one. Same total demand, spread out:

| shards | throughput (res/s) | vs 1 shard |
|---|---|---|
| 1 | ~14,000 | 1.00× |
| 4 | ~27,000 | 1.9× |
| 16 | ~49,000 | 3.5× |
| 64 | ~49,000 | 3.5× (plateau — pool/CPU bound) |

Aggregate correctness is unchanged (`test/sharded.test.ts`): total stock = sum of shards, fallback ensures every unit still sells, and no shard can go negative. Diminishing returns past ~16 shards on this machine — the honest shape of the curve. (`npm run bench:sharded`; `src/domain/sharded.ts`.)

## Idempotency (money-movement discipline)

Order placement accepts an `Idempotency-Key`. The `orders.idempotency_key` UNIQUE constraint makes a retried/duplicated request collide instead of reserving twice. The whole thing is one transaction, so a key that loses the race **rolls back its decrement** — net effect: exactly one reservation per key (verified with 100 concurrent identical requests).

## Multi-item baskets (deadlock-safe)

Real carts reserve several SKUs at once, atomically. The trap: if cart A reserves `[milk, eggs]` while cart B reserves `[eggs, milk]` concurrently, naive per-item locking **deadlocks** (A holds milk waiting eggs; B holds eggs waiting milk — Postgres aborts one). `reserveBasket` prevents it by acquiring rows in a single **global order (sorted by SKU)**, so every concurrent basket grabs shared SKUs in the same sequence and no lock cycle can form. All-or-nothing: any out-of-stock line rolls the whole basket back.

Proven in `test/basket.test.ts`: **100 concurrent baskets locking the same two SKUs in opposite order complete with zero deadlocks** and a consistent ledger.

## Reservation lifecycle

```
HOLD (TTL 2m) ──confirm──▶ CONFIRMED
   │
   └──expire──▶ RELEASED  (stock returned by the sweeper)
```
A background sweeper (`FOR UPDATE SKIP LOCKED`) returns abandoned holds to stock.

## Resilience — fails closed under chaos

`test/chaos.test.ts` runs a stampede of 400 buyers while a concurrent killer issues `pg_terminate_backend` on their connections, **violently aborting ~100 transactions mid-flight**. The guarantee holds anyway: killed transactions roll back, so they leave no phantom decrements — **exactly the available stock sells, `available` never goes negative, and the ledger stays consistent** every run. The pool swallows backend-teardown signals (failover/kill) so a dropped connection can never crash the process.

## Observability
`/metrics` exposes `qc_reservations_total{strategy,result}`, `qc_reservation_duration_seconds`, and `qc_optimistic_cas_attempts` for Prometheus/Grafana.

---

## Run it

```bash
# 1. Postgres (local or docker compose up -d)
createdb holdfast
export DATABASE_URL=postgresql://localhost:5432/holdfast

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
| POST | `/reserve-basket` | `{items:[{sku,qty}], strategy?}` — atomic, deadlock-safe multi-SKU |
| POST | `/orders/:id/confirm` | HELD → CONFIRMED |
| GET | `/inventory/:sku` | available / reserved / version |
| GET | `/metrics` | Prometheus |
| GET | `/healthz` | liveness |

---

## Deliberately out of scope (honesty)
Payments (see my `stripe-payments-demo` / `razorpay-patterns-demo`), delivery routing, real auth, and a UI. This is the reservation *core*, kept sharp.

## Schema & migrations
Schema is **model-driven**: defined as code in [`src/db/schema.ts`](src/db/schema.ts) and migrations are **generated** from it via Drizzle (`npm run db:generate`) — no hand-written DDL. Ordinary reads go through Drizzle's type-safe query builder. The reservation hot path deliberately drops to **raw SQL** (`src/domain/strategies.ts`) because the whole value is in the explicit `FOR UPDATE` / conditional-update / version-CAS locking — which an ORM's query builder would hide and whose interactive transactions add overhead under heavy contention. ORM for productivity, raw SQL where it counts.

## Stack
TypeScript (strict) · Postgres 16 · **Drizzle** (schema-as-code + generated migrations + typed reads) · raw SQL via `node-postgres` on the lock path · Fastify · Zod · prom-client · Vitest.
