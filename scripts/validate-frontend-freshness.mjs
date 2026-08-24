import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
if (!html.includes('function sourceIsHealthy')) throw new Error('frontend must centralize source health semantics');
if (!html.includes("s.freshness_status==='healthy'")) throw new Error('frontend must honor API freshness_status');
if (!html.includes('sourceAgeHours(s)!==null&&sourceAgeHours(s)>2')) throw new Error('frontend must label stale fallback sources instead of healthy');
if (/freshness_status==='healthy'\|\|\(s\.last_success_at&&\!s\.last_error\)/.test(html)) {
  throw new Error('frontend still treats any historical success as healthy');
}
console.log('Frontend freshness semantics validated: stale sources are not presented as healthy');
