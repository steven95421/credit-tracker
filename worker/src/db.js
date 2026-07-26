// D1 query helpers — mirrors the prepared statements in server/src/db.js.
const all = async (stmt) => (await stmt.all()).results;

// items
export const listItems = (DB) => all(DB.prepare('SELECT * FROM items ORDER BY created_at'));
export const getItem = (DB, id) => DB.prepare('SELECT * FROM items WHERE item_id = ?').bind(id).first();
export const insertItem = (DB, itemId, accessToken, institutionId, institutionName, createdAt) =>
  DB.prepare(
    `INSERT INTO items (item_id, access_token, institution_id, institution_name, cursor, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       access_token=excluded.access_token,
       institution_id=excluded.institution_id,
       institution_name=excluded.institution_name`
  ).bind(itemId, accessToken, institutionId, institutionName, createdAt).run();
export const deleteItem = (DB, id) => DB.prepare('DELETE FROM items WHERE item_id = ?').bind(id).run();
export const setCursor = (DB, itemId, cursor, syncedAt) =>
  DB.prepare('UPDATE items SET cursor = ?, last_synced_at = ? WHERE item_id = ?').bind(cursor, syncedAt, itemId).run();

// accounts
export const upsertAccount = (DB, a, itemId) =>
  DB.prepare(
    `INSERT INTO accounts (account_id, item_id, name, official_name, mask, type, subtype)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       name=excluded.name, official_name=excluded.official_name, mask=excluded.mask,
       type=excluded.type, subtype=excluded.subtype`
  ).bind(a.account_id, itemId, a.name ?? null, a.official_name ?? null, a.mask ?? null, a.type ?? null, a.subtype ?? null).run();
export const listAccounts = (DB) => all(DB.prepare('SELECT * FROM accounts ORDER BY name'));
export const listAccountsByItem = (DB, itemId) =>
  all(DB.prepare('SELECT * FROM accounts WHERE item_id = ? ORDER BY name').bind(itemId));
export const getAccount = (DB, id) => DB.prepare('SELECT * FROM accounts WHERE account_id = ?').bind(id).first();
export const deleteAccountsByItem = (DB, itemId) =>
  DB.prepare('DELETE FROM accounts WHERE item_id = ?').bind(itemId).run();

// transactions
export const upsertTxn = (DB, vals) =>
  DB.prepare(
    `INSERT INTO transactions (transaction_id, account_id, item_id, date, name, merchant_name, amount, iso_currency, category, pending, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(transaction_id) DO UPDATE SET
       account_id=excluded.account_id, date=excluded.date, name=excluded.name,
       merchant_name=excluded.merchant_name, amount=excluded.amount, iso_currency=excluded.iso_currency,
       category=excluded.category, pending=excluded.pending, raw=excluded.raw`
  ).bind(...vals).run();
export const deleteTxn = (DB, id) => DB.prepare('DELETE FROM transactions WHERE transaction_id = ?').bind(id).run();
export const deleteTxnsByItem = (DB, itemId) =>
  DB.prepare('DELETE FROM transactions WHERE item_id = ?').bind(itemId).run();
export const txnsForAccountBetween = (DB, accountId, start, end) =>
  all(DB.prepare('SELECT * FROM transactions WHERE account_id = ? AND date >= ? AND date <= ? ORDER BY date DESC').bind(accountId, start, end));
export const txnsForAccount = (DB, accountId, limit) =>
  all(DB.prepare('SELECT * FROM transactions WHERE account_id = ? ORDER BY date DESC LIMIT ?').bind(accountId, limit));

// cards
export const insertCard = async (DB, accountId, productKey, displayName, createdAt) => {
  const r = await DB.prepare('INSERT INTO cards (account_id, product_key, display_name, created_at) VALUES (?, ?, ?, ?)')
    .bind(accountId, productKey, displayName, createdAt).run();
  return r.meta.last_row_id;
};
export const listCards = (DB) => all(DB.prepare('SELECT * FROM cards ORDER BY created_at'));
export const getCard = (DB, id) => DB.prepare('SELECT * FROM cards WHERE id = ?').bind(id).first();
export const deleteCard = (DB, id) => DB.prepare('DELETE FROM cards WHERE id = ?').bind(id).run();
export const unlinkCardsOfAccounts = (DB, itemId) =>
  DB.prepare('UPDATE cards SET account_id = NULL WHERE account_id IN (SELECT account_id FROM accounts WHERE item_id = ?)').bind(itemId).run();

// overrides
export const getOverride = (DB, cardId, benefitId, periodKey) =>
  DB.prepare('SELECT * FROM benefit_overrides WHERE card_id = ? AND benefit_id = ? AND period_key = ?').bind(cardId, benefitId, periodKey).first();
export const upsertOverride = (DB, cardId, benefitId, periodKey, usedAmount, claimed, note, updatedAt) =>
  DB.prepare(
    `INSERT INTO benefit_overrides (card_id, benefit_id, period_key, used_amount, claimed, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(card_id, benefit_id, period_key) DO UPDATE SET
       used_amount=excluded.used_amount, claimed=excluded.claimed, note=excluded.note, updated_at=excluded.updated_at`
  ).bind(cardId, benefitId, periodKey, usedAmount, claimed, note, updatedAt).run();
