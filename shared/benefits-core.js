// Pure benefit engine — no filesystem, no Node APIs. Shared by:
//   server/  (Express + node:sqlite, local use)
//   worker/  (Cloudflare Worker + D1, cloud deployment)
// Callers supply the catalog products array and async-capable data deps.

// ---------- calendar helpers (YYYY-MM-DD) ----------
const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function todayYMD(now = new Date(), timeZone = null) {
  if (timeZone) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(now).map((part) => [part.type, part.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function parseYMD(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fmt(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function lastDay(y, m) {
  // m is 1-based; day 0 of next month == last day of month m
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Returns the current period window containing `today`.
 * { start, end, key, label } — start/end inclusive YYYY-MM-DD strings.
 */
export function periodWindow(period, today = todayYMD(), anchor = null) {
  const t = parseYMD(today);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + 1; // 1-based

  switch (period) {
    case 'monthly':
      return {
        start: fmt(y, m, 1),
        end: fmt(y, m, lastDay(y, m)),
        key: `${y}-${String(m).padStart(2, '0')}`,
        label: `${MONTHS[m - 1]} ${y}`,
      };
    case 'quarterly': {
      const qi = Math.floor((m - 1) / 3); // 0..3
      const sm = qi * 3 + 1;
      const em = sm + 2;
      return {
        start: fmt(y, sm, 1),
        end: fmt(y, em, lastDay(y, em)),
        key: `${y}-Q${qi + 1}`,
        label: `Q${qi + 1} ${y}`,
      };
    }
    case 'semiannual': {
      const half = m <= 6 ? 1 : 2;
      return half === 1
        ? { start: fmt(y, 1, 1), end: fmt(y, 6, 30), key: `${y}-H1`, label: `H1 ${y} (Jan–Jun)` }
        : { start: fmt(y, 7, 1), end: fmt(y, 12, 31), key: `${y}-H2`, label: `H2 ${y} (Jul–Dec)` };
    }
    case 'annual': {
      if (anchor && anchor.month) {
        const am = anchor.month;
        const ad = anchor.day || 1;
        // cycle start = most recent anchor date on/before today
        let startYear = y;
        const anchorThisYear = parseYMD(fmt(y, am, Math.min(ad, lastDay(y, am))));
        if (t < anchorThisYear) startYear = y - 1;
        const start = fmt(startYear, am, Math.min(ad, lastDay(startYear, am)));
        const endDate = new Date(parseYMD(start));
        endDate.setUTCFullYear(endDate.getUTCFullYear() + 1);
        endDate.setUTCDate(endDate.getUTCDate() - 1);
        const end = endDate.toISOString().slice(0, 10);
        return { start, end, key: `${start}_AY`, label: `${start} → ${end}` };
      }
      return { start: fmt(y, 1, 1), end: fmt(y, 12, 31), key: `${y}`, label: `${y}` };
    }
    default:
      // treat unknown as monthly
      return periodWindow('monthly', today);
  }
}

export function daysUntil(endYMD, today = todayYMD()) {
  return Math.round((parseYMD(endYMD) - parseYMD(today)) / DAY);
}

function benefitAmount(benefit, today) {
  const month = String(Number(today.slice(5, 7)));
  const override = benefit.amountByMonth?.[month]
    ?? benefit.amountByMonth?.[today.slice(5, 7)];
  const amount = Number(override ?? benefit.amount);
  return Number.isFinite(amount) ? amount : 0;
}

const CREDIT_WORDS = /\b(credit|rebate|reimburse(?:ment|d)?|benefit|offer|statement adjustment)\b/;
const PAYMENT_WORDS = /\b(autopay|auto pay|automatic payment|payment received|online payment|mobile payment|thank you for your payment)\b/;
const REVERSAL_WORDS = /\b(refund|refunded|return|returned|reversal|reversed|chargeback|dispute)\b/;
const CREDIT_TOKEN_STOPWORDS = new Set([
  'american', 'express', 'amex', 'citi', 'card', 'credit', 'benefit', 'monthly', 'quarterly',
  'semiannual', 'annual', 'the', 'and', 'with', 'membership',
]);

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function transactionText(txn) {
  return normalizeText(`${txn.merchant_name || ''} ${txn.name || ''}`);
}

function isPending(txn) {
  return txn.pending === true || Number(txn.pending) === 1;
}

function inWindow(txn, win) {
  return Boolean(txn.date && txn.date >= win.start && txn.date <= win.end);
}

function windowDays(win) {
  return Math.round((parseYMD(win.end) - parseYMD(win.start)) / DAY) + 1;
}

function purchaseEvidence(txn, benefit) {
  // Every provider adapter must emit the canonical sign: positive = purchase/charge.
  if (isPending(txn) || !Number.isFinite(Number(txn.amount)) || Number(txn.amount) <= 0) return null;
  const rules = benefit.match || {};
  const hay = transactionText(txn);
  const merchants = (rules.merchants || [])
    .map(normalizeText)
    .filter(Boolean);
  const merchant = merchants
    .filter((token) => hay.includes(token))
    .sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
  if (merchant) return { rank: 3, specificity: merchant.length, reason: 'merchant' };

  const category = String(txn.category || '').toUpperCase();
  const categories = (rules.categories || []).map((value) => String(value).toUpperCase());
  if (category && categories.includes(category)) {
    return { rank: 2, specificity: category.length, reason: 'category' };
  }
  return null;
}

/** True if a posted purchase counts toward a benefit's eligible spend. */
export function matchesBenefit(txn, benefit) {
  return Boolean(purchaseEvidence(txn, benefit));
}

function benefitCreditTokens(benefit) {
  if (benefit.tracking === 'wallet') return [];
  const explicit = benefit.creditMatch?.descriptions || [];
  const merchants = benefit.match?.merchants || [];
  const nameWords = normalizeText(benefit.name)
    .split(' ')
    .filter((word) => word.length >= 3 && !CREDIT_TOKEN_STOPWORDS.has(word));
  const namePhrase = nameWords.join(' ');
  // Keep the meaningful benefit name as a phrase. Individual words such as
  // "fee" are too broad and can turn unrelated fee rebates into false matches.
  return [...new Set([...explicit, ...merchants, namePhrase]
    .map(normalizeText)
    .filter((token) => token.length >= 3))];
}

function compareCandidates(a, b) {
  return b.rank - a.rank
    || b.specificity - a.specificity
    || a.windowDays - b.windowDays
    || a.benefitId.localeCompare(b.benefitId);
}

function sameCandidateStrength(a, b) {
  return a.rank === b.rank
    && a.specificity === b.specificity
    && a.windowDays === b.windowDays;
}

function chooseOwner(candidates) {
  if (candidates.length === 0) return { owner: null, collided: false, ambiguous: false };
  const ordered = [...candidates].sort(compareCandidates);
  const ambiguous = ordered.length > 1 && sameCandidateStrength(ordered[0], ordered[1]);
  return {
    owner: ambiguous ? null : ordered[0],
    collided: ordered.length > 1,
    ambiguous,
  };
}

function transactionKey(txn, index) {
  return String(
    txn.transaction_id
    || txn.external_transaction_id
    || `${txn.date || ''}:${txn.name || ''}:${txn.amount || ''}:${index}`
  );
}

function daysBetween(earlier, later) {
  return Math.round((parseYMD(later) - parseYMD(earlier)) / DAY);
}

function bestPurchasePair(creditTxn, creditAmount, purchases, benefitId) {
  return purchases
    .filter((entry) => entry.benefitId === benefitId)
    .map((entry) => ({
      ...entry,
      source: entry,
      gap: daysBetween(entry.txn.date, creditTxn.date),
      availableAmount: Number(entry.remainingAmount ?? entry.txn.amount),
      amountGap: Math.abs(Number(entry.remainingAmount ?? entry.txn.amount) - creditAmount),
    }))
    .filter((entry) => entry.gap >= 0 && entry.gap <= 90 && entry.availableAmount + 0.01 >= creditAmount)
    .sort((a, b) => {
      const aExact = a.amountGap <= 0.01 ? 0 : 1;
      const bExact = b.amountGap <= 0.01 ? 0 : 1;
      return aExact - bExact || a.amountGap - b.amountGap || a.gap - b.gap || a.key.localeCompare(b.key);
    })[0] || null;
}

/**
 * Assign every posted transaction to at most one benefit in its active window.
 * Positive canonical amounts are purchases. Negative canonical amounts are inflows;
 * only explicit statement-credit evidence is considered, while payments/refunds are ignored.
 */
export function attributeTransactions(txns, benefitEntries) {
  const stats = Object.fromEntries(benefitEntries.map(({ benefit }) => [benefit.id, {
    autoUsed: 0,
    matchedCount: 0,
    purchaseMatchedCount: 0,
    creditMatchedCount: 0,
    reversalMatchedCount: 0,
  }]));
  const ownership = {};
  const purchases = [];
  let collisionCount = 0;
  let ambiguousCount = 0;

  const rows = (txns || [])
    .map((txn, index) => ({ txn, key: transactionKey(txn, index) }))
    .sort((a, b) => String(a.txn.date || '').localeCompare(String(b.txn.date || '')) || a.key.localeCompare(b.key));

  for (const row of rows) {
    const amount = Number(row.txn.amount);
    if (!Number.isFinite(amount) || amount <= 0 || isPending(row.txn)) continue;
    const candidates = benefitEntries.flatMap(({ benefit, window }) => {
      if (!inWindow(row.txn, window) || benefit.tracking === 'wallet') return [];
      const evidence = purchaseEvidence(row.txn, benefit);
      return evidence ? [{
        ...evidence,
        benefitId: benefit.id,
        windowDays: windowDays(window),
      }] : [];
    });
    const chosen = chooseOwner(candidates);
    if (chosen.collided) collisionCount++;
    if (chosen.ambiguous) ambiguousCount++;
    if (!chosen.owner) continue;
    ownership[row.key] = { benefitId: chosen.owner.benefitId, role: 'purchase', reason: chosen.owner.reason };
    const benefitStats = stats[chosen.owner.benefitId];
    benefitStats.autoUsed += amount;
    benefitStats.matchedCount++;
    benefitStats.purchaseMatchedCount++;
    purchases.push({ ...row, benefitId: chosen.owner.benefitId, remainingAmount: amount });
  }

  // Reversals/refunds undo eligible spend. Pair only when the negative row also
  // carries the benefit's merchant/category evidence; unmatched refunds stay ignored.
  for (const row of rows) {
    const amount = Number(row.txn.amount);
    if (!Number.isFinite(amount) || amount >= 0 || isPending(row.txn)) continue;
    const hay = transactionText(row.txn);
    if (!REVERSAL_WORDS.test(hay) || PAYMENT_WORDS.test(hay)) continue;
    const reversalAmount = Math.abs(amount);
    const candidates = benefitEntries.flatMap(({ benefit, window }) => {
      if (!inWindow(row.txn, window) || benefit.tracking === 'wallet') return [];
      const evidence = purchaseEvidence({ ...row.txn, amount: reversalAmount, pending: false }, benefit);
      const pair = bestPurchasePair(row.txn, reversalAmount, purchases, benefit.id);
      if (!evidence || !pair) return [];
      return [{
        ...evidence,
        benefitId: benefit.id,
        specificity: evidence.specificity + (pair.amountGap <= 0.01 ? 60 : Math.max(0, 60 - pair.gap)),
        windowDays: windowDays(window),
        reason: 'reversal-purchase-pair',
        pair,
      }];
    });
    const chosen = chooseOwner(candidates);
    if (chosen.collided) collisionCount++;
    if (chosen.ambiguous) ambiguousCount++;
    if (!chosen.owner) continue;
    const reversedAmount = Math.min(reversalAmount, chosen.owner.pair.availableAmount);
    chosen.owner.pair.source.remainingAmount = round2(chosen.owner.pair.availableAmount - reversedAmount);
    ownership[row.key] = {
      benefitId: chosen.owner.benefitId,
      role: 'reversal',
      reason: chosen.owner.reason,
      pairedPurchaseId: chosen.owner.pair.key,
    };
    const benefitStats = stats[chosen.owner.benefitId];
    benefitStats.autoUsed = Math.max(0, benefitStats.autoUsed - reversedAmount);
    benefitStats.matchedCount++;
    benefitStats.reversalMatchedCount++;
  }

  for (const row of rows) {
    const amount = Number(row.txn.amount);
    if (!Number.isFinite(amount) || amount >= 0 || isPending(row.txn)) continue;
    const hay = transactionText(row.txn);
    if (!CREDIT_WORDS.test(hay) || PAYMENT_WORDS.test(hay) || REVERSAL_WORDS.test(hay)) continue;
    const creditAmount = Math.abs(amount);
    const candidates = benefitEntries.flatMap(({ benefit, window }) => {
      if (!inWindow(row.txn, window) || benefit.tracking === 'wallet') return [];
      const tokens = benefitCreditTokens(benefit)
        .filter((token) => hay.includes(token))
        .sort((a, b) => b.length - a.length || a.localeCompare(b));
      const pair = bestPurchasePair(row.txn, creditAmount, purchases, benefit.id);
      if (tokens.length === 0 && !pair) return [];
      const descriptorRank = tokens.length > 0 ? 5 : 0;
      const pairRank = pair ? (pair.amountGap <= 0.01 ? 4 : 3) : 0;
      return [{
        benefitId: benefit.id,
        rank: descriptorRank + pairRank,
        specificity: (tokens[0]?.length || 0) + (pair ? Math.max(0, 60 - pair.gap) : 0),
        windowDays: windowDays(window),
        reason: tokens.length > 0 && pair ? 'credit-description+purchase' : tokens.length > 0 ? 'credit-description' : 'credit-purchase-pair',
        pairedPurchaseKey: pair?.key || null,
      }];
    });
    const chosen = chooseOwner(candidates);
    if (chosen.collided) collisionCount++;
    if (chosen.ambiguous) ambiguousCount++;
    if (!chosen.owner) continue;
    ownership[row.key] = {
      benefitId: chosen.owner.benefitId,
      role: 'statement_credit',
      reason: chosen.owner.reason,
      pairedPurchaseId: chosen.owner.pairedPurchaseKey,
    };
    const benefitStats = stats[chosen.owner.benefitId];
    // A paired purchase is already counted as used; the credit confirms it rather than doubling it.
    if (!chosen.owner.pairedPurchaseKey) benefitStats.autoUsed += creditAmount;
    benefitStats.matchedCount++;
    benefitStats.creditMatchedCount++;
  }

  const limits = Object.fromEntries(benefitEntries.map(({ benefit, amount }) => {
    const limit = Number(amount ?? benefit.amount);
    return [benefit.id, Number.isFinite(limit) ? Math.max(0, limit) : Infinity];
  }));
  for (const [benefitId, value] of Object.entries(stats)) {
    value.autoUsed = round2(Math.min(value.autoUsed, limits[benefitId] ?? Infinity));
  }
  return { ownership, stats, collisionCount, ambiguousCount };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Build the dashboard status for one card profile.
 * products: catalog products array.
 * deps: { getTxnsBetween(accountId,start,end) -> rows|Promise, getOverride(cardId,benefitId,periodKey) -> row|undefined|Promise }
 * Async so D1 (Promise-based) and node:sqlite (sync) both work.
 */
export async function statusForCard(card, products, deps, today = todayYMD()) {
  const product = products.find((p) => p.key === card.product_key) || null;
  const benefitEntries = (product?.benefits || []).map((benefit) => ({
    benefit,
    amount: benefitAmount(benefit, today),
    window: periodWindow(benefit.period, today, benefit.anchor),
  }));
  let attribution = { ownership: {}, stats: {}, collisionCount: 0, ambiguousCount: 0 };
  if (card.account_id && benefitEntries.length > 0) {
    const start = benefitEntries.reduce((value, entry) => value < entry.window.start ? value : entry.window.start, benefitEntries[0].window.start);
    const end = benefitEntries.reduce((value, entry) => value > entry.window.end ? value : entry.window.end, benefitEntries[0].window.end);
    const txns = await deps.getTxnsBetween(card.account_id, start, end);
    attribution = attributeTransactions(txns, benefitEntries);
  }
  const benefits = [];

  for (const { benefit: b, window: win, amount } of benefitEntries) {
    const autoStats = attribution.stats[b.id] || {
      autoUsed: 0,
      matchedCount: 0,
      purchaseMatchedCount: 0,
      creditMatchedCount: 0,
      reversalMatchedCount: 0,
    };
    const hasPurchaseRules = (b.match?.merchants?.length || 0) + (b.match?.categories?.length || 0) > 0;
    const hasAutoRules = hasPurchaseRules || b.tracking !== 'wallet';

    const override = await deps.getOverride(card.id, b.id, win.key);
    const autoCapped = Math.min(autoStats.autoUsed, amount);
    const used = override && override.used_amount != null ? override.used_amount : autoCapped;
    const remaining = round2(Math.max(0, amount - used));
    const claimed = override && override.claimed ? true : remaining <= 0;
    const daysLeft = daysUntil(win.end, today);

    let status = 'open';
    if (claimed || remaining <= 0) status = 'used';
    else if (daysLeft <= 7) status = 'expiring';

    benefits.push({
      benefitId: b.id,
      name: b.name,
      amount,
      period: b.period,
      notes: b.notes || '',
      periodKey: win.key,
      periodLabel: win.label,
      windowStart: win.start,
      windowEnd: win.end,
      daysLeft,
      autoUsed: round2(autoStats.autoUsed),
      used: round2(used),
      remaining,
      claimed,
      status,
      matchedCount: autoStats.matchedCount,
      purchaseMatchedCount: autoStats.purchaseMatchedCount,
      creditMatchedCount: autoStats.creditMatchedCount,
      reversalMatchedCount: autoStats.reversalMatchedCount,
      hasAutoRules,
      overrideNote: override?.note || '',
      hasManualOverride: Boolean(override && (override.used_amount != null || override.claimed)),
    });
  }

  const totalRemaining = round2(
    benefits.filter((b) => b.status !== 'used').reduce((s, b) => s + b.remaining, 0)
  );

  return {
    cardId: card.id,
    accountId: card.account_id,
    productKey: card.product_key,
    productName: product?.name || card.product_key,
    issuer: product?.issuer || '',
    displayName: card.display_name || product?.name || card.product_key,
    benefits,
    totalRemaining,
    linked: Boolean(card.account_id),
    attributionCollisionCount: attribution.collisionCount,
    attributionAmbiguousCount: attribution.ambiguousCount,
  };
}
