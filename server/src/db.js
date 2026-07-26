import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

const dbPath = process.env.DB_PATH
  ? resolve(repoRoot, process.env.DB_PATH)
  : resolve(repoRoot, 'server', 'data', 'credit-tracker.db');

mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
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
  category       TEXT,          -- plaid personal_finance_category.primary or category[0]
  pending        INTEGER DEFAULT 0,
  raw            TEXT
);
CREATE INDEX IF NOT EXISTS idx_txn_account_date ON transactions(account_id, date);

-- A "card profile": maps a linked Plaid account to a known card product in the catalog.
-- account_id may be NULL for a manual-only card you track without linking.
CREATE TABLE IF NOT EXISTS cards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT UNIQUE REFERENCES accounts(account_id) ON DELETE SET NULL,
  product_key  TEXT NOT NULL,   -- references a product in catalog
  display_name TEXT,
  created_at   TEXT NOT NULL
);

-- Manual overrides per (card, benefit, period). Lets you mark a credit as used/claimed
-- when auto-matching from transactions isn't reliable.
CREATE TABLE IF NOT EXISTS benefit_overrides (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  benefit_id  TEXT NOT NULL,
  period_key  TEXT NOT NULL,
  used_amount REAL,             -- NULL => fall back to auto-matched amount
  claimed     INTEGER DEFAULT 0,
  note        TEXT,
  updated_at  TEXT NOT NULL,
  UNIQUE(card_id, benefit_id, period_key)
);
`);

// ---- prepared helpers ----
export const q = {
  insertItem: db.prepare(
    `INSERT INTO items (item_id, access_token, institution_id, institution_name, cursor, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       access_token=excluded.access_token,
       institution_id=excluded.institution_id,
       institution_name=excluded.institution_name`
  ),
  listItems: db.prepare(`SELECT * FROM items ORDER BY created_at`),
  getItem: db.prepare(`SELECT * FROM items WHERE item_id = ?`),
  deleteItem: db.prepare(`DELETE FROM items WHERE item_id = ?`),
  setCursor: db.prepare(`UPDATE items SET cursor = ?, last_synced_at = ? WHERE item_id = ?`),

  upsertAccount: db.prepare(
    `INSERT INTO accounts (account_id, item_id, name, official_name, mask, type, subtype)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       name=excluded.name, official_name=excluded.official_name, mask=excluded.mask,
       type=excluded.type, subtype=excluded.subtype`
  ),
  listAccounts: db.prepare(`SELECT * FROM accounts ORDER BY name`),
  listAccountsByItem: db.prepare(`SELECT * FROM accounts WHERE item_id = ? ORDER BY name`),
  getAccount: db.prepare(`SELECT * FROM accounts WHERE account_id = ?`),

  upsertTxn: db.prepare(
    `INSERT INTO transactions (transaction_id, account_id, item_id, date, name, merchant_name, amount, iso_currency, category, pending, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(transaction_id) DO UPDATE SET
       account_id=excluded.account_id, date=excluded.date, name=excluded.name,
       merchant_name=excluded.merchant_name, amount=excluded.amount, iso_currency=excluded.iso_currency,
       category=excluded.category, pending=excluded.pending, raw=excluded.raw`
  ),
  deleteTxn: db.prepare(`DELETE FROM transactions WHERE transaction_id = ?`),
  txnsForAccountBetween: db.prepare(
    `SELECT * FROM transactions WHERE account_id = ? AND date >= ? AND date <= ? ORDER BY date DESC`
  ),
  txnsForAccount: db.prepare(
    `SELECT * FROM transactions WHERE account_id = ? ORDER BY date DESC LIMIT ?`
  ),

  insertCard: db.prepare(
    `INSERT INTO cards (account_id, product_key, display_name, created_at) VALUES (?, ?, ?, ?)`
  ),
  listCards: db.prepare(`SELECT * FROM cards ORDER BY created_at`),
  getCard: db.prepare(`SELECT * FROM cards WHERE id = ?`),
  deleteCard: db.prepare(`DELETE FROM cards WHERE id = ?`),

  getOverride: db.prepare(
    `SELECT * FROM benefit_overrides WHERE card_id = ? AND benefit_id = ? AND period_key = ?`
  ),
  upsertOverride: db.prepare(
    `INSERT INTO benefit_overrides (card_id, benefit_id, period_key, used_amount, claimed, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(card_id, benefit_id, period_key) DO UPDATE SET
       used_amount=excluded.used_amount, claimed=excluded.claimed, note=excluded.note, updated_at=excluded.updated_at`
  ),
};

export { dbPath };
