const MAX_ITEM_AGE_MS = Number(process.env.MAX_FEED_ITEM_AGE_MS || 7 * 24 * 60 * 60 * 1000);
const FUTURE_SKEW_MS = Number(process.env.MAX_FUTURE_SKEW_MS || 5 * 60 * 1000);
const MIN_FRESH_ITEMS = Number(process.env.MIN_FRESH_RSS_ITEMS || 5);

const SOURCES = [
  { id: 'sspai', mode: 'item', feeds: ['https://sspai.com/feed'] },
  {
    id: '36kr',
    mode: 'feed',
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

function feedTimestamp(xml) {
  const value = stripHtml(tagValue(xml, 'lastBuildDate') || tagValue(xml, 'pubDate') || tagValue(xml, 'updated'));
  return freshTimestamp(value);
}

async function fetchFeed(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5',
      'user-agent': 'Mozilla/5.0 trend-radar-rss-freshness/1.2',
      referer: url.includes('36kr.com') ? 'https://www.36kr.com/rss-center' : undefined
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
  const errors = [];
  let result = null;

  for (const url of source.feeds) {
    try {
      const xml = await fetchFeed(url);
      const rows = parseFeed(xml);

      if (source.mode === 'item') {
        const timestamps = rows.map(row => freshTimestamp(row.published)).filter(Number.isFinite);
        if (timestamps.length >= MIN_FRESH_ITEMS) {
          result = {
            id: source.id,
            mode: 'item-level',
            feedUrl: url,
            feedItems: rows.length,
            freshItems: timestamps.length,
            newestPublishedAt: new Date(Math.max(...timestamps)).toISOString(),
            oldestFreshPublishedAt: new Date(Math.min(...timestamps)).toISOString(),
            errors
          };
          break;
        }
        errors.push(`${url}: fresh item timestamps ${timestamps.length} < ${MIN_FRESH_ITEMS}`);
        continue;
      }

      const builtAt = feedTimestamp(xml);
      if (rows.length >= MIN_FRESH_ITEMS && builtAt !== null) {
        result = {
          id: source.id,
          mode: 'feed-level',
          feedUrl: url,
          feedItems: rows.length,
          freshItems: null,
          feedPublishedAt: new Date(builtAt).toISOString(),
          note: '36Kr items currently omit stable per-item publication timestamps; freshness is verified from the official RSS channel timestamp plus live item count.',
          errors
        };
        break;
      }
      errors.push(`${url}: feedItems=${rows.length}, freshFeedTimestamp=${builtAt !== null}`);
    } catch (error) {
      errors.push(`${url}: ${String(error?.message || error)}`);
    }
  }

  if (!result) {
    failed = true;
    result = { id: source.id, mode: source.mode === 'item' ? 'item-level' : 'feed-level', errors };
    console.error(`RSS_FRESHNESS_FAIL ${source.id}: ${errors.join('; ')}`);
  }
  results.push(result);
}

console.log(JSON.stringify({
  ok: !failed,
  maxAgeSeconds: Math.round(MAX_ITEM_AGE_MS / 1000),
  minRequiredItems: MIN_FRESH_ITEMS,
  sources: results
}, null, 2));

if (failed) process.exitCode = 1;
