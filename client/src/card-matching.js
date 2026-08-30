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

const GENERIC_PRODUCT_TOKENS = new Set([
  'account',
  'bank',
  'card',
  'consumer',
  'credit',
  'mastercard',
  'personal',
  'rewards',
  'visa',
]);

const canonicalIssuer = (value) => {
  const normalized = normalizeName(value);
  for (const [issuer, aliases] of ISSUER_ALIASES) {
    if (aliases.includes(normalized)) return issuer;
  }
  return normalized;
};

const nameTokens = (value) => normalizeName(value).split(' ').filter(Boolean);

const issuerTokens = (issuer) => {
  const canonical = canonicalIssuer(issuer);
  const aliases = ISSUER_ALIASES.get(canonical) || [canonical];
  return new Set(aliases.flatMap(nameTokens));
};

const productIdentityTokens = (product) => {
  const ignored = issuerTokens(product.issuer);
  return [...new Set(nameTokens(product.name).filter((token) => (
    !ignored.has(token) && !GENERIC_PRODUCT_TOKENS.has(token)
  )))];
};

const sourceMentionsIssuer = (sourceTokens, issuer) => {
  const canonical = canonicalIssuer(issuer);
  const aliases = ISSUER_ALIASES.get(canonical) || [canonical];
  return aliases.some((alias) => {
    const tokens = nameTokens(alias);
    return tokens.length > 0 && tokens.every((token) => sourceTokens.has(token));
  });
};

const singleMostSpecific = (matches) => {
  if (matches.length === 0) return null;
  const maxTokens = Math.max(...matches.map((match) => match.identityTokens.length));
  const mostSpecific = matches.filter((match) => match.identityTokens.length === maxTokens);
  return mostSpecific.length === 1 ? mostSpecific[0].product : null;
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
        reconnectRequiredCount: 0,
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
    if (item.relinkRequired) {
      group.reconnectRequiredCount += Math.max(1, item.accounts?.length || 0);
    }
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

export function matchProductForConnectedAccount(products, account, institutionName = '') {
  const sourceTokens = new Set(nameTokens([
    account?.name,
    account?.official_name,
    account?.officialName,
    institutionName,
  ].filter(Boolean).join(' ')));
  if (sourceTokens.size === 0 || products.length === 0) return null;

  const institutionIssuer = canonicalIssuer(institutionName);
  let candidates = products.filter((product) => canonicalIssuer(product.issuer) === institutionIssuer);

  if (candidates.length === 0) {
    const mentionedIssuers = [...new Set(products
      .map((product) => canonicalIssuer(product.issuer))
      .filter((issuer) => sourceMentionsIssuer(sourceTokens, issuer)))];
    candidates = mentionedIssuers.length === 1
      ? products.filter((product) => canonicalIssuer(product.issuer) === mentionedIssuers[0])
      : [];
  }

  const matches = candidates.map((product) => ({
    product,
    identityTokens: productIdentityTokens(product),
  }));
  const fullMatches = matches.filter(({ identityTokens }) => (
    identityTokens.length > 0 && identityTokens.every((token) => sourceTokens.has(token))
  ));
  const fullMatch = singleMostSpecific(fullMatches);
  if (fullMatch) return fullMatch;

  // If this user's catalog has only one product for the connected issuer, use
  // that roster entry as the default. The tracked card remains editable.
  if (candidates.length === 1 && canonicalIssuer(candidates[0].issuer) === institutionIssuer) {
    return candidates[0];
  }
  return null;
}

export function unmappedConnectedAccounts(accounts, cards) {
  const mappedAccountIds = new Set(cards.map((card) => card.account_id).filter(Boolean));
  return accounts.filter((account) => (
    account.provider !== 'csv'
    && String(account.type || '').toLowerCase() === 'credit'
    && !mappedAccountIds.has(account.account_id)
  ));
}

export function automaticConnectedCardMatches(accounts, cards, items, products) {
  const itemsById = new Map(items.map((item) => [item.itemId, item]));
  return unmappedConnectedAccounts(accounts, cards).flatMap((account) => {
    const item = itemsById.get(account.item_id) || null;
    const product = matchProductForConnectedAccount(products, account, item?.institutionName || '');
    return product ? [{ account, item, product }] : [];
  });
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
