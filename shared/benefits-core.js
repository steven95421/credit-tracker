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

/** True if a transaction counts toward a benefit's spend. */
export function matchesBenefit(txn, benefit) {
  // Every provider adapter must emit the canonical sign: positive = purchase/charge.
  if (!Number.isFinite(Number(txn.amount)) || Number(txn.amount) <= 0) return false;
  const rules = benefit.match || {};
  const merchants = (rules.merchants || []).map((s) => s.toLowerCase());
  const categories = (rules.categories || []).map((s) => s.toUpperCase());
  if (merchants.length === 0 && categories.length === 0) return false; // manual-only benefit

  const hay = `${txn.merchant_name || ''} ${txn.name || ''}`.toLowerCase();
  if (merchants.some((msub) => hay.includes(msub))) return true;

  const cat = (txn.category || '').toUpperCase();
  if (cat && categories.includes(cat)) return true;

  return false;
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
  const benefits = [];

  for (const b of product?.benefits || []) {
    const win = periodWindow(b.period, today, b.anchor);
    let autoUsed = 0;
    let matchedCount = 0;
    const hasAutoRules = (b.match?.merchants?.length || 0) + (b.match?.categories?.length || 0) > 0;

    if (card.account_id) {
      const txns = await deps.getTxnsBetween(card.account_id, win.start, win.end);
      for (const t of txns) {
        if (matchesBenefit(t, b)) {
          autoUsed += t.amount;
          matchedCount++;
        }
      }
    }

    const override = await deps.getOverride(card.id, b.id, win.key);
    const autoCapped = Math.min(autoUsed, b.amount);
    const used = override && override.used_amount != null ? override.used_amount : autoCapped;
    const remaining = round2(Math.max(0, b.amount - used));
    const claimed = override && override.claimed ? true : remaining <= 0;
    const daysLeft = daysUntil(win.end, today);

    let status = 'open';
    if (claimed || remaining <= 0) status = 'used';
    else if (daysLeft <= 7) status = 'expiring';

    benefits.push({
      benefitId: b.id,
      name: b.name,
      amount: b.amount,
      period: b.period,
      notes: b.notes || '',
      periodKey: win.key,
      periodLabel: win.label,
      windowStart: win.start,
      windowEnd: win.end,
      daysLeft,
      autoUsed: round2(autoUsed),
      used: round2(used),
      remaining,
      claimed,
      status,
      matchedCount,
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
  };
}
