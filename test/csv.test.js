import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCsvRows, parseCsvText } from '../client/src/csv.js';

test('CSV parser accepts common transaction statement headers', async () => {
  const rows = await parseCsvText(
    'Transaction Date,Description,Amount,Category\n08/28/2026,Uber,-18.20,Transportation\n'
  );
  assert.deepEqual(rows, [{
    date: '08/28/2026',
    description: 'Uber',
    amount: -18.2,
    category: 'Transportation',
    currency: 'USD',
  }]);
});

test('CSV parser converts separate debit and credit columns to signed amounts', () => {
  const rows = normalizeCsvRows([
    { Date: '08/28/2026', Description: 'Cafe', Debit: '12.34', Credit: '' },
    { Date: '08/29/2026', Description: 'Payment', Debit: '', Credit: '50.00' },
  ]);
  assert.equal(rows[0].amount, 12.34);
  assert.equal(rows[1].amount, -50);
});

test('CSV parser rejects missing required columns', () => {
  assert.throws(
    () => normalizeCsvRows([{ Description: 'Cafe', Amount: '12.34' }]),
    /needs a Date/
  );
});
