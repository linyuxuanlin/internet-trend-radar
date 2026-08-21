import { collectDailyHot } from '../src/sources/dailyhot.js';

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
  if (String(url).startsWith('https://broken.example/')) throw new TypeError('fetch failed');
  if (String(url).startsWith('https://empty.example/')) {
    return new Response(JSON.stringify({ code: 200, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (String(url).startsWith('https://good.example/')) {
    return new Response(JSON.stringify({
      code: 200,
      title: '微博',
      data: [{ id: '1', title: '真实热榜条目', hot: 12345, url: 'https://example.com/item/1' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`unexpected URL ${url}`);
};

try {
  const items = await collectDailyHot({ DAILYHOT_BASES: 'https://broken.example,https://empty.example,https://good.example' }, 'weibo');
  if (items.length !== 1) throw new Error(`expected 1 real item, got ${items.length}`);
  if (items[0].title !== '真实热榜条目') throw new Error('fallback returned wrong item');
  if (items[0].raw?.trendRadarUpstream !== 'https://good.example') throw new Error('fallback provenance missing');
  if (calls.length !== 3) throw new Error(`expected three upstream attempts, got ${calls.length}`);
  console.log('DailyHot fallback validated: network failure -> empty response -> real upstream');
} finally {
  globalThis.fetch = originalFetch;
}
