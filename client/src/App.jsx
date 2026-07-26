import React, { useCallback, useEffect, useState } from 'react';
import { api, session, setUnauthorizedHandler } from './api.js';
import Dashboard from './components/Dashboard.jsx';
import CardsAccounts from './components/CardsAccounts.jsx';
import Login from './components/Login.jsx';

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

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.get('/api/benefits/status'));
      setError('');
    } catch (e) {
      if (e.status !== 401) setError(e.message); // 401 flips the login gate instead
    }
  }, []);

  const boot = useCallback(async () => {
    try {
      const cfg = await api.get('/api/config');
      setConfig(cfg);
      if (cfg.authRequired && !cfg.authed) {
        setNeedLogin(true);
        setStatus(null);
        return;
      }
      setNeedLogin(false);
      await loadStatus();
    } catch (e) {
      setError(e.message);
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
      await api.post('/api/sync');
      await loadStatus();
    } catch (e) {
      if (e.status !== 401) setError(e.message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="app">
      <header className="top">
        <h1>💳 Credit Tracker</h1>
        {config && (
          <span className="env-pill">
            Plaid: {config.plaidEnv}
            {!config.plaidConfigured && ' · not configured'}
          </span>
        )}
      </header>

      {needLogin ? (
        <Login clientId={config?.googleClientId} onSuccess={boot} />
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
            <button className="" onClick={syncAll} disabled={syncing || !config?.plaidConfigured}>
              {syncing ? 'Syncing…' : '↻ Sync transactions'}
            </button>
            {config?.authRequired && (
              <button className="" onClick={signOut} title="Sign out">
                Sign out
              </button>
            )}
          </div>

          {error && <div className="err">⚠ {error}</div>}

          {config && !config.plaidConfigured && (
            <div className="notice">
              Plaid keys aren’t set{config.authRequired ? ' on the API worker' : ''}. You can still track
              cards manually; set <code>PLAID_CLIENT_ID</code> / <code>PLAID_SECRET</code> to link real cards.
            </div>
          )}

          {tab === 'dashboard' ? (
            <Dashboard status={status} onChange={loadStatus} />
          ) : (
            <CardsAccounts config={config} onChange={loadStatus} />
          )}
        </>
      )}
    </div>
  );
}
