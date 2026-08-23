import { collectDailyHot } from '../src/sources/dailyhot.js';

const originalFetch = globalThis.fetch;

async function validateGenericFallback() {
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

  const items = await collectDailyHot({ DAILYHOT_BASES: 'https://broken.example,https://empty.example,https://good.example' }, 'weibo');
  if (items.length !== 1) throw new Error(`expected 1 real item, got ${items.length}`);
  if (items[0].title !== '真实热榜条目') throw new Error('fallback returned wrong item');
  if (items[0].raw?.trendRadarUpstream !== 'https://good.example') throw new Error('fallback provenance missing');
  if (calls.length !== 3) throw new Error(`expected three upstream attempts, got ${calls.length}`);
}

async function validateDouyinFallback() {
  const calls = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.startsWith('https://broken.example/')) throw new TypeError('fetch failed');
    if (href.startsWith('https://empty.example/')) {
      return new Response(JSON.stringify({ code: 200, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (href.includes('/passport/general/login_guiding_strategy/')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (href === 'https://v.api.aa1.cn/api/douyin-hot/index.php?aa1=hot') {
      return new Response(JSON.stringify({
        status_code: 0,
        data: {
          word_list: [
            { sentence_id: '101', word: '真实抖音热点一', hot_value: 998877 },
            { sentence_id: '102', word: '真实抖音热点二', hot_value: 887766 },
            { sentence_id: '103', word: '真实抖音热点三', hot_value: 776655 },
            { sentence_id: '104', word: '真实抖音热点四', hot_value: 665544 },
            { sentence_id: '105', word: '真实抖音热点五', hot_value: 554433 }
          ]
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const items = await collectDailyHot({ DAILYHOT_BASES: 'https://broken.example,https://empty.example' }, 'douyin');
  if (items.length !== 5) throw new Error(`expected 5 Douyin items, got ${items.length}`);
  if (items[0].title !== '真实抖音热点一') throw new Error('Douyin fallback returned wrong item');
  if (items[0].heat !== 998877) throw new Error(`Douyin fallback lost heat: ${items[0].heat}`);
  if (items[0].raw?.trendRadarUpstream !== 'https://v.api.aa1.cn/api/douyin-hot/index.php?aa1=hot') {
    throw new Error('Douyin fallback provenance missing');
  }
  if (!calls.some(url => url === 'https://v.api.aa1.cn/api/douyin-hot/index.php?aa1=hot')) {
    throw new Error('Douyin AA1 fallback was not attempted');
  }
}

try {
  await validateGenericFallback();
  await validateDouyinFallback();
  console.log('DailyHot fallback validated: generic failover plus official-Douyin failure -> real AA1 payload');
} finally {
  globalThis.fetch = originalFetch;
}
