import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  uuid,
  timestamp,
  index,
  check,
  primaryKey,
} from "drizzle-orm/pg-core";

/**
 * Schema-as-code → migrations are generated from this model (`npm run db:generate`),
 * not hand-written DDL. The reservation hot path still uses raw SQL (see
 * src/domain/strategies.ts) — Drizzle owns the schema; raw SQL owns the locking.
 */

export const products = pgTable("products", {
  sku: text("sku").primaryKey(),
  name: text("name").notNull(),
});

export const inventory = pgTable(
  "inventory",
  {
    sku: text("sku")
      .primaryKey()
      .references(() => products.sku),
    // CHECK is the backstop: even a buggy strategy aborts instead of overselling.
    available: integer("available").notNull(),
    reserved: integer("reserved").notNull().default(0),
    // monotonic counter powering the optimistic compare-and-swap strategy
    version: integer("version").notNull().default(0),
  },
  (t) => [
    check("inventory_available_nonneg", sql`${t.available} >= 0`),
    check("inventory_reserved_nonneg", sql`${t.reserved} >= 0`),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // UNIQUE makes placement idempotent: a retry collides instead of re-reserving.
    idempotencyKey: text("idempotency_key").unique(),
    // Groups the line-item orders created by a single multi-SKU basket.
    basketId: uuid("basket_id"),
    sku: text("sku")
      .notNull()
      .references(() => products.sku),
    qty: integer("qty").notNull(),
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("orders_qty_pos", sql`${t.qty} > 0`),
    check(
      "orders_status_chk",
      sql`${t.status} IN ('HELD','CONFIRMED','RELEASED','FULFILLED')`,
    ),
    index("idx_orders_status_expires").on(t.status, t.expiresAt),
  ],
);

/**
 * Sharded stock for hot SKUs: a SKU's inventory is split across N rows so
 * concurrent reservations contend on N different row locks instead of one hot
 * row — the standard fix for single-row write contention. (See domain/sharded.ts.)
 */
export const inventoryShards = pgTable(
  "inventory_shards",
  {
    sku: text("sku")
      .notNull()
      .references(() => products.sku),
    shard: integer("shard").notNull(),
    available: integer("available").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sku, t.shard] }),
    check("inventory_shards_available_nonneg", sql`${t.available} >= 0`),
  ],
);
