import { performance } from "node:perf_hooks";
import { createPool } from "./infra/db";
import { migrate } from "./infra/migrate";
import { setStock } from "./infra/seed";
import { reserve } from "./domain/reservation";
import { STRATEGIES, type Strategy } from "./domain/types";

/**
 * Apples-to-apples benchmark of the three concurrency strategies.
 *
 * Each round seeds enough stock that EVERY buyer succeeds (so we measure the
 * cost of the concurrency control itself, not stock-out short-circuits), fires
 * `buyers` reservations concurrently, and reports throughput + tail behaviour.
 *
 * Usage: tsx src/bench.ts [buyers] [rounds]
 */

const BUYERS = Number(process.argv[2] ?? 2000);
const ROUNDS = Number(process.argv[3] ?? 3);

interface RoundStat {
  ms: number;
  throughput: number;
  winners: number;
  totalAttempts: number;
}

async function benchOnce(
  pool: ReturnType<typeof createPool>,
  strategy: Strategy,
  buyers: number,
): Promise<RoundStat> {
  const sku = `BENCH-${strategy}`;
  await setStock(pool, sku, buyers);

  const start = performance.now();
  const results = await Promise.all(
    Array.from({ length: buyers }, (_, i) =>
      reserve(pool, {
        sku,
        qty: 1,
        strategy,
        idempotencyKey: `${sku}-${i}`,
      }),
    ),
  );
  const ms = performance.now() - start;

  let winners = 0;
  let totalAttempts = 0;
  for (const r of results) {
    if (r.ok) {
      winners++;
      totalAttempts += r.attempts ?? 1;
    }
  }
  return { ms, throughput: buyers / (ms / 1000), winners, totalAttempts };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

async function main(): Promise<void> {
  await migrate();
  const pool = createPool({ max: Number(process.env.PG_POOL_MAX ?? 32) });

  console.log(
    `\nQuickCommerce Core — reservation benchmark` +
      `\n  buyers/round=${BUYERS}  rounds=${ROUNDS}  pool=${pool.options.max}\n`,
  );
  console.log(
    "strategy      | med throughput (res/s) | med latency (ms) | avg CAS attempts/win",
  );
  console.log(
    "------------- | ---------------------- | ---------------- | --------------------",
  );

  for (const strategy of STRATEGIES) {
    const stats: RoundStat[] = [];
    // one warmup round (not recorded) to prime connections/plan cache
    await benchOnce(pool, strategy, BUYERS);
    for (let r = 0; r < ROUNDS; r++) {
      stats.push(await benchOnce(pool, strategy, BUYERS));
    }
    const tput = Math.round(median(stats.map((s) => s.throughput)));
    const lat = median(stats.map((s) => s.ms)).toFixed(0);
    const avgAttempts = (
      stats.reduce((a, s) => a + s.totalAttempts / s.winners, 0) / stats.length
    ).toFixed(2);
    console.log(
      `${strategy.padEnd(13)} | ${String(tput).padStart(22)} | ${String(lat).padStart(16)} | ${avgAttempts.padStart(20)}`,
    );
  }

  await pool.end();
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
