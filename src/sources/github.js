import { categoryFor, fingerprintTitle } from '../utils.js';

export async function collectGitHub(env) {
  const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString().slice(0, 10);
  const q = encodeURIComponent(`created:>=${since}`);
  const headers = {
    'accept': 'application/vnd.github+json',
    'user-agent': 'TrendRadarMVP/0.1'
  };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=30`, { headers });
  if (!res.ok) throw new Error(`github: HTTP ${res.status}`);
  const body = await res.json();
  return (body.items || []).map((repo, i) => {
    const title = `${repo.full_name}: ${repo.description || 'new repository'}`;
    return {
      sourceId: 'github', sourceName: 'GitHub', externalId: String(repo.id), title,
      url: repo.html_url, author: repo.owner?.login || '', category: categoryFor('github', title), language: 'en',
      rank: i + 1, heat: Number(repo.stargazers_count || 0), engagement: Number(repo.forks_count || 0),
      publishedAt: repo.created_at || null, capturedAt: new Date().toISOString(), fingerprint: fingerprintTitle(title), raw: repo
    };
  });
}
