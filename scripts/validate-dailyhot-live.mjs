import { collectDailyHot } from '../src/sources/dailyhot.js';

const required = String(process.env.REQUIRED_DAILYHOT_SOURCES || 'weibo,zhihu,douyin').split(',').map(x => x.trim()).filter(Boolean);
const optional = String(process.env.OPTIONAL_DAILYHOT_SOURCES || '').split(',').map(x => x.trim()).filter(Boolean);
const env = {
  DAILYHOT_BASES: process.env.DAILYHOT_BASES || 'https://api.guole.fun,https://api-hot.imsyy.top'
};

async function probe(sourceId) {
  try {
    const items = await collectDailyHot(env, sourceId);
    const upstream = items[0]?.raw?.trendRadarUpstream || null;
    if (items.length < 5) throw new Error(`only ${items.length} real items`);
    return { sourceId, ok: true, count: items.length, upstream };
  } catch (err) {
    return { sourceId, ok: false, error: String(err?.message || err) };
  }
}

const requiredResults = [];
for (const sourceId of required) requiredResults.push(await probe(sourceId));
const optionalResults = [];
for (const sourceId of optional.filter(x => !required.includes(x))) optionalResults.push(await probe(sourceId));

console.log(JSON.stringify({ required: requiredResults, optional: optionalResults }, null, 2));
const failed = requiredResults.filter(x => !x.ok);
if (failed.length) throw new Error(`Required live social fallback failed: ${failed.map(x => `${x.sourceId}: ${x.error}`).join('; ')}`);
console.log(`Validated ${requiredResults.length} required live social sources with non-empty real data`);
