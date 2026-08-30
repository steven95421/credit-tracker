import React, { useCallback, useEffect, useState } from 'react';
import { api, session, setUnauthorizedHandler } from './api.js';
import Dashboard from './components/Dashboard.jsx';
import CardsAccounts from './components/CardsAccounts.jsx';
import Login from './components/Login.jsx';

const FEEDBACK_URL = 'https://github.com/steven95421/credit-tracker/issues/new?title=Feedback%3A%20&body=What%20would%20you%20like%20us%20to%20improve%3F%0A%0A%3E%20Please%20do%20not%20include%20account%2C%20card%2C%20or%20transaction%20details.';

export default function App() {
  // land on Cards & Accounts when returning from a Plaid OAuth redirect
  const [tab, setTab] = useState(() =>
    new URLSearchParams(window.location.search).has('oauth_state_id') ? 'cards' : 'dashboard'
  );
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [booting, setBooting] = useState(true);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.get('/api/benefits/status'));
      setError('');
    } catch (e) {
      if (e.status !== 401) setError(e.message); // 401 flips the login gate instead
    }
  }, []);

  const boot = useCallback(async () => {
    setBooting(true);
    try {
      const cfg = await api.get('/api/config');
      setConfig(cfg);
      setError('');
      if (cfg.authRequired && !cfg.authed) {
        setNeedLogin(true);
        setStatus(null);
        return;
      }
      setNeedLogin(false);
      await loadStatus();
    } catch (e) {
      setError(e.message);
      setConfig(null);
      setNeedLogin(true);
    } finally {
      setBooting(false);
    }
  }, [loadStatus]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      session.clear();
      setNeedLogin(true);
    });
    boot();
  }, [boot]);

  const signOut = () => {
    session.clear();
    setNeedLogin(true);
    setStatus(null);
  };

  const syncAll = async () => {
    setSyncing(true);
    try {
      const result = await api.post('/api/sync');
      await loadStatus();
      if (result.failed) {
        setError(`${result.failed} linked provider failed to sync. Open Cards & Accounts for details.`);
      }
    } catch (e) {
      if (e.status !== 401) setError(e.message);
    } finally {
      setSyncing(false);
    }
  };

  const stripeConfig = config?.providers?.find((provider) => provider.id === 'stripe');
  const tellerConfig = config?.providers?.find((provider) => provider.id === 'teller');
  const plaidConfig = config?.providers?.find((provider) => provider.id === 'plaid');
  const remoteSyncConfigured = Boolean(
    stripeConfig?.configured || tellerConfig?.configured || plaidConfig?.configured
  );
  const configuredProviderLabels = [
    ['Stripe', stripeConfig],
    ['Teller', tellerConfig],
    ['Plaid', plaidConfig],
  ]
    .filter(([, provider]) => provider?.configured)
    .map(([label, provider]) => `${label}: ${provider.environment || 'configured'}`);
  const publicUrl = (page) => `${import.meta.env.BASE_URL}${page}`;

  return (
    <div className="app">
      <header className="top">
        <h1>
          <button
            type="button"
            className="brand-home"
            aria-label="Credit Tracker — go to dashboard"
            onClick={() => setTab('dashboard')}
          >
            <span aria-hidden="true">💳</span>
            <span>Credit Tracker</span>
          </button>
        </h1>
        <div className="top-actions">
          {config && configuredProviderLabels.length > 0 && (
            <span className="env-pill">
              {configuredProviderLabels.join(' · ')}
            </span>
          )}
          <a
            className="feedback-cta"
            href={FEEDBACK_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Send product feedback (opens GitHub in a new tab)"
          >
            <span aria-hidden="true">💬</span> Feedback
          </a>
        </div>
      </header>

      {needLogin || !config ? (
        <main className="public-shell">
          <section className="public-hero" aria-labelledby="product-heading">
            <div className="public-copy">
              <span className="public-kicker">Private beta · Read-only financial data</span>
              <h2 id="product-heading">See every recurring card credit before it expires.</h2>
              <p className="public-lead">
                Credit Tracker brings eligible credit-card transactions and recurring statement-credit
                benefits into one dashboard, so you can see what has been used and what still needs attention.
              </p>
              <div className="public-features" aria-label="Product capabilities">
                <article>
                  <strong>Connect or import</strong>
                  <span>Link an eligible credit card through Stripe Financial Connections, or use CSV and manual tracking.</span>
                </article>
                <article>
                  <strong>Limited data access</strong>
                  <span>The Stripe connection requests Transactions access—not balances, ownership, ACH details, payments, or transfers.</span>
                </article>
                <article>
                  <strong>You stay in control</strong>
                  <span>Unlink an account to disconnect it and delete its locally stored accounts and transactions.</span>
                </article>
              </div>
            </div>
            <Login
              clientId={config?.googleClientId}
              loading={booting}
              apiUnavailable={!booting && !config}
              onSuccess={boot}
            />
          </section>
        </main>
      ) : (
        <>
          <div className="tabs">
            <button className={tab === 'dashboard' ? 'active' : ''} onClick={() => setTab('dashboard')}>
              Dashboard
            </button>
            <button className={tab === 'cards' ? 'active' : ''} onClick={() => setTab('cards')}>
              Cards &amp; Accounts
            </button>
            <div className="spacer" />
            <button className="" onClick={syncAll} disabled={syncing || !remoteSyncConfigured}>
              {syncing ? 'Syncing…' : '↻ Sync transactions'}
            </button>
            {config?.authRequired && (
              <button className="" onClick={signOut} title="Sign out">
                Sign out
              </button>
            )}
          </div>

          {error && <div className="err">⚠ {error}</div>}

          {config && !remoteSyncConfigured && (
            <div className="notice">
              Stripe, Teller, and Plaid are not configured{config.authRequired ? ' on the API Worker' : ''}.
              You can still import CSV statements or track cards manually.
            </div>
          )}

          {tab === 'dashboard' ? (
            <Dashboard status={status} onChange={loadStatus} />
          ) : (
            <CardsAccounts config={config} onChange={loadStatus} />
          )}
        </>
      )}

      <footer className="site-footer">
        <span>Credit Tracker · Independent private beta</span>
        <nav aria-label="Legal and support">
          <a href={publicUrl('privacy.html')}>Privacy</a>
          <a href={publicUrl('terms.html')}>Terms</a>
          <a href={publicUrl('data-deletion.html')}>Data deletion</a>
          <a href={publicUrl('support.html')}>Support</a>
        </nav>
      </footer>
    </div>
  );
}
