// Provider-neutral transaction contract used by every ingest path.
// Canonical invariants:
//   - amount is a finite number; positive = purchase/charge, negative = payment/refund
//   - date is an actual YYYY-MM-DD calendar date
//   - category uses the small vocabulary consumed by shared/catalog.json

export const PROVIDERS = Object.freeze({
  STRIPE: 'stripe',
  PLAID: 'plaid',
  TELLER: 'teller',
  CSV: 'csv',
});

export function localId(provider, externalId) {
  if (!provider || !externalId) throw new Error('provider and external id are required');
  return `${provider}:${externalId}`;
}

export function parseFiniteAmount(value) {
  const cleaned = typeof value === 'string'
    ? value.trim().replace(/[$,]/g, '').replace(/^\((.*)\)$/, '-$1')
    : value;
  if (cleaned === '' || cleaned === null || cleaned === undefined) {
    throw new Error('amount is required');
  }
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) throw new Error(`invalid amount: ${value}`);
  return amount;
}

export function canonicalAmount(value, chargeSign = 'positive') {
  if (!['positive', 'negative'].includes(chargeSign)) {
    throw new Error('chargeSign must be positive or negative');
  }
  const amount = parseFiniteAmount(value);
  return chargeSign === 'negative' ? -amount : amount;
}

function validYMD(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function normalizeDate(value) {
  const input = String(value || '').trim();
  let match = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let y;
  let m;
  let d;
  if (match) {
    [, y, m, d] = match.map(Number);
  } else {
    match = input.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (!match) throw new Error(`invalid date: ${value}`);
    m = Number(match[1]);
    d = Number(match[2]);
    y = Number(match[3]);
  }
  if (!validYMD(y, m, d)) throw new Error(`invalid date: ${value}`);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const CATEGORY_ALIASES = new Map([
  ['FOOD_AND_DRINK', 'FOOD_AND_DRINK'],
  ['DINING', 'FOOD_AND_DRINK'],
  ['BAR', 'FOOD_AND_DRINK'],
  ['RESTAURANT', 'FOOD_AND_DRINK'],
  ['RESTAURANTS', 'FOOD_AND_DRINK'],
  ['TRAVEL', 'TRAVEL'],
  ['ACCOMMODATION', 'TRAVEL'],
  ['TRANSPORT', 'TRANSPORTATION'],
  ['TRANSPORTATION', 'TRANSPORTATION'],
  ['AIRLINE', 'TRAVEL'],
  ['AIRLINES', 'TRAVEL'],
]);

export function normalizeCategory(_provider, value) {
  const category = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!category) return null;
  return CATEGORY_ALIASES.get(category) || category;
}

export function parseProviderData(item) {
  if (!item?.provider_data) return {};
  try {
    return JSON.parse(item.provider_data) || {};
  } catch {
    return {};
  }
}

export function canonicalTransaction(input, options = {}) {
  const provider = input.provider;
  const externalTransactionId = String(input.externalTransactionId || '');
  if (!provider || !externalTransactionId || !input.accountId || !input.itemId) {
    throw new Error('transaction provider, external id, account id, and item id are required');
  }
  return {
    transactionId: input.transactionId || localId(provider, externalTransactionId),
    provider,
    externalTransactionId,
    accountId: input.accountId,
    itemId: input.itemId,
    date: normalizeDate(input.date),
    name: String(input.name || '').slice(0, 500) || null,
    merchantName: String(input.merchantName || '').slice(0, 500) || null,
    amount: canonicalAmount(input.amount, options.chargeSign || 'positive'),
    isoCurrency: String(input.isoCurrency || '').toUpperCase().slice(0, 3) || null,
    category: normalizeCategory(provider, input.category),
    pending: Boolean(input.pending),
    raw: input.raw == null ? null : typeof input.raw === 'string' ? input.raw : JSON.stringify(input.raw),
  };
}
