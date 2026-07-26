import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statusForCard as coreStatusForCard, todayYMD } from '../../shared/benefits-core.js';

export { todayYMD, periodWindow, daysUntil, matchesBenefit } from '../../shared/benefits-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = resolve(__dirname, '..', '..', 'shared', 'catalog.json');

export function loadCatalog() {
  // Read fresh each call so edits to catalog.json take effect without a restart.
  const raw = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  return raw.products || [];
}

export function productByKey(key) {
  return loadCatalog().find((p) => p.key === key) || null;
}

/** Async (engine is shared with the D1-backed worker); node:sqlite deps resolve immediately. */
export function statusForCard(card, deps, today = todayYMD()) {
  return coreStatusForCard(card, loadCatalog(), deps, today);
}
