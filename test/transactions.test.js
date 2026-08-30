import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesBenefit } from '../shared/benefits-core.js';
import {
  canonicalAmount,
  canonicalTransaction,
  normalizeCategory,
  normalizeDate,
} from '../shared/transactions.js';

test('provider amount signs normalize to positive purchases', () => {
  assert.equal(canonicalAmount('12.34', 'positive'), 12.34);
  assert.equal(canonicalAmount('-12.34', 'negative'), 12.34);
  assert.equal(canonicalAmount('(12.34)', 'negative'), 12.34);
  assert.equal(canonicalAmount('50.00', 'negative'), -50);
  assert.throws(() => canonicalAmount('not money'), /invalid amount/);
});

test('dates are validated rather than silently rolled over', () => {
  assert.equal(normalizeDate('2026-08-29'), '2026-08-29');
  assert.equal(normalizeDate('8/29/2026'), '2026-08-29');
  assert.throws(() => normalizeDate('2026-02-30'), /invalid date/);
  assert.throws(() => normalizeDate('29/08/2026'), /invalid date/);
});

test('Teller categories map to the catalog vocabulary', () => {
  assert.equal(normalizeCategory('teller', 'dining'), 'FOOD_AND_DRINK');
  assert.equal(normalizeCategory('teller', 'transportation'), 'TRANSPORTATION');
  assert.equal(normalizeCategory('plaid', 'food and drink'), 'FOOD_AND_DRINK');
});

test('canonical transaction validates and names provider ids', () => {
  const transaction = canonicalTransaction({
    provider: 'teller',
    externalTransactionId: 'txn_1',
    accountId: 'teller:acc_1',
    itemId: 'teller:enr_1',
    date: '08/29/2026',
    name: 'Cafe',
    amount: '-9.50',
    category: 'dining',
  }, { chargeSign: 'negative' });
  assert.equal(transaction.transactionId, 'teller:txn_1');
  assert.equal(transaction.amount, 9.5);
  assert.equal(transaction.category, 'FOOD_AND_DRINK');
});

test('benefit matching only counts canonical positive purchases', () => {
  const benefit = { match: { merchants: [], categories: ['TRAVEL'] } };
  assert.equal(matchesBenefit({ amount: 30, category: 'TRAVEL' }, benefit), true);
  assert.equal(matchesBenefit({ amount: -30, category: 'TRAVEL' }, benefit), false);
  assert.equal(matchesBenefit({ amount: 30, category: 'TRANSPORTATION' }, benefit), false);
});
