import { isStoredAIUsable } from '../src/ai.js';

const now = Date.parse('2026-08-25T00:00:00.000Z');
const base = {
  ai_summary: '这是一个基于真实来源证据生成的有效趋势总结。',
  ai_why_now: '多个来源在当前窗口出现可观察变化，具备验证依据。',
  ai_opportunities_json: JSON.stringify([{ idea: '做一个可验证的小工具', rationale: '先用来源中的具体问题测试需求。' }]),
  ai_updated_at: '2026-08-24T23:00:00.000Z'
};

if (isStoredAIUsable({ ...base, ai_updated_at: '2026-08-24T17:00:00.000Z' }, 6, now)) {
  throw new Error('AI output older than refresh window must be stale');
}
if (!isStoredAIUsable({ ...base, ai_updated_at: '2026-08-24T23:00:00.000Z' }, 25, now)) {
  throw new Error('AI output inside refresh window was rejected');
}
if (isStoredAIUsable({ ...base, ai_updated_at: null }, 6, now)) {
  throw new Error('AI output without timestamp must be unavailable');
}
console.log('AI freshness gate validated: stale and untimestamped output is hidden');
