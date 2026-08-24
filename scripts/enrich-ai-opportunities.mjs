import { readFile, writeFile } from 'node:fs/promises';

const dashboardPath = new URL('../public/data/dashboard.json', import.meta.url);
const productionSourceUrl = process.env.AI_SOURCE_URL || 'https://radar.wiki-power.com/api/dashboard';
const pagesSourceUrl = process.env.PAGES_SOURCE_URL || 'https://radar.wiki-power.com/data/dashboard.json';
const sourceUrls = [...new Set([process.env.AI_SOURCE_URL, productionSourceUrl, pagesSourceUrl].filter(Boolean))];
const minMatches = Math.max(0, Number(process.env.MIN_AI_MATCHES || 0));
const maxAgeMs = Math.max(1, Number(process.env.MAX_AI_AGE_HOURS || 12)) * 60 * 60 * 1000;
const timeoutMs = Math.max(1000, Number(process.env.AI_FETCH_TIMEOUT_MS || 15000));
const attempts = Math.max(1, Number(process.env.AI_FETCH_ATTEMPTS || 6));
const retryMs = Math.max(0, Number(process.env.AI_FETCH_RETRY_MS || 10000));

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function normalizeTitle(value) { return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''); }
function isKnownHeuristic(topic) {
  const summary = String(topic?.ai_summary || '');
  const why = String(topic?.ai_why_now || '');
  const opps = Array.isArray(topic?.opportunities) ? topic.opportunities : [];
  if (summary.includes('正在进入活跃讨论区间，可结合来源扩散和热度增速判断是否形成持续趋势')) return true;
  if (why.includes('当前综合热度') && why.includes('突破指数') && why.includes('覆盖')) return true;
  return opps.some(o => String(o?.rationale || '').includes('热点早期的信息差通常大于成熟期') || String(o?.rationale || '').includes('用搜索量和评论问题验证真实需求后再开发'));
}
function validAI(topic, now) {
  if (!topic || isKnownHeuristic(topic)) return false;
  if (!String(topic.ai_summary || '').trim() || !String(topic.ai_why_now || '').trim()) return false;
  if (!Array.isArray(topic.opportunities) || topic.opportunities.length < 1) return false;
  const updated = Date.parse(topic.ai_updated_at || '');
  if (!Number.isFinite(updated)) return false;
  const age = now - updated;
  if (age < -5 * 60 * 1000 || age > maxAgeMs) return false;
  const signals = Array.isArray(topic.raw_signals) ? topic.raw_signals : [];
  if (!signals.length) return false;
  if (signals.some(signal => {
    const capturedAt = Date.parse(signal?.latest_captured_at || '');
    const upstream = String(signal?.upstream || '').trim();
    const observed = Array.isArray(signal?.observed_upstreams) ? signal.observed_upstreams : [];
    return !upstream || !Number.isFinite(capturedAt) || now - capturedAt < -5 * 60 * 1000 || now - capturedAt > maxAgeMs || (observed.length > 0 && !observed.includes(upstream));
  })) return false;
  return topic.opportunities.every(o => String(o?.idea || '').trim() && String(o?.rationale || '').trim());
}

const dashboard = JSON.parse(await readFile(dashboardPath, 'utf8'));
if (dashboard.preview !== false || dashboard.ready !== true || !Array.isArray(dashboard.topics) || !dashboard.topics.length) throw new Error('AI enrichment requires a real-data ready dashboard snapshot');

const generatedAt = new Date().toISOString();
let source = null;
let sourceUrlUsed = null;
let fetchError = null;
const attemptsPerSource = Math.max(1, Math.ceil(attempts / sourceUrls.length));
for (const sourceUrl of sourceUrls) {
  for (let attempt = 1; attempt <= attemptsPerSource; attempt++) {
    try {
      const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`AI source HTTP ${response.status}`);
      const candidate = await response.json();
      if (candidate?.preview !== false || candidate?.ready !== true || !Array.isArray(candidate?.topics)) throw new Error('AI source is not a real-data ready dashboard');
      const sourceGeneratedAt = Date.parse(candidate.generatedAt || '');
      if (!Number.isFinite(sourceGeneratedAt) || Date.now() - sourceGeneratedAt < -5 * 60 * 1000 || Date.now() - sourceGeneratedAt > maxAgeMs) throw new Error('AI source snapshot is stale or invalid');
      source = candidate;
      sourceUrlUsed = sourceUrl;
      fetchError = null;
      break;
    } catch (error) {
      fetchError = `${sourceUrl}: ${String(error?.message || error)}`;
      console.warn(`AI source ${sourceUrl} attempt ${attempt}/${attemptsPerSource} failed: ${fetchError}`);
      if (attempt < attemptsPerSource && retryMs) await sleep(retryMs);
    }
  }
  if (source) break;
}

let matchedCount = 0;
let candidateCount = 0;
if (source) {
  const now = Date.now();
  const byTitle = new Map();
  for (const topic of source.topics) {
    if (!validAI(topic, now)) continue;
    candidateCount++;
    const key = normalizeTitle(topic.canonical_title);
    if (key) byTitle.set(key, topic);
  }
  dashboard.topics = dashboard.topics.map(topic => {
    const ai = byTitle.get(normalizeTitle(topic.canonical_title));
    if (!ai) return topic;
    matchedCount++;
    return { ...topic, ai_summary: ai.ai_summary, ai_why_now: ai.ai_why_now, ai_risks: ai.ai_risks || '', ai_updated_at: ai.ai_updated_at, opportunities: ai.opportunities.slice(0, 3), ai_provenance: { provider: 'cloudflare-workers-ai', source: sourceUrlUsed === pagesSourceUrl ? 'pages-last-known-good' : 'worker-dashboard', source_url: sourceUrlUsed, verified_non_heuristic: true, source_generated_at: source.generatedAt || null } };
  });
}

dashboard.ai = { mode: 'actions-worker-overlay', provider: 'cloudflare-workers-ai', generatedAt, available: matchedCount > 0, matchedCount, candidateCount, sourceReady: Boolean(source), sourceUrl: sourceUrlUsed, error: fetchError };
await writeFile(dashboardPath, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
console.log(`AI overlay: matched=${matchedCount}, candidates=${candidateCount}, sourceReady=${Boolean(source)}, source=${sourceUrlUsed || 'none'}${fetchError ? `, error=${fetchError}` : ''}`);
if (matchedCount < minMatches) throw new Error(`AI overlay matched ${matchedCount} topics; require at least ${minMatches}`);
