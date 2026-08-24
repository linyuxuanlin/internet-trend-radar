import { kindFromItems } from '../src/collector.js';

const item = upstream => ({ raw: { trendRadarUpstream: upstream } });
const cases = [
  ['weibo', 'https://weibo.com/ajax/side/hotSearch', 'official-api'],
  ['douyin', 'https://v.api.aa1.cn/api/douyin-hot/index.php?aa1=hot', 'mirror-fallback'],
  ['weibo', 'https://api-hot.imsyy.top/weibo', 'aggregator-fallback'],
  ['36kr', 'https://www.36kr.com/feed', 'official-rss'],
  ['xiaohongshu', 'xiaohongshu-mcp:/api/v1/feeds/search', 'external-bridge']
];
for (const [source, upstream, expected] of cases) {
  const actual = kindFromItems(source, [item(upstream)]);
  if (actual !== expected) throw new Error(`${source} ${upstream}: expected ${expected}, got ${actual}`);
}
console.log('Upstream kind labels validated: official, mirror, aggregator fallback, and bridge are distinct');
