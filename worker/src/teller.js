import * as db from './db.js';
import {
  canonicalTransaction,
  localId,
  parseProviderData,
  PROVIDERS,
} from '../../shared/transactions.js';

const API_BASE = 'https://api.teller.io';
const PAGE_SIZE = 100;
const OVERLAP_DAYS = 10;
const VALID_ENVIRONMENTS = new Set(['sandbox', 'development', 'production']);

export const tellerEnv = (env) => String(env.TELLER_ENV || 'sandbox').toLowerCase();

export function tellerStatus(env) {
  const environment = tellerEnv(env);
  const missing = [];
  if (!VALID_ENVIRONMENTS.has(environment)) missing.push('valid TELLER_ENV');
  if (!env.TELLER_APPLICATION_ID) missing.push('TELLER_APPLICATION_ID');
  if (!env.TELLER_TOKEN_SIGNING_KEY) missing.push('TELLER_TOKEN_SIGNING_KEY');
  if (!env.TOKEN_ENCRYPTION_KEY) missing.push('TOKEN_ENCRYPTION_KEY');
  if (environment !== 'sandbox' && typeof env.TELLER_MTLS?.fetch !== 'function') {
    missing.push('TELLER_MTLS binding');
  }
  return { configured: missing.length === 0, environment, missing };
}

function tellerFetcher(env) {
  const environment = tellerEnv(env);
  if (!VALID_ENVIRONMENTS.has(environment)) {
    throw Object.assign(new Error('TELLER_ENV must be sandbox, development, or production'), { status: 503 });
  }
  if (typeof env.TELLER_MTLS?.fetch === 'function') return env.TELLER_MTLS.fetch.bind(env.TELLER_MTLS);
  if (environment === 'sandbox') return fetch;
  throw Object.assign(new Error('TELLER_MTLS binding is required outside sandbox'), { status: 503 });
}

async function tellerRequest(env, accessToken, path, init = {}) {
  if (!accessToken) throw new Error('Teller access token is required');
  const res = await tellerFetcher(env)(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${btoa(`${accessToken}:`)}`,
      ...(init.headers || {}),
    },
  });
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || data?.message || data?.error || `Teller ${path} failed (${res.status})`;
    throw Object.assign(new Error(String(message)), { status: res.status, detail: data });
  }
  return data;
}

export const fetchAccounts = (env, accessToken) => tellerRequest(env, accessToken, '/accounts');

export function supportsCreditTransactions(account) {
  return account?.type === 'credit'
    && account?.subtype === 'credit_card'
    && Boolean(account?.links?.transactions);
}

export function accountRecord(account, itemId, existing = null) {
  return {
    accountId: existing?.account_id || localId(PROVIDERS.TELLER, account.id),
    provider: PROVIDERS.TELLER,
    externalAccountId: account.id,
    itemId,
    name: account.name,
    officialName: account.name,
    mask: account.last_four,
    type: account.type,
    subtype: account.subtype,
  };
}

const ymd = (date) => date.toISOString().slice(0, 10);

function syncWindow(env, item) {
  const end = new Date();
  const start = item.last_synced_at ? new Date(item.last_synced_at) : new Date(end);
  if (Number.isNaN(start.getTime())) start.setTime(end.getTime());
  const initialDays = Math.min(730, Math.max(30, Number(env.TELLER_INITIAL_DAYS) || 400));
  start.setUTCDate(start.getUTCDate() - (item.last_synced_at ? OVERLAP_DAYS : initialDays));
  return { start: ymd(start), end: ymd(end) };
}

async function fetchTransactionWindow(env, accessToken, externalAccountId, start, end, maxRows = Infinity) {
  const transactions = [];
  let fromId = null;
  const seenPages = new Set();

  for (let page = 0; page < 100; page++) {
    const params = new URLSearchParams({
      start_date: start,
      end_date: end,
      count: String(Math.min(PAGE_SIZE, maxRows)),
    });
    if (fromId) params.set('from_id', fromId);
    const rows = await tellerRequest(
      env,
      accessToken,
      `/accounts/${encodeURIComponent(externalAccountId)}/transactions?${params}`
    );
    if (!Array.isArray(rows)) throw new Error('Teller transactions response was not an array');
    transactions.push(...rows);
    if (transactions.length >= maxRows) return transactions.slice(0, maxRows);
    if (rows.length < PAGE_SIZE) return transactions;
    const next = rows.at(-1)?.id;
    if (!next || seenPages.has(next)) throw new Error('Teller pagination did not advance');
    seenPages.add(next);
    fromId = next;
  }
  throw new Error('Teller transaction pagination exceeded 100 pages');
}

export async function sampleTransactions(env, item, limit = 10) {
  const accounts = await db.listAccountsByItem(env.DB, item.item_id);
  const output = [];
  const end = new Date();
  const start = new Date(end);
  const sampleDays = Math.min(730, Math.max(30, Number(env.TELLER_INITIAL_DAYS) || 400));
  start.setUTCDate(start.getUTCDate() - sampleDays);
  for (const account of accounts) {
    const rows = await fetchTransactionWindow(
      env,
      item.access_token,
      account.external_account_id,
      ymd(start),
      ymd(end),
      Math.max(1, limit - output.length)
    );
    for (const row of rows.slice(0, Math.max(0, limit - output.length))) {
      output.push({
        accountId: account.account_id,
        accountName: account.name,
        date: row.date,
        description: row.details?.counterparty?.name || row.description,
        amount: row.amount,
        type: row.type,
        status: row.status,
      });
    }
    if (output.length >= limit) break;
  }
  return output;
}

export async function syncItem(env, item) {
  const providerData = parseProviderData(item);
  const chargeSign = providerData.chargeSign;
  if (!['positive', 'negative'].includes(chargeSign)) {
    throw Object.assign(
      new Error('Confirm whether Teller credit-card purchases are positive or negative before syncing'),
      { status: 409, code: 'teller.sign_confirmation_required' }
    );
  }

  const accounts = await db.listAccountsByItem(env.DB, item.item_id);
  if (accounts.length === 0) {
    throw Object.assign(
      new Error('This Teller enrollment has no credit-card account with transaction access; repair it before syncing'),
      { status: 409, code: 'teller.credit_transactions_unavailable' }
    );
  }
  const window = syncWindow(env, item);
  let fetched = 0;
  let pending = 0;

  for (const account of accounts) {
    const rows = await fetchTransactionWindow(
      env,
      item.access_token,
      account.external_account_id,
      window.start,
      window.end
    );
    const normalized = rows.map((row) => canonicalTransaction({
      provider: PROVIDERS.TELLER,
      externalTransactionId: row.id,
      transactionId: localId(PROVIDERS.TELLER, row.id),
      accountId: account.account_id,
      itemId: item.item_id,
      date: row.date,
      name: row.description,
      merchantName: row.details?.counterparty?.name,
      amount: row.amount,
      isoCurrency: 'USD',
      category: row.details?.category,
      pending: row.status === 'pending',
      raw: row,
    }, { chargeSign }));

    // Teller recommends a 7-10 day overlap. Re-read pending rows from that full
    // window because a materially changed pending transaction may receive a new id.
    await db.deletePendingTxnsInWindow(env.DB, account.account_id, window.start, window.end);
    await db.upsertTxns(env.DB, normalized);
    fetched += normalized.length;
    pending += normalized.filter((row) => row.pending).length;
  }

  const syncedAt = new Date().toISOString();
  await db.setCursor(env.DB, item.item_id, window.start, syncedAt);
  return { fetched, pending, windowStart: window.start, windowEnd: window.end };
}

export async function removeItem(env, item) {
  try {
    await tellerRequest(env, item.access_token, '/accounts', { method: 'DELETE' });
  } catch (error) {
    if (![404, 410].includes(error.status)) throw error;
  }
}
