import assert from 'node:assert/strict';
import test from 'node:test';
import { attributeTransactions, matchesBenefit, periodWindow, statusForCard } from '../shared/benefits-core.js';

const windowFor = (benefit, today = '2026-08-30') => ({
  benefit,
  window: periodWindow(benefit.period, today, benefit.anchor),
});

test('a transaction has one deterministic owner and the most specific merchant wins', () => {
  const uber = {
    id: 'uber', name: 'Uber Cash', amount: 15, period: 'monthly',
    match: { merchants: ['uber'], categories: [] },
  };
  const uberOne = {
    id: 'uber_one', name: 'Uber One Membership Credit', amount: 120, period: 'annual',
    match: { merchants: ['uber one'], categories: [] },
  };
  const result = attributeTransactions([
    { transaction_id: 'txn_uber_one', date: '2026-08-10', name: 'UBER ONE', amount: 9.99 },
  ], [windowFor(uber), windowFor(uberOne)]);

  assert.equal(result.ownership.txn_uber_one.benefitId, 'uber_one');
  assert.equal(result.stats.uber.autoUsed, 0);
  assert.equal(result.stats.uber_one.autoUsed, 9.99);
  assert.equal(result.collisionCount, 1);
});

test('merchant evidence wins over category evidence and an exact tie stays unassigned', () => {
  const merchantBenefit = {
    id: 'merchant', name: 'Restaurant Offer', amount: 50, period: 'monthly',
    match: { merchants: ['corner cafe'], categories: [] },
  };
  const categoryBenefit = {
    id: 'category', name: 'Dining Credit', amount: 25, period: 'monthly',
    match: { merchants: [], categories: ['FOOD_AND_DRINK'] },
  };
  const tiedCategory = {
    id: 'category_two', name: 'Second Dining Credit', amount: 25, period: 'monthly',
    match: { merchants: [], categories: ['FOOD_AND_DRINK'] },
  };
  const merchantResult = attributeTransactions([
    { transaction_id: 'txn_cafe', date: '2026-08-10', name: 'Corner Cafe', category: 'FOOD_AND_DRINK', amount: 20 },
  ], [windowFor(merchantBenefit), windowFor(categoryBenefit)]);
  const ambiguousResult = attributeTransactions([
    { transaction_id: 'txn_dining', date: '2026-08-10', name: 'Unknown Restaurant', category: 'FOOD_AND_DRINK', amount: 20 },
  ], [windowFor(categoryBenefit), windowFor(tiedCategory)]);

  assert.equal(merchantResult.ownership.txn_cafe.benefitId, 'merchant');
  assert.equal(ambiguousResult.ownership.txn_dining, undefined);
  assert.equal(ambiguousResult.ambiguousCount, 1);
});

test('statement credits confirm paired purchases without double counting and can fill missing purchases', () => {
  const blacklane = {
    id: 'blacklane', name: 'Blacklane Credit', amount: 100, period: 'semiannual',
    match: { merchants: ['blacklane'], categories: [] },
  };
  const splurge = {
    id: 'splurge', name: 'Splurge Credit', amount: 200, period: 'annual',
    match: { merchants: ['best buy'], categories: [] },
  };
  const result = attributeTransactions([
    { transaction_id: 'blacklane_purchase', date: '2026-07-27', name: 'BLACKLANE Berlin DEU', amount: 96.27 },
    { transaction_id: 'blacklane_credit', date: '2026-08-03', name: '$100 Credit with Blacklane July-Dec', amount: -96.27 },
    { transaction_id: 'splurge_credit', date: '2026-04-15', name: 'SPLURGE CREDIT BESTBUY Rebate MO', amount: -200 },
    { transaction_id: 'autopay', date: '2026-08-04', name: 'AUTOPAY', amount: -500 },
    { transaction_id: 'dispute', date: '2026-08-05', name: 'CITIBANK CREDIT FOR DISPUTE', amount: -75 },
    { transaction_id: 'refund', date: '2026-08-06', name: 'OTHER MERCHANT REFUND', amount: -20 },
  ], [windowFor(blacklane), windowFor(splurge)]);

  assert.deepEqual(result.ownership.blacklane_credit, {
    benefitId: 'blacklane',
    role: 'statement_credit',
    reason: 'credit-description+purchase',
    pairedPurchaseId: 'blacklane_purchase',
  });
  assert.equal(result.stats.blacklane.autoUsed, 96.27);
  assert.equal(result.stats.blacklane.purchaseMatchedCount, 1);
  assert.equal(result.stats.blacklane.creditMatchedCount, 1);
  assert.equal(result.stats.splurge.autoUsed, 200);
  assert.equal(result.stats.splurge.purchaseMatchedCount, 0);
  assert.equal(result.stats.splurge.creditMatchedCount, 1);
  assert.equal(result.ownership.autopay, undefined);
  assert.equal(result.ownership.dispute, undefined);
  assert.equal(result.ownership.refund, undefined);
});

test('broad name words do not turn unrelated fee rebates into benefit credits', () => {
  const airline = {
    id: 'airline', name: 'Airline Fee Credit', amount: 200, period: 'annual',
    creditMatch: { descriptions: ['airline fee', 'airline incidental'] },
    match: { merchants: [], categories: [] },
  };
  const result = attributeTransactions([
    { transaction_id: 'membership_fee', date: '2026-08-10', name: 'ANNUAL MEMBERSHIP FEE CREDIT', amount: -200 },
    { transaction_id: 'airline_fee', date: '2026-08-11', name: 'AIRLINE FEE CREDIT', amount: -50 },
  ], [windowFor(airline)]);

  assert.equal(result.ownership.membership_fee, undefined);
  assert.equal(result.ownership.airline_fee.benefitId, 'airline');
  assert.equal(result.stats.airline.autoUsed, 50);
});

test('matched refunds and reversals net out the purchase they undo', () => {
  const blacklane = {
    id: 'blacklane', name: 'Blacklane Credit', amount: 100, period: 'semiannual',
    match: { merchants: ['blacklane'], categories: [] },
  };
  const full = attributeTransactions([
    { transaction_id: 'purchase', date: '2026-08-10', name: 'BLACKLANE', amount: 96.27 },
    { transaction_id: 'reversal', date: '2026-08-10', name: 'BLACKLANE REVERSAL', amount: -96.27 },
  ], [windowFor(blacklane)]);
  const partial = attributeTransactions([
    { transaction_id: 'purchase', date: '2026-08-10', name: 'BLACKLANE', amount: 96.27 },
    { transaction_id: 'refund', date: '2026-08-12', name: 'BLACKLANE REFUND', amount: -20 },
  ], [windowFor(blacklane)]);

  assert.equal(full.stats.blacklane.autoUsed, 0);
  assert.equal(full.stats.blacklane.reversalMatchedCount, 1);
  assert.equal(full.ownership.reversal.role, 'reversal');
  assert.equal(full.ownership.reversal.pairedPurchaseId, 'purchase');
  assert.equal(partial.stats.blacklane.autoUsed, 76.27);
});

test('a lump-sum statement credit does not double-count several eligible purchases', () => {
  const splurge = {
    id: 'splurge', name: 'Splurge Credit', amount: 200, period: 'annual',
    match: { merchants: ['best buy'], categories: [] },
  };
  const result = attributeTransactions([
    ...[1, 2, 3, 4].map((number) => ({
      transaction_id: `purchase_${number}`, date: `2026-08-0${number}`, name: 'BEST BUY', amount: 50,
    })),
    { transaction_id: 'credit', date: '2026-08-15', name: 'SPLURGE CREDIT BEST BUY', amount: -200 },
  ], [windowFor(splurge)]);

  assert.equal(result.stats.splurge.autoUsed, 200);
  assert.equal(result.stats.splurge.purchaseMatchedCount, 4);
  assert.equal(result.stats.splurge.creditMatchedCount, 1);
});

test('wallet benefits and pending transactions are not auto-attributed', () => {
  const wallet = {
    id: 'uber_cash', name: 'Uber Cash', amount: 15, period: 'monthly', tracking: 'wallet',
    match: { merchants: ['uber'], categories: [] },
  };
  const result = attributeTransactions([
    { transaction_id: 'posted', date: '2026-08-10', name: 'UBER TRIP', amount: 12 },
    { transaction_id: 'pending', date: '2026-08-11', name: 'UBER TRIP', amount: 8, pending: 1 },
    { transaction_id: 'credit', date: '2026-08-12', name: 'UBER CASH CREDIT', amount: -15 },
  ], [windowFor(wallet)]);

  assert.deepEqual(result.ownership, {});
  assert.equal(result.stats.uber_cash.autoUsed, 0);
});

test('the exported benefit matcher rejects pending purchases', () => {
  const benefit = { match: { merchants: ['merchant'], categories: [] } };
  assert.equal(matchesBenefit({ name: 'MERCHANT', amount: 10, pending: 1 }, benefit), false);
  assert.equal(matchesBenefit({ name: 'MERCHANT', amount: 10, pending: 0 }, benefit), true);
});

test('status fetches the union window once and exposes purchase and credit evidence counts', async () => {
  const product = {
    key: 'test_card', name: 'Test Card', issuer: 'Test', benefits: [
      {
        id: 'monthly', name: 'Merchant Credit', amount: 20, period: 'monthly',
        match: { merchants: ['merchant'], categories: [] },
      },
      {
        id: 'annual', name: 'Annual Credit', amount: 100, period: 'annual',
        match: { merchants: ['annual shop'], categories: [] },
      },
    ],
  };
  const calls = [];
  const status = await statusForCard(
    { id: 1, account_id: 'account_1', product_key: 'test_card', display_name: 'My Card' },
    [product],
    {
      getTxnsBetween: async (...args) => {
        calls.push(args);
        return [{ transaction_id: 'txn_1', date: '2026-08-10', name: 'MERCHANT', amount: 12 }];
      },
      getOverride: async () => null,
    },
    '2026-08-30'
  );

  assert.deepEqual(calls, [['account_1', '2026-01-01', '2026-12-31']]);
  assert.equal(status.benefits[0].autoUsed, 12);
  assert.equal(status.benefits[0].purchaseMatchedCount, 1);
  assert.equal(status.benefits[0].creditMatchedCount, 0);
});

test('monthly amount overrides apply only in their configured month', async () => {
  const product = {
    key: 'test_card', name: 'Test Card', issuer: 'Test', benefits: [
      {
        id: 'wallet', name: 'Wallet Credit', amount: 15, amountByMonth: { 12: 35 },
        period: 'monthly', tracking: 'wallet', match: { merchants: [], categories: [] },
      },
    ],
  };
  const deps = {
    getTxnsBetween: async () => [],
    getOverride: async () => null,
  };
  const card = { id: 1, account_id: null, product_key: 'test_card', display_name: 'My Card' };

  const november = await statusForCard(card, [product], deps, '2026-11-15');
  const december = await statusForCard(card, [product], deps, '2026-12-15');

  assert.equal(november.benefits[0].amount, 15);
  assert.equal(november.benefits[0].remaining, 15);
  assert.equal(december.benefits[0].amount, 35);
  assert.equal(december.benefits[0].remaining, 35);
});
