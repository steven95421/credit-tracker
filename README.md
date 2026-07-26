# Credit Tracker

Self-hosted, personal-use web app that tracks **unused credit-card statement credits** so you don't
leave money on the table. It pulls your own credit-card transactions via [Plaid](https://plaid.com)
(Transactions product), matches them against a catalog of recurring card benefits
(monthly / quarterly / semi-annual / annual), and surfaces the credits that are about to expire.

Examples it's built for: Amex Platinum monthly Uber Cash, Hilton Aspire semi-annual resort credit,
Chase Sapphire Reserve annual travel credit, Citi Strata monthly entertainment credit.

> Personal use only, runs against your own cards. This is a rebuild from spec — verify the benefit
> amounts in `server/src/catalog.json` against your card's current terms.

## Stack

- **Client** — React + Vite + `react-plaid-link`. Deployable to **GitHub Pages** (see `DEPLOY.md`).
- **Local server** — Node + Express + Plaid Node SDK, SQLite via the built-in `node:sqlite` (no native deps).
- **Cloud API** — Cloudflare **Worker + D1** (`worker/`), same routes as the Express server,
  plus Google Sign-In auth (email allowlist, no passwords) and a daily transaction-sync cron. Free tier.
- **Shared engine** — `shared/benefits-core.js` + `shared/catalog.json`, used by both backends.

## Setup

```bash
cd ~/Desktop/credit-tracker
npm run setup            # installs server + client deps
cp .env.example .env     # then fill PLAID_CLIENT_ID / PLAID_SECRET
```

Get sandbox keys at <https://dashboard.plaid.com/developers/keys>. Start on `PLAID_ENV=sandbox`;
switch to `production` once Plaid Full Production access is granted.

## Run

```bash
npm run dev              # server on :8080, client on :5173 (Vite proxies /api → :8080)
```

Open <http://localhost:5173>.

**Sandbox login:** in the Plaid Link dialog use username `user_good`, password `pass_good`
(any OTP). This links a fake institution with sample transactions.

### Production-style single process

```bash
npm run build            # builds client into client/dist
npm start                # Express serves the API + the built client on :8080
```

## How to use

1. **Cards & Accounts** tab → *Link a card with Plaid* (or add a manual card without linking).
2. Map the linked account to a card product, then *Sync transactions*.
3. **Dashboard** tab → see each card's benefits, how much of each credit is used vs remaining,
   days until the period resets, and what's expiring soon.
4. Auto-matching is best-effort (statement credits don't always post cleanly). Use **Mark used** or
   the **$ used** field to override any benefit manually.

## Deploying to the cloud ($0)

GitHub Pages (UI) + Cloudflare Worker/D1 (API + data) + Google Sign-In (no passwords).
Full walkthrough: **[DEPLOY.md](DEPLOY.md)**.

## Editing the benefit catalog

`shared/catalog.json` is read live by the local server (no restart needed; the cloud worker
bundles it — redeploy after edits). Each benefit:

```jsonc
{
  "id": "amex_plat_uber",
  "name": "Uber Cash",
  "amount": 15,
  "period": "monthly",          // monthly | quarterly | semiannual | annual
  "notes": "...",
  "match": {                      // omit/empty => manual-only benefit
    "merchants": ["uber"],        // case-insensitive substrings of merchant_name/name
    "categories": ["TRANSPORTATION"]  // Plaid personal_finance_category.primary
  },
  "anchor": { "month": 7, "day": 1 } // optional: cardmember-year start for `annual`
}
```

## Layout

```
shared/
  benefits-core.js   period-window math + credit-status engine (pure, shared)
  catalog.json       editable benefit catalog (single source of truth)
server/src/
  index.js           Express app + routes (local use)
  db.js              node:sqlite schema + prepared statements
  plaid.js           Plaid Node SDK: link/exchange, transactions/sync
  benefits.js        thin fs wrapper around the shared engine
worker/
  wrangler.toml      Cloudflare config (D1 binding, vars, cron)
  schema.sql/seed.sql
  src/index.js       Worker router (same API surface as Express)
  src/auth.js        Google Sign-In verify + bearer sessions
  src/plaid.js       Plaid via plain fetch
  src/db.js          D1 query helpers
client/src/
  App.jsx, api.js, components/  Dashboard, Cards & Accounts, BenefitRow, Login
.github/workflows/deploy-pages.yml   builds client → GitHub Pages
```

## Plaid access

Runs on **sandbox** keys (or fully manual without keys) until Plaid Full Production
access is granted for your account; then switch `PLAID_ENV=production` (see `DEPLOY.md` §4).
