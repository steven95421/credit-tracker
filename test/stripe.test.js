import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  accountRecord,
  createRelinkSession,
  createSession,
  effectiveChargeSign,
  eligibleCreditCardAccounts,
  normalizeTransaction,
  relinkedProviderData,
  stripeStatus,
  validateCollectedSession,
  validateRelinkedSession,
  validateWebhookMode,
  verifyWebhook,
} from '../worker/src/stripe.js';

const testEnv = {
  STRIPE_SECRET_KEY: ['sk', 'test', 'fixture'].join('_'),
  STRIPE_PUBLISHABLE_KEY: 'pk_test_publishable',
  STRIPE_WEBHOOK_SECRET: ['whsec', 'fixture'].join('_'),
};

test('Stripe configuration rejects missing or mixed-mode API keys', () => {
  assert.equal(stripeStatus(testEnv).configured, true);
  assert.equal(stripeStatus(testEnv).environment, 'test');
  const mixed = stripeStatus({
    STRIPE_SECRET_KEY: ['sk', 'live', 'fixture'].join('_'),
    STRIPE_PUBLISHABLE_KEY: 'pk_test_publishable',
  });
  assert.equal(mixed.configured, false);
  assert.ok(mixed.missing.includes('matching Stripe key modes'));
});

test('Stripe purchases default to negative while preserving an explicit override', () => {
  assert.equal(effectiveChargeSign({}), 'negative');
  assert.equal(effectiveChargeSign({ chargeSign: 'positive' }), 'positive');
});

test('Stripe Session reuses the durable Customer instead of creating one per attempt', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({
      id: 'fcsess_reused',
      client_secret: 'fcsess_client_secret_reused',
    });
  };
  try {
    const result = await createSession(testEnv, 'nonce_reused', 'cus_durable');
    assert.equal(result.customerId, 'cus_durable');
    assert.equal(calls.length, 1);
    assert.match(String(calls[0].url), /financial_connections\/sessions$/);
    const body = new URLSearchParams(calls[0].init.body);
    assert.equal(body.get('account_holder[customer]'), 'cus_durable');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Stripe Session asks only for credit-card transactions and prefetches them', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (String(url).endsWith('/customers')) {
      return Response.json({ id: 'cus_test' });
    }
    return Response.json({
      id: 'fcsess_test',
      client_secret: 'fcsess_client_secret_test',
    });
  };
  try {
    const result = await createSession(testEnv, 'nonce_test');
    assert.equal(result.sessionId, 'fcsess_test');
    assert.equal(calls.length, 2);
    const body = new URLSearchParams(calls[1].init.body);
    assert.deepEqual(body.getAll('permissions[]'), ['transactions']);
    assert.deepEqual(body.getAll('prefetch[]'), ['transactions']);
    assert.deepEqual(body.getAll('filters[account_subcategories][]'), ['credit_card']);
    assert.deepEqual(body.getAll('filters[countries][]'), ['US']);
    assert.equal(body.has('ownership'), false);
    assert.equal(body.has('balances'), false);
    assert.equal(calls[1].init.headers['Stripe-Version'], '2026-08-26.dahlia');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Stripe Relink targets the existing authorization with the preview API', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes('/financial_connections/accounts/')) {
      return Response.json({
        id: 'fca_inactive',
        object: 'financial_connections.account',
        account_holder: { type: 'customer', customer: 'cus_durable' },
        authorization: 'fcauth_amex',
        status: 'inactive',
        status_details: { inactive: { action: 'relink_required' } },
      });
    }
    return Response.json({
      id: 'fcsess_relink',
      client_secret: 'fcsess_client_secret_relink',
    });
  };
  try {
    const result = await createRelinkSession(
      testEnv,
      'cus_durable',
      'fca_inactive'
    );
    assert.equal(result.sessionId, 'fcsess_relink');
    assert.equal(result.authorizationId, 'fcauth_amex');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.headers['Stripe-Version'], '2026-08-26.preview');
    assert.equal(calls[1].init.headers['Stripe-Version'], '2026-08-26.preview');
    const body = new URLSearchParams(calls[1].init.body);
    assert.equal(body.get('account_holder[customer]'), 'cus_durable');
    assert.equal(body.get('relink_options[authorization]'), 'fcauth_amex');
    assert.equal(body.has('relink_options[account]'), false);
    assert.deepEqual(body.getAll('permissions[]'), ['transactions']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Stripe Relink refuses inactive accounts Stripe did not mark as relinkable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    id: 'fca_inactive',
    object: 'financial_connections.account',
    account_holder: { type: 'customer', customer: 'cus_durable' },
    authorization: 'fcauth_amex',
    status: 'inactive',
    status_details: { inactive: { action: 'none' } },
  });
  try {
    await assert.rejects(
      createRelinkSession(testEnv, 'cus_durable', 'fca_inactive'),
      /cannot be reconnected yet/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Stripe completion validates collected accounts without relying on a nonexistent Session status', () => {
  const session = {
    id: 'fcsess_test',
    object: 'financial_connections.session',
    account_holder: { type: 'customer', customer: 'cus_test' },
    permissions: ['transactions'],
    filters: { account_subcategories: ['credit_card'], countries: ['US'] },
  };
  assert.equal(validateCollectedSession(session, 'fcsess_test'), session);
  assert.deepEqual(eligibleCreditCardAccounts([
    { id: 'fca_ok', subcategory: 'credit_card', status: 'active', permissions: ['transactions'] },
    { id: 'fca_no_permission', subcategory: 'credit_card', status: 'active', permissions: [] },
    { id: 'fca_checking', subcategory: 'checking', status: 'active', permissions: ['transactions'] },
  ]).map((account) => account.id), ['fca_ok']);
  assert.throws(
    () => validateCollectedSession({ ...session, id: 'fcsess_other' }, 'fcsess_test'),
    /expected Financial Connections session/
  );
});

test('Stripe relink completion accepts a newly minted authorization', () => {
  const session = {
    id: 'fcsess_relink',
    object: 'financial_connections.session',
    account_holder: { type: 'customer', customer: 'cus_durable' },
    permissions: ['transactions'],
    filters: { account_subcategories: ['credit_card'], countries: ['US'] },
    relink_options: { authorization: 'fcauth_amex' },
    relink_result: { authorization: 'fcauth_reconsented' },
  };
  assert.equal(
    validateRelinkedSession(session, 'fcsess_relink'),
    session
  );
  assert.throws(
    () => validateRelinkedSession({ ...session, relink_options: {} }, 'fcsess_relink'),
    /did not return a Financial Connections relink session/
  );
  assert.throws(
    () => validateRelinkedSession({
      ...session,
      relink_result: { failure_reason: 'no_authorization' },
    }, 'fcsess_relink'),
    /was not completed/
  );
});

test('Stripe relink resets subscriptions while preserving card identity inputs and settings', () => {
  const existingData = {
    chargeSign: 'positive',
    transactionsSubscribed: true,
    transactionSubscriptions: { fca_amex: true },
    subscriptionErrors: [{ accountId: 'fca_amex', error: 'old failure' }],
    manualSetting: 'keep-me',
  };
  const next = relinkedProviderData(existingData, {
    customerId: 'cus_durable',
    sessionId: 'fcsess_relink',
    authorizationId: 'fcauth_reconsented',
    webhookConfigured: true,
    account: { id: 'fca_amex', status: 'active' },
    refreshPending: true,
  });
  assert.equal(next.chargeSign, 'positive');
  assert.equal(next.manualSetting, 'keep-me');
  assert.equal(next.authorizationId, 'fcauth_reconsented');
  assert.equal(next.transactionsSubscribed, false);
  assert.deepEqual(next.transactionSubscriptions, {});
  assert.deepEqual(next.subscriptionErrors, existingData.subscriptionErrors);
  assert.equal(next.accountStatuses.fca_amex, 'active');

  const prior = { account_id: 'stable-local-account-id' };
  const record = accountRecord({
    id: 'fca_amex',
    display_name: 'Platinum Card',
    institution_name: 'American Express',
    last4: '1001',
    category: 'credit',
    subcategory: 'credit_card',
  }, 'stable-item-id', prior);
  assert.equal(record.accountId, 'stable-local-account-id');
  assert.equal(record.itemId, 'stable-item-id');
});

test('Stripe credit-card debits become canonical positive purchases', () => {
  const account = accountRecord({
    id: 'fca_test',
    display_name: 'Gold Card',
    institution_name: 'Test Bank',
    last4: '4242',
    category: 'credit',
    subcategory: 'credit_card',
  }, 'stripe:fca_test');
  assert.equal(account.accountId, 'stripe:fca_test');
  const item = { item_id: 'stripe:fca_test' };
  const purchase = normalizeTransaction({
    id: 'fctxn_purchase',
    amount: -1234,
    currency: 'usd',
    description: 'Cafe',
    status: 'posted',
    transacted_at: Date.UTC(2026, 7, 29) / 1000,
  }, { account_id: account.accountId }, item, 'negative');
  const refund = normalizeTransaction({
    id: 'fctxn_refund',
    amount: 500,
    currency: 'usd',
    description: 'Cafe refund',
    status: 'posted',
    transacted_at: Date.UTC(2026, 7, 29) / 1000,
  }, { account_id: account.accountId }, item, 'negative');
  assert.equal(purchase.amount, 12.34);
  assert.equal(refund.amount, -5);
  assert.equal(purchase.date, '2026-08-29');
  assert.equal(purchase.merchantName, null);
  assert.equal(purchase.name, 'Cafe');
});

test('Stripe transaction dates use the configured benefit time zone at month boundaries', () => {
  const account = { account_id: 'stripe:fca_test' };
  const item = { item_id: 'stripe:cus_test' };
  const transaction = {
    id: 'fctxn_boundary',
    amount: -100,
    currency: 'usd',
    description: 'Late purchase',
    status: 'posted',
    // 2026-08-31 23:30 in Los Angeles, but 2026-09-01 in UTC.
    transacted_at: Date.UTC(2026, 8, 1, 6, 30) / 1000,
  };
  assert.equal(
    normalizeTransaction(transaction, account, item, 'negative', 'America/Los_Angeles').date,
    '2026-08-31'
  );
  assert.equal(normalizeTransaction(transaction, account, item, 'negative', 'UTC').date, '2026-09-01');
});

test('Stripe webhook verification uses the raw body, HMAC signature, and timestamp tolerance', async () => {
  const timestamp = 1_788_000_000;
  const rawBody = JSON.stringify({
    id: 'evt_test',
    type: 'financial_connections.account.refreshed_transactions',
    livemode: false,
  });
  const signature = createHmac('sha256', testEnv.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  const event = await verifyWebhook(
    testEnv,
    rawBody,
    `t=${timestamp},v1=${signature}`,
    timestamp + 30
  );
  assert.equal(event.id, 'evt_test');
  assert.equal(validateWebhookMode(testEnv, event), event);
  assert.throws(
    () => validateWebhookMode(testEnv, { ...event, livemode: true }),
    /mode does not match/
  );
  await assert.rejects(
    verifyWebhook(testEnv, rawBody, `t=${timestamp},v1=bad`, timestamp + 30),
    /signature verification failed/
  );
  await assert.rejects(
    verifyWebhook(testEnv, rawBody, `t=${timestamp},v1=${signature}`, timestamp + 301),
    /five-minute tolerance/
  );
});
