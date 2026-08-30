// Credit Tracker API on Cloudflare Workers + D1.
// UI lives on GitHub Pages; auth = Google Sign-In (email allowlist), no passwords stored.
import catalogRaw from '../../shared/catalog.json';
import { statusForCard, todayYMD } from '../../shared/benefits-core.js';
import {
  canonicalTransaction,
  localId,
  parseProviderData,
  PROVIDERS,
} from '../../shared/transactions.js';
import * as db from './db.js';
import * as plaid from './plaid.js';
import * as providers from './providers.js';
import * as stripe from './stripe.js';
import * as teller from './teller.js';
import { devMode, isAuthed, makeSession, verifyGoogleCredential } from './auth.js';
import { randomToken, sha256Hex } from './secrets.js';
import { verifyTellerEnrollment } from './teller-crypto.js';

const products = catalogRaw.products || [];
const LINK_NONCE_TTL_MS = 10 * 60 * 1000;
const appToday = (env) => todayYMD(new Date(), env.APP_TIME_ZONE || 'UTC');

function corsHeaders(env, req) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && (allowed.includes(origin) || devMode(env))) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

async function readJson(req) {
  return req.json().catch(() => ({}));
}

const httpError = (status, message, code, detail) =>
  Object.assign(new Error(message), { status, code, detail });

const decodeId = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw httpError(400, 'invalid id');
  }
};

const sessionHash = (req) => sha256Hex(req.headers.get('Authorization') || 'development-session');

function itemView(item, accounts) {
  const provider = item.provider || PROVIDERS.PLAID;
  const data = parseProviderData(item);
  const transactionsSupported = provider !== PROVIDERS.TELLER
    || data.creditTransactionsSupported !== false;
  const inactiveStripeAccounts = provider === PROVIDERS.STRIPE
    ? Object.values(data.accountStatuses || {}).filter((status) => status !== 'active').length
    : 0;
  return {
    itemId: item.item_id,
    externalItemId: item.external_item_id || item.item_id,
    provider,
    institutionName: item.institution_name,
    createdAt: item.created_at,
    lastSyncedAt: item.last_synced_at,
    transactionsSupported,
    capabilityWarning: transactionsSupported ? null : data.capabilityWarning,
    refreshPending: provider === PROVIDERS.STRIPE && Boolean(data.refreshPending),
    subscriptionWarning: provider === PROVIDERS.STRIPE && Array.isArray(data.subscriptionErrors)
      && data.subscriptionErrors.length > 0
      ? 'Stripe daily refresh subscription failed for at least one account. Sync retries it automatically.'
      : null,
    accountWarning: inactiveStripeAccounts > 0
      ? `${inactiveStripeAccounts} Stripe account(s) need attention. Reconnect the card before relying on new transactions.`
      : null,
    dataQualityWarning: provider === PROVIDERS.STRIPE
      ? 'Stripe supplies only a bank description here, not structured merchant, category, or MCC data. Automatic matches may need manual confirmation.'
      : null,
    signConfirmationRequired: [PROVIDERS.TELLER, PROVIDERS.STRIPE].includes(provider)
      && transactionsSupported
      && !['positive', 'negative'].includes(data.chargeSign),
    accounts,
  };
}

async function handleStripeComplete(env, req, nonce, sessionId, now) {
  const stripeInfo = stripe.stripeStatus(env);
  if (!stripeInfo.configured) {
    throw httpError(503, `Stripe is not configured: ${stripeInfo.missing.join(', ')}`);
  }
  const session = stripe.validateCollectedSession(await stripe.retrieveSession(env, sessionId), sessionId);
  const rawAccounts = await stripe.listSessionAccounts(env, session);
  const accounts = stripe.eligibleCreditCardAccounts(rawAccounts);
  if (accounts.length === 0) {
    throw httpError(409, 'Stripe did not return an active credit-card account with transaction access');
  }

  const consumed = await db.consumeLinkNonce(
    env.DB,
    await sha256Hex(`${nonce}.${sessionId}`),
    await sessionHash(req),
    PROVIDERS.STRIPE
  );
  if (!consumed) throw httpError(400, 'Stripe link nonce is invalid, expired, or already used');

  const profile = await db.getProviderProfile(env.DB, PROVIDERS.STRIPE);
  const customerId = session.account_holder.customer;
  if (!profile || profile.external_id !== customerId) {
    throw httpError(409, 'Stripe session is not bound to this app profile', 'stripe.customer_mismatch');
  }
  const institutionNames = [...new Set(accounts.map((account) => account.institution_name).filter(Boolean))];
  const linkedItems = [];
  for (const account of accounts) {
    // Stripe has no Plaid-style Item. A Financial Connections Account is the
    // stable, independently disconnectable unit; the Customer lives separately
    // in provider_profiles and is reused only for future Link sessions.
    const existing = await db.getItemByExternal(env.DB, PROVIDERS.STRIPE, account.id);
    const existingData = parseProviderData(existing);
    const itemId = existing?.item_id || providers.itemIdFor(PROVIDERS.STRIPE, account.id);
    const refreshPending = !account.transaction_refresh
      || account.transaction_refresh.status === 'pending';
    const providerData = {
      ...existingData,
      customerId,
      sessionId: session.id,
      webhookConfigured: stripeInfo.webhookConfigured,
      accountStatuses: {
        ...(existingData.accountStatuses || {}),
        [account.id]: account.status,
      },
      refreshPending,
    };
    await db.insertItem(env.DB, {
      itemId,
      provider: PROVIDERS.STRIPE,
      externalItemId: account.id,
      accessToken: 'stripe-secret-key-binding',
      institutionId: null,
      institutionName: account.institution_name || account.display_name || 'Stripe credit card',
      providerData,
      createdAt: existing?.created_at || now(),
    });
    const prior = await db.getAccountByExternal(env.DB, PROVIDERS.STRIPE, account.id);
    await db.upsertAccount(env.DB, stripe.accountRecord(account, itemId, prior));
    const saved = await db.getItem(env.DB, itemId);
    const signConfirmationRequired = !['positive', 'negative'].includes(
      parseProviderData(saved).chargeSign
    );
    const sync = signConfirmationRequired ? null : await providers.syncItem(env, saved);
    linkedItems.push({
      itemId,
      accountId: account.id,
      institutionName: account.institution_name,
      refreshPending: refreshPending || Boolean(sync?.subscription?.refreshPending),
      signConfirmationRequired,
      sync,
    });
  }

  return {
    itemId: linkedItems[0].itemId,
    items: linkedItems,
    institutionName: institutionNames.join(' / '),
    accounts: accounts.length,
    refreshPending: linkedItems.some((item) => item.refreshPending),
    webhookConfigured: stripeInfo.webhookConfigured,
    ignoredAccounts: rawAccounts.length - accounts.length,
    signConfirmationRequired: linkedItems.some((item) => item.signConfirmationRequired),
    subscriptionErrors: linkedItems.flatMap((item) => item.sync?.subscription?.errors || []),
  };
}

async function persistPlaidAccounts(env, accounts, itemId) {
  for (const account of accounts) {
    const existing = await db.getAccountByExternal(env.DB, PROVIDERS.PLAID, account.account_id);
    await db.upsertAccount(env.DB, plaid.accountRecord(account, itemId, existing));
  }
}

async function handlePlaidExchange(env, publicToken, now) {
  const { accessToken, itemId: externalItemId } = await plaid.exchangePublicToken(env, publicToken);
  const { institutionId, institutionName } = await plaid.fetchInstitution(env, accessToken);
  const existing = await db.getItemByExternal(env.DB, PROVIDERS.PLAID, externalItemId);
  const itemId = existing?.item_id || providers.itemIdFor(PROVIDERS.PLAID, externalItemId);
  await db.insertItem(env.DB, {
    itemId,
    provider: PROVIDERS.PLAID,
    externalItemId,
    accessToken: await providers.storeAccessToken(env, PROVIDERS.PLAID, accessToken),
    institutionId,
    institutionName,
    providerData: parseProviderData(existing),
    createdAt: existing?.created_at || now(),
  });

  const accounts = await plaid.fetchAccounts(env, accessToken);
  await persistPlaidAccounts(env, accounts, itemId);
  const item = await db.getItem(env.DB, itemId);
  const counts = await providers.syncItem(env, item);
  return { itemId, institutionName, accounts: accounts.length, sync: counts };
}

async function handleTellerExchange(env, req, nonce, enrollment, now) {
  const status = teller.tellerStatus(env);
  if (!status.configured) {
    throw httpError(503, `Teller is not configured: ${status.missing.join(', ')}`);
  }
  const nonceHash = await sha256Hex(nonce);
  const consumed = await db.consumeLinkNonce(
    env.DB,
    nonceHash,
    await sessionHash(req),
    PROVIDERS.TELLER
  );
  if (!consumed) throw httpError(400, 'Teller link nonce is invalid, expired, or already used');

  const signatureOk = await verifyTellerEnrollment(
    env.TELLER_TOKEN_SIGNING_KEY,
    nonce,
    enrollment,
    status.environment
  );
  if (!signatureOk) throw httpError(401, 'Teller enrollment signature verification failed');

  const externalItemId = enrollment.enrollment.id;
  const rawAccounts = await teller.fetchAccounts(env, enrollment.accessToken);
  const accounts = rawAccounts.filter((account) =>
    account.enrollment_id === externalItemId && teller.supportsCreditTransactions(account)
  );

  const existing = await db.getItemByExternal(env.DB, PROVIDERS.TELLER, externalItemId);
  const itemId = existing?.item_id || providers.itemIdFor(PROVIDERS.TELLER, externalItemId);
  const institution = enrollment.enrollment.institution || rawAccounts[0]?.institution || {};
  const capabilityWarning = accounts.length === 0
    ? 'This enrollment did not expose a credit-card account with transaction access. Repair it instead of creating another enrollment.'
    : null;
  const providerData = {
    ...parseProviderData(existing),
    creditTransactionsSupported: accounts.length > 0,
    capabilityWarning,
    capabilityCheckedAt: now(),
  };
  await db.insertItem(env.DB, {
    itemId,
    provider: PROVIDERS.TELLER,
    externalItemId,
    accessToken: await providers.storeAccessToken(env, PROVIDERS.TELLER, enrollment.accessToken),
    institutionId: institution.id || rawAccounts[0]?.institution?.id || null,
    institutionName: institution.name || rawAccounts[0]?.institution?.name || 'Teller institution',
    providerData,
    createdAt: existing?.created_at || now(),
  });

  for (const account of accounts) {
    const prior = await db.getAccountByExternal(env.DB, PROVIDERS.TELLER, account.id);
    await db.upsertAccount(env.DB, teller.accountRecord(account, itemId, prior));
  }

  const saved = await db.getItem(env.DB, itemId);
  const data = parseProviderData(saved);
  const canSync = accounts.length > 0 && ['positive', 'negative'].includes(data.chargeSign);
  return {
    itemId,
    institutionName: institution.name || rawAccounts[0]?.institution?.name,
    accounts: accounts.length,
    transactionsSupported: accounts.length > 0,
    capabilityWarning,
    signConfirmationRequired: accounts.length > 0 && !canSync,
    sync: canSync ? await providers.syncItem(env, saved) : null,
  };
}

async function importCsv(env, payload, now) {
  const cardId = Number(payload.cardId);
  const rows = payload.rows;
  if (!Number.isInteger(cardId) || cardId <= 0) throw httpError(400, 'valid cardId required');
  if (!Array.isArray(rows) || rows.length === 0) throw httpError(400, 'CSV rows are required');
  if (rows.length > 5000) throw httpError(413, 'Import is limited to 5,000 rows at a time');
  const chargeSign = payload.chargeSign || 'positive';
  if (!['positive', 'negative'].includes(chargeSign)) {
    throw httpError(400, 'chargeSign must be positive or negative');
  }

  const card = await db.getCard(env.DB, cardId);
  if (!card) throw httpError(404, 'card not found');
  let account = card.account_id ? await db.getAccount(env.DB, card.account_id) : null;
  if (account && account.provider !== PROVIDERS.CSV) {
    throw httpError(409, 'CSV can only be attached to a manual card or an existing CSV-import card');
  }

  const externalItemId = `card:${cardId}`;
  const itemId = localId(PROVIDERS.CSV, externalItemId);
  const externalAccountId = `card:${cardId}`;
  const accountId = localId(PROVIDERS.CSV, externalAccountId);
  const targetItemId = account?.item_id || itemId;
  const targetAccountId = account?.account_id || accountId;
  const existingCsvItem = account ? await db.getItem(env.DB, account.item_id) : null;
  const previousChargeSign = parseProviderData(existingCsvItem).chargeSign;
  if (previousChargeSign && previousChargeSign !== chargeSign && !payload.replaceExisting) {
    throw httpError(
      409,
      'Changing the CSV purchase sign requires replacing the existing imported transactions'
    );
  }

  const occurrences = new Map();
  const transactions = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      const base = canonicalTransaction({
        provider: PROVIDERS.CSV,
        externalTransactionId: 'pending',
        accountId: targetAccountId,
        itemId: targetItemId,
        date: rows[i].date,
        name: rows[i].name || rows[i].description,
        merchantName: rows[i].merchantName || rows[i].merchant_name || rows[i].description,
        amount: rows[i].amount,
        isoCurrency: rows[i].isoCurrency || rows[i].currency || 'USD',
        category: rows[i].category,
        pending: false,
      }, { chargeSign });
      if (!base.name && !base.merchantName) throw new Error('description is required');
      const fingerprint = [base.date, base.name, base.merchantName, base.amount, base.category].join('|');
      const occurrence = occurrences.get(fingerprint) || 0;
      occurrences.set(fingerprint, occurrence + 1);
      const externalTransactionId = await sha256Hex(`${cardId}|${fingerprint}|${occurrence}`);
      transactions.push({
        ...base,
        externalTransactionId,
        transactionId: localId(PROVIDERS.CSV, externalTransactionId),
      });
    } catch (error) {
      throw httpError(400, `CSV row ${i + 1}: ${error.message}`);
    }
  }

  // Do not mutate the card or erase earlier data until every row has validated.
  if (!account) {
    await db.insertItem(env.DB, {
      itemId,
      provider: PROVIDERS.CSV,
      externalItemId,
      accessToken: 'csv-import',
      institutionId: 'csv',
      institutionName: 'CSV import',
      providerData: { chargeSign },
      createdAt: now(),
    });
    await db.upsertAccount(env.DB, {
      accountId,
      provider: PROVIDERS.CSV,
      externalAccountId,
      itemId,
      name: card.display_name || card.product_key,
      officialName: 'Imported credit-card transactions',
      mask: null,
      type: 'credit',
      subtype: 'credit_card',
    });
    await db.updateCardAccount(env.DB, cardId, accountId);
    account = await db.getAccount(env.DB, accountId);
  } else {
    await db.setItemProviderData(env.DB, account.item_id, {
      ...parseProviderData(existingCsvItem),
      chargeSign,
    });
  }

  if (payload.replaceExisting) await db.deleteTxnsByItem(env.DB, account.item_id);
  await db.upsertTxns(env.DB, transactions);
  await db.setCursor(env.DB, account.item_id, null, now());
  return { imported: transactions.length, cardId, accountId: account.account_id };
}

async function handle(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;
  const now = () => new Date().toISOString();

  // ---------------- public ----------------
  if (path === '/api/health') return { ok: true };

  if (path === '/api/webhooks/stripe' && method === 'POST') {
    const rawBody = await req.text();
    const event = await stripe.verifyWebhook(env, rawBody, req.headers.get('Stripe-Signature'));
    stripe.validateWebhookMode(env, event);
    // Return 2xx only after durable processing. A failure must reach Stripe so it
    // can retry the signed delivery instead of silently losing the update.
    const result = await stripe.handleWebhookEvent(env, event);
    return { received: true, result };
  }

  if (path === '/api/config') {
    const providerConfig = providers.publicProviderConfig(env);
    return {
      providers: providerConfig,
      // Backwards compatibility during the UI migration.
      plaidConfigured: providerConfig.find((p) => p.id === PROVIDERS.PLAID)?.configured || false,
      plaidEnv: plaid.plaidEnv(env),
      today: appToday(env),
      authRequired: !devMode(env),
      authed: await isAuthed(env, req),
      googleClientId: (env.GOOGLE_CLIENT_ID || '').endsWith('.apps.googleusercontent.com')
        ? env.GOOGLE_CLIENT_ID
        : '',
    };
  }

  if (path === '/api/auth/google' && method === 'POST') {
    const { credential } = await readJson(req);
    if (!credential) return { status: 400, error: 'credential required' };
    const verified = await verifyGoogleCredential(env, credential);
    if (!verified.ok) return { status: 401, error: verified.error };
    return { token: await makeSession(env, verified.email), email: verified.email };
  }

  // ---------------- everything below requires a session ----------------
  if (!(await isAuthed(env, req))) return { status: 401, error: 'auth required' };

  // ---------------- Plaid Link ----------------
  if ((path === '/api/link/token' || path === '/api/link/plaid/token') && method === 'POST') {
    return { link_token: await plaid.createLinkToken(env) };
  }
  if ((path === '/api/link/exchange' || path === '/api/link/plaid/exchange') && method === 'POST') {
    const { public_token: publicToken } = await readJson(req);
    if (!publicToken) return { status: 400, error: 'public_token required' };
    return handlePlaidExchange(env, publicToken, now);
  }

  // ---------------- Stripe Financial Connections ----------------
  if (path === '/api/link/stripe/session' && method === 'POST') {
    const nonce = randomToken();
    let profile = await db.getProviderProfile(env.DB, PROVIDERS.STRIPE);
    if (!profile) {
      const customer = await stripe.createCustomer(env, nonce);
      profile = await db.putProviderProfileIfAbsent(
        env.DB,
        PROVIDERS.STRIPE,
        customer.id,
        now()
      );
    }
    if (!profile?.external_id) {
      throw httpError(500, 'Unable to persist the Stripe Customer profile', 'stripe.profile_missing');
    }
    const setup = await stripe.createSession(env, nonce, profile.external_id);
    await db.putLinkNonce(
      env.DB,
      await sha256Hex(`${nonce}.${setup.sessionId}`),
      await sessionHash(req),
      PROVIDERS.STRIPE,
      Date.now() + LINK_NONCE_TTL_MS,
      now()
    );
    return {
      clientSecret: setup.clientSecret,
      sessionId: setup.sessionId,
      nonce,
      publishableKey: stripe.stripeStatus(env).publishableKey,
    };
  }

  if (path === '/api/link/stripe/complete' && method === 'POST') {
    const { nonce, sessionId } = await readJson(req);
    if (!nonce || !sessionId) return { status: 400, error: 'nonce and sessionId required' };
    return handleStripeComplete(env, req, nonce, sessionId, now);
  }

  // ---------------- Teller Connect ----------------
  if (path === '/api/link/teller/config' && method === 'POST') {
    const status = teller.tellerStatus(env);
    if (!status.configured) {
      throw httpError(503, `Teller is not configured: ${status.missing.join(', ')}`);
    }
    const { itemId } = await readJson(req);
    let enrollmentId = null;
    if (itemId) {
      const item = await db.getItem(env.DB, itemId);
      if (!item || item.provider !== PROVIDERS.TELLER) throw httpError(404, 'Teller item not found');
      enrollmentId = item.external_item_id;
    }
    const nonce = randomToken();
    await db.putLinkNonce(
      env.DB,
      await sha256Hex(nonce),
      await sessionHash(req),
      PROVIDERS.TELLER,
      Date.now() + LINK_NONCE_TTL_MS,
      now()
    );
    return {
      applicationId: env.TELLER_APPLICATION_ID,
      environment: status.environment,
      nonce,
      enrollmentId,
    };
  }

  if (path === '/api/link/teller/exchange' && method === 'POST') {
    const { nonce, enrollment } = await readJson(req);
    if (!nonce || !enrollment) return { status: 400, error: 'nonce and enrollment required' };
    return handleTellerExchange(env, req, nonce, enrollment, now);
  }

  // ---------------- items / accounts ----------------
  if (path === '/api/items' && method === 'GET') {
    const items = [];
    for (const item of await db.listItems(env.DB)) {
      items.push(itemView(item, await db.listAccountsByItem(env.DB, item.item_id)));
    }
    return { items };
  }

  let match = path.match(/^\/api\/items\/([^/]+)\/sample$/);
  if (match && method === 'GET') {
    const item = await db.getItem(env.DB, decodeId(match[1]));
    if (!item || ![PROVIDERS.TELLER, PROVIDERS.STRIPE].includes(item.provider)) {
      throw httpError(404, 'provider item not found');
    }
    const hydrated = await providers.withAccessToken(env, item);
    const transactions = item.provider === PROVIDERS.STRIPE
      ? await stripe.sampleTransactions(env, hydrated)
      : await teller.sampleTransactions(env, hydrated);
    await db.mergeItemProviderData(env.DB, item.item_id, {
      signSampleCheckedAt: now(),
      ...(transactions.length > 0 ? { signSampleViewedAt: now() } : {}),
    });
    return { transactions };
  }

  match = path.match(/^\/api\/items\/([^/]+)\/stripe-sign$/);
  if (match && method === 'POST') {
    const itemId = decodeId(match[1]);
    const item = await db.getItem(env.DB, itemId);
    if (!item || item.provider !== PROVIDERS.STRIPE) throw httpError(404, 'Stripe item not found');
    const providerData = parseProviderData(item);
    const { chargeSign, emptySampleAcknowledged = false } = await readJson(req);
    if (!providerData.signSampleCheckedAt) {
      throw httpError(
        409,
        'Check Stripe transaction samples before confirming the purchase sign',
        'stripe.sign_sample_required'
      );
    }
    if (!providerData.signSampleViewedAt && emptySampleAcknowledged !== true) {
      throw httpError(
        409,
        'Confirm that you checked a statement separately when Stripe returns no sample transactions',
        'stripe.empty_sample_acknowledgement_required'
      );
    }
    if (!['positive', 'negative'].includes(chargeSign)) {
      throw httpError(400, 'chargeSign must be positive or negative');
    }
    await db.mergeItemProviderData(env.DB, itemId, {
      chargeSign,
      ...(!providerData.signSampleViewedAt && emptySampleAcknowledged
        ? { emptySampleAcknowledgedAt: now() }
        : {}),
    });
    return providers.syncItem(env, await db.getItem(env.DB, itemId));
  }

  match = path.match(/^\/api\/items\/([^/]+)\/teller-sign$/);
  if (match && method === 'POST') {
    const itemId = decodeId(match[1]);
    const item = await db.getItem(env.DB, itemId);
    if (!item || item.provider !== PROVIDERS.TELLER) throw httpError(404, 'Teller item not found');
    const providerData = parseProviderData(item);
    const { chargeSign, emptySampleAcknowledged = false } = await readJson(req);
    if (!providerData.signSampleCheckedAt) {
      throw httpError(
        409,
        'Check Teller transaction samples before confirming the purchase sign',
        'teller.sign_sample_required'
      );
    }
    if (!providerData.signSampleViewedAt && emptySampleAcknowledged !== true) {
      throw httpError(
        409,
        'Confirm that you checked a statement separately when Teller returns no sample transactions',
        'teller.empty_sample_acknowledgement_required'
      );
    }
    if (!['positive', 'negative'].includes(chargeSign)) {
      throw httpError(400, 'chargeSign must be positive or negative');
    }
    await db.setItemProviderData(env.DB, itemId, {
      ...providerData,
      chargeSign,
      ...(!providerData.signSampleViewedAt && emptySampleAcknowledged
        ? { emptySampleAcknowledgedAt: now() }
        : {}),
    });
    return providers.syncItem(env, await db.getItem(env.DB, itemId));
  }

  match = path.match(/^\/api\/items\/([^/]+)\/sync$/);
  if (match && method === 'POST') {
    const item = await db.getItem(env.DB, decodeId(match[1]));
    if (!item) return { status: 404, error: 'not found' };
    return providers.syncItem(env, item, { requestRefresh: true });
  }

  match = path.match(/^\/api\/items\/([^/]+)$/);
  if (match && method === 'DELETE') {
    const item = await db.getItem(env.DB, decodeId(match[1]));
    if (!item) return { status: 404, error: 'not found' };
    await providers.removeItem(env, item);
    await db.unlinkCardsOfAccounts(env.DB, item.item_id);
    await db.deleteTxnsByItem(env.DB, item.item_id);
    await db.deleteAccountsByItem(env.DB, item.item_id);
    await db.deleteItem(env.DB, item.item_id);
    return { ok: true };
  }

  if (path === '/api/accounts' && method === 'GET') {
    return { accounts: await db.listAccounts(env.DB) };
  }

  if (path === '/api/sync' && method === 'POST') {
    const results = [];
    for (const item of await db.listItems(env.DB)) {
      try {
        const counts = await providers.syncItem(env, item, { requestRefresh: true });
        results.push({ itemId: item.item_id, provider: item.provider, ok: true, ...counts });
      } catch (error) {
        results.push({
          itemId: item.item_id,
          provider: item.provider,
          ok: false,
          error: error.message,
          code: error.code,
        });
      }
    }
    return {
      synced: results.filter((result) => result.ok && !result.skipped).length,
      failed: results.filter((result) => !result.ok).length,
      results,
    };
  }

  if (path === '/api/transactions' && method === 'GET') {
    const accountId = url.searchParams.get('accountId');
    if (!accountId) return { status: 400, error: 'accountId required' };
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    return { transactions: await db.txnsForAccount(env.DB, accountId, limit) };
  }

  if (path === '/api/import/csv' && method === 'POST') {
    return importCsv(env, await readJson(req), now);
  }

  // ---------------- catalog ----------------
  if (path === '/api/catalog' && method === 'GET') return { products };

  // ---------------- cards ----------------
  if (path === '/api/cards' && method === 'GET') {
    const cards = [];
    for (const card of await db.listCards(env.DB)) {
      cards.push({
        ...card,
        account: card.account_id ? await db.getAccount(env.DB, card.account_id) : null,
      });
    }
    return { cards };
  }

  if (path === '/api/cards' && method === 'POST') {
    const { accountId, productKey, displayName } = await readJson(req);
    if (!productKey) return { status: 400, error: 'productKey required' };
    if (!products.some((product) => product.key === productKey)) {
      return { status: 400, error: `unknown productKey: ${productKey}` };
    }
    if (accountId && !(await db.getAccount(env.DB, accountId))) {
      return { status: 404, error: 'account not found' };
    }
    if (accountId && (await db.getCardByAccount(env.DB, accountId))) {
      return { status: 409, error: 'account is already linked to a tracked card' };
    }
    const id = await db.insertCard(env.DB, accountId || null, productKey, displayName || null, now());
    return { id };
  }

  match = path.match(/^\/api\/cards\/(\d+)$/);
  if (match && method === 'DELETE') {
    await db.deleteCard(env.DB, Number(match[1]));
    return { ok: true };
  }

  // ---------------- dashboard ----------------
  if (path === '/api/benefits/status' && method === 'GET') {
    const today = appToday(env);
    const deps = {
      getTxnsBetween: (accountId, start, end) => db.txnsForAccountBetween(env.DB, accountId, start, end),
      getOverride: (cardId, benefitId, periodKey) => db.getOverride(env.DB, cardId, benefitId, periodKey),
    };
    const cards = [];
    for (const card of await db.listCards(env.DB)) {
      cards.push(await statusForCard(card, products, deps, today));
    }

    const alerts = [];
    for (const card of cards) {
      for (const benefit of card.benefits) {
        if (benefit.status !== 'used') {
          alerts.push({
            cardId: card.cardId,
            cardName: card.displayName,
            productName: card.productName,
            ...benefit,
          });
        }
      }
    }
    alerts.sort((a, b) => a.daysLeft - b.daysLeft || b.remaining - a.remaining);
    const totalRemaining = Math.round(alerts.reduce((sum, alert) => sum + alert.remaining, 0) * 100) / 100;
    return { today, cards, alerts, totalRemaining };
  }

  if (path === '/api/benefits/override' && method === 'POST') {
    const { cardId, benefitId, periodKey, usedAmount, claimed, note } = await readJson(req);
    if (!cardId || !benefitId || !periodKey) {
      return { status: 400, error: 'cardId, benefitId, periodKey required' };
    }
    if (!(await db.getCard(env.DB, Number(cardId)))) return { status: 404, error: 'card not found' };
    await db.upsertOverride(
      env.DB,
      Number(cardId),
      benefitId,
      periodKey,
      usedAmount === undefined || usedAmount === null || usedAmount === '' ? null : Number(usedAmount),
      claimed ? 1 : 0,
      note || null,
      now()
    );
    return { ok: true };
  }

  return { status: 404, error: 'not found' };
}

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let body;
    try {
      body = await handle(req, env, ctx);
    } catch (error) {
      console.error('[error]', error.status || 500, error.code || '', error.message);
      body = {
        status: error.status || 500,
        error: error.message || 'server error',
        code: error.code,
        detail: error.detail,
      };
    }
    const { status = 200, ...rest } = body || {};
    return new Response(JSON.stringify(rest), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
    });
  },

  // Daily cron: pull fresh transactions for every linked provider item.
  async scheduled(_event, env) {
    for (const item of await db.listItems(env.DB)) {
      try {
        const counts = await providers.syncItem(env, item, { requestRefresh: false });
        console.log('cron sync', item.provider, item.item_id, JSON.stringify(counts));
      } catch (error) {
        console.error('cron sync failed', item.provider, item.item_id, error.code || '', error.message);
      }
    }
  },
};
