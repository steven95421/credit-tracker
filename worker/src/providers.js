import * as plaid from './plaid.js';
import * as stripe from './stripe.js';
import * as teller from './teller.js';
import { openSecret, sealSecret } from './secrets.js';
import { localId, PROVIDERS } from '../../shared/transactions.js';

export function publicProviderConfig(env) {
  const stripeInfo = stripe.stripeStatus(env);
  const tellerInfo = teller.tellerStatus(env);
  return [
    {
      id: PROVIDERS.STRIPE,
      label: 'Stripe Financial Connections',
      configured: stripeInfo.configured,
      environment: stripeInfo.environment,
      publishableKey: stripeInfo.publishableKey,
      webhookConfigured: stripeInfo.webhookConfigured,
      primary: true,
    },
    {
      id: PROVIDERS.TELLER,
      label: 'Teller',
      configured: tellerInfo.configured,
      environment: tellerInfo.environment,
      primary: false,
    },
    {
      id: PROVIDERS.PLAID,
      label: 'Plaid',
      configured: plaid.plaidConfigured(env),
      environment: plaid.plaidEnv(env),
      primary: false,
    },
    {
      id: PROVIDERS.CSV,
      label: 'CSV import',
      configured: true,
      environment: 'local-file',
      primary: false,
    },
  ];
}

export const itemIdFor = (provider, externalItemId) => localId(provider, externalItemId);

export async function storeAccessToken(env, provider, accessToken) {
  if (env.TOKEN_ENCRYPTION_KEY) return sealSecret(accessToken, env.TOKEN_ENCRYPTION_KEY);
  if (provider === PROVIDERS.TELLER) {
    throw Object.assign(new Error('TOKEN_ENCRYPTION_KEY is required before linking Teller'), { status: 503 });
  }
  return accessToken; // compatibility for existing Plaid-only installs
}

export async function withAccessToken(env, item) {
  return {
    ...item,
    access_token: await openSecret(item.access_token, env.TOKEN_ENCRYPTION_KEY),
  };
}

export async function syncItem(env, item, options = {}) {
  const hydrated = await withAccessToken(env, item);
  if (item.provider === PROVIDERS.STRIPE) return stripe.syncItem(env, hydrated, options);
  if (item.provider === PROVIDERS.TELLER) return teller.syncItem(env, hydrated);
  if (item.provider === PROVIDERS.CSV) return { skipped: true, reason: 'CSV data is updated by importing a file' };
  return plaid.syncItem(env, hydrated);
}

export async function removeItem(env, item) {
  const hydrated = await withAccessToken(env, item);
  if (item.provider === PROVIDERS.STRIPE) return stripe.removeItem(env, hydrated);
  if (item.provider === PROVIDERS.TELLER) return teller.removeItem(env, hydrated);
  if (item.provider === PROVIDERS.CSV) return;
  return plaid.removeItem(env, hydrated.access_token);
}
