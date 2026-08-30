import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultTrackedCardName,
  partitionProductsForInstitution,
  prunePendingSelections,
  unmappedConnectedAccounts,
} from '../client/src/card-matching.js';

const products = [
  { key: 'amex_platinum', issuer: 'American Express' },
  { key: 'hilton_aspire', issuer: 'American Express' },
  { key: 'citi_strata_premier', issuer: 'Citi' },
];

test('card products are suggested only when the institution issuer is unambiguous', () => {
  const amex = partitionProductsForInstitution(products, 'American Express National Bank');
  assert.deepEqual(amex.suggested.map((product) => product.key), [
    'amex_platinum',
    'hilton_aspire',
  ]);
  assert.deepEqual(amex.other.map((product) => product.key), ['citi_strata_premier']);

  const citi = partitionProductsForInstitution(products, 'Citibank, N.A.');
  assert.deepEqual(citi.suggested.map((product) => product.key), ['citi_strata_premier']);

  const citizens = partitionProductsForInstitution(products, 'Citizens Bank');
  assert.deepEqual(citizens.suggested, []);
  assert.deepEqual(citizens.other, products);

  const sandbox = partitionProductsForInstitution(products, 'StripeBank');
  assert.deepEqual(sandbox.suggested, []);
  assert.deepEqual(sandbox.other, products);

  const missing = partitionProductsForInstitution(products, '');
  assert.deepEqual(missing.suggested, []);
  assert.deepEqual(missing.other, products);
});

test('only connected credit accounts without a tracked card need confirmation', () => {
  const accounts = [
    { account_id: 'stripe:1', provider: 'stripe', type: 'credit' },
    { account_id: 'stripe:2', provider: 'stripe', type: 'credit' },
    { account_id: 'plaid:checking', provider: 'plaid', type: 'depository' },
    { account_id: 'csv:1', provider: 'csv', type: 'credit' },
  ];
  const cards = [{ account_id: 'stripe:1' }];
  assert.deepEqual(
    unmappedConnectedAccounts(accounts, cards).map((account) => account.account_id),
    ['stripe:2']
  );
});

test('tracked card names use provider display names without treating them as products', () => {
  assert.equal(defaultTrackedCardName({ name: 'Sandbox Rewards' }, null), 'Sandbox Rewards');
  assert.equal(defaultTrackedCardName({ name: '' }, { institutionName: 'Citi' }), 'Citi');
});

test('pending product selections retain only accounts that still need confirmation', () => {
  const selections = { 'stripe:1': 'amex_platinum', 'stripe:2': 'hilton_aspire' };
  const unchanged = prunePendingSelections(selections, [
    { account_id: 'stripe:1' },
    { account_id: 'stripe:2' },
  ]);
  assert.equal(unchanged, selections);
  assert.deepEqual(
    prunePendingSelections(selections, [{ account_id: 'stripe:2' }]),
    { 'stripe:2': 'hilton_aspire' }
  );
});
