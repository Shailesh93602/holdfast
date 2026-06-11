import { performance } from "node:perf_hooks";
import { createPool } from "./infra/db";
import { migrate } from "./infra/migrate";
import { setupShardedStock, reserveSharded } from "./domain/sharded";

/**
 * Show throughput climbing as a hot SKU's stock is split across more shards —
 * the same total demand, spread over N row locks instead of one.
 *
 * Usage: tsx src/sharded-bench.ts [buyers] [rounds]
 */
const BUYERS = Number(process.argv[2] ?? 2000);
const ROUNDS = Number(process.argv[3] ?? 3);
const SHARD_COUNTS = [1, 4, 16, 64];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

async function benchOnce(
  pool: ReturnType<typeof createPool>,
  sku: string,
  shards: number,
  buyers: number,
): Promise<number> {
  await setupShardedStock(pool, sku, buyers, shards); // enough stock that all win
  const start = performance.now();
  await Promise.all(
    Array.from({ length: buyers }, () => reserveSharded(pool, sku, 1, shards)),
  );
  return buyers / ((performance.now() - start) / 1000);
}

async function main(): Promise<void> {
  await migrate();
  const pool = createPool({ max: Number(process.env.PG_POOL_MAX ?? 32) });
  console.log(
    `\nHoldfast — sharded hot-SKU benchmark` +
      `\n  buyers=${BUYERS}  rounds=${ROUNDS}  pool=${pool.options.max}\n`,
  );
  console.log("shards | median throughput (res/s) | vs 1 shard");
  console.log("------ | -------------------------- | ----------");

  let baseline = 0;
  for (const shards of SHARD_COUNTS) {
    const tps: number[] = [];
    await benchOnce(pool, `BENCHSH-${shards}`, shards, BUYERS); // warmup
    for (let r = 0; r < ROUNDS; r++) {
      tps.push(await benchOnce(pool, `BENCHSH-${shards}`, shards, BUYERS));
    }
    const t = Math.round(median(tps));
    if (shards === 1) baseline = t;
    const speedup = baseline ? `${(t / baseline).toFixed(2)}×` : "—";
    console.log(
      `${String(shards).padStart(6)} | ${String(t).padStart(26)} | ${speedup.padStart(10)}`,
    );
  }
  await pool.end();
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
