-- QuickCommerce Core schema.
-- gen_random_uuid() lives in pgcrypto on PG < 13; harmless to ensure it.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS products (
  sku  TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory (
  sku       TEXT PRIMARY KEY REFERENCES products(sku),
  -- CHECK is the last line of defense: even a buggy strategy can never push
  -- available below zero — the DB aborts the transaction instead of overselling.
  available INTEGER NOT NULL CHECK (available >= 0),
  reserved  INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  -- monotonic counter for the optimistic-concurrency (compare-and-swap) strategy
  version   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- UNIQUE makes order placement idempotent: a retried request with the same
  -- key collides here instead of reserving stock twice.
  idempotency_key TEXT UNIQUE,
  sku             TEXT NOT NULL REFERENCES products(sku),
  qty             INTEGER NOT NULL CHECK (qty > 0),
  status          TEXT NOT NULL CHECK (status IN ('HELD','CONFIRMED','RELEASED','FULFILLED')),
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- supports the expiry sweeper: find HELD orders past their TTL fast
CREATE INDEX IF NOT EXISTS idx_orders_status_expires ON orders (status, expires_at);
