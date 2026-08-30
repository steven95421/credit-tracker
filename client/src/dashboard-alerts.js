const roundMoney = (value) => Math.round(value * 100) / 100;
const finiteDays = (value) => {
  const days = Number(value);
  return Number.isFinite(days) ? days : Number.POSITIVE_INFINITY;
};

export function groupExpiringAlertsByCard(alerts) {
  const groups = new Map();

  for (const alert of alerts) {
    if (alert.status !== 'expiring') continue;
    const key = alert.cardId == null
      ? `${alert.cardName || ''}\u0000${alert.productName || ''}`
      : String(alert.cardId);
    const current = groups.get(key) || {
      key,
      cardId: alert.cardId,
      cardName: alert.cardName || alert.productName || 'Card',
      productName: alert.productName || '',
      alerts: [],
      totalRemaining: 0,
      nearestDaysLeft: Number.POSITIVE_INFINITY,
    };

    current.alerts.push(alert);
    current.totalRemaining = roundMoney(current.totalRemaining + Number(alert.remaining || 0));
    current.nearestDaysLeft = Math.min(current.nearestDaysLeft, finiteDays(alert.daysLeft));
    groups.set(key, current);
  }

  const result = [...groups.values()]
    .map((group) => ({
      ...group,
      alerts: [...group.alerts].sort((a, b) => (
        finiteDays(a.daysLeft) - finiteDays(b.daysLeft)
        || b.remaining - a.remaining
        || a.name.localeCompare(b.name)
      )),
    }));

  const duplicateNames = new Map();
  for (const group of result) {
    const duplicateKey = `${group.cardName}\u0000${group.productName}`;
    const matches = duplicateNames.get(duplicateKey) || [];
    matches.push(group);
    duplicateNames.set(duplicateKey, matches);
  }
  for (const matches of duplicateNames.values()) {
    matches.sort((a, b) => String(a.cardId).localeCompare(String(b.cardId), undefined, { numeric: true }));
    matches.forEach((group, index) => {
      group.duplicateIndex = index + 1;
      group.duplicateCount = matches.length;
    });
  }

  return result.sort((a, b) => (
      a.nearestDaysLeft - b.nearestDaysLeft
      || b.totalRemaining - a.totalRemaining
      || a.cardName.localeCompare(b.cardName)
  ));
}

export function compactExpiryLabel(daysLeft) {
  if (!Number.isFinite(Number(daysLeft))) return 'Unknown';
  if (daysLeft <= 0) return 'Today';
  if (daysLeft === 1) return '1 day';
  return `${daysLeft} days`;
}

const periodTitle = (period) => ({
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semiannual: 'Half-year',
  annual: 'Annual',
}[period] || 'Current window');

export function buildCardProgressWindows(benefits) {
  const windows = new Map();

  for (const benefit of benefits) {
    const key = [benefit.period, benefit.windowStart, benefit.windowEnd].join('\u0000');
    const current = windows.get(key) || {
      key,
      period: benefit.period,
      periodTitle: periodTitle(benefit.period),
      periodLabel: benefit.periodLabel || '',
      windowStart: benefit.windowStart,
      windowEnd: benefit.windowEnd,
      daysLeft: Number.POSITIVE_INFINITY,
      amount: 0,
      remaining: 0,
      benefitCount: 0,
    };

    current.amount = roundMoney(current.amount + Number(benefit.amount || 0));
    current.remaining = roundMoney(current.remaining + Number(benefit.remaining || 0));
    current.daysLeft = Math.min(current.daysLeft, finiteDays(benefit.daysLeft));
    current.benefitCount += 1;
    windows.set(key, current);
  }

  return [...windows.values()]
    .map((window) => {
      const used = roundMoney(Math.max(0, window.amount - window.remaining));
      const progress = window.amount > 0
        ? Math.min(100, Math.round((used / window.amount) * 100))
        : 0;
      const status = window.remaining <= 0 ? 'used' : window.daysLeft <= 7 ? 'expiring' : 'open';
      return { ...window, used, progress, status };
    })
    .sort((a, b) => a.daysLeft - b.daysLeft || a.periodTitle.localeCompare(b.periodTitle));
}
