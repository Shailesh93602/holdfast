import Fastify from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { createPool } from "./infra/db";
import { migrate } from "./infra/migrate";
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
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`Holdfast listening on :${port}`);
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
