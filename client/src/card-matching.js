const normalizeName = (value) => String(value || '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const ISSUER_ALIASES = new Map([
  ['american express', ['american express', 'american express national bank', 'amex']],
  ['citi', ['citi', 'citibank', 'citibank na', 'citibank n a', 'citibank national association']],
]);

const ISSUER_DISPLAY_NAMES = new Map([
  ['american express', 'American Express'],
  ['citi', 'Citi'],
]);

const NON_GROUPABLE_INSTITUTION_NAMES = new Set([
  '',
  'institution',
  'institution unavailable',
  'stripe credit card',
  'teller institution',
  'unknown institution',
]);

const canonicalIssuer = (value) => {
  const normalized = normalizeName(value);
  for (const [issuer, aliases] of ISSUER_ALIASES) {
    if (aliases.includes(normalized)) return issuer;
  }
  return normalized;
};

const laterTimestamp = (current, candidate) => {
  const candidateTime = Date.parse(candidate || '');
  if (!Number.isFinite(candidateTime)) return current;
  const currentTime = Date.parse(current || '');
  return !Number.isFinite(currentTime) || candidateTime > currentTime ? candidate : current;
};

const earlierTimestamp = (current, candidate) => {
  const candidateTime = Date.parse(candidate || '');
  if (!Number.isFinite(candidateTime)) return current;
  const currentTime = Date.parse(current || '');
  return !Number.isFinite(currentTime) || candidateTime < currentTime ? candidate : current;
};

export function groupLinkedInstitutions(items) {
  const groups = new Map();

  items.forEach((item, index) => {
    const originalName = String(item.institutionName || '').trim();
    const canonicalName = canonicalIssuer(originalName);
    // Stripe creates one independently removable Item per account and does not
    // expose a Plaid-style institution id. Group real normalized bank names,
    // but keep provider fallback labels separate so unrelated cards never merge.
    const groupableName = NON_GROUPABLE_INSTITUTION_NAMES.has(canonicalName) ? '' : canonicalName;
    const key = groupableName
      ? `institution:${canonicalName}`
      : `connection:${item.itemId || index}`;
    let group = groups.get(key);

    if (!group) {
      group = {
        key,
        institutionName: ISSUER_DISPLAY_NAMES.get(groupableName) || originalName || 'Institution',
        items: [],
        providers: [],
        accounts: [],
        oldestSyncedAt: null,
        latestSyncedAt: null,
        neverSyncedCount: 0,
        refreshPending: false,
        needsAttention: false,
      };
      groups.set(key, group);
    }

    group.items.push(item);
    if (item.provider && !group.providers.includes(item.provider)) group.providers.push(item.provider);
    if (Array.isArray(item.accounts)) group.accounts.push(...item.accounts);
    const syncedAt = Date.parse(item.lastSyncedAt || '');
    if (Number.isFinite(syncedAt)) {
      group.oldestSyncedAt = earlierTimestamp(group.oldestSyncedAt, item.lastSyncedAt);
      group.latestSyncedAt = laterTimestamp(group.latestSyncedAt, item.lastSyncedAt);
    } else {
      group.neverSyncedCount += 1;
    }
    group.refreshPending ||= Boolean(item.refreshPending);
    group.needsAttention ||= Boolean(
      item.capabilityWarning || item.subscriptionWarning || item.accountWarning
    );
  });

  return [...groups.values()].sort((left, right) => (
    left.institutionName.localeCompare(right.institutionName, 'en', { sensitivity: 'base' })
      || left.key.localeCompare(right.key)
  ));
}

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
