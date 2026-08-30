import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCardProgressWindows,
  compactExpiryLabel,
  groupExpiringAlertsByCard,
} from '../client/src/dashboard-alerts.js';

test('expiring alerts are grouped by tracked card and ordered by urgency', () => {
  const alerts = [
    { cardId: 10, cardName: 'Platinum Card', productName: 'Amex Platinum', benefitId: 'uber', periodKey: '2026-08', name: 'Uber Cash', remaining: 15, daysLeft: 2, status: 'expiring' },
    { cardId: 20, cardName: 'Marriott Card', productName: 'Bonvoy Brilliant', benefitId: 'dining', periodKey: '2026-08', name: 'Dining Credit', remaining: 25, daysLeft: 1, status: 'expiring' },
    { cardId: 10, cardName: 'Platinum Card', productName: 'Amex Platinum', benefitId: 'digital', periodKey: '2026-08', name: 'Digital Entertainment', remaining: 25, daysLeft: 2, status: 'expiring' },
    { cardId: 10, cardName: 'Platinum Card', productName: 'Amex Platinum', benefitId: 'airline', periodKey: '2026', name: 'Airline Fee Credit', remaining: 200, daysLeft: 123, status: 'open' },
  ];

  const groups = groupExpiringAlertsByCard(alerts);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].cardId, 20);
  assert.equal(groups[0].nearestDaysLeft, 1);
  assert.equal(groups[1].cardId, 10);
  assert.equal(groups[1].alerts.length, 2);
  assert.equal(groups[1].totalRemaining, 40);
  assert.deepEqual(groups[1].alerts.map((alert) => alert.benefitId), ['digital', 'uber']);
});

test('cards with the same display name remain separate card groups', () => {
  const groups = groupExpiringAlertsByCard([
    { cardId: 1, cardName: 'Platinum Card', benefitId: 'uber', name: 'Uber', remaining: 15, daysLeft: 2, status: 'expiring' },
    { cardId: 2, cardName: 'Platinum Card', benefitId: 'digital', name: 'Digital', remaining: 25, daysLeft: 2, status: 'expiring' },
  ]);

  assert.deepEqual(groups.map((group) => group.cardId), [2, 1]);
  assert.deepEqual(
    groups.map((group) => [group.cardId, group.duplicateIndex, group.duplicateCount]),
    [[2, 2, 2], [1, 1, 2]]
  );
});

test('card progress keeps monthly and annual limits in separate reset windows', () => {
  const windows = buildCardProgressWindows([
    { period: 'monthly', periodLabel: 'Aug 2026', windowStart: '2026-08-01', windowEnd: '2026-08-31', amount: 15, used: 5, remaining: 10, daysLeft: 2 },
    { period: 'monthly', periodLabel: 'Aug 2026', windowStart: '2026-08-01', windowEnd: '2026-08-31', amount: 25, used: 25, remaining: 0, daysLeft: 2 },
    { period: 'annual', periodLabel: '2026', windowStart: '2026-01-01', windowEnd: '2026-12-31', amount: 200, used: 50, remaining: 150, daysLeft: 124 },
    { period: 'annual', periodLabel: 'Sep 2025 → Aug 2026', windowStart: '2025-09-01', windowEnd: '2026-08-31', amount: 100, used: 250, remaining: 0, daysLeft: 2 },
  ]);

  const monthly = windows.find((window) => window.period === 'monthly');
  const annual = windows.find((window) => window.windowStart === '2026-01-01');
  const anchoredAnnual = windows.find((window) => window.windowStart === '2025-09-01');

  assert.equal(windows.length, 3);
  assert.equal(windows.filter((window) => window.period === 'annual').length, 2);
  assert.equal(monthly.amount, 40);
  assert.equal(monthly.used, 30);
  assert.equal(monthly.remaining, 10);
  assert.equal(monthly.progress, 75);
  assert.equal(monthly.status, 'expiring');
  assert.equal(annual.progress, 25);
  assert.equal(annual.status, 'open');
  assert.equal(anchoredAnnual.used, 100);
  assert.equal(anchoredAnnual.progress, 100);
  assert.equal(anchoredAnnual.status, 'used');
});

test('compact expiry labels make urgent deadlines scannable', () => {
  assert.equal(compactExpiryLabel(0), 'Today');
  assert.equal(compactExpiryLabel(1), '1 day');
  assert.equal(compactExpiryLabel(6), '6 days');
  assert.equal(compactExpiryLabel(undefined), 'Unknown');
});
