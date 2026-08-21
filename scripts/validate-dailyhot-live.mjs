import { collectDailyHot } from '../src/sources/dailyhot.js';

const required = String(process.env.REQUIRED_DAILYHOT_SOURCES || 'weibo,zhihu,douyin').split(',').map(x => x.trim()).filter(Boolean);
const env = {
  DAILYHOT_BASES: process.env.DAILYHOT_BASES || 'https://api.guole.fun,https://api-hot.imsyy.top'
};

const results = [];
for (const sourceId of required) {
  try {
    const items = await collectDailyHot(env, sourceId);
    const upstream = items[0]?.raw?.trendRadarUpstream || null;
    if (items.length < 5) throw new Error(`only ${items.length} real items`);
    results.push({ sourceId, ok: true, count: items.length, upstream });
  } catch (err) {
    results.push({ sourceId, ok: false, error: String(err?.message || err) });
  }
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter(x => !x.ok);
if (failed.length) throw new Error(`DailyHot live fallback failed: ${failed.map(x => `${x.sourceId}: ${x.error}`).join('; ')}`);
console.log(`Validated ${results.length} live DailyHot sources with non-empty real data`);
