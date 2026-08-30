import React, { useState } from 'react';
import { money } from '../api.js';
import {
  buildCardProgressWindows,
  compactExpiryLabel,
  groupExpiringAlertsByCard,
} from '../dashboard-alerts.js';
import BenefitRow from './BenefitRow.jsx';

function ExpiryCardGroup({ card, initiallyOpen }) {
  const [open, setOpen] = useState(initiallyOpen);

  return (
    <details
      className="expiry-card-group"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="expiry-card-summary">
        <span className="expiry-card-identity">
          <span className="expiry-card-icon" aria-hidden="true">💳</span>
          <span>
            <strong>{card.cardName}</strong>
            {(card.productName !== card.cardName || card.duplicateCount > 1) && (
              <small>
                {[
                  card.productName && card.productName !== card.cardName ? card.productName : null,
                  card.duplicateCount > 1 ? `Card ${card.duplicateIndex} of ${card.duplicateCount}` : null,
                ].filter(Boolean).join(' · ')}
              </small>
            )}
          </span>
        </span>
        <span className="expiry-card-stats">
          <span>{card.alerts.length} credit{card.alerts.length === 1 ? '' : 's'}</span>
          <strong>{money(card.totalRemaining)}</strong>
          <span className="expiry-due-pill">{compactExpiryLabel(card.nearestDaysLeft)}</span>
          <span className="expiry-chevron" aria-hidden="true">›</span>
        </span>
      </summary>
      <div className="expiry-credit-list">
        {card.alerts.map((alert) => (
          <div className="expiry-credit-row" key={`${alert.benefitId}-${alert.periodKey}`}>
            <span className="expiry-credit-name">{alert.name}</span>
            <span className="expiry-credit-amount">{money(alert.remaining)} remaining</span>
            <span className={`expiry-credit-deadline ${alert.daysLeft <= 0 ? 'today' : ''}`}>
              {compactExpiryLabel(alert.daysLeft)}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

function CreditProgressWindow({ window, historical = false }) {
  return (
    <div className={`card-progress-window ${window.status}`}>
      <div className="card-progress-window-head">
        <span>
          <strong>{window.periodTitle}</strong>
          <small>{window.periodLabel}</small>
        </span>
        <span className="card-progress-amount">
          {money(window.used)} <small>of {money(window.amount)}</small>
        </span>
      </div>
      <div
        className="card-progress-track"
        role="progressbar"
        aria-label={`${window.periodTitle} ${window.periodLabel} credit usage from ${window.windowStart} to ${window.windowEnd}`}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={window.progress}
      >
        <span style={{ width: `${window.progress}%` }} />
      </div>
      <div className="card-progress-foot">
        <span>{window.progress}% used</span>
        <span>
          {historical
            ? (window.remaining <= 0 ? 'Fully used' : `${money(window.remaining)} unused`)
            : `${money(window.remaining)} left · ${compactExpiryLabel(window.daysLeft)}`}
        </span>
      </div>
    </div>
  );
}

export default function Dashboard({ status, onChange }) {
  if (!status) return <div className="empty">Loading…</div>;

  const { cards, alerts, totalRemaining, today } = status;

  if (!cards.length) {
    return (
      <div className="empty">
        No cards yet. Go to <strong>Cards &amp; Accounts</strong> to link a credit card or add one manually.
      </div>
    );
  }

  const expiringCards = groupExpiringAlertsByCard(alerts);
  const expiringCount = expiringCards.reduce((total, card) => total + card.alerts.length, 0);

  return (
    <>
      <div className="summary">
        <div className="big">{money(totalRemaining)}</div>
        <div className="sub">
          in unused statement credits across {alerts.length} benefit{alerts.length === 1 ? '' : 's'}
          {' · '}as of {today}
        </div>
      </div>

      {expiringCount > 0 && (
        <section className="expiry-notice" aria-labelledby="expiry-heading">
          <div className="expiry-overview">
            <span className="expiry-kicker">⏰ Expiring soon</span>
            <h2 id="expiry-heading">
              {expiringCount} credit{expiringCount === 1 ? '' : 's'} across {expiringCards.length}{' '}
              card{expiringCards.length === 1 ? '' : 's'} expire within a week
            </h2>
            <p>Cards with the nearest deadline appear first. Open a card to review each credit.</p>
          </div>
          <div className="expiry-card-list">
            {expiringCards.map((card, index) => (
              <ExpiryCardGroup card={card} initiallyOpen={index === 0} key={card.key} />
            ))}
          </div>
        </section>
      )}

      {cards.map((card) => {
        const progressWindows = buildCardProgressWindows(card.benefits);
        const historyWindows = buildCardProgressWindows(
          card.historyBenefits || [],
          { historical: true }
        );
        const totalUsed = progressWindows.reduce((total, window) => total + window.used, 0);
        const historicalMonths = historyWindows.filter((window) => window.period === 'monthly').length;
        const historicalQuarters = historyWindows.filter((window) => window.period === 'quarterly').length;

        return (
        <section className="card-section" key={card.cardId}>
          <div className="card-head">
            <div>
              <div className="name">{card.displayName}</div>
              <div className="meta">
                {card.productName}
                {card.linked ? '' : ' · manual'}
              </div>
            </div>
            <div
              className="card-usage-totals"
              role="group"
              aria-label={`${money(card.totalRemaining)} unused in current periods, ${money(totalUsed)} used in current periods`}
            >
              <div className="card-usage-total">
                <strong>{money(card.totalRemaining)}</strong>
                <div className="meta">current unused</div>
              </div>
              <div className="card-usage-total used">
                <strong>{money(totalUsed)}</strong>
                <div className="meta">current used</div>
              </div>
            </div>
          </div>

          {card.annualFee != null && (
            <div
              className="card-annual-value"
              role="group"
              aria-label={`Annual value summary for ${card.displayName}`}
            >
              <div className="card-annual-value-item">
                <span>Annual fee</span>
                <strong>{money(card.annualFee)}</strong>
              </div>
              <div className="card-annual-value-item">
                <span>Tracked {today.slice(0, 4)} credits</span>
                <strong>{money(card.annualCreditValue)}</strong>
              </div>
              <div className="card-annual-value-note">
                Standard U.S. fee · tracked credits only; points, free nights, lounge access, and other perks are excluded
              </div>
            </div>
          )}

          {card.benefits.length > 0 && (
            <div className="card-progress" role="group" aria-label={`Credit progress for ${card.displayName}`}>
              <div className="card-progress-heading">
                <strong>Credit progress</strong>
                <span>Grouped by reset window</span>
              </div>
              <div className="card-progress-windows">
                {progressWindows.map((window) => (
                  <CreditProgressWindow window={window} key={window.key} />
                ))}
              </div>
              {historyWindows.length > 0 && (
                <details className="card-progress-history">
                  <summary>
                    <span>Earlier in {today.slice(0, 4)}</span>
                    <span className="muted small">
                      {[
                        historicalMonths > 0
                          ? `${historicalMonths} prior month${historicalMonths === 1 ? '' : 's'}`
                          : null,
                        historicalQuarters > 0
                          ? `${historicalQuarters} completed quarter${historicalQuarters === 1 ? '' : 's'}`
                          : null,
                      ].filter(Boolean).join(' · ')}
                      <span className="benefit-details-chevron" aria-hidden="true">›</span>
                    </span>
                  </summary>
                  <div className="card-progress-windows historical">
                    {historyWindows.map((window) => (
                      <CreditProgressWindow historical window={window} key={`history:${window.key}`} />
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}

          {card.attributionAmbiguousCount > 0 && (
            <div className="attribution-notice" role="status">
              <strong>{card.attributionAmbiguousCount} transaction{card.attributionAmbiguousCount === 1 ? '' : 's'} need review.</strong>{' '}
              They matched multiple credits equally, so nothing was assigned automatically. Open Credit details to set the used amount manually.
            </div>
          )}

          {card.benefits.length === 0 ? (
            <div className="muted" style={{ fontSize: 13, paddingTop: 8 }}>
              No benefits defined for this product. Edit{' '}
              <code>server/src/catalog.json</code> to add some.
            </div>
          ) : (
            <details className="benefit-details">
              <summary className="benefit-details-summary">
                <span>Credit details</span>
                <span>
                  {card.benefits.length} credit{card.benefits.length === 1 ? '' : 's'}
                  <span className="benefit-details-chevron" aria-hidden="true">›</span>
                </span>
              </summary>
              <div className="benefit-details-list">
                {card.benefits.map((b) => (
                  <BenefitRow key={b.benefitId} cardId={card.cardId} b={b} onChange={onChange} />
                ))}
              </div>
            </details>
          )}
        </section>
        );
      })}
    </>
  );
}
