// Plaid REST client for Workers — plain fetch, no SDK (the Node SDK drags in axios).
// Mirrors server/src/plaid.js behavior exactly.
import * as db from './db.js';
import { canonicalTransaction, localId, PROVIDERS } from '../../shared/transactions.js';

const HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

export const plaidEnv = (env) => (env.PLAID_ENV || 'sandbox').toLowerCase();
export const plaidConfigured = (env) => Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET);

async function plaid(env, path, body) {
  if (!plaidConfigured(env)) {
    throw Object.assign(
      new Error('Plaid is not configured — set PLAID_CLIENT_ID and PLAID_SECRET worker secrets.'),
      { status: 503 }
    );
  }
  const res = await fetch((HOSTS[plaidEnv(env)] || HOSTS.sandbox) + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID,
      'PLAID-SECRET': env.PLAID_SECRET,
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error_message || `Plaid ${path} failed (${res.status})`), {
      status: res.status,
      detail: data,
    });
  }
  return data;
}

const csv = (s, fallback) => String(s || fallback).split(',').map((x) => x.trim()).filter(Boolean);

export async function createLinkToken(env, userId = 'credit-tracker-user') {
  const body = {
    user: { client_user_id: userId },
    client_name: 'Credit Tracker',
    products: csv(env.PLAID_PRODUCTS, 'transactions').map((p) => p.toLowerCase()),
    country_codes: csv(env.PLAID_COUNTRY_CODES, 'US').map((c) => c.toUpperCase()),
    language: 'en',
  };
  // Needed for OAuth institutions (Amex/Chase/Citi) — must match a URI registered in the Plaid dashboard.
  if (env.PLAID_REDIRECT_URI) body.redirect_uri = env.PLAID_REDIRECT_URI;
  return (await plaid(env, '/link/token/create', body)).link_token;
}

export async function exchangePublicToken(env, publicToken) {
  const data = await plaid(env, '/item/public_token/exchange', { public_token: publicToken });
  return { accessToken: data.access_token, itemId: data.item_id };
}

export async function fetchInstitution(env, accessToken) {
  try {
    const item = await plaid(env, '/item/get', { access_token: accessToken });
    const institutionId = item.item.institution_id;
    if (!institutionId) return { institutionId: null, institutionName: null };
    const inst = await plaid(env, '/institutions/get_by_id', {
      institution_id: institutionId,
      country_codes: csv(env.PLAID_COUNTRY_CODES, 'US').map((c) => c.toUpperCase()),
    });
    return { institutionId, institutionName: inst.institution.name };
  } catch {
    return { institutionId: null, institutionName: null };
  }
}

export async function fetchAccounts(env, accessToken) {
  return (await plaid(env, '/accounts/get', { access_token: accessToken })).accounts;
}

export function accountRecord(account, itemId, existing = null) {
  return {
    accountId: existing?.account_id || localId(PROVIDERS.PLAID, account.account_id),
    provider: PROVIDERS.PLAID,
    externalAccountId: account.account_id,
    itemId,
    name: account.name,
    officialName: account.official_name,
    mask: account.mask,
    type: account.type,
    subtype: account.subtype,
  };
}

function categoryOf(txn) {
  if (txn.personal_finance_category?.primary) return txn.personal_finance_category.primary;
  if (Array.isArray(txn.category) && txn.category.length) return txn.category[0];
  return null;
}

/** transactions/sync loop: persist added/modified/removed, advance the cursor. */
export async function syncItem(env, item) {
  let cursor = item.cursor || undefined;
  let added = 0;
  let modified = 0;
  let removed = 0;
  let hasMore = true;
  const accountMap = new Map(
    (await db.listAccountsByItem(env.DB, item.item_id))
      .map((account) => [account.external_account_id || account.account_id, account.account_id])
  );

  while (hasMore) {
    const data = await plaid(env, '/transactions/sync', {
      access_token: item.access_token,
      ...(cursor ? { cursor } : {}),
      count: 500,
    });

    for (const t of [...data.added, ...data.modified]) {
      const accountId = accountMap.get(t.account_id);
      if (!accountId) throw new Error(`Plaid transaction references unknown account ${t.account_id}`);
      await db.upsertTxn(env.DB, canonicalTransaction({
        provider: PROVIDERS.PLAID,
        externalTransactionId: t.transaction_id,
        transactionId: localId(PROVIDERS.PLAID, t.transaction_id),
        accountId,
        itemId: item.item_id,
        date: t.date,
        name: t.name,
        merchantName: t.merchant_name,
        amount: t.amount,
        isoCurrency: t.iso_currency_code,
        category: categoryOf(t),
        pending: t.pending,
        raw: t,
      }));
    }
    added += data.added.length;
    modified += data.modified.length;
    for (const r of data.removed) {
      await db.deleteTxnByExternal(env.DB, PROVIDERS.PLAID, r.transaction_id);
      removed++;
    }

    cursor = data.next_cursor;
    hasMore = data.has_more;
  }

  await db.setCursor(env.DB, item.item_id, cursor, new Date().toISOString());
  return { added, modified, removed };
}

export async function removeItem(env, accessToken) {
  try {
    await plaid(env, '/item/remove', { access_token: accessToken });
  } catch {
    // best-effort; still delete locally
  }
}
