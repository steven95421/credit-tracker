# Credit Tracker

Personal web app for tracking unused credit-card statement credits. It normalizes transactions from
**Stripe Financial Connections**, **Plaid**, **Teller**, or **CSV statements**, matches them against
recurring card benefits, and keeps manual overrides for credits that cannot be identified reliably.

Stripe Financial Connections is the primary live-data path. Plaid and existing Teller installations
remain available, and every card can still be tracked manually. The production API is the Cloudflare
Worker in `worker/`; the older Express server is kept only as a Plaid-only legacy development path.

## Provider behavior

- **Stripe Financial Connections** — A server-created Session requests only `transactions`, prefetches
  the initial history, and restricts selection to `credit_card`. Stripe refreshes asynchronously, so
  the Worker verifies the raw webhook signature before importing completed refreshes. It never stores
  a Stripe secret or Session client secret in D1. Financial Connections transaction records expose a
  bank description but no structured merchant name, category, or MCC, so Stripe benefit matching uses
  description text and may require manual confirmation. The Worker reuses one durable Stripe Customer;
  one-shot Session ids are never used as the permanent local item identity. Each collected Financial
  Connections Account is stored as its own item, so amount direction, status, sync, and unlink remain
  specific to one card. Stripe purchases default to a negative upstream amount; the setting can be
  changed later, which recalculates stored rows and replays the available transaction history.
- **Teller (legacy)** — Connect runs with a server-generated one-time nonce. The Worker verifies Teller's
  Ed25519 enrollment signature, encrypts the access token in D1, checks that the selected credit-card
  account advertises a transactions link, and syncs with a 10-day overlap.
- **Plaid** — Existing Link and `transactions/sync` behavior is preserved behind the same provider
  abstraction.
- **CSV** — Import common statement formats with `Amount`, or separate `Debit` / `Credit` columns.
  Choose the sign used by purchases before import. A malformed file is fully validated before earlier
  imported rows are replaced.
- **Manual** — Add card profiles without an account and mark benefits used by hand.

Every provider emits one canonical transaction contract: finite numeric amount, positive for a
purchase/charge, negative for a payment/refund, validated `YYYY-MM-DD` date, and a normalized category
when the provider supplies one.

## Local setup

```bash
cd ~/Desktop/credit-tracker
npm run setup
npm --prefix worker run db:migrate:local
npm run dev
```

The tracked migrations work for both a fresh local D1 and an older Plaid-only local D1, and are safe
to run again after pulling a new migration.

This starts the provider-aware Worker on `http://localhost:8787` and Vite on
`http://localhost:5173`. Local Worker auth is bypassed by `DEV_MODE=1`.

For Stripe sandbox testing, add installation-specific values to `worker/.dev.vars`:

```dotenv
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
# Optional locally; get this from `stripe listen` to test automatic imports:
STRIPE_WEBHOOK_SECRET=whsec_...
```

`APP_TIME_ZONE` defaults from `worker/wrangler.toml`; change it to the cardholder's IANA time zone if
needed so transactions near midnight land in the intended benefit period.

Stripe sandbox Sessions show test institutions and return test transactions. To exercise the webhook
locally, run `stripe listen --forward-to localhost:8787/api/webhooks/stripe`. Without a webhook secret,
linking still works and **Sync** imports a completed refresh manually. `worker/.dev.vars*` is ignored by
Git. See [DEPLOY.md](DEPLOY.md) for live registration and webhook setup.

The legacy Express/Plaid path is still available only through explicit `:legacy` scripts, but new
provider work is not duplicated there. `npm start` now starts the local Worker, not the unauthenticated
legacy Express server.

## Use

1. Open **Cards & Accounts** and connect a credit card with Stripe, use a configured fallback, or add
   a manual card. Stripe initially exposes only test institutions while using test API keys.
2. Stripe prepares transaction history asynchronously. Wait for the signed webhook, or press
   **Check refresh** / **Sync**. Purchases default to a negative (−) Stripe amount and import without a
   separate confirmation. If purchases and refunds appear reversed, change the amount direction on
   that linked account; stored rows are recalculated and the available history is synced again.
3. For a legacy Teller enrollment, load sample transactions and explicitly confirm whether a real
   purchase is positive or negative. No Teller transactions sync before this confirmation. If the
   initial sync window is empty, the UI requires an explicit acknowledgement that you checked a
   statement separately.
4. Map the linked account to a card product. For CSV, first create a manual card, then import its
   statement from the CSV fallback section.
5. Open **Dashboard** to review matched spend, remaining credits, reset dates, and expiring benefits.
6. Use **Mark used** or the **$ used** field when statement-credit matching is ambiguous.

Teller Development uses real bank data and has a lifetime total of 100 enrollments. Repair an existing
enrollment from its item row instead of connecting it again; deleting it does not restore the count.

## Verify changes

```bash
npm test
npm run build
cd worker && npx wrangler deploy --dry-run
```

Tests cover Stripe Session scope, credit-card amount normalization, webhook HMAC/timestamp checks,
strict date/category handling, benefit matching, Teller signature verification, encrypted token
storage, and common CSV statement layouts.

The signature unit test uses Teller's documented literal field order. Before enabling Development or
Production, complete one real Teller Sandbox enrollment end to end; a locally generated signature
cannot substitute for validating the dashboard key encoding and actual Connect payload.

## Benefit catalog

`shared/catalog.json` is the single source of truth. Merchant matches are case-insensitive substrings;
category matches use the canonical categories produced by `shared/transactions.js`. Empty match rules
remain manual-only. Benefit terms change, so verify amounts and enrollment requirements against the
issuer before relying on them.

## Layout

```text
shared/
  transactions.js       provider-neutral transaction validation and normalization
  benefits-core.js      period math and benefit matching
  catalog.json          card/benefit catalog
worker/
  migrations/           tracked fresh install and Plaid-only D1 upgrade path
  schema.sql             consolidated provider-aware D1 schema reference
  src/providers.js       provider dispatch and token encryption boundary
  src/stripe.js          Financial Connections Sessions, refreshes, webhook verification, unlink
  src/teller.js          Teller account capability, samples, overlap sync, unlink
  src/plaid.js           Plaid REST client and cursor sync
  src/index.js           authenticated Worker routes and cron
client/src/
  components/            Stripe/Teller/Plaid/manual/CSV UI and dashboard
  csv.js                 browser-side CSV header mapping
server/                  legacy local Plaid-only backend
test/                    Node tests
```

Cloud deployment uses GitHub Pages for the UI and Cloudflare Worker + D1 for the API and data. Follow
[DEPLOY.md](DEPLOY.md); do not deploy the new Worker before applying the D1 migration and configuring
the required secrets.
