export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
}

export function normalizeTitle(input = '') {
  return String(input)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[【】\[\]()（）「」『』“”‘’'"`~!@#$%^&*+=|\\/:;：；,.，。?？<>《》_—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

export function fingerprintTitle(title) {
  const s = normalizeTitle(title);
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `t_${(hash >>> 0).toString(36)}`;
}

export function numberFromUnknown(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return 0;
  const s = value.trim().toLowerCase().replace(/,/g, '');
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*(万|w|k|m|亿)?/i);
  if (!m) return 0;
  let n = Number(m[1]);
  const unit = m[2];
  if (unit === '万' || unit === 'w') n *= 1e4;
  else if (unit === 'k') n *= 1e3;
  else if (unit === 'm') n *= 1e6;
  else if (unit === '亿') n *= 1e8;
  return Number.isFinite(n) ? n : 0;
}

export function categoryFor(source, title = '') {
  const s = `${source} ${title}`.toLowerCase();
  if (/ai|人工智能|大模型|llm|gpt|机器人|agent|openai|claude|gemini/.test(s)) return 'AI';
  if (/股票|基金|金融|银行|黄金|美联储|a股|港股|crypto|bitcoin|btc|经济/.test(s)) return '财经';
  if (/游戏|电竞|steam|原神|lol|王者|主机|switch|xbox|playstation/.test(s)) return '游戏';
  if (/电影|明星|综艺|音乐|娱乐|票房|演唱会/.test(s)) return '娱乐';
  if (/手机|数码|芯片|半导体|github|开源|程序员|科技|iphone|android|软件|硬件/.test(s)) return '科技';
  if (/足球|篮球|网球|体育|nba|f1|世界杯|奥运/.test(s)) return '体育';
  if (/消费|品牌|餐饮|咖啡|旅游|酒店|汽车|房产|电商/.test(s)) return '消费';
  if (/政策|政府|社会|教育|就业|交通|医疗|新闻/.test(s)) return '社会';
  return '综合';
}

export function scoreItem(rank, total = 50, heat = 0, engagement = 0) {
  const safeRank = Math.max(1, Number(rank) || total);
  const rankScore = clamp(102 - (safeRank - 1) * (82 / Math.max(20, Math.min(total, 100))));
  const heatBoost = clamp(Math.log10(Math.max(1, Number(heat) || 1)) * 5, 0, 24);
  const engagementBoost = clamp(Math.log10(Math.max(1, Number(engagement) || 1)) * 4, 0, 18);
  return clamp(rankScore * 0.78 + heatBoost + engagementBoost);
}

export function topicStatus(score, breakout) {
  if (breakout >= 80 && score < 75) return 'emerging';
  if (score >= 85) return 'hot';
  if (breakout >= 60) return 'rising';
  if (score >= 55) return 'active';
  return 'new';
}

export function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

export function nowIso() { return new Date().toISOString(); }
