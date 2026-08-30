import React, { useState } from 'react';
import { api, money } from '../api.js';

function daysLabel(d) {
  if (d <= 0) return { text: 'expires today', cls: 'today' };
  if (d === 1) return { text: '1 day left', cls: 'soon' };
  if (d <= 7) return { text: `${d} days left`, cls: 'soon' };
  return { text: `${d} days left`, cls: '' };
}

export default function BenefitRow({ cardId, b, onChange }) {
  const [usedInput, setUsedInput] = useState('');
  const [busy, setBusy] = useState(false);
  const pct = Math.min(100, Math.round((b.used / b.amount) * 100));
  const dl = daysLabel(b.daysLeft);

  const post = async (payload) => {
    setBusy(true);
    try {
      await api.post('/api/benefits/override', {
        cardId,
        benefitId: b.benefitId,
        periodKey: b.periodKey,
        ...payload,
      });
      setUsedInput('');
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="benefit">
      <div>
        <span className="bname">{b.name}</span>{' '}
        <span className="badge period">{b.period}</span>{' '}
        <span className={`badge ${b.status}`}>{b.status}</span>
        <div className="bnotes">{b.notes}</div>
      </div>
      <div className="right">
        <div>
          <strong>{money(b.remaining)}</strong> <span className="muted">left of {money(b.amount)}</span>
        </div>
        <div className={`days ${dl.cls}`}>
          {b.status === 'used' ? `resets ${b.windowEnd}` : dl.text}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>{b.periodLabel}</div>
      </div>

      <div className={`bar ${b.status}`}>
        <span style={{ width: `${pct}%` }} />
      </div>

      <div className="benefit-actions">
        {b.hasAutoRules && (
          <span className="muted" style={{ fontSize: 12 }}>
            auto-attributed {money(b.autoUsed)}
            {b.purchaseMatchedCount > 0 && ` · ${b.purchaseMatchedCount} purchase${b.purchaseMatchedCount === 1 ? '' : 's'}`}
            {b.creditMatchedCount > 0 && ` · ${b.creditMatchedCount} credit${b.creditMatchedCount === 1 ? '' : 's'}`}
            {b.reversalMatchedCount > 0 && ` · ${b.reversalMatchedCount} reversal${b.reversalMatchedCount === 1 ? '' : 's'}`}
            {b.matchedCount === 0 && ' · no matches yet'}
          </span>
        )}
        {!b.hasAutoRules && <span className="muted" style={{ fontSize: 12 }}>manual tracking</span>}
        <span className="spacer" />
        {b.status !== 'used' && (
          <button className="btn primary" disabled={busy} onClick={() => post({ claimed: true })}>
            Mark used
          </button>
        )}
        <input
          type="number"
          placeholder="$ used"
          value={usedInput}
          onChange={(e) => setUsedInput(e.target.value)}
          step="0.01"
          min="0"
        />
        <button
          className="btn"
          disabled={busy || usedInput === ''}
          onClick={() => post({ usedAmount: usedInput })}
        >
          Set
        </button>
        {b.hasManualOverride && (
          <button className="btn" disabled={busy} onClick={() => post({ usedAmount: null, claimed: false })}>
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
