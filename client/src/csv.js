import Papa from 'papaparse';

const ALIASES = Object.freeze({
  date: ['date', 'transactiondate', 'posteddate', 'postingdate'],
  description: ['description', 'merchant', 'merchantname', 'name', 'memo'],
  amount: ['amount', 'transactionamount'],
  debit: ['debit', 'debitamount', 'charge'],
  credit: ['credit', 'creditamount', 'payment'],
  category: ['category', 'categoryname'],
  currency: ['currency', 'isocurrency', 'currencycode'],
});

export const normalizeCsvHeader = (value) => String(value || '')
  .replace(/^\uFEFF/, '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '');

const present = (value) => value !== undefined && value !== null && String(value).trim() !== '';

function amountNumber(value, label) {
  const text = String(value || '').trim().replace(/[$,]/g, '').replace(/^\((.*)\)$/, '-$1');
  const amount = Number(text);
  if (!Number.isFinite(amount)) throw new Error(`invalid ${label}: ${value}`);
  return amount;
}

function headerMap(row) {
  return new Map(Object.keys(row || {}).map((key) => [normalizeCsvHeader(key), key]));
}

function findColumn(headers, names) {
  for (const name of names) {
    const original = headers.get(name);
    if (original) return original;
  }
  return null;
}

export function normalizeCsvRows(records) {
  const nonEmpty = (records || []).filter((row) =>
    Object.values(row || {}).some((value) => present(value))
  );
  if (nonEmpty.length === 0) throw new Error('CSV has no transaction rows');

  const headers = headerMap(nonEmpty[0]);
  const columns = Object.fromEntries(
    Object.entries(ALIASES).map(([field, aliases]) => [field, findColumn(headers, aliases)])
  );
  if (!columns.date) throw new Error('CSV needs a Date, Transaction Date, or Posted Date column');
  if (!columns.description) throw new Error('CSV needs a Description, Merchant, Name, or Memo column');
  if (!columns.amount && !columns.debit && !columns.credit) {
    throw new Error('CSV needs an Amount column, or Debit/Credit columns');
  }

  return nonEmpty.map((row, index) => {
    let amount;
    if (columns.amount && present(row[columns.amount])) {
      amount = amountNumber(row[columns.amount], 'amount');
    } else if (columns.debit && present(row[columns.debit])) {
      amount = Math.abs(amountNumber(row[columns.debit], 'debit'));
    } else if (columns.credit && present(row[columns.credit])) {
      amount = -Math.abs(amountNumber(row[columns.credit], 'credit'));
    } else {
      throw new Error(`row ${index + 2} has no amount`);
    }

    return {
      date: row[columns.date],
      description: row[columns.description],
      amount,
      category: columns.category ? row[columns.category] : null,
      currency: columns.currency ? row[columns.currency] : 'USD',
    };
  });
}

function parse(input) {
  return new Promise((resolve, reject) => {
    Papa.parse(input, {
      header: true,
      skipEmptyLines: 'greedy',
      complete: (result) => {
        const fatal = result.errors.find((error) => error.code !== 'TooFewFields');
        if (fatal) {
          reject(new Error(`CSV row ${(fatal.row ?? 0) + 2}: ${fatal.message}`));
          return;
        }
        try {
          resolve(normalizeCsvRows(result.data));
        } catch (error) {
          reject(error);
        }
      },
      error: reject,
    });
  });
}

export const parseCsvFile = (file) => parse(file);
export const parseCsvText = (text) => parse(text);
