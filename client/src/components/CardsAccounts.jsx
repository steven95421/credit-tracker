import React, { useCallback, useEffect, useRef, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { usePlaidLink } from 'react-plaid-link';
import { useTellerConnect } from 'teller-connect-react';
import { api } from '../api.js';
import {
  automaticConnectedCardMatches,
  defaultTrackedCardName,
  groupLinkedInstitutions,
  partitionPendingAccounts,
  partitionProductsForInstitution,
  pruneDeferredSetupIds,
  prunePendingSelections,
  unmappedConnectedAccounts,
} from '../card-matching.js';
import { parseCsvFile } from '../csv.js';

const itemPath = (itemId, suffix = '') => `/api/items/${encodeURIComponent(itemId)}${suffix}`;
const DEFERRED_SETUP_STORAGE_KEY = 'ct_deferred_card_setups';

const formatLastSyncedAt = (value) => {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : 'never';
};

const institutionSyncSummary = (group) => {
  if (group.neverSyncedCount === group.items.length) return 'last synced: never';
  if (group.neverSyncedCount > 0) {
    return `${group.neverSyncedCount} connection${group.neverSyncedCount === 1 ? '' : 's'} never synced`;
  }
  return `oldest sync: ${formatLastSyncedAt(group.oldestSyncedAt)}`;
};

function loadDeferredSetupIds() {
  try {
    const stored = JSON.parse(localStorage.getItem(DEFERRED_SETUP_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(stored) ? stored.filter((accountId) => typeof accountId === 'string') : []);
  } catch {
    return new Set();
  }
}

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
  const [deferredSetupIds, setDeferredSetupIds] = useState(loadDeferredSetupIds);
  const [autoMatchFailures, setAutoMatchFailures] = useState(new Set());
  const autoMatchAttempts = useRef(new Set());
  const setupFocusTargets = useRef(new Map());
  const setupFocusRequest = useRef(null);

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
      setDeferredSetupIds((current) => pruneDeferredSetupIds(current, pending));
      setErr('');
    } catch (error) {
      setErr(error.message);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    try {
      localStorage.setItem(DEFERRED_SETUP_STORAGE_KEY, JSON.stringify([...deferredSetupIds]));
    } catch {
      // Deferring setup still works for this page if browser storage is unavailable.
    }
  }, [deferredSetupIds]);

  useEffect(() => {
    const targetKey = setupFocusRequest.current;
    if (!targetKey) return;
    setupFocusRequest.current = null;
    setupFocusTargets.current.get(targetKey)?.focus();
  }, [deferredSetupIds]);

  const afterMutation = useCallback(async () => {
    await reload();
    await onChange();
  }, [reload, onChange]);

  useEffect(() => {
    const unmatched = unmappedConnectedAccounts(accounts, cards);
    const unmatchedIds = new Set(unmatched.map((account) => account.account_id));
    for (const accountId of autoMatchAttempts.current) {
      if (!unmatchedIds.has(accountId)) autoMatchAttempts.current.delete(accountId);
    }
    setAutoMatchFailures((current) => {
      const next = new Set([...current].filter((accountId) => unmatchedIds.has(accountId)));
      return next.size === current.size ? current : next;
    });

    const matches = automaticConnectedCardMatches(accounts, cards, items, catalog)
      .filter(({ account }) => !autoMatchAttempts.current.has(account.account_id));
    if (matches.length === 0) return;
    for (const { account } of matches) autoMatchAttempts.current.add(account.account_id);

    void (async () => {
      let shouldReload = false;
      let matchedCount = 0;
      const failedIds = [];
      for (const { account, item, product } of matches) {
        try {
          await api.post('/api/cards', {
            accountId: account.account_id,
            productKey: product.key,
            displayName: defaultTrackedCardName(account, item),
          });
          matchedCount += 1;
          shouldReload = true;
        } catch (error) {
          if (error.status === 409) shouldReload = true;
          else failedIds.push(account.account_id);
        }
      }
      if (failedIds.length > 0) {
        setAutoMatchFailures((current) => new Set([...current, ...failedIds]));
        setErr('Some connected cards could not be matched automatically. Review the remaining cards below.');
      }
      if (matchedCount > 0) {
        setMessage(
          `Automatically matched ${matchedCount} connected card${matchedCount === 1 ? '' : 's'}. `
          + 'You can change the product under Tracked cards.'
        );
      }
      if (shouldReload) await afterMutation();
    })();
  }, [accounts, cards, items, catalog, afterMutation]);

  const connectStripe = async (reconnectItem = null) => {
    const reconnecting = reconnectItem?.provider === 'stripe';
    setBusy(true);
    setErr('');
    setMessage('');
    try {
      const setupPath = reconnecting
        ? itemPath(reconnectItem.itemId, '/stripe-relink/session')
        : '/api/link/stripe/session';
      const completePath = reconnecting
        ? itemPath(reconnectItem.itemId, '/stripe-relink/complete')
        : '/api/link/stripe/complete';
      const setup = await api.post(setupPath);
      const stripeClient = await loadStripe(setup.publishableKey);
      if (!stripeClient) throw new Error('Unable to load Stripe.js');
      const result = await stripeClient.collectFinancialConnectionsAccounts({
        clientSecret: setup.clientSecret,
      });
      if (result.error) throw new Error(result.error.message || 'Stripe account linking was cancelled');
      if (!result.financialConnectionsSession) {
        throw new Error('Stripe did not return a completed Financial Connections session');
      }
      const linked = await api.post(completePath, {
        nonce: setup.nonce,
        sessionId: setup.sessionId,
      });
      const notes = [reconnecting
        ? `Reconnected ${linked.accounts} ${linked.institutionName || 'Stripe'} credit-card account(s).`
        : `Linked ${linked.accounts} Stripe credit-card account(s).`];
      if (reconnecting) {
        notes.push('Existing tracked-card assignments were preserved.');
      } else {
        notes.push('Card products are matched from account names automatically and remain editable under Tracked cards.');
        notes.push('Purchases default to a negative (−) amount; you can change this later per account.');
      }
      if (linked.ignoredAccounts > 0) notes.push(`${linked.ignoredAccounts} unsupported or inactive account(s) were ignored.`);
      if (linked.refreshPending) notes.push('Stripe is preparing transaction history in the background.');
      if (!linked.webhookConfigured) notes.push('Run Sync after it finishes because the Stripe webhook is not configured yet.');
      if (linked.subscriptionErrors?.length) notes.push('At least one daily transaction subscription needs attention.');
      setMessage(notes.join(' '));
      await afterMutation();
    } catch (error) {
      if (reconnecting && error.code === 'stripe.relink_not_needed') {
        try {
          await api.post(itemPath(reconnectItem.itemId, '/sync'));
          setMessage('This Stripe connection is active again. Transactions were checked and the existing card assignment was preserved.');
          await afterMutation();
        } catch (syncError) {
          setErr(syncError.message);
        }
      } else {
        setErr(error.message);
      }
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

  const changeCardProduct = async (card, productKey) => {
    if (!productKey || productKey === card.product_key) return;
    setBusy(true);
    setErr('');
    try {
      await api.patch(`/api/cards/${card.id}`, { productKey });
      const product = catalog.find((entry) => entry.key === productKey);
      setMessage(`${card.display_name || card.account?.name || 'Card'} now tracks ${product?.name || productKey}.`);
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
  const institutionGroups = groupLinkedInstitutions(items);
  const reconnectGroups = institutionGroups.filter((group) => group.reconnectRequiredCount > 0);
  const unmatchedAccounts = unmappedConnectedAccounts(accounts, cards);
  const automaticMatchIds = new Set(
    automaticConnectedCardMatches(accounts, cards, items, catalog)
      .map(({ account }) => account.account_id)
  );
  const pendingAccounts = unmatchedAccounts.filter((account) => (
    !automaticMatchIds.has(account.account_id) || autoMatchFailures.has(account.account_id)
  ));
  const { active: activePendingAccounts, deferred: deferredPendingAccounts } = partitionPendingAccounts(
    pendingAccounts,
    deferredSetupIds
  );
  const csvCards = cards.filter((card) => !card.account || card.account.provider === 'csv');

  const setSetupDeferred = (accountId, deferred, keyboardTriggered = false) => {
    setupFocusRequest.current = deferred
      ? (keyboardTriggered ? 'pending-section-heading' : null)
      : `active:${accountId}`;
    setDeferredSetupIds((current) => {
      const next = new Set(current);
      if (deferred) next.add(accountId);
      else next.delete(accountId);
      return next;
    });
  };

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
              <button className="btn primary" disabled={busy} onClick={() => connectStripe()}>
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
        {tellerConfig?.configured && tellerConfig.environment === 'development' && (
          <div className="muted small">
            Teller Development has 100 total lifetime enrollments. Use Repair on an existing enrollment instead of connecting it again.
          </div>
        )}
        {reconnectGroups.map((group) => {
          const reconnectItem = group.items.find((item) => item.relinkRequired);
          return (
            <div className="stripe-reconnect-banner" role="status" key={`reconnect:${group.key}`}>
              <div>
                <strong>{group.institutionName} stopped syncing</strong>
                <div className="muted small">
                  {group.reconnectRequiredCount} card{group.reconnectRequiredCount === 1 ? '' : 's'} need bank authorization again.
                  Reconnect this bank authorization; existing card products and manual credit settings stay in place.
                  If the cards were linked separately, repeat until this notice clears.
                </div>
              </div>
              <button
                className="btn reconnect"
                disabled={busy || !reconnectItem}
                onClick={() => connectStripe(reconnectItem)}
              >
                Reconnect {group.institutionName}
              </button>
            </div>
          );
        })}
        {items.length === 0 && (
          <div className="muted small" style={{ paddingTop: 6 }}>No institutions or CSV accounts linked yet.</div>
        )}
        {institutionGroups.map((group) => (
          <details className="acct institution-accordion" key={group.key}>
            <summary className="institution-summary">
              <span className="institution-summary-copy">
                <span className="institution-summary-name">
                  <strong>{group.institutionName}</strong>
                  {group.providers.map((provider) => (
                    <span className="badge provider-badge" key={provider}>{provider}</span>
                  ))}
                  {group.needsAttention && (
                    <span
                      className="badge institution-attention-badge"
                      role="img"
                      aria-label="Needs attention"
                      title="Needs attention"
                    >
                      ⚠
                    </span>
                  )}
                </span>
                <span className="muted small institution-last-synced">
                  {institutionSyncSummary(group)}
                  {group.refreshPending ? ' · Stripe refresh pending' : ''}
                </span>
              </span>
              <span className="institution-summary-side">
                <span className="muted small">
                  {group.accounts.length} account{group.accounts.length === 1 ? '' : 's'}
                </span>
                {group.reconnectRequiredCount > 0 && (
                  <span className="badge reconnect-count-badge">
                    {group.reconnectRequiredCount} need reconnect
                  </span>
                )}
                <span className="institution-chevron" aria-hidden="true">›</span>
              </span>
            </summary>
            <div className="institution-details">
              {group.items.map((item) => (
                <div className="institution-connection" key={item.itemId}>
                  <div className="row between">
                    <div className="institution-connection-copy">
                      <div className="row institution-connection-meta">
                        <span className="badge provider-badge">{item.provider}</span>
                        <span className="muted small">
                          last synced: {formatLastSyncedAt(item.lastSyncedAt)}
                        </span>
                      </div>
                      <div className="muted small institution-account-list">
                        {item.accounts.map((account) => (
                          `${account.name}${account.mask ? ' ••' + account.mask : ''}`
                        )).join(' · ')}
                      </div>
                    </div>
                    <div className="row institution-connection-actions">
                      {item.provider === 'stripe' && item.relinkRequired && (
                        <button className="btn reconnect" disabled={busy} onClick={() => connectStripe(item)}>
                          Reconnect
                        </button>
                      )}
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
                  {item.capabilityWarning && <div className="warning-box">⚠ {item.capabilityWarning}</div>}
                  {item.subscriptionWarning && <div className="warning-box">⚠ {item.subscriptionWarning}</div>}
                  {item.accountWarning && <div className="warning-box">⚠ {item.accountWarning}</div>}
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
            </div>
          </details>
        ))}
      </section>

      {pendingAccounts.length > 0 && (
        <section className="card-section pending-card-section">
          <div className="card-head">
            <div
              ref={(node) => {
                if (node) setupFocusTargets.current.set('pending-section-heading', node);
                else setupFocusTargets.current.delete('pending-section-heading');
              }}
              className="name pending-setup-title"
              tabIndex={-1}
            >
              Finish connected card setup
            </div>
            <div className="row pending-setup-counts" aria-live="polite">
              {activePendingAccounts.length > 0 && (
                <span className="badge open">{activePendingAccounts.length} to confirm</span>
              )}
              {deferredPendingAccounts.length > 0 && (
                <span className="badge pending-later-badge">{deferredPendingAccounts.length} later</span>
              )}
            </div>
          </div>
          <div className="muted small pending-intro">
            These account names did not identify one card product confidently. Choose the product once;
            transactions will stay linked automatically afterward, and you can change it later.
          </div>
          {activePendingAccounts.map((account) => {
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
                  ref={(node) => {
                    const key = `active:${account.account_id}`;
                    if (node) setupFocusTargets.current.set(key, node);
                    else setupFocusTargets.current.delete(key);
                  }}
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
                <div className="pending-account-actions">
                  <button
                    className="btn primary"
                    disabled={busy || !pendingProducts[account.account_id]}
                    onClick={() => confirmConnectedCard(account, item)}
                  >
                    Confirm &amp; track
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={(event) => setSetupDeferred(
                      account.account_id,
                      true,
                      event.detail === 0
                    )}
                  >
                    Not now
                  </button>
                </div>
              </div>
            );
          })}
          {deferredPendingAccounts.length > 0 && (
            <div
              className="deferred-setup-list"
              role="group"
              aria-labelledby="deferred-setup-heading"
            >
              <div id="deferred-setup-heading" className="muted small deferred-setup-heading">
                Saved for later
              </div>
              {deferredPendingAccounts.map((account) => {
                const item = itemsById.get(account.item_id);
                const institutionName = item?.institutionName || '';
                const accountName = account.name || institutionName || 'Connected credit card';
                return (
                  <button
                    ref={(node) => {
                      const key = `deferred:${account.account_id}`;
                      if (node) setupFocusTargets.current.set(key, node);
                      else setupFocusTargets.current.delete(key);
                    }}
                    type="button"
                    className="pending-account-collapsed"
                    key={account.account_id}
                    disabled={busy}
                    onClick={() => setSetupDeferred(account.account_id, false)}
                    aria-label={`Restore ${accountName} to card setup`}
                  >
                    <span className="deferred-setup-name">
                      <strong>{accountName}</strong>
                      {account.mask ? ` · ••${account.mask}` : ''}
                    </span>
                    <span className="badge provider-badge">{account.provider}</span>
                    <span className="deferred-setup-action">Restore to setup</span>
                  </button>
                );
              })}
            </div>
          )}
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
          <div className="acct row between tracked-card-row" key={card.id}>
            <div className="tracked-card-copy">
              <strong>{card.display_name || card.product_key}</strong>{' '}
              <span className="muted">
                · {card.account
                  ? `${card.account.name}${card.account.mask ? ' ••' + card.account.mask : ''} (${card.account.provider})`
                  : 'manual'}
              </span>
            </div>
            <div className="row tracked-card-actions">
              <select
                className="tracked-product-select"
                value={card.product_key}
                disabled={busy}
                aria-label={`Card product for ${card.display_name || card.account?.name || 'tracked card'}`}
                onChange={(event) => changeCardProduct(card, event.target.value)}
              >
                {catalog.map((product) => (
                  <option key={product.key} value={product.key}>{product.name}</option>
                ))}
              </select>
              <button className="btn danger" disabled={busy} onClick={() => deleteCard(card.id)}>Remove</button>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
