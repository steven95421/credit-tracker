# Deploying Credit Tracker

```text
Browser -> GitHub Pages (React)
              |
              | Google login + bearer token
              v
           Cloudflare Worker -> Stripe Financial Connections API
              |              -> Teller API through outbound mTLS (legacy)
              |              -> Plaid API
              v
           Cloudflare D1 (cards, overrides, normalized transactions, encrypted provider tokens)
```

The app remains usable with CSV/manual tracking when no live provider is configured. Stripe test mode
is available before live Financial Connections registration and uses test institutions and data.

## 1. Install and verify

```bash
cd ~/Desktop/credit-tracker
npm run setup
npm test
npm run build
```

## 2. D1 database

Create the database only for a fresh installation:

```bash
cd worker
npm run db:create
```

Paste the returned database ID into `worker/wrangler.toml`.

For a **fresh empty database**, install the tracked schema migrations and optional seed:

```bash
npm run db:init:fresh
npm run db:seed
```

For an **existing Plaid-only database**, do not run `db:init:fresh` (the command will refuse a
non-empty database). Back it up, then apply the additive
provider migration:

```bash
npx wrangler d1 export credit-tracker --remote --output=credit-tracker-before-teller.sql
npm run db:migrate
```

The migrations preserve existing local IDs and backfill them as Plaid external IDs. The initial
`0000` migration is deliberately a no-op on an existing Plaid schema, so fresh and upgrade paths use
the same tracked migration chain.

## 3. Worker auth and token encryption

Set secrets from `worker/`:

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ALLOWED_EMAIL
npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

Generate the two random values with a password manager or `openssl rand -hex 32`. Keep
`TOKEN_ENCRYPTION_KEY` stable: changing or losing it makes newly encrypted Teller/Plaid access tokens
unreadable. Existing Plaid plaintext rows remain readable during migration; new provider tokens are
encrypted before D1 storage.

Set `GOOGLE_CLIENT_ID` and `ALLOWED_ORIGINS` in `wrangler.toml`. The OAuth client ID is public; the
allowed email and session/encryption keys are not.

## 4. Stripe Financial Connections (primary)

Create a Stripe account and start with its **test** API keys. Put the publishable key in `[vars]` in
`worker/wrangler.toml` (it is public by design):

```toml
STRIPE_PUBLISHABLE_KEY = "pk_test_..."
STRIPE_API_VERSION = "2026-08-26.dahlia"
STRIPE_COUNTRY_CODES = "US"
APP_TIME_ZONE = "America/Los_Angeles"
```

Store the secret key with Wrangler:

```bash
npx wrangler secret put STRIPE_SECRET_KEY
```

The integration creates a Financial Connections Session on the server, requests only transaction
access, and filters selectable accounts to `credit_card`. It does not request ownership, balances, or
ACH payment credentials. It stores and reuses one Stripe Customer id as the durable provider profile;
each one-shot Session remains only a link artifact. Each collected Financial Connections Account is
stored separately so amount-sign confirmation, status warnings, sync, and unlink operate on one card at
a time. The initial transaction history and every later refresh are asynchronous.
Stripe documents the amount in cents but not one universal credit-card purchase sign, so the app
requires inspecting actual sample rows and confirming the sign before the first D1 import.
The transaction object provides `description`, but not a structured merchant name, category, or MCC.
Automatic benefit matching therefore falls back to description text and is less precise than a feed
with enriched merchant metadata; retain the manual override and CSV paths for ambiguous credits.
Set `APP_TIME_ZONE` to the cardholder's IANA time zone so a late-night purchase is assigned to the
correct monthly, quarterly, or annual benefit period.

After the Worker has a stable public URL, create a Stripe webhook destination for:

```text
https://<worker-host>/api/webhooks/stripe
```

Subscribe it to at least:

```text
financial_connections.account.refreshed_transactions
financial_connections.account.deactivated
financial_connections.account.reactivated
financial_connections.account.disconnected
```

Pin the webhook destination to the same API version as `STRIPE_API_VERSION`, reveal its signing secret,
then store it:

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Test and live webhook destinations have different `whsec_...` secrets. The Worker validates the raw
request body, HMAC signature, and five-minute timestamp tolerance before accepting an event. Daily
subscriptions refresh connected transactions automatically; the cron also reconciles a completed
refresh if a webhook delivery was missed.

Stripe test data is available immediately. Live transaction access requires a completed Financial
Connections registration in the Stripe Dashboard. Do not replace `pk_test_...` / `sk_test_...` with
live keys until registration and an end-to-end test-mode link, refresh, webhook, and unlink have all
succeeded. Current US standard pricing lists transaction feeds at $0.30 per institution per account
holder per month; verify the current price at [Stripe pricing](https://stripe.com/pricing) before use.

Before submitting the live-access application, make the review surface public and complete:

- The landing page must explain what Credit Tracker does and why it requests transaction data before
  the Google login wall.
- Publish stable URLs for `privacy.html`, `terms.html`, `data-deletion.html`, and `support.html`.
- Make the business/operator identity and contact details used in the Stripe application consistent
  with the public site. Do not invent or expose private contact details just to fill this requirement.
- Keep the Worker and Pages site on HTTPS, and use the public Pages URL as the business/product URL.
- Demonstrate test-mode link, refresh, signed webhook handling, account unlink, and local-data removal.

The repository includes the public product and policy pages, but the operator must review their legal
accuracy and add the real public business/contact identity before relying on them for a production
application. Passing the technical checklist improves the application but does not guarantee Stripe approval.

For local webhook testing, use the Stripe CLI signing secret printed by:

```bash
stripe listen --forward-to localhost:8787/api/webhooks/stripe
```

## 5. Teller (legacy, optional)

Create a Teller application, then add its public application ID to `[vars]` in `wrangler.toml`:

```toml
TELLER_APPLICATION_ID = "app_..."
TELLER_ENV = "sandbox"
```

Store the Token Signing Key from the Teller dashboard as a Worker secret:

```bash
npx wrangler secret put TELLER_TOKEN_SIGNING_KEY
```

Start in Sandbox. It uses simulated data and does not require client-certificate authentication.
Teller Connect still uses a server-generated nonce and the Worker verifies its signed enrollment
payload before storing a token.

Before switching environments, complete one real Sandbox enrollment through the deployed UI and
confirm that signature verification, account discovery, sample loading, sign confirmation, and sync
all succeed. Unit tests prove the documented algorithm and field order, but cannot prove the encoding
of your dashboard key or a live Connect payload.

To use **Development** or **Production** with real end-user data, upload the Teller-issued certificate
and private key to Cloudflare:

```bash
npx wrangler mtls-certificate upload \
  --cert /secure/path/to/teller-cert.pem \
  --key /secure/path/to/teller-key.pem \
  --name credit-tracker-teller
```

Copy the returned certificate ID and enable the binding in `wrangler.toml`:

```toml
[[mtls_certificates]]
binding = "TELLER_MTLS"
certificate_id = "..."
```

Then set `TELLER_ENV = "development"`. Development connects to real institutions, is free, and has
100 total enrollments—not 100 API calls. One enrollment can expose multiple accounts. Deleting an
enrollment does not restore the count, so use the app's **Repair** action; it passes the existing
`enrollmentId` back to Teller Connect.

After linking, the app checks the actual account response for `type=credit`,
`subtype=credit_card`, and a `links.transactions` capability. It does not assume a named institution
supports credit-card transactions. Before the first sync, inspect sample rows and confirm whether a
real purchase is positive or negative; Teller documents a signed amount but not one universal
credit-card purchase convention.

## 6. Optional Plaid fallback

Plaid can remain configured alongside Stripe and Teller:

```bash
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET
```

Set `PLAID_ENV` in `wrangler.toml`. OAuth institutions also require `PLAID_REDIRECT_URI` to exactly
match a URI registered in the Plaid dashboard.

## 7. Google Sign-In

In Google Cloud Console:

1. Configure an external OAuth consent screen and add your Gmail as a test user.
2. Create an OAuth Web client.
3. Add `https://<github-user>.github.io` and `http://localhost:5173` as authorized JavaScript origins.
4. Put the resulting `...apps.googleusercontent.com` ID into `GOOGLE_CLIENT_ID` in `wrangler.toml`.

No Google client secret or redirect URI is needed for this popup flow.

## 8. Validate and deploy the Worker

```bash
cd worker
npx wrangler deploy --dry-run
npm run deploy
```

Record the Worker URL. No live deployment should happen before the D1 migration, auth secrets, and
the credentials required by each provider you actually enable are present. A correctly scoped webhook
signing secret gives prompt Stripe imports; the daily cron and manual Sync remain reconciliation
fallbacks when webhook delivery is absent or delayed.

## 9. GitHub Pages

In the repository settings:

1. Enable Pages with **GitHub Actions** as the source.
2. Add Actions variable `VITE_API_BASE` with the Worker URL and no trailing slash.
3. Add `VITE_BASE=/credit-tracker/`.
4. Push to `main` or manually run the Pages workflow.

The site is served at `https://<github-user>.github.io/credit-tracker/`.

## Operations

- `npm run dev` at the repository root runs the local provider-aware Worker and Vite client.
- `npm run dev:legacy` runs the older Express/Plaid-only backend; it is intentionally not a second
  Teller implementation.
- `cd worker && npm run tail` streams Worker and cron logs.
- Stripe subscriptions refresh daily; the cron reconciles completed Stripe refreshes, syncs Teller and
  Plaid independently, and skips CSV items.
- Back up with `wrangler d1 export` before migrations. Treat backups as sensitive even though new
  access tokens are encrypted, because older Plaid rows or financial transactions may be present.
- Keep Teller certificate files and private keys outside the repository. Revoke and replace the
  certificate in Teller and Cloudflare if the key may have leaked.
