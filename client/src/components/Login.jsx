import React, { useEffect, useRef, useState } from 'react';
import { api, session } from '../api.js';

/** Google Sign-In gate — renders the GIS button, trades the ID token for an API session. */
export default function Login({ clientId, onSuccess }) {
  const btnRef = useRef(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!clientId) return undefined;
    let cancelled = false;

    const init = () => {
      if (cancelled || !window.google?.accounts?.id || !btnRef.current) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async (resp) => {
          setBusy(true);
          setErr('');
          try {
            const r = await api.post('/api/auth/google', { credential: resp.credential });
            session.set(r.token);
            onSuccess();
          } catch (e) {
            setErr(e.message);
          } finally {
            setBusy(false);
          }
        },
      });
      window.google.accounts.id.renderButton(btnRef.current, {
        theme: 'filled_black',
        size: 'large',
        shape: 'pill',
      });
    };

    if (window.google?.accounts?.id) {
      init();
    } else {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.defer = true;
      s.onload = init;
      s.onerror = () => setErr('Failed to load Google Sign-In script');
      document.head.appendChild(s);
    }
    return () => {
      cancelled = true;
    };
  }, [clientId, onSuccess]);

  return (
    <div className="login">
      <div className="login-emoji">🔒</div>
      <h2>Locked</h2>
      <p className="muted">Sign in with your Google account to open the dashboard.</p>
      {clientId ? (
        <div className="login-google" ref={btnRef} />
      ) : (
        <div className="err">⚠ GOOGLE_CLIENT_ID is not configured on the API worker yet.</div>
      )}
      {busy && <div className="muted">Verifying…</div>}
      {err && <div className="err">⚠ {err}</div>}
    </div>
  );
}
