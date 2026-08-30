import test from 'node:test';
import assert from 'node:assert/strict';
import { setItemChargeSign } from '../worker/src/db.js';

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
      return Promise.resolve([]);
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
