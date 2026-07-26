# Deploying Credit Tracker (GitHub Pages + Cloudflare Worker, $0)

Architecture — everything on free tiers, no card required anywhere:

```
Browser ──▶ GitHub Pages (static React UI, public URL)
              │  fetch + Bearer token (localStorage)
              ▼
            Cloudflare Worker  ──▶ Plaid API (keys live here as secrets)
              │                      ▲
              ▼                      │ daily cron sync (free tier)
            Cloudflare D1 (SQLite: cards, overrides, transactions, Plaid tokens)
```

Auth: **Google Sign-In only, no passwords anywhere.** The UI gets a Google ID token,
the worker verifies it against Google and an email allowlist, then issues a signed
30-day bearer token. The Pages bundle contains no secrets (the repo can be public —
free GitHub Pages requires that anyway).

Do the steps in order; each is one-time.

## 1. Cloudflare (API + database) — ~10 min

Sign up free at <https://dash.cloudflare.com/sign-up> (email only), then:

```bash
cd worker
npm install
npx wrangler login                 # opens browser, authorize
npm run db:create                  # prints a database_id
```

Paste the printed `database_id` into `wrangler.toml`, then:

```bash
npm run db:schema                  # create tables in D1
npm run db:seed                    # load your 7 cards + current override state
npx wrangler secret put SESSION_SECRET     # paste output of: openssl rand -hex 32
```

Edit the `[vars]` block in `wrangler.toml`:
- `ALLOWED_ORIGINS` → replace `REPLACE_GITHUB_USERNAME` with your GitHub username
- `ALLOWED_EMAIL` → your Gmail (or keep the placeholder and `npx wrangler secret put ALLOWED_EMAIL`)
- `GOOGLE_CLIENT_ID` → filled in step 2

Deploy (re-run after any config change):

```bash
npm run deploy
```

Note the printed URL, e.g. `https://credit-tracker-api.<account>.workers.dev` — that's `VITE_API_BASE` for step 3.

Plaid keys (works without them — manual tracking mode — so this can wait for production approval):

```bash
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET       # the secret matching PLAID_ENV in wrangler.toml
```

## 2. Google OAuth client (the login button) — ~5 min

1. <https://console.cloud.google.com> → create a project (any name).
2. **APIs & Services → OAuth consent screen**: External → fill app name + your email →
   add your Gmail as a **test user** (test mode is fine forever for personal use).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**:
   - Authorized JavaScript origins: `https://<your-github-username>.github.io` and `http://localhost:5173`
   - No redirect URIs needed (Google Identity Services popup flow).
4. Copy the **Client ID** (`…apps.googleusercontent.com`) into `wrangler.toml` → `GOOGLE_CLIENT_ID`,
   then `npm run deploy` again. (Client IDs are public by design; the client secret is never used.)

## 3. GitHub Pages (the UI) — ~5 min

1. Push this repo to GitHub as a **public** repo named `credit-tracker`
   (`.gitignore` already keeps `.env`, the local DB, wrangler state, and `worker/seed.sql`
   out — the seed carries card last-digits, it only needs to exist locally. Check with `git ls-files`).
2. Repo → **Settings → Pages** → Source: **GitHub Actions**.
3. Repo → **Settings → Secrets and variables → Actions → Variables** (not secrets), add:
   - `VITE_API_BASE` = the worker URL from step 1 (no trailing slash)
   - `VITE_BASE` = `/credit-tracker/`
4. Push to `main` (or Actions → *Deploy client to GitHub Pages* → Run workflow).

The app is now at `https://<your-github-username>.github.io/credit-tracker/` —
open it, sign in with Google, and you should see the dashboard with your cards.

## 4. When Plaid production is approved

1. Plaid dashboard → **Team Settings → API → Allowed redirect URIs** →
   add `https://<your-github-username>.github.io/credit-tracker/`
   (OAuth banks — Amex/Chase/Citi — bounce through this and back).
2. `wrangler.toml`: set `PLAID_ENV = "production"`, uncomment `PLAID_REDIRECT_URI` with the same URL.
3. `npx wrangler secret put PLAID_SECRET` with the **production** secret → `npm run deploy`.
4. Open the app → Cards & Accounts → *Link a card with Plaid*. The daily cron
   (13:00 UTC) then keeps transactions synced automatically.

## Day-2 notes

- **Local dev is unchanged**: `npm run dev` at the repo root (Express + local SQLite, no auth).
  Cloud-parity local run: `cd worker && npm run dev` (D1 local, auth bypassed via `DEV_MODE`).
- **Catalog edits** (`shared/catalog.json`): local server picks them up live; the worker
  bundles it, so run `npm run deploy` in `worker/` after editing.
- **Logs**: `cd worker && npm run tail` streams live worker logs (incl. cron runs).
- **Backup**: `npx wrangler d1 export credit-tracker --remote --output=backup.sql`
  (contains Plaid access tokens once linked — treat it as sensitive).
- **Free-tier headroom**: Workers 100k requests/day and D1 5M row-reads/day vs. one user's
  dashboard — effectively unlimited for this app.
