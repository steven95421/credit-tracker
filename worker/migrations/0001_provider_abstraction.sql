-- Add provider namespaces without changing existing local primary keys.
-- Existing rows are Plaid rows; external ids are backfilled from their current ids.
ALTER TABLE items ADD COLUMN provider TEXT NOT NULL DEFAULT 'plaid';
ALTER TABLE items ADD COLUMN external_item_id TEXT;
ALTER TABLE items ADD COLUMN provider_data TEXT;
UPDATE items SET external_item_id = item_id WHERE external_item_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_provider_external
  ON items(provider, external_item_id);

ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'plaid';
ALTER TABLE accounts ADD COLUMN external_account_id TEXT;
UPDATE accounts SET external_account_id = account_id WHERE external_account_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider_external
  ON accounts(provider, external_account_id);

ALTER TABLE transactions ADD COLUMN provider TEXT NOT NULL DEFAULT 'plaid';
ALTER TABLE transactions ADD COLUMN external_transaction_id TEXT;
UPDATE transactions
  SET external_transaction_id = transaction_id
  WHERE external_transaction_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_provider_external
  ON transactions(provider, external_transaction_id);

CREATE TABLE IF NOT EXISTS link_nonces (
  nonce_hash   TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  provider     TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_nonces_expires ON link_nonces(expires_at);
