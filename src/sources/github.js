import { categoryFor, fingerprintTitle } from '../utils.js';

export async function collectGitHub(env) {
  const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString().slice(0, 10);
  const q = encodeURIComponent(`created:>=${since}`);
  const upstream = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=30`;
  const headers = {
    'accept': 'application/vnd.github+json',
    'user-agent': 'TrendRadarMVP/0.1'
  };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetch(upstream, { headers });
  if (!res.ok) throw new Error(`github: HTTP ${res.status}`);
  const body = await res.json();
  return (body.items || []).map((repo, i) => {
    const title = `${repo.full_name}: ${repo.description || 'new repository'}`;
    return {
      sourceId: 'github', sourceName: 'GitHub', externalId: String(repo.id), title,
      url: repo.html_url, author: repo.owner?.login || '', category: categoryFor('github', title), language: 'en',
      rank: i + 1,
      heat: repo.stargazers_count === null || repo.stargazers_count === undefined ? null : Number(repo.stargazers_count),
      engagement: repo.forks_count === null || repo.forks_count === undefined ? null : Number(repo.forks_count),
      publishedAt: repo.created_at || null, capturedAt: new Date().toISOString(), fingerprint: fingerprintTitle(title),
      raw: {
        trendRadarUpstream: upstream,
        trendRadarMetrics: { heat_path: 'repository.stargazers_count', engagement_path: 'repository.forks_count', selection: 'official repository fields' },
        item: repo
      }
    };
  });
}
