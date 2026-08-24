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

  const items = await collectDailyHot({ DAILYHOT_BASES: 'https://broken.example,https://empty.example,https://good.example' }, 'generic');
  if (items.length !== 1) throw new Error(`expected 1 real item, got ${items.length}`);
  if (items[0].title !== '真实热榜条目') throw new Error('fallback returned wrong item');
  if (items[0].raw?.trendRadarUpstream !== 'https://good.example/generic') throw new Error('fallback provenance missing full request URL');
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

async function validateDouyinSecondaryFallback() {
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
      return new Response('upstream unavailable', { status: 503, headers: { 'content-type': 'text/plain' } });
    }
    if (href === 'https://api.luochen.sbs/API/hot_list.php?platform=douyin') {
      return new Response(JSON.stringify({
        code: 200,
        data: {
          platform: '抖音',
          list: [
            { rank: 1, title: '备用抖音热点一', hotness: 7654321, url: 'https://www.douyin.com/hot/9001' },
            { rank: 2, title: '备用抖音热点二', hotness: 6543210, url: 'https://www.douyin.com/hot/9002' },
            { rank: 3, title: '备用抖音热点三', hotness: 5432109, url: 'https://www.douyin.com/hot/9003' },
            { rank: 4, title: '备用抖音热点四', hotness: 4321098, url: 'https://www.douyin.com/hot/9004' },
            { rank: 5, title: '备用抖音热点五', hotness: 3210987, url: 'https://www.douyin.com/hot/9005' }
          ]
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const items = await collectDailyHot({ DAILYHOT_BASES: 'https://broken.example,https://empty.example' }, 'douyin');
  if (items.length !== 5) throw new Error(`expected 5 secondary Douyin items, got ${items.length}`);
  if (items[0].title !== '备用抖音热点一') throw new Error('secondary Douyin fallback returned wrong item');
  if (items[0].heat !== 7654321) throw new Error(`secondary Douyin fallback lost hotness: ${items[0].heat}`);
  if (items[0].url !== 'https://www.douyin.com/hot/9001') throw new Error(`secondary Douyin fallback lost canonical URL: ${items[0].url}`);
  if (items[0].raw?.trendRadarUpstream !== 'https://api.luochen.sbs/API/hot_list.php?platform=douyin') {
    throw new Error('secondary Douyin fallback provenance missing');
  }
  const aa1Index = calls.indexOf('https://v.api.aa1.cn/api/douyin-hot/index.php?aa1=hot');
  const luochenIndex = calls.indexOf('https://api.luochen.sbs/API/hot_list.php?platform=douyin');
  if (aa1Index < 0 || luochenIndex <= aa1Index) {
    throw new Error('secondary Douyin fallback ordering is incorrect');
  }
}

async function validateDouyinThirdFallback() {
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
      return new Response('temporarily unavailable', { status: 503, headers: { 'content-type': 'text/plain' } });
    }
    if (href === 'https://api.luochen.sbs/API/hot_list.php?platform=douyin') {
      return new Response('<html>upstream maintenance</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (href === 'https://api.fanyia.cn/api/douyin/dyhot') {
      return new Response(JSON.stringify({
        code: 200,
        msg: '请求成功',
        data: [
          { index: 1, title: '第三抖音热点一', hot: '1044.6万', url: 'https://www.douyin.com/search/%E7%AC%AC%E4%B8%89%E6%8A%96%E9%9F%B3%E7%83%AD%E7%82%B9%E4%B8%80' },
          { index: 2, title: '第三抖音热点二', hot: '998.1万', mobilUrl: 'https://www.douyin.com/search/%E7%AC%AC%E4%B8%89%E6%8A%96%E9%9F%B3%E7%83%AD%E7%82%B9%E4%BA%8C' },
          { index: 3, title: '第三抖音热点三', hot: '887.2万' },
          { index: 4, title: '第三抖音热点四', hot: 7765000 },
          { index: 5, title: '第三抖音热点五', hot: 6654000 }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const items = await collectDailyHot({ DAILYHOT_BASES: 'https://broken.example,https://empty.example' }, 'douyin');
  if (items.length !== 5) throw new Error(`expected 5 third-fallback Douyin items, got ${items.length}`);
  if (items[0].title !== '第三抖音热点一') throw new Error('third Douyin fallback returned wrong item');
  if (items[0].heat !== 10446000) throw new Error(`third Douyin fallback lost heat: ${items[0].heat}`);
  if (items[1].url !== 'https://www.douyin.com/search/%E7%AC%AC%E4%B8%89%E6%8A%96%E9%9F%B3%E7%83%AD%E7%82%B9%E4%BA%8C') throw new Error(`third Douyin fallback lost mobile URL: ${items[1].url}`);
  if (!items[2].url.startsWith('https://www.douyin.com/search/')) throw new Error('third Douyin fallback did not synthesize canonical search URL');
  if (items[0].raw?.trendRadarUpstream !== 'https://api.fanyia.cn/api/douyin/dyhot') {
    throw new Error('third Douyin fallback provenance missing');
  }
  const aa1Index = calls.indexOf('https://v.api.aa1.cn/api/douyin-hot/index.php?aa1=hot');
  const luochenIndex = calls.indexOf('https://api.luochen.sbs/API/hot_list.php?platform=douyin');
  const fanyiaIndex = calls.indexOf('https://api.fanyia.cn/api/douyin/dyhot');
  if (aa1Index < 0 || luochenIndex <= aa1Index || fanyiaIndex <= luochenIndex) {
    throw new Error('third Douyin fallback ordering is incorrect');
  }
}

try {
  await validateGenericFallback();
  await validateDouyinFallback();
  await validateDouyinSecondaryFallback();
  await validateDouyinThirdFallback();
  console.log('DailyHot fallback validated: generic failover plus official-Douyin failure -> AA1 -> Luochen -> independent flat real hot-list fallback');
} finally {
  globalThis.fetch = originalFetch;
}
