import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { q } from './db.js';
import {
  plaidConfigured, plaidEnv, createLinkToken, exchangePublicToken,
  fetchInstitution, fetchAccounts, syncItem, removeItem,
} from './plaid.js';
import { loadCatalog, statusForCard, todayYMD } from './benefits.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const clientDist = resolve(repoRoot, 'client', 'dist');

const app = express();
app.use(cors());
app.use(express.json());

// async route wrapper
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  const status = err.status || err.response?.status || 500;
  const detail = err.response?.data || { message: err.message };
  console.error('[error]', status, detail);
  res.status(status).json({ error: detail.error_message || detail.message || 'server error', detail });
});

// ---------------- meta ----------------
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) =>
  res.json({ plaidConfigured, plaidEnv, today: todayYMD() })
);

// ---------------- Plaid Link ----------------
app.post('/api/link/token', wrap(async (_req, res) => {
  const linkToken = await createLinkToken();
  res.json({ link_token: linkToken });
}));

app.post('/api/link/exchange', wrap(async (req, res) => {
  const { public_token } = req.body || {};
  if (!public_token) return res.status(400).json({ error: 'public_token required' });
  const { accessToken, itemId } = await exchangePublicToken(public_token);
  const { institutionId, institutionName } = await fetchInstitution(accessToken);
  q.insertItem.run(itemId, accessToken, institutionId, institutionName, new Date().toISOString());

  const accounts = await fetchAccounts(accessToken);
  for (const a of accounts) {
    q.upsertAccount.run(
      a.account_id, itemId, a.name, a.official_name ?? null, a.mask ?? null,
      a.type ?? null, a.subtype ?? null
    );
  }
  // pull transactions immediately
  const item = q.getItem.get(itemId);
  const counts = await syncItem(item);
  res.json({ itemId, institutionName, accounts: accounts.length, sync: counts });
}));

// ---------------- items / accounts ----------------
app.get('/api/items', wrap(async (_req, res) => {
  const items = q.listItems.all().map((it) => ({
    itemId: it.item_id,
    institutionName: it.institution_name,
    createdAt: it.created_at,
    lastSyncedAt: it.last_synced_at,
    accounts: q.listAccountsByItem.all(it.item_id),
  }));
  res.json({ items });
}));

app.delete('/api/items/:itemId', wrap(async (req, res) => {
  const item = q.getItem.get(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'not found' });
  await removeItem(item.access_token);
  q.deleteItem.run(req.params.itemId); // cascade removes accounts
  res.json({ ok: true });
}));

app.get('/api/accounts', wrap(async (_req, res) => {
  res.json({ accounts: q.listAccounts.all() });
}));

app.post('/api/sync', wrap(async (_req, res) => {
  const results = [];
  for (const item of q.listItems.all()) {
    const counts = await syncItem(item);
    results.push({ itemId: item.item_id, ...counts });
  }
  res.json({ synced: results.length, results });
}));

app.post('/api/items/:itemId/sync', wrap(async (req, res) => {
  const item = q.getItem.get(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'not found' });
  const counts = await syncItem(item);
  res.json(counts);
}));

app.get('/api/transactions', wrap(async (req, res) => {
  const { accountId, limit } = req.query;
  if (!accountId) return res.status(400).json({ error: 'accountId required' });
  const rows = q.txnsForAccount.all(accountId, Number(limit) || 100);
  res.json({ transactions: rows });
}));

// ---------------- catalog ----------------
app.get('/api/catalog', wrap(async (_req, res) => {
  res.json({ products: loadCatalog() });
}));

// ---------------- cards (account <-> product mapping) ----------------
app.get('/api/cards', wrap(async (_req, res) => {
  const cards = q.listCards.all().map((c) => {
    const account = c.account_id ? q.getAccount.get(c.account_id) : null;
    return { ...c, account };
  });
  res.json({ cards });
}));

app.post('/api/cards', wrap(async (req, res) => {
  const { accountId, productKey, displayName } = req.body || {};
  if (!productKey) return res.status(400).json({ error: 'productKey required' });
  if (!loadCatalog().some((p) => p.key === productKey)) {
    return res.status(400).json({ error: `unknown productKey: ${productKey}` });
  }
  const info = q.insertCard.run(
    accountId || null, productKey, displayName || null, new Date().toISOString()
  );
  res.json({ id: Number(info.lastInsertRowid) });
}));

app.patch('/api/cards/:id', wrap(async (req, res) => {
  const cardId = Number(req.params.id);
  const { productKey } = req.body || {};
  if (!productKey) return res.status(400).json({ error: 'productKey required' });
  if (!loadCatalog().some((product) => product.key === productKey)) {
    return res.status(400).json({ error: `unknown productKey: ${productKey}` });
  }
  if (!q.getCard.get(cardId)) return res.status(404).json({ error: 'card not found' });
  q.updateCardProduct.run(productKey, cardId);
  res.json({ ok: true });
}));

app.delete('/api/cards/:id', wrap(async (req, res) => {
  q.deleteCard.run(Number(req.params.id));
  res.json({ ok: true });
}));

// ---------------- the dashboard ----------------
const deps = {
  getTxnsBetween: (accountId, start, end) => q.txnsForAccountBetween.all(accountId, start, end),
  getOverride: (cardId, benefitId, periodKey) => q.getOverride.get(cardId, benefitId, periodKey),
};

app.get('/api/benefits/status', wrap(async (_req, res) => {
  const today = todayYMD();
  const cards = await Promise.all(q.listCards.all().map((c) => statusForCard(c, deps, today)));

  // flat alert list: unused credits, soonest expiry first
  const alerts = [];
  for (const card of cards) {
    for (const b of card.benefits) {
      if (b.status !== 'used') {
        alerts.push({
          cardId: card.cardId,
          cardName: card.displayName,
          productName: card.productName,
          ...b,
        });
      }
    }
  }
  alerts.sort((a, b) => a.daysLeft - b.daysLeft || b.remaining - a.remaining);

  const totalRemaining = Math.round(alerts.reduce((s, a) => s + a.remaining, 0) * 100) / 100;
  res.json({ today, cards, alerts, totalRemaining });
}));

app.post('/api/benefits/override', wrap(async (req, res) => {
  const { cardId, benefitId, periodKey, usedAmount, claimed, note } = req.body || {};
  if (!cardId || !benefitId || !periodKey) {
    return res.status(400).json({ error: 'cardId, benefitId, periodKey required' });
  }
  if (!q.getCard.get(Number(cardId))) return res.status(404).json({ error: 'card not found' });
  q.upsertOverride.run(
    Number(cardId), benefitId, periodKey,
    usedAmount === undefined || usedAmount === null || usedAmount === '' ? null : Number(usedAmount),
    claimed ? 1 : 0,
    note || null,
    new Date().toISOString()
  );
  res.json({ ok: true });
}));

// ---------------- serve built client in production ----------------
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(resolve(clientDist, 'index.html')));
}

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, () => {
  console.log(`Credit Tracker server on http://localhost:${PORT}  (Plaid env: ${plaidEnv}, configured: ${plaidConfigured})`);
  if (!plaidConfigured) {
    console.log('⚠  Plaid keys missing — copy .env.example to .env and fill PLAID_CLIENT_ID / PLAID_SECRET to link cards.');
  }
});
