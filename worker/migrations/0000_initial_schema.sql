-- Original Plaid-only schema. On an existing installation every statement is
-- a no-op; on a fresh installation it establishes the base that 0001 upgrades.
CREATE TABLE IF NOT EXISTS items (
  item_id          TEXT PRIMARY KEY,
  access_token     TEXT NOT NULL,
  institution_id   TEXT,
  institution_name TEXT,
  cursor           TEXT,
  created_at       TEXT NOT NULL,
  last_synced_at   TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id    TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  name          TEXT,
  official_name TEXT,
  mask          TEXT,
  type          TEXT,
  subtype       TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  transaction_id TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL,
  item_id        TEXT NOT NULL,
  date           TEXT NOT NULL,
  name           TEXT,
  merchant_name  TEXT,
  amount         REAL NOT NULL,
  iso_currency   TEXT,
  category       TEXT,
  pending        INTEGER DEFAULT 0,
  raw            TEXT
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
