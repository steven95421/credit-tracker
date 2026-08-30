import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const input = process.argv.slice(2);
const mode = input.includes('--local') ? '--local' : '--remote';
const passthrough = [];

for (let index = 0; index < input.length; index++) {
  if (input[index] === '--persist-to' && input[index + 1]) {
    passthrough.push(input[index], input[index + 1]);
    index++;
  }
}

function run(args, options = {}) {
  const result = spawnSync(npx, args, {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: options.inherit ? undefined : 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
  });
  if (result.error) throw result.error;
  return result;
}

const tableNames = [
  'items',
  'accounts',
  'transactions',
  'cards',
  'benefit_overrides',
  'link_nonces',
  'provider_profiles',
];
const quotedNames = tableNames.map((name) => `'${name}'`).join(',');
const probe = run([
  'wrangler', 'd1', 'execute', 'credit-tracker', mode,
  '--command', `SELECT COUNT(*) AS app_tables FROM sqlite_master WHERE type='table' AND name IN (${quotedNames})`,
  '--json',
  ...passthrough,
]);

if (probe.status !== 0) {
  process.stderr.write(probe.stderr || probe.stdout || 'Unable to inspect D1 database\n');
  process.exit(probe.status || 1);
}

let appTables;
try {
  const response = JSON.parse(probe.stdout);
  appTables = Number(response?.[0]?.results?.[0]?.app_tables);
} catch {
  process.stderr.write('Unable to parse Wrangler D1 inspection output; refusing to initialize.\n');
  process.exit(1);
}

if (!Number.isFinite(appTables)) {
  process.stderr.write('D1 inspection did not return a table count; refusing to initialize.\n');
  process.exit(1);
}
if (appTables !== 0) {
  process.stderr.write(
    `Refusing fresh schema initialization: found ${appTables} Credit Tracker table(s). `
    + 'For an existing Plaid database, run npm run db:migrate instead.\n'
  );
  process.exit(2);
}

const install = run([
  'wrangler', 'd1', 'migrations', 'apply', 'credit-tracker', mode,
  ...passthrough,
], { inherit: true });
process.exit(install.status || 0);
