import { readFile, writeFile } from 'node:fs/promises';
import { classifySourceFailure } from './source-failure-diagnostics.mjs';

const DASHBOARD = new URL('../public/data/dashboard.json', import.meta.url);
const DAILYHOT_BASE = (process.env.DAILYHOT_BASE || 'https://api-hot.imsyy.top').replace(/\/$/, '');
const PROBE_TIMEOUT_MS = Math.max(1000, Number(process.env.SOURCE_PROBE_TIMEOUT_MS || 8000));

function diagnosticFor(error) {
  const failure = classifySourceFailure(error);
  return {
    type: failure.type || 'unknown',
    code: failure.code || null,
    message: String(error?.message || error || 'unknown error').slice(0, 300)
  };
}

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'internet-trend-radar-source-probe/1.0'
      }
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.code = `HTTP_${response.status}`;
      throw error;
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, ...diagnosticFor(error) };
  } finally {
    clearTimeout(timer);
  }
}

const dashboard = JSON.parse(await readFile(DASHBOARD, 'utf8'));
const sources = Array.isArray(dashboard.sources) ? dashboard.sources : [];
let probed = 0;

for (const source of sources) {
  if (source?.kind !== 'aggregator' || source?.last_success_at || !source?.last_error) continue;
  const id = String(source?.id || '').trim();
  if (!id) continue;

  probed += 1;
  const result = await probe(`${DAILYHOT_BASE}/${encodeURIComponent(id)}`);
  if (result.ok) {
    source.last_error_type = 'transient';
    source.last_error_code = 'PROBE_SUCCEEDED';
    console.log(`PROBE ${id}: transient (retry endpoint reachable)`);
    continue;
  }

  source.last_error_type = result.type;
  source.last_error_code = result.code;
  const suffix = result.code ? ` [${result.code}]` : '';
  source.last_error = `${result.message}${suffix}`.slice(0, 300);
  console.log(`PROBE ${id}: ${result.type}${result.code ? ` / ${result.code}` : ''}`);
}

await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ ok: true, probed }));
