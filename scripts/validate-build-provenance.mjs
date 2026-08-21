import { readFile } from 'node:fs/promises';

const DASHBOARD = new URL('../public/data/dashboard.json', import.meta.url);
const DASHBOARD_URL = String(process.env.DASHBOARD_URL || '').trim();
const EXPECTED_BUILD_SHA = String(process.env.EXPECTED_BUILD_SHA || '').trim().toLowerCase();
const FETCH_TIMEOUT_MS = Number(process.env.DASHBOARD_FETCH_TIMEOUT_MS || 15 * 1000);

function fail(message) {
  console.error(`BUILD_PROVENANCE_FAIL ${message}`);
  process.exitCode = 1;
}

async function loadDashboard() {
  if (!DASHBOARD_URL) return JSON.parse(await readFile(DASHBOARD, 'utf8'));

  let url;
  try {
    url = new URL(DASHBOARD_URL);
  } catch {
    throw new Error(`invalid DASHBOARD_URL: ${DASHBOARD_URL}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`DASHBOARD_URL must use http(s): ${url.protocol}`);
  }

  url.searchParams.set('_radar_provenance', `${EXPECTED_BUILD_SHA}-${Date.now()}`);
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`dashboard fetch failed: HTTP ${response.status} ${response.statusText}`);
  return await response.json();
}

if (!/^[0-9a-f]{40}$/.test(EXPECTED_BUILD_SHA)) {
  fail(`EXPECTED_BUILD_SHA must be a full 40-character git SHA; got: ${EXPECTED_BUILD_SHA || '<empty>'}`);
  process.exit();
}

let dashboard;
try {
  dashboard = await loadDashboard();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  process.exit();
}

const actual = String(dashboard?.buildSha || '').trim().toLowerCase();
if (!/^[0-9a-f]{40}$/.test(actual)) {
  fail(`dashboard buildSha is missing or invalid: ${actual || '<empty>'}`);
} else if (actual !== EXPECTED_BUILD_SHA) {
  fail(`dashboard belongs to a different commit: expected=${EXPECTED_BUILD_SHA} actual=${actual}`);
}

if (!process.exitCode) {
  console.log(JSON.stringify({
    ok: true,
    dashboardLocation: DASHBOARD_URL || DASHBOARD.pathname,
    buildSha: actual
  }));
}
