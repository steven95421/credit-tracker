import test from 'node:test';
import assert from 'node:assert/strict';
import { rebindProviderAccounts, setItemChargeSign } from '../worker/src/db.js';

function fakeDb() {
  const prepared = [];
  let batched = null;
  return {
    prepared,
    get batched() { return batched; },
    prepare(sql) {
      const statement = {
        sql,
        bindings: [],
        bind(...bindings) {
          this.bindings = bindings;
          return this;
        },
      };
      prepared.push(statement);
      return statement;
    },
    batch(statements) {
      batched = statements;
      return Promise.resolve(statements.map(() => ({ meta: { changes: 1 } })));
    },
  };
}

test('Stripe sign update is one guarded D1 batch and always resets the replay cursor', async () => {
  const DB = fakeDb();
  await setItemChargeSign(DB, 'stripe:item', 'positive', '2026-08-29T12:00:00.000Z');

  assert.equal(DB.batched.length, 2);
  assert.match(DB.batched[0].sql, /SET amount = -amount/);
  assert.match(DB.batched[0].sql, /json_extract/);
  assert.match(DB.batched[0].sql, /'negative'/);
  assert.deepEqual(DB.batched[0].bindings, ['stripe:item', 'stripe:item', 'positive']);

  const patch = JSON.parse(DB.batched[1].bindings[0]);
  assert.deepEqual(patch, {
    chargeSign: 'positive',
    chargeSignSource: 'user',
    chargeSignUpdatedAt: '2026-08-29T12:00:00.000Z',
    transactionRefreshes: null,
  });
  assert.equal(DB.batched[1].bindings[1], 'stripe:item');
});

test('provider account rebind atomically preserves local item and account ids', async () => {
  const DB = fakeDb();
  await rebindProviderAccounts(DB, 'stripe', [{
    itemId: 'stable-item',
    previousExternalAccountId: 'fca_old',
    externalAccountId: 'fca_new',
    institutionName: 'American Express',
    providerData: { authorizationId: 'fcauth_new' },
    account: {
      accountId: 'stable-account',
      externalAccountId: 'fca_new',
      itemId: 'stable-item',
      name: 'Platinum Card',
      officialName: 'American Express',
      mask: '3001',
      type: 'credit',
      subtype: 'credit_card',
    },
  }]);

  assert.equal(DB.batched.length, 3);
  assert.match(DB.batched[0].sql, /AS rebind_guard/);
  assert.match(DB.batched[0].sql, /json_extract/);
  assert.deepEqual(DB.batched[0].bindings, [
    'stable-item',
    'stripe',
    'fca_old',
    'fca_new',
    'stable-account',
    'stripe',
    'stable-item',
    'fca_old',
    'fca_new',
  ]);
  assert.match(DB.batched[1].sql, /UPDATE items/);
  assert.deepEqual(DB.batched[1].bindings, [
    'fca_new',
    'American Express',
    JSON.stringify({ authorizationId: 'fcauth_new' }),
    'stable-item',
    'stripe',
    'fca_old',
    'fca_new',
  ]);
  assert.match(DB.batched[2].sql, /UPDATE accounts/);
  assert.deepEqual(DB.batched[2].bindings.slice(-5), [
    'stable-account',
    'stripe',
    'stable-item',
    'fca_old',
    'fca_new',
  ]);
});

test('provider account rebind rejects any zero-row update after the in-batch guard', async () => {
  const DB = fakeDb();
  DB.batch = async (statements) => {
    const results = statements.map(() => ({ meta: { changes: 1 } }));
    results[2] = { meta: { changes: 0 } };
    return results;
  };
  await assert.rejects(
    rebindProviderAccounts(DB, 'stripe', [{
      itemId: 'stable-item',
      previousExternalAccountId: 'fca_old',
      externalAccountId: 'fca_new',
      institutionName: 'American Express',
      providerData: {},
      account: {
        accountId: 'stable-account', externalAccountId: 'fca_new', itemId: 'stable-item',
      },
    }]),
    /did not update every expected item and account/
  );
});
