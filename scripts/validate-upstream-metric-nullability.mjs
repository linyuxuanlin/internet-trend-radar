import { collectDailyHot } from '../src/sources/dailyhot.js';
import { collectHackerNews } from '../src/sources/hackernews.js';
import { collectGitHub } from '../src/sources/github.js';

const originalFetch = globalThis.fetch;
const json = body => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' }
});

try {
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href === 'https://gateway.36kr.com/api/mis/nav/home/nav/rank/hot') {
      return json({ data: { hotRankList: [
        { itemId: 36, templateMaterial: { widgetTitle: '36Kr missing metrics', statRead: 'N/A', statCollect: 'N/A' } },
        { itemId: 37, templateMaterial: { widgetTitle: '36Kr declared metrics', statRead: '1234', statCollect: 4, statComment: 5, statPraise: 6 } }
      ] } });
    }
    if (href === 'https://api-hot.imsyy.top/36kr' || href === 'https://api.guole.fun/36kr') {
      throw new Error('unexpected fallback after direct 36Kr fixture');
    }
    if (href === 'https://hacker-news.firebaseio.com/v0/topstories.json') return json([101]);
    if (href === 'https://hacker-news.firebaseio.com/v0/item/101.json') {
      return json({ id: 101, title: 'HN missing descendants', score: 7, by: 'fixture' });
    }
    if (href.startsWith('https://api.github.com/search/repositories?')) {
      return json({ items: [{ id: 202, full_name: 'fixture/github', description: 'GitHub exact upstream', html_url: 'https://github.com/fixture/github', stargazers_count: 8, forks_count: 2, owner: { login: 'fixture' }, created_at: '2026-08-24T00:00:00Z' }] });
    }
    throw new Error(`unexpected URL ${href}`);
  };

  const [kr] = await collectDailyHot({}, '36kr');
  if (!kr || kr.heat !== null || kr.engagement !== null) {
    throw new Error(`36Kr missing metrics must stay null, got heat=${kr?.heat} engagement=${kr?.engagement}`);
  }
  if (kr.raw?.trendRadarUpstream !== 'https://gateway.36kr.com/api/mis/nav/home/nav/rank/hot') {
    throw new Error('36Kr upstream missing');
  }
  const krWithMetrics = (await collectDailyHot({}, '36kr')).find(item => item.externalId === '37');
  if (krWithMetrics?.raw?.trendRadarMetrics?.heat_path !== 'templateMaterial.statRead' || krWithMetrics?.raw?.trendRadarMetrics?.engagement_path !== 'statCollect+statComment+statPraise') {
    throw new Error('36Kr adapter metric field provenance missing');
  }

  const [hn] = await collectHackerNews({});
  if (!hn || hn.heat !== 7 || hn.engagement !== null) {
    throw new Error(`Hacker News missing descendants must stay null, got heat=${hn?.heat} engagement=${hn?.engagement}`);
  }
  if (hn.raw?.trendRadarMetrics?.heat_path !== 'item.score' || hn.raw?.trendRadarMetrics?.engagement_path !== 'item.descendants') {
    throw new Error('Hacker News metric field provenance missing');
  }
  const [github] = await collectGitHub({});
  if (!github?.raw?.trendRadarUpstream?.includes('?q=created%3A%3E%3D') || !github.raw.trendRadarUpstream.includes('per_page=30')) {
    throw new Error(`GitHub upstream must retain the exact search query: ${github?.raw?.trendRadarUpstream}`);
  }
  console.log('Upstream metric nullability validated: absent metrics remain null');
} finally {
  globalThis.fetch = originalFetch;
}
