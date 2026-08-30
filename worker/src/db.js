// D1 query helpers. Local primary keys are stable app ids; provider/external ids
// preserve the upstream identity and prevent Plaid, Teller, and CSV collisions.
const all = async (stmt) => (await stmt.all()).results;

const chunks = (rows, size = 50) => {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};

// items
export const listItems = (DB) => all(DB.prepare('SELECT * FROM items ORDER BY created_at'));
export const listItemsByProvider = (DB, provider) =>
  all(DB.prepare('SELECT * FROM items WHERE provider = ? ORDER BY created_at').bind(provider));
export const getItem = (DB, id) => DB.prepare('SELECT * FROM items WHERE item_id = ?').bind(id).first();
export const getItemByExternal = (DB, provider, externalId) =>
  DB.prepare('SELECT * FROM items WHERE provider = ? AND external_item_id = ?')
    .bind(provider, externalId).first();

export const insertItem = (DB, item) =>
  DB.prepare(
    `INSERT INTO items
       (item_id, provider, external_item_id, access_token, institution_id,
        institution_name, cursor, provider_data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(provider, external_item_id) DO UPDATE SET
       access_token=excluded.access_token,
       institution_id=excluded.institution_id,
       institution_name=excluded.institution_name,
       provider_data=COALESCE(excluded.provider_data, items.provider_data)`
  ).bind(
    item.itemId,
    item.provider,
    item.externalItemId,
    item.accessToken,
    item.institutionId ?? null,
    item.institutionName ?? null,
    item.providerData ? JSON.stringify(item.providerData) : null,
    item.createdAt
  ).run();

export const deleteItem = (DB, id) => DB.prepare('DELETE FROM items WHERE item_id = ?').bind(id).run();
export const setCursor = (DB, itemId, cursor, syncedAt) =>
  DB.prepare('UPDATE items SET cursor = ?, last_synced_at = ? WHERE item_id = ?')
    .bind(cursor ?? null, syncedAt, itemId).run();
export const setItemProviderData = (DB, itemId, data) =>
  DB.prepare('UPDATE items SET provider_data = ? WHERE item_id = ?')
    .bind(JSON.stringify(data || {}), itemId).run();
export const mergeItemProviderData = (DB, itemId, patch) =>
  DB.prepare(
    `UPDATE items
     SET provider_data = json_patch(COALESCE(provider_data, '{}'), ?)
     WHERE item_id = ?`
  ).bind(JSON.stringify(patch || {}), itemId).run();
export const setItemChargeSign = (DB, itemId, chargeSign, updatedAt) => DB.batch([
  // Read the current sign inside the same D1 transaction that performs the
  // inversion. Retried or concurrent requests for the same sign therefore do
  // not flip stored transactions twice. A missing Stripe sign means negative.
  DB.prepare(
    `UPDATE transactions
     SET amount = -amount
     WHERE item_id = ?
       AND COALESCE(
         json_extract((SELECT provider_data FROM items WHERE item_id = ?), '$.chargeSign'),
         'negative'
       ) <> ?`
  ).bind(itemId, itemId, chargeSign),
  DB.prepare(
    `UPDATE items
     SET provider_data = json_patch(COALESCE(provider_data, '{}'), ?)
     WHERE item_id = ?`
  ).bind(JSON.stringify({
    chargeSign,
    chargeSignSource: 'user',
    chargeSignUpdatedAt: updatedAt,
    // Force the next sync to replay all history available from Stripe. JSON
    // merge-patch removes this key when its value is null.
    transactionRefreshes: null,
  }), itemId),
]);

// accounts
export const upsertAccount = (DB, account) =>
  DB.prepare(
    `INSERT INTO accounts
       (account_id, provider, external_account_id, item_id, name, official_name, mask, type, subtype)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, external_account_id) DO UPDATE SET
       item_id=excluded.item_id, name=excluded.name, official_name=excluded.official_name,
       mask=excluded.mask, type=excluded.type, subtype=excluded.subtype`
  ).bind(
    account.accountId,
    account.provider,
    account.externalAccountId,
    account.itemId,
    account.name ?? null,
    account.officialName ?? null,
    account.mask ?? null,
    account.type ?? null,
    account.subtype ?? null
  ).run();

export const listAccounts = (DB) => all(DB.prepare('SELECT * FROM accounts ORDER BY name'));
export const listAccountsByItem = (DB, itemId) =>
  all(DB.prepare('SELECT * FROM accounts WHERE item_id = ? ORDER BY name').bind(itemId));
export const getAccount = (DB, id) => DB.prepare('SELECT * FROM accounts WHERE account_id = ?').bind(id).first();
export const getAccountByExternal = (DB, provider, externalId) =>
  DB.prepare('SELECT * FROM accounts WHERE provider = ? AND external_account_id = ?')
    .bind(provider, externalId).first();
export const deleteAccountsByItem = (DB, itemId) =>
  DB.prepare('DELETE FROM accounts WHERE item_id = ?').bind(itemId).run();

export async function rebindProviderAccounts(DB, provider, bindings) {
  if (!bindings.length) return [];
  const statements = [];
  for (const binding of bindings) {
    statements.push(
      // D1 rolls a batch back only when a statement fails. Make a stale
      // precondition fail inside the transaction instead of discovering a
      // zero-row UPDATE after the batch has already committed. json_extract
      // is evaluated only when either stable row is no longer bound to the
      // expected old (or idempotently, target) external id.
      DB.prepare(
        `SELECT CASE WHEN
           EXISTS (
             SELECT 1 FROM items
             WHERE item_id = ? AND provider = ? AND external_item_id IN (?, ?)
           )
           AND EXISTS (
             SELECT 1 FROM accounts
             WHERE account_id = ? AND provider = ? AND item_id = ?
               AND external_account_id IN (?, ?)
           )
         THEN 1 ELSE json_extract('provider account rebind precondition failed', '$') END
         AS rebind_guard`
      ).bind(
        binding.itemId,
        provider,
        binding.previousExternalAccountId,
        binding.externalAccountId,
        binding.account.accountId,
        provider,
        binding.itemId,
        binding.previousExternalAccountId,
        binding.externalAccountId
      ),
      DB.prepare(
        `UPDATE items
         SET external_item_id = ?, institution_name = ?, provider_data = ?
         WHERE item_id = ? AND provider = ? AND external_item_id IN (?, ?)`
      ).bind(
        binding.externalAccountId,
        binding.institutionName,
        JSON.stringify(binding.providerData || {}),
        binding.itemId,
        provider,
        binding.previousExternalAccountId,
        binding.externalAccountId
      ),
      DB.prepare(
        `UPDATE accounts
         SET external_account_id = ?, item_id = ?, name = ?, official_name = ?,
             mask = ?, type = ?, subtype = ?
         WHERE account_id = ? AND provider = ? AND item_id = ?
           AND external_account_id IN (?, ?)`
      ).bind(
        binding.account.externalAccountId,
        binding.account.itemId,
        binding.account.name ?? null,
        binding.account.officialName ?? null,
        binding.account.mask ?? null,
        binding.account.type ?? null,
        binding.account.subtype ?? null,
        binding.account.accountId,
        provider,
        binding.itemId,
        binding.previousExternalAccountId,
        binding.externalAccountId
      )
    );
  }
  let results;
  try {
    results = await DB.batch(statements);
  } catch (error) {
    if (/malformed JSON/i.test(error.message)) {
      throw Object.assign(
        new Error('Provider account rebind state changed before it could be committed; no rows were updated'),
        { status: 409, code: `${provider}.relink_rebind_conflict` }
      );
    }
    throw error;
  }
  const incomplete = bindings.some((_, index) => (
    Number(results[index * 3 + 1]?.meta?.changes || 0) !== 1
      || Number(results[index * 3 + 2]?.meta?.changes || 0) !== 1
  ));
  if (incomplete) {
    throw new Error('Provider account rebind did not update every expected item and account');
  }
  return results;
}

// transactions
const txnStatement = (DB, txn) =>
  DB.prepare(
    `INSERT INTO transactions
       (transaction_id, provider, external_transaction_id, account_id, item_id, date,
        name, merchant_name, amount, iso_currency, category, pending, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, external_transaction_id) DO UPDATE SET
       account_id=excluded.account_id, item_id=excluded.item_id, date=excluded.date,
       name=excluded.name, merchant_name=excluded.merchant_name, amount=excluded.amount,
       iso_currency=excluded.iso_currency, category=excluded.category,
       pending=excluded.pending, raw=excluded.raw`
  ).bind(
    txn.transactionId,
    txn.provider,
    txn.externalTransactionId,
    txn.accountId,
    txn.itemId,
    txn.date,
    txn.name ?? null,
    txn.merchantName ?? null,
    txn.amount,
    txn.isoCurrency ?? null,
    txn.category ?? null,
    txn.pending ? 1 : 0,
    txn.raw ?? null
  );

export const upsertTxn = (DB, txn) => txnStatement(DB, txn).run();
export const upsertTxns = async (DB, txns) => {
  for (const group of chunks(txns)) await DB.batch(group.map((txn) => txnStatement(DB, txn)));
};
export const deleteTxn = (DB, id) =>
  DB.prepare('DELETE FROM transactions WHERE transaction_id = ?').bind(id).run();
export const deleteTxnByExternal = (DB, provider, externalId) =>
  DB.prepare('DELETE FROM transactions WHERE provider = ? AND external_transaction_id = ?')
    .bind(provider, externalId).run();
export const deleteTxnsByItem = (DB, itemId) =>
  DB.prepare('DELETE FROM transactions WHERE item_id = ?').bind(itemId).run();
export const countTransactionsByItem = async (DB, itemId) => {
  const row = await DB.prepare('SELECT COUNT(*) AS count FROM transactions WHERE item_id = ?')
    .bind(itemId).first();
  return Number(row?.count || 0);
};
export const deletePendingTxnsInWindow = (DB, accountId, start, end) =>
  DB.prepare(
    'DELETE FROM transactions WHERE account_id = ? AND pending = 1 AND date >= ? AND date <= ?'
  ).bind(accountId, start, end).run();
export const txnsForAccountBetween = (DB, accountId, start, end) =>
  all(DB.prepare(
    'SELECT * FROM transactions WHERE account_id = ? AND date >= ? AND date <= ? ORDER BY date DESC'
  ).bind(accountId, start, end));
export const txnsForAccount = (DB, accountId, limit) =>
  all(DB.prepare('SELECT * FROM transactions WHERE account_id = ? ORDER BY date DESC LIMIT ?')
    .bind(accountId, limit));

// cards
export const insertCard = async (DB, accountId, productKey, displayName, createdAt) => {
  const r = await DB.prepare(
    'INSERT INTO cards (account_id, product_key, display_name, created_at) VALUES (?, ?, ?, ?)'
  ).bind(accountId, productKey, displayName, createdAt).run();
  return r.meta.last_row_id;
};
export const listCards = (DB) => all(DB.prepare('SELECT * FROM cards ORDER BY created_at'));
export const getCard = (DB, id) => DB.prepare('SELECT * FROM cards WHERE id = ?').bind(id).first();
export const getCardByAccount = (DB, accountId) =>
  DB.prepare('SELECT * FROM cards WHERE account_id = ?').bind(accountId).first();
export const updateCardAccount = (DB, id, accountId) =>
  DB.prepare('UPDATE cards SET account_id = ? WHERE id = ?').bind(accountId, id).run();
export const updateCardProduct = (DB, id, productKey) =>
  DB.prepare('UPDATE cards SET product_key = ? WHERE id = ?').bind(productKey, id).run();
export const deleteCard = (DB, id) => DB.prepare('DELETE FROM cards WHERE id = ?').bind(id).run();
export const unlinkCardsOfAccounts = (DB, itemId) =>
  DB.prepare(
    'UPDATE cards SET account_id = NULL WHERE account_id IN (SELECT account_id FROM accounts WHERE item_id = ?)'
  ).bind(itemId).run();

// Teller Connect nonces
export const putLinkNonce = async (DB, nonceHash, sessionHash, provider, expiresAt, createdAt) => {
  await DB.prepare('DELETE FROM link_nonces WHERE expires_at < ?').bind(Date.now()).run();
  return DB.prepare(
    'INSERT INTO link_nonces (nonce_hash, session_hash, provider, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(nonceHash, sessionHash, provider, expiresAt, createdAt).run();
};
export const consumeLinkNonce = async (DB, nonceHash, sessionHash, provider) => {
  const result = await DB.prepare(
    `DELETE FROM link_nonces
     WHERE nonce_hash = ? AND session_hash = ? AND provider = ? AND expires_at >= ?`
  ).bind(nonceHash, sessionHash, provider, Date.now()).run();
  return Number(result.meta?.changes || 0) === 1;
};

// durable provider identity
export const getProviderProfile = (DB, provider) =>
  DB.prepare('SELECT * FROM provider_profiles WHERE provider = ?').bind(provider).first();
export const putProviderProfileIfAbsent = async (DB, provider, externalId, timestamp) => {
  await DB.prepare(
    `INSERT OR IGNORE INTO provider_profiles (provider, external_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).bind(provider, externalId, timestamp, timestamp).run();
  return getProviderProfile(DB, provider);
};

// benefit overrides
export const getOverride = (DB, cardId, benefitId, periodKey) =>
  DB.prepare(
    'SELECT * FROM benefit_overrides WHERE card_id = ? AND benefit_id = ? AND period_key = ?'
  ).bind(cardId, benefitId, periodKey).first();
export const listOverridesByCard = (DB, cardId) =>
  all(DB.prepare('SELECT * FROM benefit_overrides WHERE card_id = ?').bind(cardId));
export const upsertOverride = (DB, cardId, benefitId, periodKey, usedAmount, claimed, note, updatedAt) =>
  DB.prepare(
    `INSERT INTO benefit_overrides (card_id, benefit_id, period_key, used_amount, claimed, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(card_id, benefit_id, period_key) DO UPDATE SET
       used_amount=excluded.used_amount, claimed=excluded.claimed,
       note=excluded.note, updated_at=excluded.updated_at`
  ).bind(cardId, benefitId, periodKey, usedAmount, claimed, note, updatedAt).run();
