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

async function probe(url, allowHttpError = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'internet-trend-radar-source-probe/1.1'
      }
    });
    if (!response.ok && !allowHttpError) {
      const error = new Error(`HTTP ${response.status}`);
      error.code = `HTTP_${response.status}`;
      throw error;
    }
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, ...diagnosticFor(error) };
  } finally {
    clearTimeout(timer);
  }
}

function applyFailure(source, result) {
  source.last_error_type = result.type;
  source.last_error_code = result.code;
  const suffix = result.code ? ` [${result.code}]` : '';
  source.last_error = `${result.message}${suffix}`.slice(0, 300);
}

const dashboard = JSON.parse(await readFile(DASHBOARD, 'utf8'));
const sources = Array.isArray(dashboard.sources) ? dashboard.sources : [];
const degraded = sources.filter(source => source?.kind === 'aggregator' && !source?.last_success_at && source?.last_error && String(source?.id || '').trim());
let probed = 0;
let sharedProbe = false;

if (degraded.length) {
  // The remaining DailyHot-backed sources share one hostname. Probe that hostname once
  // before retrying individual endpoints. DNS/TLS/network/timeout failures at the base
  // necessarily affect every endpoint, so repeating the same failed lookup per source
  // only adds latency and log noise without yielding more diagnostic information.
  const baseResult = await probe(DAILYHOT_BASE, true);
  probed += 1;

  if (!baseResult.ok && ['dns', 'tls', 'network', 'timeout'].includes(baseResult.type)) {
    sharedProbe = true;
    for (const source of degraded) {
      applyFailure(source, baseResult);
      console.log(`PROBE ${source.id}: ${baseResult.type}${baseResult.code ? ` / ${baseResult.code}` : ''} (shared base failure)`);
    }
  } else {
    for (const source of degraded) {
      const id = String(source.id).trim();
      const result = await probe(`${DAILYHOT_BASE}/${encodeURIComponent(id)}`);
      probed += 1;
      if (result.ok) {
        source.last_error_type = 'transient';
        source.last_error_code = 'PROBE_SUCCEEDED';
        console.log(`PROBE ${id}: transient (retry endpoint reachable)`);
        continue;
      }

      applyFailure(source, result);
      console.log(`PROBE ${id}: ${result.type}${result.code ? ` / ${result.code}` : ''}`);
    }
  }
}

await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ ok: true, probed, degraded: degraded.length, sharedProbe }));
