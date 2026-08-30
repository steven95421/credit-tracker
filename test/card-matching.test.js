import assert from 'node:assert/strict';
import test from 'node:test';
import {
  automaticConnectedCardMatches,
  defaultTrackedCardName,
  groupLinkedInstitutions,
  matchProductForConnectedAccount,
  partitionPendingAccounts,
  partitionProductsForInstitution,
  pruneDeferredSetupIds,
  prunePendingSelections,
  unmappedConnectedAccounts,
} from '../client/src/card-matching.js';

const products = [
  { key: 'amex_platinum', name: 'American Express Platinum', issuer: 'American Express' },
  { key: 'hilton_aspire', name: 'Hilton Honors Aspire', issuer: 'American Express' },
  { key: 'citi_strata_premier', name: 'Citi Strata Premier', issuer: 'Citi' },
];

const matchingProducts = [
  ...products,
  { key: 'amex_bonvoy_brilliant', name: 'Marriott Bonvoy Brilliant', issuer: 'American Express' },
  { key: 'citi_strata_elite', name: 'Citi Strata Elite', issuer: 'Citi' },
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

test('connected account product names match automatically when the result is unique', () => {
  const cases = [
    ['American Express Platinum Card', 'American Express National Bank', 'amex_platinum'],
    ['Hilton Honors American Express Aspire Card', 'American Express', 'hilton_aspire'],
    ['Marriott Bonvoy Brilliant® American Express® Card', 'American Express', 'amex_bonvoy_brilliant'],
    ['Citi Strata Premier Card', 'Citibank, N.A.', 'citi_strata_premier'],
    ['Citi Strata Elite Mastercard', '', 'citi_strata_elite'],
  ];

  for (const [accountName, institutionName, expectedKey] of cases) {
    assert.equal(
      matchProductForConnectedAccount(matchingProducts, { name: accountName }, institutionName)?.key,
      expectedKey
    );
  }

  assert.equal(
    matchProductForConnectedAccount(matchingProducts, { name: 'Citi Credit Card' }, 'Citi'),
    null
  );
  assert.equal(
    matchProductForConnectedAccount(matchingProducts, { name: 'Citi Strata' }, 'Citi'),
    null
  );
  assert.equal(
    matchProductForConnectedAccount(
      matchingProducts,
      { name: 'Hilton Honors Surpass' },
      'American Express'
    ),
    null
  );
  assert.equal(
    matchProductForConnectedAccount(matchingProducts, { name: 'Platinum' }, 'Chase'),
    null
  );
  assert.equal(
    matchProductForConnectedAccount(
      [matchingProducts[0]],
      { name: 'Credit Card' },
      'American Express'
    )?.key,
    'amex_platinum'
  );
});

test('automatic matches skip accounts that already have a tracked card', () => {
  const accounts = [
    { account_id: 'stripe:platinum', item_id: 'item:amex', provider: 'stripe', type: 'credit', name: 'Platinum Card' },
    { account_id: 'stripe:premier', item_id: 'item:citi', provider: 'stripe', type: 'credit', name: 'Citi Strata Premier' },
  ];
  const items = [
    { itemId: 'item:amex', institutionName: 'American Express' },
    { itemId: 'item:citi', institutionName: 'Citi' },
  ];
  const matches = automaticConnectedCardMatches(
    accounts,
    [{ account_id: 'stripe:platinum' }],
    items,
    matchingProducts
  );

  assert.deepEqual(matches.map(({ account, product }) => [account.account_id, product.key]), [
    ['stripe:premier', 'citi_strata_premier'],
  ]);
});

test('linked connections are grouped into one row per canonical institution', () => {
  const items = [
    {
      itemId: 'stripe:citi-1',
      institutionName: 'Citi',
      provider: 'stripe',
      lastSyncedAt: '2026-08-29T22:00:23.000Z',
      accounts: [{ account_id: 'citi-1' }],
    },
    {
      itemId: 'stripe:citi-2',
      institutionName: 'Citibank, N.A.',
      provider: 'stripe',
      lastSyncedAt: '2026-08-29T22:00:32.000Z',
      accounts: [{ account_id: 'citi-2' }],
    },
    {
      itemId: 'plaid:citi-3',
      institutionName: 'CITI',
      provider: 'plaid',
      lastSyncedAt: '2026-08-29T22:00:43.000Z',
      accounts: [{ account_id: 'citi-3' }],
    },
    {
      itemId: 'stripe:amex-1',
      institutionName: 'American Express National Bank',
      provider: 'stripe',
      lastSyncedAt: null,
      accountWarning: 'Reconnect this account.',
      accounts: [{ account_id: 'amex-1' }],
    },
    {
      itemId: 'stripe:unknown-1',
      institutionName: '',
      provider: 'stripe',
      accounts: [{ account_id: 'unknown-1' }],
    },
    {
      itemId: 'stripe:unknown-2',
      institutionName: '',
      provider: 'stripe',
      accounts: [{ account_id: 'unknown-2' }],
    },
  ];

  const groups = groupLinkedInstitutions(items);
  assert.deepEqual(groups.map((group) => group.institutionName), [
    'American Express',
    'Citi',
    'Institution',
    'Institution',
  ]);
  const citi = groups.find((group) => group.institutionName === 'Citi');
  const amex = groups.find((group) => group.institutionName === 'American Express');
  assert.equal(citi.items.length, 3);
  assert.equal(citi.accounts.length, 3);
  assert.deepEqual(citi.providers, ['stripe', 'plaid']);
  assert.equal(citi.oldestSyncedAt, '2026-08-29T22:00:23.000Z');
  assert.equal(citi.latestSyncedAt, '2026-08-29T22:00:43.000Z');
  assert.equal(citi.neverSyncedCount, 0);
  assert.equal(amex.needsAttention, true);
  assert.equal(amex.neverSyncedCount, 1);
  assert.notEqual(groups[2].key, groups[3].key);
});

test('provider fallback institution labels stay as separate connection rows', () => {
  const groups = groupLinkedInstitutions([
    { itemId: 'stripe:1', institutionName: 'Stripe credit card', provider: 'stripe', accounts: [] },
    { itemId: 'stripe:2', institutionName: 'Stripe credit card', provider: 'stripe', accounts: [] },
  ]);

  assert.equal(groups.length, 2);
  assert.notEqual(groups[0].key, groups[1].key);
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

test('deferred card setup tasks stay ordered at the bottom and stale tasks are pruned', () => {
  const accounts = [
    { account_id: 'stripe:1' },
    { account_id: 'stripe:2' },
    { account_id: 'stripe:3' },
  ];
  const deferredIds = new Set(['stripe:2', 'stripe:old']);

  const partitioned = partitionPendingAccounts(accounts, deferredIds);
  assert.deepEqual(partitioned.active.map((account) => account.account_id), ['stripe:1', 'stripe:3']);
  assert.deepEqual(partitioned.deferred.map((account) => account.account_id), ['stripe:2']);
  assert.deepEqual([...pruneDeferredSetupIds(deferredIds, accounts)], ['stripe:2']);

  const currentIds = new Set(['stripe:2']);
  assert.equal(pruneDeferredSetupIds(currentIds, accounts), currentIds);
});
