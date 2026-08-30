// Stripe Financial Connections REST client for Cloudflare Workers.
// Uses direct fetch calls so the Worker does not need the Node Stripe SDK.
import * as db from './db.js';
import { todayYMD } from '../../shared/benefits-core.js';
import {
  canonicalTransaction,
  localId,
  parseProviderData,
  PROVIDERS,
} from '../../shared/transactions.js';

const API_BASE = 'https://api.stripe.com/v1';
const DEFAULT_API_VERSION = '2026-08-26.dahlia';
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
const encoder = new TextEncoder();

const stripeError = (status, message, code, detail) =>
  Object.assign(new Error(message), { status, code, detail });

function keyMode(value, kind) {
  const match = String(value || '').match(kind === 'publishable'
    ? /^pk_(test|live)_/
    : /^(?:sk|rk)_(test|live)_/);
  return match?.[1] || null;
}

export function stripeStatus(env) {
  const missing = [];
  const secretMode = keyMode(env.STRIPE_SECRET_KEY, 'secret');
  const publishableMode = keyMode(env.STRIPE_PUBLISHABLE_KEY, 'publishable');
  if (!env.STRIPE_SECRET_KEY) missing.push('STRIPE_SECRET_KEY');
  else if (!secretMode) missing.push('valid STRIPE_SECRET_KEY');
  if (!env.STRIPE_PUBLISHABLE_KEY) missing.push('STRIPE_PUBLISHABLE_KEY');
  else if (!publishableMode) missing.push('valid STRIPE_PUBLISHABLE_KEY');
  if (secretMode && publishableMode && secretMode !== publishableMode) {
    missing.push('matching Stripe key modes');
  }
  return {
    configured: missing.length === 0,
    environment: secretMode || publishableMode || 'test',
    publishableKey: env.STRIPE_PUBLISHABLE_KEY || '',
    webhookConfigured: Boolean(env.STRIPE_WEBHOOK_SECRET),
    apiVersion: env.STRIPE_API_VERSION || DEFAULT_API_VERSION,
    missing,
  };
}

function appendParams(search, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      search.append(key, String(entry));
    }
  }
  return search;
}

async function stripeRequest(env, path, options = {}) {
  const status = stripeStatus(env);
  if (!status.configured) {
    throw stripeError(503, `Stripe is not configured: ${status.missing.join(', ')}`);
  }
  const method = options.method || 'GET';
  const params = appendParams(new URLSearchParams(), options.params);
  const url = method === 'GET' && params.size
    ? `${API_BASE}${path}?${params}`
    : `${API_BASE}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': status.apiVersion,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
    },
    body: method === 'POST' ? params.toString() : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const upstream = payload?.error || {};
    throw stripeError(
      response.status,
      upstream.message || `Stripe ${path} failed (${response.status})`,
      upstream.code ? `stripe.${upstream.code}` : 'stripe.request_failed',
      {
        type: upstream.type,
        param: upstream.param,
        requestId: response.headers.get('request-id'),
      }
    );
  }
  return payload;
}

const safeIdempotencyPart = (value) =>
  String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 180);

export const createCustomer = (env, idempotencySeed) => {
  const seed = safeIdempotencyPart(idempotencySeed);
  return stripeRequest(env, '/customers', {
    method: 'POST',
    idempotencyKey: `credit-tracker-customer-${seed}`,
    params: {
      description: 'Credit Tracker Financial Connections user',
      'metadata[integration]': 'credit-tracker',
    },
  });
};

export async function createSession(env, idempotencySeed, existingCustomerId = null) {
  const seed = safeIdempotencyPart(idempotencySeed);
  const customer = existingCustomerId
    ? { id: existingCustomerId }
    : await createCustomer(env, seed);
  const countries = String(env.STRIPE_COUNTRY_CODES || 'US')
    .split(',')
    .map((country) => country.trim().toUpperCase())
    .filter(Boolean);
  const session = await stripeRequest(env, '/financial_connections/sessions', {
    method: 'POST',
    idempotencyKey: `credit-tracker-session-${seed}`,
    params: {
      'account_holder[type]': 'customer',
      'account_holder[customer]': customer.id,
      'permissions[]': ['transactions'],
      'prefetch[]': ['transactions'],
      'filters[account_subcategories][]': ['credit_card'],
      'filters[countries][]': countries,
    },
  });
  return {
    clientSecret: session.client_secret,
    customerId: customer.id,
    sessionId: session.id,
  };
}

export const retrieveSession = (env, sessionId) =>
  stripeRequest(env, `/financial_connections/sessions/${encodeURIComponent(sessionId)}`);

export function validateCollectedSession(session, expectedSessionId) {
  if (session?.object !== 'financial_connections.session' || session.id !== expectedSessionId) {
    throw stripeError(
      409,
      'Stripe did not return the expected Financial Connections session',
      'stripe.session_mismatch'
    );
  }
  if (session.account_holder?.type !== 'customer' || !session.account_holder.customer) {
    throw stripeError(409, 'Stripe session has an invalid account holder', 'stripe.account_holder_invalid');
  }
  if (!session.permissions?.includes('transactions')) {
    throw stripeError(409, 'Stripe session did not grant transaction access', 'stripe.permission_missing');
  }
  if (!session.filters?.account_subcategories?.includes('credit_card')) {
    throw stripeError(409, 'Stripe session was not restricted to credit cards', 'stripe.filter_missing');
  }
  return session;
}

export const eligibleCreditCardAccounts = (accounts) => (accounts || []).filter((account) =>
  account.subcategory === 'credit_card'
    && account.status === 'active'
    && Array.isArray(account.permissions)
    && account.permissions.includes('transactions')
);

export async function listSessionAccounts(env, session) {
  const accounts = [...(session?.accounts?.data || [])];
  if (!session?.accounts?.has_more) return accounts;
  let startingAfter = accounts.at(-1)?.id;
  for (let page = 0; page < MAX_PAGES && startingAfter; page++) {
    const response = await stripeRequest(env, '/financial_connections/accounts', {
      params: { session: session.id, limit: PAGE_SIZE, starting_after: startingAfter },
    });
    const rows = Array.isArray(response.data) ? response.data : [];
    accounts.push(...rows);
    if (!response.has_more) return accounts;
    const next = rows.at(-1)?.id;
    if (!next || next === startingAfter) throw new Error('Stripe account pagination did not advance');
    startingAfter = next;
  }
  throw new Error('Stripe account pagination exceeded 100 pages');
}

export function accountRecord(account, itemId, existing = null) {
  return {
    accountId: existing?.account_id || localId(PROVIDERS.STRIPE, account.id),
    provider: PROVIDERS.STRIPE,
    externalAccountId: account.id,
    itemId,
    name: account.display_name || account.institution_name || 'Credit card',
    officialName: account.institution_name || account.display_name || null,
    mask: account.last4 || null,
    type: account.category || 'credit',
    subtype: account.subcategory || 'credit_card',
  };
}

function transactionDate(transaction, timeZone = 'UTC') {
  const seconds = Number(transaction.transacted_at);
  if (!Number.isFinite(seconds)) throw new Error('Stripe transaction is missing transacted_at');
  return todayYMD(new Date(seconds * 1000), timeZone);
}

export function normalizeTransaction(transaction, account, item, chargeSign, timeZone = 'UTC') {
  return canonicalTransaction({
    provider: PROVIDERS.STRIPE,
    externalTransactionId: transaction.id,
    transactionId: localId(PROVIDERS.STRIPE, transaction.id),
    accountId: account.account_id,
    itemId: item.item_id,
    date: transactionDate(transaction, timeZone),
    name: transaction.description,
    // Financial Connections exposes only description here. Keep the structured
    // merchant field empty so downstream/UI code cannot mistake it for enrichment.
    merchantName: null,
    amount: Number(transaction.amount) / 100,
    isoCurrency: transaction.currency,
    category: null,
    pending: transaction.status === 'pending',
    raw: transaction,
  }, { chargeSign });
}

async function listTransactions(env, externalAccountId, afterRefresh = null, maxRows = Infinity) {
  const transactions = [];
  let startingAfter = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await stripeRequest(env, '/financial_connections/transactions', {
      params: {
        account: externalAccountId,
        limit: Math.min(PAGE_SIZE, maxRows - transactions.length),
        starting_after: startingAfter,
        'transaction_refresh[after]': afterRefresh,
      },
    });
    const rows = Array.isArray(response.data) ? response.data : [];
    transactions.push(...rows);
    if (transactions.length >= maxRows) return transactions.slice(0, maxRows);
    if (!response.has_more) return transactions;
    const next = rows.at(-1)?.id;
    if (!next || next === startingAfter) throw new Error('Stripe transaction pagination did not advance');
    startingAfter = next;
  }
  throw new Error('Stripe transaction pagination exceeded 100 pages');
}

const retrieveAccount = (env, externalAccountId) =>
  stripeRequest(env, `/financial_connections/accounts/${encodeURIComponent(externalAccountId)}`);

export const subscribeToTransactions = (env, externalAccountId) =>
  stripeRequest(env, `/financial_connections/accounts/${encodeURIComponent(externalAccountId)}/subscribe`, {
    method: 'POST',
    params: { 'features[]': ['transactions'] },
  });

export async function subscribeItem(env, item) {
  const providerData = parseProviderData(item);
  if (providerData.transactionsSubscribed) {
    return { subscribed: true, refreshPending: Boolean(providerData.refreshPending), errors: [] };
  }
  const errors = [];
  const transactionSubscriptions = { ...(providerData.transactionSubscriptions || {}) };
  let refreshPending = false;
  const accounts = await db.listAccountsByItem(env.DB, item.item_id);
  for (const account of accounts) {
    if (transactionSubscriptions[account.external_account_id] === true) continue;
    try {
      const subscribed = await subscribeToTransactions(env, account.external_account_id);
      transactionSubscriptions[account.external_account_id] = true;
      refreshPending ||= subscribed.transaction_refresh?.status === 'pending';
    } catch (error) {
      transactionSubscriptions[account.external_account_id] = false;
      errors.push({ accountId: account.external_account_id, error: error.message });
    }
  }
  const subscribed = accounts.length > 0
    && accounts.every((account) => transactionSubscriptions[account.external_account_id] === true);
  await db.mergeItemProviderData(env.DB, item.item_id, {
    transactionsSubscribed: subscribed,
    transactionSubscriptions,
    subscriptionErrors: errors,
    lastSubscriptionAttemptAt: new Date().toISOString(),
    refreshPending: refreshPending || Boolean(providerData.refreshPending),
  });
  return { subscribed, refreshPending, errors };
}

const refreshTransactions = (env, externalAccountId) =>
  stripeRequest(env, `/financial_connections/accounts/${encodeURIComponent(externalAccountId)}/refresh`, {
    method: 'POST',
    params: { 'features[]': ['transactions'] },
  });

async function persistTransactions(env, item, account, afterRefresh) {
  const chargeSign = parseProviderData(item).chargeSign;
  const rows = await listTransactions(env, account.external_account_id, afterRefresh);
  const active = [];
  let voided = 0;
  for (const transaction of rows) {
    if (transaction.status === 'void') {
      await db.deleteTxnByExternal(env.DB, PROVIDERS.STRIPE, transaction.id);
      voided += 1;
    } else {
      active.push(normalizeTransaction(
        transaction,
        account,
        item,
        chargeSign,
        env.APP_TIME_ZONE || 'UTC'
      ));
    }
  }
  await db.upsertTxns(env.DB, active);
  return { fetched: active.length, voided };
}

export async function syncItem(env, item, options = {}) {
  const accounts = await db.listAccountsByItem(env.DB, item.item_id);
  const providerData = parseProviderData(item);
  const signConfirmed = ['positive', 'negative'].includes(providerData.chargeSign);
  const refreshCursors = { ...(providerData.transactionRefreshes || {}) };
  const accountStatuses = { ...(providerData.accountStatuses || {}) };
  let fetched = 0;
  let voided = 0;
  let completedRefreshes = 0;
  let pendingRefreshes = 0;
  let succeededRefreshes = 0;
  let failedRefreshes = 0;
  let refreshesStarted = 0;

  for (const account of accounts) {
    const remote = await retrieveAccount(env, account.external_account_id);
    accountStatuses[account.external_account_id] = remote.status;
    const refresh = remote.transaction_refresh;
    if (refresh?.status === 'succeeded') succeededRefreshes += 1;
    if (refresh?.status === 'failed') failedRefreshes += 1;
    if (refresh?.status === 'succeeded' && refresh.id && refreshCursors[account.external_account_id] !== refresh.id) {
      if (signConfirmed) {
        const result = await persistTransactions(
          env,
          item,
          account,
          refreshCursors[account.external_account_id] || null
        );
        fetched += result.fetched;
        voided += result.voided;
        completedRefreshes += 1;
        refreshCursors[account.external_account_id] = refresh.id;
      }
    }

    if (refresh?.status === 'pending') pendingRefreshes += 1;
    const nextRefresh = Number(refresh?.next_refresh_available_at);
    const refreshAvailable = !refresh
      || (Number.isFinite(nextRefresh) && nextRefresh <= Math.floor(Date.now() / 1000));
    if (options.requestRefresh && remote.status === 'active' && refresh?.status !== 'pending' && refreshAvailable) {
      await refreshTransactions(env, account.external_account_id);
      refreshesStarted += 1;
      pendingRefreshes += 1;
    }
  }

  await db.mergeItemProviderData(env.DB, item.item_id, {
    transactionRefreshes: refreshCursors,
    accountStatuses,
    refreshPending: pendingRefreshes > 0,
    ...(!signConfirmed && succeededRefreshes > 0
      ? { signSampleAvailableAt: new Date().toISOString() }
      : {}),
    lastRefreshCheckAt: new Date().toISOString(),
  });
  if (completedRefreshes > 0) {
    await db.setCursor(env.DB, item.item_id, null, new Date().toISOString());
  }
  const subscription = signConfirmed && providerData.transactionsSubscribed !== true
    ? await subscribeItem(env, await db.getItem(env.DB, item.item_id))
    : null;
  return {
    fetched,
    voided,
    completedRefreshes,
    pendingRefreshes,
    failedRefreshes,
    refreshesStarted,
    signConfirmationRequired: !signConfirmed,
    subscription,
  };
}

export async function sampleTransactions(env, item, limit = 10) {
  const accounts = await db.listAccountsByItem(env.DB, item.item_id);
  const output = [];
  let succeededRefreshes = 0;
  let pendingRefreshes = 0;
  let failedRefreshes = 0;
  for (const account of accounts) {
    const remote = await retrieveAccount(env, account.external_account_id);
    const refresh = remote.transaction_refresh;
    if (refresh?.status === 'pending' || !refresh) {
      pendingRefreshes += 1;
      continue;
    }
    if (refresh.status !== 'succeeded') {
      failedRefreshes += 1;
      continue;
    }
    succeededRefreshes += 1;
    const rows = await listTransactions(
      env,
      account.external_account_id,
      null,
      Math.max(1, limit - output.length)
    );
    for (const row of rows.filter((transaction) => transaction.status !== 'void')) {
      output.push({
        accountId: account.account_id,
        accountName: account.name,
        date: transactionDate(row, env.APP_TIME_ZONE || 'UTC'),
        description: row.description,
        amount: Number(row.amount) / 100,
        status: row.status,
      });
      if (output.length >= limit) return output;
    }
  }
  if (succeededRefreshes > 0) return output;
  if (pendingRefreshes > 0) {
    throw stripeError(
      409,
      'Stripe transaction history is still refreshing; try the sample again after it finishes',
      'stripe.refresh_pending'
    );
  }
  if (failedRefreshes > 0) {
    throw stripeError(
      409,
      'Stripe could not refresh transaction history; use Sync to retry when available',
      'stripe.refresh_failed'
    );
  }
  throw stripeError(409, 'Stripe returned no transaction refresh state', 'stripe.refresh_unavailable');
}

export async function removeItem(env, item) {
  for (const account of await db.listAccountsByItem(env.DB, item.item_id)) {
    try {
      const remote = await retrieveAccount(env, account.external_account_id);
      if (remote.status === 'disconnected') continue;
      await stripeRequest(
        env,
        `/financial_connections/accounts/${encodeURIComponent(account.external_account_id)}/disconnect`,
        { method: 'POST' }
      );
    } catch (error) {
      if (![404, 410].includes(error.status)) throw error;
    }
  }
}

function parseSignatureHeader(header) {
  const parts = String(header || '').split(',');
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  return { timestamp: Number(timestamp), signatures };
}

function constantTimeEqual(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

const hex = (bytes) => [...new Uint8Array(bytes)]
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('');

export async function verifyWebhook(env, rawBody, signatureHeader, nowSeconds = Date.now() / 1000) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw stripeError(503, 'STRIPE_WEBHOOK_SECRET is required for Stripe webhooks');
  }
  const { timestamp, signatures } = parseSignatureHeader(signatureHeader);
  if (!Number.isFinite(timestamp) || signatures.length === 0) {
    throw stripeError(400, 'Invalid Stripe-Signature header');
  }
  if (Math.abs(nowSeconds - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    throw stripeError(400, 'Stripe webhook timestamp is outside the five-minute tolerance');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.STRIPE_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const expected = hex(await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${timestamp}.${rawBody}`)
  ));
  if (!signatures.some((signature) => constantTimeEqual(signature, expected))) {
    throw stripeError(400, 'Stripe webhook signature verification failed');
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    throw stripeError(400, 'Stripe webhook body is not valid JSON');
  }
}

export function validateWebhookMode(env, event) {
  if (typeof event?.livemode !== 'boolean') {
    throw stripeError(400, 'Stripe webhook event is missing livemode');
  }
  const expectedLiveMode = stripeStatus(env).environment === 'live';
  if (event.livemode !== expectedLiveMode) {
    throw stripeError(400, 'Stripe webhook mode does not match the configured API keys');
  }
  return event;
}

export async function handleWebhookEvent(env, event) {
  const account = event?.data?.object;
  if (!account?.id || !String(event.type || '').startsWith('financial_connections.account.')) {
    return { ignored: true };
  }
  const localAccount = await db.getAccountByExternal(env.DB, PROVIDERS.STRIPE, account.id);
  if (!localAccount) return { ignored: true, reason: 'account not linked locally' };
  const item = await db.getItem(env.DB, localAccount.item_id);
  if (!item) return { ignored: true, reason: 'item not linked locally' };

  if (event.type === 'financial_connections.account.refreshed_transactions') {
    const providerData = parseProviderData(item);
    if (!['positive', 'negative'].includes(providerData.chargeSign)) {
      const refreshStatus = account.transaction_refresh?.status || 'unknown';
      await db.mergeItemProviderData(env.DB, item.item_id, {
        refreshPending: refreshStatus === 'pending',
        transactionRefreshStatuses: {
          ...(providerData.transactionRefreshStatuses || {}),
          [account.id]: refreshStatus,
        },
        ...(refreshStatus === 'succeeded'
          ? { signSampleAvailableAt: new Date().toISOString() }
          : {}),
      });
      return {
        synced: false,
        signConfirmationRequired: true,
        refreshStatus,
      };
    }
    return syncItem(env, item, { requestRefresh: false });
  }

  const statusEvents = new Map([
    ['financial_connections.account.deactivated', 'inactive'],
    ['financial_connections.account.reactivated', 'active'],
    ['financial_connections.account.disconnected', 'disconnected'],
  ]);
  if (statusEvents.has(event.type)) {
    const providerData = parseProviderData(item);
    await db.mergeItemProviderData(env.DB, item.item_id, {
      accountStatuses: {
        ...(providerData.accountStatuses || {}),
        [account.id]: account.status || statusEvents.get(event.type),
      },
    });
    return { updated: true, accountId: account.id, status: account.status || statusEvents.get(event.type) };
  }
  return { ignored: true };
}
