import React from 'react';
import { money } from '../api.js';
import BenefitRow from './BenefitRow.jsx';

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

  const expiringSoon = alerts.filter((a) => a.status === 'expiring');

  return (
    <>
      <div className="summary">
        <div className="big">{money(totalRemaining)}</div>
        <div className="sub">
          in unused statement credits across {alerts.length} benefit{alerts.length === 1 ? '' : 's'}
          {' · '}as of {today}
        </div>
      </div>

      {expiringSoon.length > 0 && (
        <div className="notice">
          ⏰ {expiringSoon.length} credit{expiringSoon.length === 1 ? '' : 's'} expiring within a week:{' '}
          {expiringSoon
            .map((a) => `${a.cardName} ${a.name} (${money(a.remaining)}, ${a.daysLeft <= 0 ? 'today' : a.daysLeft + 'd'})`)
            .join(' · ')}
        </div>
      )}

      {cards.map((card) => (
        <section className="card-section" key={card.cardId}>
          <div className="card-head">
            <div>
              <div className="name">{card.displayName}</div>
              <div className="meta">
                {card.productName}
                {card.linked ? '' : ' · manual'}
              </div>
            </div>
            <div className="right">
              <strong>{money(card.totalRemaining)}</strong>
              <div className="meta">unused</div>
            </div>
          </div>

          {card.benefits.length === 0 ? (
            <div className="muted" style={{ fontSize: 13, paddingTop: 8 }}>
              No benefits defined for this product. Edit{' '}
              <code>server/src/catalog.json</code> to add some.
            </div>
          ) : (
            card.benefits.map((b) => (
              <BenefitRow key={b.benefitId} cardId={card.cardId} b={b} onChange={onChange} />
            ))
          )}
        </section>
      ))}
    </>
  );
}
