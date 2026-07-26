// Credit Tracker API on Cloudflare Workers + D1.
// UI lives on GitHub Pages; auth = Google Sign-In (email allowlist), no passwords stored.
import catalogRaw from '../../shared/catalog.json';
import { statusForCard, todayYMD } from '../../shared/benefits-core.js';
import * as db from './db.js';
import * as plaid from './plaid.js';
import { devMode, isAuthed, makeSession, verifyGoogleCredential } from './auth.js';

const products = catalogRaw.products || [];

function corsHeaders(env, req) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && (allowed.includes(origin) || devMode(env))) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

async function readJson(req) {
  return req.json().catch(() => ({}));
}

async function handle(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;
  const now = () => new Date().toISOString();

  // ---------------- public ----------------
  if (path === '/api/health') return { ok: true };

  if (path === '/api/config') {
    return {
      plaidConfigured: plaid.plaidConfigured(env),
      plaidEnv: plaid.plaidEnv(env),
      today: todayYMD(),
      authRequired: !devMode(env),
      authed: await isAuthed(env, req),
      googleClientId: env.GOOGLE_CLIENT_ID || '',
    };
  }

  if (path === '/api/auth/google' && method === 'POST') {
    const { credential } = await readJson(req);
    if (!credential) return { status: 400, error: 'credential required' };
    const v = await verifyGoogleCredential(env, credential);
    if (!v.ok) return { status: 401, error: v.error };
    return { token: await makeSession(env, v.email), email: v.email };
  }

  // ---------------- everything below requires a session ----------------
  if (!(await isAuthed(env, req))) return { status: 401, error: 'auth required' };

  // ---------------- Plaid Link ----------------
  if (path === '/api/link/token' && method === 'POST') {
    return { link_token: await plaid.createLinkToken(env) };
  }

  if (path === '/api/link/exchange' && method === 'POST') {
    const { public_token } = await readJson(req);
    if (!public_token) return { status: 400, error: 'public_token required' };
    const { accessToken, itemId } = await plaid.exchangePublicToken(env, public_token);
    const { institutionId, institutionName } = await plaid.fetchInstitution(env, accessToken);
    await db.insertItem(env.DB, itemId, accessToken, institutionId, institutionName, now());

    const accounts = await plaid.fetchAccounts(env, accessToken);
    for (const a of accounts) await db.upsertAccount(env.DB, a, itemId);

    const item = await db.getItem(env.DB, itemId);
    const counts = await plaid.syncItem(env, item);
    return { itemId, institutionName, accounts: accounts.length, sync: counts };
  }

  // ---------------- items / accounts ----------------
  if (path === '/api/items' && method === 'GET') {
    const items = [];
    for (const it of await db.listItems(env.DB)) {
      items.push({
        itemId: it.item_id,
        institutionName: it.institution_name,
        createdAt: it.created_at,
        lastSyncedAt: it.last_synced_at,
        accounts: await db.listAccountsByItem(env.DB, it.item_id),
      });
    }
    return { items };
  }

  let m = path.match(/^\/api\/items\/([^/]+)$/);
  if (m && method === 'DELETE') {
    const item = await db.getItem(env.DB, m[1]);
    if (!item) return { status: 404, error: 'not found' };
    await plaid.removeItem(env, item.access_token);
    // explicit cascade (don't rely on PRAGMA foreign_keys)
    await db.unlinkCardsOfAccounts(env.DB, m[1]);
    await db.deleteTxnsByItem(env.DB, m[1]);
    await db.deleteAccountsByItem(env.DB, m[1]);
    await db.deleteItem(env.DB, m[1]);
    return { ok: true };
  }

  m = path.match(/^\/api\/items\/([^/]+)\/sync$/);
  if (m && method === 'POST') {
    const item = await db.getItem(env.DB, m[1]);
    if (!item) return { status: 404, error: 'not found' };
    return plaid.syncItem(env, item);
  }

  if (path === '/api/accounts' && method === 'GET') {
    return { accounts: await db.listAccounts(env.DB) };
  }

  if (path === '/api/sync' && method === 'POST') {
    const results = [];
    for (const item of await db.listItems(env.DB)) {
      const counts = await plaid.syncItem(env, item);
      results.push({ itemId: item.item_id, ...counts });
    }
    return { synced: results.length, results };
  }

  if (path === '/api/transactions' && method === 'GET') {
    const accountId = url.searchParams.get('accountId');
    if (!accountId) return { status: 400, error: 'accountId required' };
    const limit = Number(url.searchParams.get('limit')) || 100;
    return { transactions: await db.txnsForAccount(env.DB, accountId, limit) };
  }

  // ---------------- catalog ----------------
  if (path === '/api/catalog' && method === 'GET') {
    return { products };
  }

  // ---------------- cards ----------------
  if (path === '/api/cards' && method === 'GET') {
    const cards = [];
    for (const c of await db.listCards(env.DB)) {
      cards.push({ ...c, account: c.account_id ? await db.getAccount(env.DB, c.account_id) : null });
    }
    return { cards };
  }

  if (path === '/api/cards' && method === 'POST') {
    const { accountId, productKey, displayName } = await readJson(req);
    if (!productKey) return { status: 400, error: 'productKey required' };
    if (!products.some((p) => p.key === productKey)) {
      return { status: 400, error: `unknown productKey: ${productKey}` };
    }
    const id = await db.insertCard(env.DB, accountId || null, productKey, displayName || null, now());
    return { id };
  }

  m = path.match(/^\/api\/cards\/(\d+)$/);
  if (m && method === 'DELETE') {
    await db.deleteCard(env.DB, Number(m[1]));
    return { ok: true };
  }

  // ---------------- dashboard ----------------
  if (path === '/api/benefits/status' && method === 'GET') {
    const today = todayYMD();
    const deps = {
      getTxnsBetween: (accountId, start, end) => db.txnsForAccountBetween(env.DB, accountId, start, end),
      getOverride: (cardId, benefitId, periodKey) => db.getOverride(env.DB, cardId, benefitId, periodKey),
    };
    const cards = [];
    for (const c of await db.listCards(env.DB)) cards.push(await statusForCard(c, products, deps, today));

    const alerts = [];
    for (const card of cards) {
      for (const b of card.benefits) {
        if (b.status !== 'used') {
          alerts.push({ cardId: card.cardId, cardName: card.displayName, productName: card.productName, ...b });
        }
      }
    }
    alerts.sort((a, b) => a.daysLeft - b.daysLeft || b.remaining - a.remaining);
    const totalRemaining = Math.round(alerts.reduce((s, a) => s + a.remaining, 0) * 100) / 100;
    return { today, cards, alerts, totalRemaining };
  }

  if (path === '/api/benefits/override' && method === 'POST') {
    const { cardId, benefitId, periodKey, usedAmount, claimed, note } = await readJson(req);
    if (!cardId || !benefitId || !periodKey) {
      return { status: 400, error: 'cardId, benefitId, periodKey required' };
    }
    if (!(await db.getCard(env.DB, Number(cardId)))) return { status: 404, error: 'card not found' };
    await db.upsertOverride(
      env.DB,
      Number(cardId), benefitId, periodKey,
      usedAmount === undefined || usedAmount === null || usedAmount === '' ? null : Number(usedAmount),
      claimed ? 1 : 0,
      note || null,
      now()
    );
    return { ok: true };
  }

  return { status: 404, error: 'not found' };
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let body;
    try {
      body = await handle(req, env);
    } catch (err) {
      console.error('[error]', err.status || 500, err.message, err.detail || '');
      body = { status: err.status || 500, error: err.message || 'server error', detail: err.detail };
    }
    const { status = 200, ...rest } = body || {};
    return new Response(JSON.stringify(rest), {
      status,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  },

  // Daily cron: pull fresh transactions for every linked item.
  async scheduled(_event, env) {
    for (const item of await db.listItems(env.DB)) {
      try {
        const counts = await plaid.syncItem(env, item);
        console.log('cron sync', item.item_id, JSON.stringify(counts));
      } catch (e) {
        console.error('cron sync failed', item.item_id, e.message);
      }
    }
  },
};
