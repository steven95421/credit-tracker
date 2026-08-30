-- D1 schema for the provider-aware Cloudflare Worker API.
CREATE TABLE IF NOT EXISTS items (
  item_id          TEXT PRIMARY KEY,
  provider         TEXT NOT NULL DEFAULT 'plaid',
  external_item_id TEXT,
  access_token     TEXT NOT NULL,
  institution_id   TEXT,
  institution_name TEXT,
  cursor           TEXT,
  provider_data    TEXT,
  created_at       TEXT NOT NULL,
  last_synced_at   TEXT,
  UNIQUE(provider, external_item_id)
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id          TEXT PRIMARY KEY,
  provider            TEXT NOT NULL DEFAULT 'plaid',
  external_account_id TEXT,
  item_id             TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  name                TEXT,
  official_name       TEXT,
  mask                TEXT,
  type                TEXT,
  subtype             TEXT,
  UNIQUE(provider, external_account_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  transaction_id          TEXT PRIMARY KEY,
  provider                TEXT NOT NULL DEFAULT 'plaid',
  external_transaction_id TEXT,
  account_id              TEXT NOT NULL,
  item_id                 TEXT NOT NULL,
  date                    TEXT NOT NULL,
  name                    TEXT,
  merchant_name           TEXT,
  amount                  REAL NOT NULL,
  iso_currency            TEXT,
  category                TEXT,
  pending                 INTEGER DEFAULT 0,
  raw                     TEXT,
  UNIQUE(provider, external_transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_txn_account_date ON transactions(account_id, date);

CREATE TABLE IF NOT EXISTS cards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT UNIQUE REFERENCES accounts(account_id) ON DELETE SET NULL,
  product_key  TEXT NOT NULL,
  display_name TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS benefit_overrides (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  benefit_id  TEXT NOT NULL,
  period_key  TEXT NOT NULL,
  used_amount REAL,
  claimed     INTEGER DEFAULT 0,
  note        TEXT,
  updated_at  TEXT NOT NULL,
  UNIQUE(card_id, benefit_id, period_key)
);

-- Provider link nonces are server-generated, session-bound, expiring, and one-time.
-- Only a SHA-256 digest is stored; the nonce itself is returned to the authenticated client.
CREATE TABLE IF NOT EXISTS link_nonces (
  nonce_hash   TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  provider     TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_nonces_expires ON link_nonces(expires_at);

-- One durable upstream profile per provider. For Stripe this stores the reusable
-- Customer id independently of one-shot Financial Connections Sessions.
CREATE TABLE IF NOT EXISTS provider_profiles (
  provider    TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
