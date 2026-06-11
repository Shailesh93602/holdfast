import Fastify from "fastify";
import { z } from "zod";
import { createPool } from "./infra/db";
import { reserve } from "./domain/reservation";
import { confirmOrder, sweepExpired } from "./domain/lifecycle";
import {
  registry,
  reservationsTotal,
  reservationDuration,
  optimisticCasAttempts,
} from "./infra/metrics";
import { STRATEGIES } from "./domain/types";

const pool = createPool();
const app = Fastify({ logger: true });

const reserveBody = z.object({
  sku: z.string().min(1),
  qty: z.number().int().positive().default(1),
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
    const code =
      result.reason === "NOT_FOUND"
        ? 404
        : result.reason === "INSUFFICIENT_STOCK"
          ? 409
          : 503;
    return reply.code(code).send(result);
  }
  return reply.code(result.deduped ? 200 : 201).send(result);
});

app.post<{ Params: { id: string } }>("/orders/:id/confirm", async (req, reply) => {
  const ok = await confirmOrder(pool, req.params.id);
  return ok ? { ok: true } : reply.code(409).send({ ok: false });
});

app.get<{ Params: { sku: string } }>("/inventory/:sku", async (req, reply) => {
  const r = await pool.query(
    `SELECT sku, available, reserved, version FROM inventory WHERE sku = $1`,
    [req.params.sku],
  );
  if (r.rowCount === 0) return reply.code(404).send({ error: "not found" });
  return r.rows[0];
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
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`QuickCommerce Core on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
