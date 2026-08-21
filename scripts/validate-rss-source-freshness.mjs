const MAX_ITEM_AGE_MS = Number(process.env.MAX_FEED_ITEM_AGE_MS || 7 * 24 * 60 * 60 * 1000);
const FUTURE_SKEW_MS = Number(process.env.MAX_FUTURE_SKEW_MS || 5 * 60 * 1000);
const MIN_FRESH_ITEMS = Number(process.env.MIN_FRESH_RSS_ITEMS || 5);

const SOURCES = [
  { id: 'sspai', feeds: ['https://sspai.com/feed'] },
  {
    id: '36kr',
    feeds: [
      'https://36kr.com/feed',
      'https://36kr.com/feed-article',
      'https://36kr.com/feed-newsflash',
      'https://36kr.com/feed-moment'
    ]
  }
];

function decodeXml(text = '') {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripHtml(text = '') {
  return decodeXml(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tagValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXml(match[1]).trim() : '';
}

function parseFeed(xml) {
  const text = String(xml);
  const items = text.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  const entries = items.length ? [] : (text.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || []);
  return [...items, ...entries].map(block => ({
    title: stripHtml(tagValue(block, 'title')),
    published: stripHtml(tagValue(block, 'pubDate') || tagValue(block, 'published') || tagValue(block, 'updated'))
  })).filter(row => row.title);
}

async function fetchFeed(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5',
      'user-agent': 'Mozilla/5.0 trend-radar-rss-freshness/1.0'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function freshTimestamp(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const ageMs = Date.now() - timestamp;
  if (ageMs < -FUTURE_SKEW_MS || ageMs > MAX_ITEM_AGE_MS) return null;
  return timestamp;
}

let failed = false;
const results = [];

for (const source of SOURCES) {
  const fresh = new Map();
  const errors = [];
  for (const url of source.feeds) {
    try {
      const rows = parseFeed(await fetchFeed(url));
      for (const row of rows) {
        const timestamp = freshTimestamp(row.published);
        if (timestamp !== null) fresh.set(`${row.title}\n${timestamp}`, timestamp);
      }
      if (fresh.size >= MIN_FRESH_ITEMS) break;
    } catch (error) {
      errors.push(`${url}: ${String(error?.message || error)}`);
    }
  }

  const timestamps = [...fresh.values()];
  const result = {
    id: source.id,
    freshItems: fresh.size,
    newestPublishedAt: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    oldestFreshPublishedAt: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    errors
  };
  results.push(result);
  if (fresh.size < MIN_FRESH_ITEMS) {
    failed = true;
    console.error(`RSS_FRESHNESS_FAIL ${source.id}: freshItems=${fresh.size} < ${MIN_FRESH_ITEMS}; ${errors.join('; ')}`);
  }
}

console.log(JSON.stringify({
  ok: !failed,
  maxItemAgeSeconds: Math.round(MAX_ITEM_AGE_MS / 1000),
  minFreshItems: MIN_FRESH_ITEMS,
  sources: results
}, null, 2));

if (failed) process.exitCode = 1;
