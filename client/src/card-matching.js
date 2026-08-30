const normalizeName = (value) => String(value || '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const ISSUER_ALIASES = new Map([
  ['american express', ['american express', 'american express national bank', 'amex']],
  ['citi', ['citi', 'citibank', 'citibank na', 'citibank n a', 'citibank national association']],
]);

const canonicalIssuer = (value) => {
  const normalized = normalizeName(value);
  for (const [issuer, aliases] of ISSUER_ALIASES) {
    if (aliases.includes(normalized)) return issuer;
  }
  return normalized;
};

export function partitionProductsForInstitution(products, institutionName) {
  const institutionIssuer = canonicalIssuer(institutionName);
  if (!institutionIssuer) return { suggested: [], other: [...products] };

  const suggested = [];
  const other = [];
  for (const product of products) {
    if (canonicalIssuer(product.issuer) === institutionIssuer) suggested.push(product);
    else other.push(product);
  }
  return { suggested, other };
}

export function unmappedConnectedAccounts(accounts, cards) {
  const mappedAccountIds = new Set(cards.map((card) => card.account_id).filter(Boolean));
  return accounts.filter((account) => (
    account.provider !== 'csv'
    && String(account.type || '').toLowerCase() === 'credit'
    && !mappedAccountIds.has(account.account_id)
  ));
}

export function prunePendingSelections(selections, pendingAccounts) {
  const pendingAccountIds = new Set(pendingAccounts.map((account) => account.account_id));
  const next = Object.fromEntries(
    Object.entries(selections).filter(([accountId]) => pendingAccountIds.has(accountId))
  );
  return Object.keys(next).length === Object.keys(selections).length ? selections : next;
}

export function partitionPendingAccounts(pendingAccounts, deferredAccountIds) {
  const active = [];
  const deferred = [];
  for (const account of pendingAccounts) {
    (deferredAccountIds.has(account.account_id) ? deferred : active).push(account);
  }
  return { active, deferred };
}

export function pruneDeferredSetupIds(deferredAccountIds, pendingAccounts) {
  const pendingAccountIds = new Set(pendingAccounts.map((account) => account.account_id));
  const next = new Set(
    [...deferredAccountIds].filter((accountId) => pendingAccountIds.has(accountId))
  );
  return next.size === deferredAccountIds.size ? deferredAccountIds : next;
}

export function defaultTrackedCardName(account, item) {
  return account.name || item?.institutionName || null;
}
