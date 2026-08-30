import React, { useCallback, useEffect, useRef, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { usePlaidLink } from 'react-plaid-link';
import { useTellerConnect } from 'teller-connect-react';
import { api } from '../api.js';
import {
  defaultTrackedCardName,
  partitionProductsForInstitution,
  prunePendingSelections,
  unmappedConnectedAccounts,
} from '../card-matching.js';
import { parseCsvFile } from '../csv.js';

const itemPath = (itemId, suffix = '') => `/api/items/${encodeURIComponent(itemId)}${suffix}`;

function PlaidLinkButton({ onLinked, onError }) {
  // OAuth banks bounce the browser away and back with ?oauth_state_id=…;
  // Link must resume with the same link_token, so keep it in localStorage.
  const oauthStateId = new URLSearchParams(window.location.search).get('oauth_state_id');
  const [token, setToken] = useState(() => (oauthStateId ? localStorage.getItem('ct_link_token') : null));

  useEffect(() => {
    if (oauthStateId) return;
    api.post('/api/link/plaid/token').then((result) => {
      localStorage.setItem('ct_link_token', result.link_token);
      setToken(result.link_token);
    }).catch((error) => onError(error.message));
  }, [oauthStateId, onError]);

  const cleanUrl = () => {
    if (oauthStateId) window.history.replaceState({}, '', window.location.pathname);
  };

  const { open, ready } = usePlaidLink({
    token,
    ...(oauthStateId ? { receivedRedirectUri: window.location.href } : {}),
    onSuccess: async (publicToken) => {
      try {
        localStorage.removeItem('ct_link_token');
        cleanUrl();
        await api.post('/api/link/plaid/exchange', { public_token: publicToken });
        await onLinked();
      } catch (error) {
        onError(error.message);
      }
    },
    onExit: cleanUrl,
  });

  useEffect(() => {
    if (oauthStateId && token && ready) open();
  }, [oauthStateId, token, ready, open]);

  return (
    <button className="btn" disabled={!ready || !token} onClick={() => open()}>
      + Link with Plaid
    </button>
  );
}

// Mount one fresh hook instance for each server-issued nonce. The upstream hook
// does not rebuild for every option change, so keying by nonce prevents a repair
// or new enrollment from accidentally reusing an earlier Connect instance.
function TellerLauncher({ setup, onSuccess, onError, onExit }) {
  const opened = useRef(false);
  const { open, ready, error } = useTellerConnect({
    applicationId: setup.applicationId,
    environment: setup.environment,
    products: ['transactions'],
    selectAccount: 'multiple',
    enrollmentId: setup.enrollmentId || undefined,
    nonce: setup.nonce,
    appearance: 'system',
    onSuccess: (enrollment) => onSuccess(setup.nonce, enrollment),
    onExit,
    onFailure: (failure) => onError(failure?.message || 'Teller Connect failed'),
  });

  useEffect(() => {
    if (error) onError('Unable to load Teller Connect');
  }, [error, onError]);

  useEffect(() => {
    if (ready && !opened.current) {
      opened.current = true;
      open();
    }
  }, [ready, open]);

  return null;
}

function ProviderSignPanel({ item, sample, busy, onLoad, onConfirm, onAcknowledgeEmpty }) {
  const sampleReady = Boolean(sample?.rows?.length || sample?.emptyAcknowledged);
  const providerLabel = item.provider === 'stripe' ? 'Stripe' : 'Teller';
  return (
    <div className="warning-box">
      <strong>Confirm {providerLabel}’s amount sign before the first sync.</strong>
      <div className="muted small">
        Load a few real transactions, find an actual purchase, then choose whether that purchase has a + or − amount.
      </div>
      <div className="row sign-actions">
        <button className="btn" disabled={busy || sample?.loading} onClick={() => onLoad(item.itemId)}>
          {sample?.loading ? 'Loading…' : 'Show sample transactions'}
        </button>
        <button className="btn" disabled={busy || !sampleReady} onClick={() => onConfirm(item, 'positive')}>
          Purchases are +
        </button>
        <button className="btn" disabled={busy || !sampleReady} onClick={() => onConfirm(item, 'negative')}>
          Purchases are −
        </button>
      </div>
      {sample?.error && <div className="err">⚠ {sample.error}</div>}
      {sample?.checked && sample?.rows?.length === 0 && (
        <label className="check-label empty-sample-check">
          <input
            type="checkbox"
            checked={Boolean(sample.emptyAcknowledged)}
            onChange={(event) => onAcknowledgeEmpty(item.itemId, event.target.checked)}
          />
          No transactions were found in the initial sync window. I checked a statement separately and know the purchase sign.
        </label>
      )}
      {sample?.rows?.length > 0 && (
        <div className="sample-table">
          {sample.rows.map((transaction, index) => (
            <div className="sample-row" key={`${transaction.accountId}-${transaction.date}-${index}`}>
              <span>{transaction.date}</span>
              <span>{transaction.description || 'Unknown transaction'}</span>
              <strong>{transaction.amount}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StripeSignControl({ item, busy, onChange }) {
  const current = item.chargeSign === 'positive' ? 'positive' : 'negative';
  return (
    <div className="stripe-sign-setting">
      <div className="muted small">
        Stripe purchases default to a negative (−) amount. Change this only if purchases and refunds appear reversed.
      </div>
      <div className="row sign-actions">
        <button
          className="btn"
          disabled={busy || current === 'negative'}
          aria-pressed={current === 'negative'}
          onClick={() => onChange(item, 'negative')}
        >
          Purchases are − {current === 'negative' ? '(current)' : ''}
        </button>
        <button
          className="btn"
          disabled={busy || current === 'positive'}
          aria-pressed={current === 'positive'}
          onClick={() => onChange(item, 'positive')}
        >
          Purchases are + {current === 'positive' ? '(current)' : ''}
        </button>
      </div>
    </div>
  );
}

export default function CardsAccounts({ config, onChange }) {
  const [items, setItems] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [cards, setCards] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [err, setErr] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [tellerSetup, setTellerSetup] = useState(null);
  const [samples, setSamples] = useState({});
  const [pendingProducts, setPendingProducts] = useState({});

  const [formAccount, setFormAccount] = useState('');
  const [formProduct, setFormProduct] = useState('');
  const [formName, setFormName] = useState('');

  const [csvCardId, setCsvCardId] = useState('');
  const [csvFile, setCsvFile] = useState(null);
  const [csvChargeSign, setCsvChargeSign] = useState('positive');
  const [csvReplace, setCsvReplace] = useState(true);
  const [csvInputKey, setCsvInputKey] = useState(0);

  const providerConfig = (id) => config?.providers?.find((provider) => provider.id === id);
  const stripeConfig = providerConfig('stripe');
  const tellerConfig = providerConfig('teller');
  const plaidConfig = providerConfig('plaid');

  const reload = useCallback(async () => {
    try {
      const [itemResult, accountResult, cardResult, catalogResult] = await Promise.all([
        api.get('/api/items'),
        api.get('/api/accounts'),
        api.get('/api/cards'),
        api.get('/api/catalog'),
      ]);
      setItems(itemResult.items);
      setAccounts(accountResult.accounts);
      setCards(cardResult.cards);
      setCatalog(catalogResult.products);
      const pending = unmappedConnectedAccounts(accountResult.accounts, cardResult.cards);
      setPendingProducts((current) => prunePendingSelections(current, pending));
      setErr('');
    } catch (error) {
      setErr(error.message);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const afterMutation = useCallback(async () => {
    await reload();
    await onChange();
  }, [reload, onChange]);

  const connectStripe = async () => {
    setBusy(true);
    setErr('');
    setMessage('');
    try {
      const setup = await api.post('/api/link/stripe/session');
      const stripeClient = await loadStripe(setup.publishableKey);
      if (!stripeClient) throw new Error('Unable to load Stripe.js');
      const result = await stripeClient.collectFinancialConnectionsAccounts({
        clientSecret: setup.clientSecret,
      });
      if (result.error) throw new Error(result.error.message || 'Stripe account linking was cancelled');
      if (!result.financialConnectionsSession) {
        throw new Error('Stripe did not return a completed Financial Connections session');
      }
      const linked = await api.post('/api/link/stripe/complete', {
        nonce: setup.nonce,
        sessionId: setup.sessionId,
      });
      const notes = [`Linked ${linked.accounts} Stripe credit-card account(s).`];
      notes.push('Confirm each card product below to start tracking its benefits.');
      notes.push('Purchases default to a negative (−) amount; you can change this later per account.');
      if (linked.ignoredAccounts > 0) notes.push(`${linked.ignoredAccounts} unsupported or inactive account(s) were ignored.`);
      if (linked.refreshPending) notes.push('Stripe is preparing transaction history in the background.');
      if (!linked.webhookConfigured) notes.push('Run Sync after it finishes because the Stripe webhook is not configured yet.');
      if (linked.subscriptionErrors?.length) notes.push('At least one daily transaction subscription needs attention.');
      setMessage(notes.join(' '));
      await afterMutation();
    } catch (error) {
      setErr(error.message);
    } finally {
      setBusy(false);
    }
  };

  const startTeller = async (itemId = null) => {
    setBusy(true);
    setErr('');
    setMessage('');
    try {
      const setup = await api.post('/api/link/teller/config', itemId ? { itemId } : {});
      setTellerSetup(setup);
    } catch (error) {
      setErr(error.message);
    } finally {
      setBusy(false);
    }
  };

  const tellerSuccess = useCallback(async (nonce, enrollment) => {
    setBusy(true);
    setErr('');
    try {
      const result = await api.post('/api/link/teller/exchange', { nonce, enrollment });
      if (result.capabilityWarning) setMessage(result.capabilityWarning);
      else if (result.signConfirmationRequired) {
        setMessage('Teller linked. Confirm the amount sign below before syncing transactions.');
      } else {
        setMessage('Teller enrollment linked and synced.');
      }
      await afterMutation();
    } catch (error) {
      setErr(error.message);
      await reload();
    } finally {
      setTellerSetup(null);
      setBusy(false);
    }
  }, [afterMutation, reload]);

  const tellerError = useCallback((errorMessage) => {
    setErr(errorMessage);
    setTellerSetup(null);
  }, []);

  const loadSamples = async (itemId) => {
    setSamples((current) => ({ ...current, [itemId]: { loading: true, rows: [], error: '', checked: false } }));
    try {
      const result = await api.get(itemPath(itemId, '/sample'));
      setSamples((current) => ({
        ...current,
        [itemId]: {
          loading: false,
          rows: result.transactions || [],
          error: '',
          checked: true,
          emptyAcknowledged: false,
        },
      }));
    } catch (error) {
      setSamples((current) => ({
        ...current,
        [itemId]: { loading: false, rows: [], error: error.message, checked: false },
      }));
    }
  };

  const acknowledgeEmptySample = (itemId, acknowledged) => {
    setSamples((current) => ({
      ...current,
      [itemId]: { ...current[itemId], emptyAcknowledged: acknowledged },
    }));
  };

  const confirmProviderSign = async (item, chargeSign) => {
    const sample = samples[item.itemId];
    const hasSampleTransactions = Boolean(sample?.rows?.length);
    const emptySampleAcknowledged = Boolean(
      sample?.checked && !hasSampleTransactions && sample?.emptyAcknowledged
    );
    const symbol = chargeSign === 'positive' ? '+' : '−';
    const providerLabel = item.provider === 'stripe' ? 'Stripe' : 'Teller';
    const evidence = hasSampleTransactions ? `the ${providerLabel} sample` : 'the statement you checked separately';
    if (!confirm(`Confirm that actual credit-card purchases in ${evidence} use the ${symbol} sign?`)) return;
    setBusy(true);
    try {
      const result = await api.post(
        itemPath(item.itemId, `/${item.provider}-sign`),
        { chargeSign, emptySampleAcknowledged }
      );
      const subscriptionErrors = result.subscription?.errors || [];
      setMessage(subscriptionErrors.length > 0
        ? `Amount sign confirmed and ${providerLabel} transactions synced. Daily Stripe subscription failed; Sync will retry it.`
        : `Amount sign confirmed and ${providerLabel} transactions synced.`);
      await afterMutation();
    } catch (error) {
      setErr(error.message);
    } finally {
      setBusy(false);
    }
  };

  const changeStripeSign = async (item, chargeSign) => {
    if (item.chargeSign === chargeSign) return;
    const symbol = chargeSign === 'positive' ? '+' : '−';
    if (!confirm(`Use ${symbol} for Stripe purchases? Existing imported transactions will be recalculated and synced.`)) return;
    setBusy(true);
    setErr('');
    try {
      const result = await api.post(itemPath(item.itemId, '/stripe-sign'), { chargeSign });
      const subscriptionErrors = result.subscription?.errors || [];
      setMessage(subscriptionErrors.length > 0
        ? `Stripe purchases now use ${symbol}. Transactions were recalculated; daily refresh subscription still needs a retry.`
        : `Stripe purchases now use ${symbol}. Existing and available transactions were recalculated and synced.`);
      await afterMutation();
    } catch (error) {
      setErr(error.message);
    } finally {
      setBusy(false);
    }
  };

  const syncItem = async (itemId) => {
    setBusy(true);
    try {
      const result = await api.post(itemPath(itemId, '/sync'));
      if (result.subscription?.errors?.length) {
        setMessage('Transactions checked, but at least one Stripe daily refresh subscription still needs a retry.');
      }
      await afterMutation();
    } catch (error) {
      setErr(error.message);
    } finally {
      setBusy(false);
    }
  };

  const removeItem = async (item) => {
    const tellerWarning = item.provider === 'teller'
      ? '\n\nIn Teller Development, deleting an enrollment does not restore one of the lifetime 100 enrollments.'
      : '';
    if (!confirm(`Unlink ${item.institutionName || item.provider} and delete its local accounts and transactions?${tellerWarning}`)) return;
    setBusy(true);
    try {
      await api.del(itemPath(item.itemId));
      await afterMutation();
    } catch (error) {
      setErr(error.message);
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
    } catch (error) {
      setErr(error.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmConnectedCard = async (account, item) => {
    const productKey = pendingProducts[account.account_id];
    if (!productKey) {
      setErr('Choose the card product for this connected account');
      return;
    }
    setBusy(true);
    setErr('');
    setMessage('');
    try {
      await api.post('/api/cards', {
        accountId: account.account_id,
        productKey,
        displayName: defaultTrackedCardName(account, item),
      });
      setPendingProducts((current) => {
        const next = { ...current };
        delete next[account.account_id];
        return next;
      });
      setMessage(`${account.name || 'Connected card'} is now tracking the selected benefits.`);
      await afterMutation();
    } catch (error) {
      if (error.status === 409) await reload();
      setErr(error.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteCard = async (id) => {
    setBusy(true);
    try {
      await api.del(`/api/cards/${id}`);
      await afterMutation();
    } catch (error) {
      setErr(error.message);
    } finally {
      setBusy(false);
    }
  };

  const importCsv = async () => {
    if (!csvCardId || !csvFile) {
      setErr('Choose an eligible card and a CSV file');
      return;
    }
    setBusy(true);
    setErr('');
    setMessage('');
    try {
      const rows = await parseCsvFile(csvFile);
      const result = await api.post('/api/import/csv', {
        cardId: Number(csvCardId),
        rows,
        chargeSign: csvChargeSign,
        replaceExisting: csvReplace,
      });
      setMessage(`Imported ${result.imported} CSV transactions.`);
      setCsvFile(null);
      setCsvInputKey((value) => value + 1);
      await afterMutation();
    } catch (error) {
      setErr(error.message);
    } finally {
      setBusy(false);
    }
  };

  const itemsById = new Map(items.map((item) => [item.itemId, item]));
  const pendingAccounts = unmappedConnectedAccounts(accounts, cards);
  const csvCards = cards.filter((card) => !card.account || card.account.provider === 'csv');

  return (
    <>
      {tellerSetup && (
        <TellerLauncher
          key={tellerSetup.nonce}
          setup={tellerSetup}
          onSuccess={tellerSuccess}
          onError={tellerError}
          onExit={() => setTellerSetup(null)}
        />
      )}
      {err && <div className="err">⚠ {err}</div>}
      {message && <div className="success">✓ {message}</div>}

      <section className="card-section">
        <div className="card-head">
          <div className="name">Linked institutions</div>
          <div className="row">
            {stripeConfig?.configured && (
              <button className="btn primary" disabled={busy} onClick={connectStripe}>
                + Connect credit card with Stripe
              </button>
            )}
            {tellerConfig?.configured && (
              <button className="btn" disabled={busy || Boolean(tellerSetup)} onClick={() => startTeller()}>
                + Teller (legacy)
              </button>
            )}
            {plaidConfig?.configured && (
              <PlaidLinkButton onLinked={afterMutation} onError={setErr} />
            )}
          </div>
        </div>
        {!stripeConfig?.configured && (
          <div className="muted small">Stripe Financial Connections is not configured on the Worker.</div>
        )}
        {stripeConfig?.configured && !stripeConfig.webhookConfigured && (
          <div className="warning-box">
            Stripe linking still works. Without STRIPE_WEBHOOK_SECRET, the daily reconciliation and manual Sync
            remain available, but a completed refresh will not import immediately.
          </div>
        )}
        {stripeConfig?.configured && (
          <div className="muted small">
            Stripe supplies a bank description but no structured merchant, category, or MCC for these transactions;
            automatic benefit matches may need manual confirmation.
          </div>
        )}
        {!tellerConfig?.configured && (
          <div className="muted small">Teller is not configured. Stripe, Plaid, CSV, and manual tracking remain available.</div>
        )}
        {tellerConfig?.configured && tellerConfig.environment === 'development' && (
          <div className="muted small">
            Teller Development has 100 total lifetime enrollments. Use Repair on an existing enrollment instead of connecting it again.
          </div>
        )}
        {items.length === 0 && (
          <div className="muted small" style={{ paddingTop: 6 }}>No institutions or CSV accounts linked yet.</div>
        )}
        {items.map((item) => (
          <div className="acct" key={item.itemId}>
            <div className="row between">
              <div>
                <strong>{item.institutionName || 'Institution'}</strong>{' '}
                <span className="badge provider-badge">{item.provider}</span>{' '}
                <span className="muted">· {item.accounts.length} account(s)</span>
                <div className="muted small">
                  last synced: {item.lastSyncedAt ? new Date(item.lastSyncedAt).toLocaleString() : 'never'}
                  {item.refreshPending ? ' · Stripe refresh pending' : ''}
                </div>
              </div>
              <div className="row">
                {item.provider === 'teller' && (
                  <button className="btn" disabled={busy || Boolean(tellerSetup)} onClick={() => startTeller(item.itemId)}>
                    Repair
                  </button>
                )}
                {item.provider !== 'csv' && (
                  <button
                    className="btn"
                    disabled={busy || !item.transactionsSupported || (
                      item.signConfirmationRequired && item.provider !== 'stripe'
                    )}
                    onClick={() => syncItem(item.itemId)}
                  >
                    {item.provider === 'stripe' && item.refreshPending ? '↻ Check refresh' : '↻ Sync'}
                  </button>
                )}
                <button className="btn danger" disabled={busy} onClick={() => removeItem(item)}>Unlink</button>
              </div>
            </div>
            <div className="muted small" style={{ marginTop: 4 }}>
              {item.accounts.map((account) => `${account.name}${account.mask ? ' ••' + account.mask : ''}`).join(' · ')}
            </div>
            {item.capabilityWarning && <div className="warning-box">⚠ {item.capabilityWarning}</div>}
            {item.subscriptionWarning && <div className="warning-box">⚠ {item.subscriptionWarning}</div>}
            {item.accountWarning && <div className="warning-box">⚠ {item.accountWarning}</div>}
            {item.dataQualityWarning && <div className="warning-box">⚠ {item.dataQualityWarning}</div>}
            {item.provider === 'stripe' && (
              <StripeSignControl item={item} busy={busy} onChange={changeStripeSign} />
            )}
            {item.signConfirmationRequired && (
              <ProviderSignPanel
                item={item}
                sample={samples[item.itemId]}
                busy={busy}
                onLoad={loadSamples}
                onConfirm={confirmProviderSign}
                onAcknowledgeEmpty={acknowledgeEmptySample}
              />
            )}
          </div>
        ))}
      </section>

      {pendingAccounts.length > 0 && (
        <section className="card-section pending-card-section">
          <div className="card-head">
            <div className="name">Finish connected card setup</div>
            <span className="badge open">{pendingAccounts.length} to confirm</span>
          </div>
          <div className="muted small pending-intro">
            The bank connection identifies the account, but not the exact rewards product. Confirm the card product once;
            transactions will stay linked automatically afterward.
          </div>
          {pendingAccounts.map((account) => {
            const item = itemsById.get(account.item_id);
            const institutionName = item?.institutionName || '';
            const { suggested, other } = partitionProductsForInstitution(catalog, institutionName);
            return (
              <div className="pending-account" key={account.account_id}>
                <div className="pending-account-details">
                  <strong>{account.name || institutionName || 'Connected credit card'}</strong>{' '}
                  <span className="badge provider-badge">{account.provider}</span>
                  <div className="muted small">
                    {institutionName || 'Institution unavailable'}
                    {account.mask
                      ? ` · account ••${account.mask}`
                      : ` · connection …${account.external_account_id?.slice(-6) || account.account_id.slice(-6)}`}
                  </div>
                  {account.mask && (
                    <div className="muted small">Account last four may differ from the number printed on the card.</div>
                  )}
                </div>
                <select
                  className="pending-product-select"
                  aria-label={`Card product for ${account.name || institutionName || 'connected account'}`}
                  value={pendingProducts[account.account_id] || ''}
                  onChange={(event) => setPendingProducts((current) => ({
                    ...current,
                    [account.account_id]: event.target.value,
                  }))}
                >
                  <option value="">— Confirm card product —</option>
                  {suggested.length > 0 && (
                    <optgroup label={`Suggested for ${institutionName}`}>
                      {suggested.map((product) => (
                        <option key={product.key} value={product.key}>{product.name}</option>
                      ))}
                    </optgroup>
                  )}
                  {other.length > 0 && (
                    <optgroup label={suggested.length > 0 ? 'Other card products' : 'All card products'}>
                      {other.map((product) => (
                        <option key={product.key} value={product.key}>{product.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <button
                  className="btn primary"
                  disabled={busy || !pendingProducts[account.account_id]}
                  onClick={() => confirmConnectedCard(account, item)}
                >
                  Confirm &amp; track
                </button>
              </div>
            );
          })}
        </section>
      )}

      <section className="card-section">
        <div className="card-head"><div className="name">Add a card to track</div></div>
        <div className="toolbar">
          <select value={formProduct} onChange={(event) => setFormProduct(event.target.value)}>
            <option value="">— Card product —</option>
            {catalog.map((product) => (
              <option key={product.key} value={product.key}>{product.name}</option>
            ))}
          </select>
          <select value={formAccount} onChange={(event) => setFormAccount(event.target.value)}>
            <option value="">Manual (no linked account)</option>
            {pendingAccounts.map((account) => (
              <option key={account.account_id} value={account.account_id}>
                {account.name}{account.mask ? ' ••' + account.mask : ''}
              </option>
            ))}
          </select>
          <input
            className="text-input"
            placeholder="Nickname (optional)"
            value={formName}
            onChange={(event) => setFormName(event.target.value)}
          />
          <button className="btn primary" disabled={busy} onClick={addCard}>Add</button>
        </div>
        <div className="muted small">
          Link an account to auto-match transactions, or add a manual card and track credits by hand.
        </div>
      </section>

      <section className="card-section">
        <div className="card-head"><div className="name">CSV fallback</div></div>
        <div className="muted small csv-help">
          Import a statement into a manual card. Supported headers include Date/Transaction Date, Description/Merchant,
          Amount, or separate Debit/Credit columns. Files stay in your browser until rows are sent to your own Worker.
        </div>
        <div className="csv-grid">
          <select value={csvCardId} onChange={(event) => setCsvCardId(event.target.value)}>
            <option value="">— Manual or CSV card —</option>
            {csvCards.map((card) => (
              <option key={card.id} value={card.id}>{card.display_name || card.product_key}</option>
            ))}
          </select>
          <input
            key={csvInputKey}
            className="file-input"
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => setCsvFile(event.target.files?.[0] || null)}
          />
          <select value={csvChargeSign} onChange={(event) => setCsvChargeSign(event.target.value)}>
            <option value="positive">Purchases are positive (+)</option>
            <option value="negative">Purchases are negative (−)</option>
          </select>
          <label className="check-label">
            <input type="checkbox" checked={csvReplace} onChange={(event) => setCsvReplace(event.target.checked)} />
            Replace previous CSV import
          </label>
          <button className="btn primary" disabled={busy || !csvCardId || !csvFile} onClick={importCsv}>
            Import CSV
          </button>
        </div>
      </section>

      <section className="card-section">
        <div className="card-head"><div className="name">Tracked cards</div></div>
        {cards.length === 0 && <div className="muted small">None yet.</div>}
        {cards.map((card) => (
          <div className="acct row between" key={card.id}>
            <div>
              <strong>{card.display_name || card.product_key}</strong>{' '}
              <span className="muted">
                · {card.account
                  ? `${card.account.name}${card.account.mask ? ' ••' + card.account.mask : ''} (${card.account.provider})`
                  : 'manual'}
              </span>
            </div>
            <button className="btn danger" disabled={busy} onClick={() => deleteCard(card.id)}>Remove</button>
          </div>
        ))}
      </section>
    </>
  );
}
