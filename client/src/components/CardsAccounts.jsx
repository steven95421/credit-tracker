import React, { useCallback, useEffect, useState } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { api } from '../api.js';

function LinkButton({ onLinked, onError }) {
  // OAuth banks (Amex/Chase/Citi) bounce the browser away and back with ?oauth_state_id=…;
  // Link must then resume with the SAME link_token, so we stash it in localStorage.
  const oauthStateId = new URLSearchParams(window.location.search).get('oauth_state_id');
  const [token, setToken] = useState(() => (oauthStateId ? localStorage.getItem('ct_link_token') : null));

  useEffect(() => {
    if (oauthStateId) return; // resuming a redirect — reuse the stored token
    api.post('/api/link/token').then((r) => {
      localStorage.setItem('ct_link_token', r.link_token);
      setToken(r.link_token);
    }).catch((e) => onError(e.message));
  }, [oauthStateId, onError]);

  const cleanUrl = () => {
    if (oauthStateId) window.history.replaceState({}, '', window.location.pathname);
  };

  const { open, ready } = usePlaidLink({
    token,
    ...(oauthStateId ? { receivedRedirectUri: window.location.href } : {}),
    onSuccess: async (public_token) => {
      try {
        localStorage.removeItem('ct_link_token');
        cleanUrl();
        await api.post('/api/link/exchange', { public_token });
        onLinked();
      } catch (e) {
        onError(e.message);
      }
    },
    onExit: cleanUrl,
  });

  // auto-resume Link after the OAuth redirect lands back here
  useEffect(() => {
    if (oauthStateId && token && ready) open();
  }, [oauthStateId, token, ready, open]);

  return (
    <button className="btn primary" disabled={!ready || !token} onClick={() => open()}>
      + Link a card with Plaid
    </button>
  );
}

export default function CardsAccounts({ config, onChange }) {
  const [items, setItems] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [cards, setCards] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // new-card form state
  const [formAccount, setFormAccount] = useState('');
  const [formProduct, setFormProduct] = useState('');
  const [formName, setFormName] = useState('');

  const reload = useCallback(async () => {
    try {
      const [it, ac, cd, ct] = await Promise.all([
        api.get('/api/items'),
        api.get('/api/accounts'),
        api.get('/api/cards'),
        api.get('/api/catalog'),
      ]);
      setItems(it.items);
      setAccounts(ac.accounts);
      setCards(cd.cards);
      setCatalog(ct.products);
      setErr('');
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const afterMutation = async () => {
    await reload();
    await onChange();
  };

  const syncItem = async (itemId) => {
    setBusy(true);
    try {
      await api.post(`/api/items/${itemId}/sync`);
      await afterMutation();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const removeItem = async (itemId) => {
    if (!confirm('Unlink this institution and delete its accounts & transactions?')) return;
    setBusy(true);
    try {
      await api.del(`/api/items/${itemId}`);
      await afterMutation();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const addCard = async () => {
    if (!formProduct) {
      setErr('Pick a card product');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/cards', {
        accountId: formAccount || null,
        productKey: formProduct,
        displayName: formName || null,
      });
      setFormAccount('');
      setFormProduct('');
      setFormName('');
      await afterMutation();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteCard = async (id) => {
    setBusy(true);
    try {
      await api.del(`/api/cards/${id}`);
      await afterMutation();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const mappedAccountIds = new Set(cards.map((c) => c.account_id).filter(Boolean));

  return (
    <>
      {err && <div className="err">⚠ {err}</div>}

      {/* ---- Linked institutions ---- */}
      <section className="card-section">
        <div className="card-head">
          <div className="name">Linked institutions</div>
          {config?.plaidConfigured && <LinkButton onLinked={afterMutation} onError={setErr} />}
        </div>
        {!config?.plaidConfigured && (
          <div className="muted" style={{ fontSize: 13 }}>
            Set Plaid keys in <code>.env</code> to link a bank. Without keys you can still add manual-only
            cards below.
          </div>
        )}
        {items.length === 0 && config?.plaidConfigured && (
          <div className="muted" style={{ fontSize: 13, paddingTop: 6 }}>No institutions linked yet.</div>
        )}
        {items.map((it) => (
          <div className="acct" key={it.itemId}>
            <div className="row between">
              <div>
                <strong>{it.institutionName || 'Institution'}</strong>{' '}
                <span className="muted">· {it.accounts.length} account(s)</span>
                <div className="muted" style={{ fontSize: 12 }}>
                  last synced: {it.lastSyncedAt ? new Date(it.lastSyncedAt).toLocaleString() : 'never'}
                </div>
              </div>
              <div className="row">
                <button className="btn" disabled={busy} onClick={() => syncItem(it.itemId)}>↻ Sync</button>
                <button className="btn danger" disabled={busy} onClick={() => removeItem(it.itemId)}>Unlink</button>
              </div>
            </div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              {it.accounts.map((a) => `${a.name}${a.mask ? ' ••' + a.mask : ''}`).join(' · ')}
            </div>
          </div>
        ))}
      </section>

      {/* ---- Add a card profile ---- */}
      <section className="card-section">
        <div className="card-head"><div className="name">Add a card to track</div></div>
        <div className="toolbar">
          <select value={formProduct} onChange={(e) => setFormProduct(e.target.value)}>
            <option value="">— Card product —</option>
            {catalog.map((p) => (
              <option key={p.key} value={p.key}>{p.name}</option>
            ))}
          </select>
          <select value={formAccount} onChange={(e) => setFormAccount(e.target.value)}>
            <option value="">Manual (no linked account)</option>
            {accounts.map((a) => (
              <option key={a.account_id} value={a.account_id} disabled={mappedAccountIds.has(a.account_id)}>
                {a.name}{a.mask ? ' ••' + a.mask : ''}{mappedAccountIds.has(a.account_id) ? ' (used)' : ''}
              </option>
            ))}
          </select>
          <input
            className="text-input"
            placeholder="Nickname (optional)"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
          />
          <button className="btn primary" disabled={busy} onClick={addCard}>Add</button>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          Link an account to auto-match transactions to benefits, or add a card manually and track credits by hand.
        </div>
      </section>

      {/* ---- Tracked cards ---- */}
      <section className="card-section">
        <div className="card-head"><div className="name">Tracked cards</div></div>
        {cards.length === 0 && <div className="muted" style={{ fontSize: 13 }}>None yet.</div>}
        {cards.map((c) => (
          <div className="acct row between" key={c.id}>
            <div>
              <strong>{c.display_name || c.product_key}</strong>{' '}
              <span className="muted">
                · {c.account ? `${c.account.name}${c.account.mask ? ' ••' + c.account.mask : ''}` : 'manual'}
              </span>
            </div>
            <button className="btn danger" disabled={busy} onClick={() => deleteCard(c.id)}>Remove</button>
          </div>
        ))}
      </section>
    </>
  );
}
