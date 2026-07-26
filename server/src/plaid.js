import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';
import { q } from './db.js';

const CLIENT_ID = process.env.PLAID_CLIENT_ID || '';
const SECRET = process.env.PLAID_SECRET || '';
const ENV = (process.env.PLAID_ENV || 'sandbox').toLowerCase();

export const plaidConfigured = Boolean(CLIENT_ID && SECRET);

export const plaidEnv = ENV;

export const countryCodes = (process.env.PLAID_COUNTRY_CODES || 'US')
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean)
  .map((c) => CountryCode[c] || c);

export const products = (process.env.PLAID_PRODUCTS || 'transactions')
  .split(',')
  .map((p) => p.trim().toLowerCase())
  .filter(Boolean)
  .map((p) => Products[p[0].toUpperCase() + p.slice(1)] || p);

let client = null;
if (plaidConfigured) {
  const configuration = new Configuration({
    basePath: PlaidEnvironments[ENV] || PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': CLIENT_ID,
        'PLAID-SECRET': SECRET,
      },
    },
  });
  client = new PlaidApi(configuration);
}

function requireClient() {
  if (!client) {
    const err = new Error(
      'Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET in .env (see .env.example).'
    );
    err.status = 503;
    throw err;
  }
  return client;
}

export async function createLinkToken(userId = 'credit-tracker-local-user') {
  const c = requireClient();
  const resp = await c.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: 'Credit Tracker',
    products,
    country_codes: countryCodes,
    language: 'en',
  });
  return resp.data.link_token;
}

export async function exchangePublicToken(publicToken) {
  const c = requireClient();
  const resp = await c.itemPublicTokenExchange({ public_token: publicToken });
  return { accessToken: resp.data.access_token, itemId: resp.data.item_id };
}

export async function fetchInstitution(accessToken) {
  const c = requireClient();
  try {
    const itemResp = await c.itemGet({ access_token: accessToken });
    const institutionId = itemResp.data.item.institution_id;
    if (!institutionId) return { institutionId: null, institutionName: null };
    const instResp = await c.institutionsGetById({
      institution_id: institutionId,
      country_codes: countryCodes,
    });
    return { institutionId, institutionName: instResp.data.institution.name };
  } catch {
    return { institutionId: null, institutionName: null };
  }
}

export async function fetchAccounts(accessToken) {
  const c = requireClient();
  const resp = await c.accountsGet({ access_token: accessToken });
  return resp.data.accounts;
}

function categoryOf(txn) {
  if (txn.personal_finance_category?.primary) return txn.personal_finance_category.primary;
  if (Array.isArray(txn.category) && txn.category.length) return txn.category[0];
  return null;
}

/**
 * Run Plaid transactions/sync for one item, persisting added/modified/removed,
 * and advancing the stored cursor. Returns counts.
 */
export async function syncItem(item) {
  const c = requireClient();
  let cursor = item.cursor || undefined;
  let added = 0;
  let modified = 0;
  let removed = 0;
  let hasMore = true;

  while (hasMore) {
    const resp = await c.transactionsSync({
      access_token: item.access_token,
      cursor,
      count: 500,
    });
    const data = resp.data;

    for (const t of data.added) {
      q.upsertTxn.run(
        t.transaction_id, t.account_id, item.item_id, t.date, t.name,
        t.merchant_name ?? null, t.amount, t.iso_currency_code ?? null,
        categoryOf(t), t.pending ? 1 : 0, JSON.stringify(t)
      );
      added++;
    }
    for (const t of data.modified) {
      q.upsertTxn.run(
        t.transaction_id, t.account_id, item.item_id, t.date, t.name,
        t.merchant_name ?? null, t.amount, t.iso_currency_code ?? null,
        categoryOf(t), t.pending ? 1 : 0, JSON.stringify(t)
      );
      modified++;
    }
    for (const r of data.removed) {
      q.deleteTxn.run(r.transaction_id);
      removed++;
    }

    cursor = data.next_cursor;
    hasMore = data.has_more;
  }

  q.setCursor.run(cursor, new Date().toISOString(), item.item_id);
  return { added, modified, removed };
}

export async function removeItem(accessToken) {
  const c = requireClient();
  try {
    await c.itemRemove({ access_token: accessToken });
  } catch {
    // best-effort; still delete locally
  }
}
