import Fastify from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { createPool } from "./infra/db";
import { migrate } from "./infra/migrate";
import { seedDemoIfEmpty } from "./infra/seed";
import { makeDrizzle } from "./db/client";
import { inventory } from "./db/schema";
import { reserve } from "./domain/reservation";
import { reserveBasket } from "./domain/basket";
import { confirmOrder, sweepExpired } from "./domain/lifecycle";
import {
  registry,
  reservationsTotal,
  reservationDuration,
  optimisticCasAttempts,
} from "./infra/metrics";
import { STRATEGIES } from "./domain/types";

const pool = createPool();
const db = makeDrizzle(pool);
const app = Fastify({ logger: true });

/** Map a reservation failure to an HTTP status. */
function failureCode(reason: string): number {
  if (reason === "NOT_FOUND") return 404;
  if (reason === "INSUFFICIENT_STOCK") return 409;
  return 503; // RETRY_EXHAUSTED
}

const reserveBody = z.object({
  sku: z.string().min(1),
  qty: z.number().int().positive().default(1),
  strategy: z.enum(STRATEGIES).optional(),
});

const basketBody = z.object({
  items: z
    .array(z.object({ sku: z.string().min(1), qty: z.number().int().positive() }))
    .min(1),
  strategy: z.enum(STRATEGIES).optional(),
});

app.post("/reserve", async (req, reply) => {
  const parsed = reserveBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const idempotencyKey =
    (req.headers["idempotency-key"] as string | undefined) ?? undefined;
  const strategy = parsed.data.strategy ?? "atomic";

  const stop = reservationDuration.startTimer({ strategy });
  const result = await reserve(pool, { ...parsed.data, idempotencyKey });
  stop();

  reservationsTotal.inc({ strategy, result: result.ok ? "ok" : result.reason });
  if (result.ok && result.attempts !== undefined) {
    optimisticCasAttempts.observe(result.attempts);
  }

  if (!result.ok) {
    return reply.code(failureCode(result.reason)).send(result);
  }
  return reply.code(result.deduped ? 200 : 201).send(result);
});

app.post("/reserve-basket", async (req, reply) => {
  const parsed = basketBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const result = await reserveBasket(pool, parsed.data.items, {
    strategy: parsed.data.strategy,
  });
  if (!result.ok) {
    return reply.code(failureCode(result.reason)).send(result);
  }
  return reply.code(201).send(result);
});

app.post<{ Params: { id: string } }>("/orders/:id/confirm", async (req, reply) => {
  const ok = await confirmOrder(pool, req.params.id);
  return ok ? { ok: true } : reply.code(409).send({ ok: false });
});

app.get<{ Params: { sku: string } }>("/inventory/:sku", async (req, reply) => {
  const rows = await db
    .select()
    .from(inventory)
    .where(eq(inventory.sku, req.params.sku));
  if (rows.length === 0) return reply.code(404).send({ error: "not found" });
  return rows[0];
});

// Root landing page so visiting the live URL shows what this is (not a 404).
app.get("/", async (_req, reply) => {
  let rowsHtml =
    '<tr><td colspan="3" style="opacity:.6">catalog seeding, refresh in a moment…</td></tr>';
  try {
    const rows = await db
      .select({
        sku: inventory.sku,
        available: inventory.available,
        reserved: inventory.reserved,
      })
      .from(inventory)
      .limit(8);
    if (rows.length) {
      rowsHtml = rows
        .map(
          (r) =>
            `<tr><td>${r.sku}</td><td>${r.available}</td><td>${r.reserved}</td></tr>`,
        )
        .join("");
    }
  } catch {
    rowsHtml =
      '<tr><td colspan="3" style="opacity:.6">database waking up, refresh in a moment…</td></tr>';
  }

  reply.header("Content-Type", "text/html; charset=utf-8");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Holdfast — live inventory reservation engine</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0c0a14;color:#e7e5ee;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif}
  .wrap{max-width:760px;margin:0 auto;padding:48px 24px}
  h1{font-size:1.9rem;margin:0 0 6px}
  .live{display:inline-block;font-size:.75rem;color:#10b981;border:1px solid #10b98155;border-radius:999px;padding:2px 10px;margin-bottom:18px}
  p{color:#b9b6c6}
  code,pre{background:#161320;border:1px solid #2a2640;border-radius:8px}
  code{padding:2px 6px;font-size:.85em}
  pre{padding:14px 16px;overflow:auto}
  table{width:100%;border-collapse:collapse;margin:10px 0 4px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #221f33}
  th{color:#8c88a0;font-weight:600;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
  a{color:#a78bfa}
  .grid{display:grid;gap:6px;margin:8px 0 20px}
  .muted{color:#8c88a0;font-size:.9rem}
</style></head>
<body><div class="wrap">
  <span class="live">● live</span>
  <h1>Holdfast</h1>
  <p>An inventory reservation engine that never oversells under concurrency, even when database transactions are killed mid-flight. This is the running API. There's no separate UI; you talk to it over HTTP.</p>

  <h3>Live stock (from the database right now)</h3>
  <table><thead><tr><th>SKU</th><th>Available</th><th>Reserved</th></tr></thead>
  <tbody>${rowsHtml}</tbody></table>

  <h3>Try it</h3>
  <p class="muted">Reserve a unit and watch the count hold the line under load:</p>
  <pre>curl -X POST ${"https://holdfast-50gt.onrender.com"}/reserve \\
  -H 'content-type: application/json' \\
  -d '{"sku":"SKU-1","qty":1}'</pre>

  <h3>Endpoints</h3>
  <div class="grid muted">
    <div><code>POST /reserve</code> — reserve stock for a SKU (atomic, never oversells)</div>
    <div><code>POST /reserve-basket</code> — reserve several SKUs, deadlock-safe, all or nothing</div>
    <div><code>GET /healthz</code> — health check</div>
    <div><code>GET /metrics</code> — Prometheus metrics</div>
  </div>

  <p>Three concurrency strategies, deadlock-safe baskets, idempotent placement, a chaos test that proves it fails closed, and hot-SKU sharding. Full write-up and code: <a href="https://github.com/Shailesh93602/holdfast">github.com/Shailesh93602/holdfast</a></p>
</div></body></html>`;
});

app.get("/healthz", async () => ({ ok: true }));

app.get("/metrics", async (_req, reply) => {
  reply.header("Content-Type", registry.contentType);
  return registry.metrics();
});

// Background expiry sweeper — returns abandoned HELDs to stock.
const sweepMs = Number(process.env.SWEEP_INTERVAL_MS ?? 10_000);
const sweeper = setInterval(() => {
  sweepExpired(pool).catch((err) => app.log.error(err, "sweep failed"));
}, sweepMs);
sweeper.unref();

const port = Number(process.env.PORT ?? 3000);

async function start(): Promise<void> {
  // Hosted platforms run a fresh container — apply migrations on boot when asked.
  if (process.env.RUN_MIGRATIONS_ON_BOOT === "true") {
    app.log.info("applying migrations on boot…");
    await migrate();
  }
  // Self-seed the demo catalog on first boot (no shell needed). Idempotent.
  if (process.env.SEED_ON_BOOT === "true") {
    const seeded = await seedDemoIfEmpty(pool);
    app.log.info(seeded ? "seeded demo catalog" : "catalog already present");
  }
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`Holdfast listening on :${port}`);
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
