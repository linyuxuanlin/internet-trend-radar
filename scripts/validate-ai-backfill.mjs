import { enrichTopTopics, isStoredAIValid } from '../src/ai.js';
import { routeApi } from '../src/api.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const goodSummary = '多个真实来源正在围绕同一事件集中报道，核心变化是产品能力从试验阶段进入可被普通用户直接使用的阶段。';
const goodWhy = '过去数小时内不同来源同时出现相关条目，并且排名和覆盖面同步上升，说明讨论正在从单一社区扩散到更广泛受众。';
const goodOpp = [{ idea: '面向具体用户做一个可在一天内验证需求的小工具', rationale: '先通过搜索和评论中的重复问题验证是否存在稳定痛点，再决定是否扩大投入' }];

assert(isStoredAIValid({ ai_summary: goodSummary, ai_why_now: goodWhy, ai_opportunities_json: JSON.stringify(goodOpp) }), 'valid stored AI should pass');
assert(!isStoredAIValid({ ai_summary: '当前热度较高，值得关注后续发展。', ai_why_now: goodWhy, ai_opportunities_json: JSON.stringify(goodOpp) }), 'low-value summary must fail public quality gate');

function makeBackfillDb({ validModelOutput }) {
  const updates = [];
  const binds = [];
  const topic = {
    id: 'topic-1', canonical_title: '测试真实趋势', category: '科技', current_score: 80, breakout_score: 75,
    source_count: 3, ai_summary: null, ai_why_now: null, ai_opportunities_json: null, ai_updated_at: null
  };
  return {
    updates,
    binds,
    prepare(sql) {
      if (sql.includes('SELECT * FROM topics')) {
        return {
          bind(...args) {
            binds.push(args);
            return this;
          },
          async all() { return { results: [topic] }; }
        };
      }
      if (sql.includes('SELECT source_id,title,url,rank,captured_at FROM topic_sources')) {
        return {
          bind() { return this; },
          async all() { return { results: [{ source_id: 'v2ex', title: '测试真实趋势出现新进展', url: 'https://example.test/1', rank: 1, captured_at: new Date().toISOString() }] }; }
        };
      }
      if (sql.startsWith('UPDATE topics SET ai_updated_at=')) {
        return {
          bind(...args) { updates.push({ kind: 'retry', args }); return this; },
          async run() { return { success: true }; }
        };
      }
      if (sql.startsWith('UPDATE topics SET ai_summary=')) {
        return {
          bind(...args) { updates.push({ kind: 'full', args }); return this; },
          async run() { return { success: true }; }
        };
      }
      throw new Error(`unexpected backfill SQL: ${sql}`);
    },
    AI: {
      async run() {
        return validModelOutput
          ? { response: JSON.stringify({ summary: goodSummary, why_now: goodWhy, opportunities: goodOpp, risks: '需继续核对真实用户需求，避免把短时讨论误判为长期需求。' }) }
          : { response: JSON.stringify({ summary: '太短', why_now: '也太短', opportunities: [] }) };
      }
    }
  };
}

{
  const fixture = makeBackfillDb({ validModelOutput: false });
  const result = await enrichTopTopics({ DB: fixture, AI: fixture.AI }, { backfillOnly: true });
  assert(result.selected === 1 && result.failed === 1 && result.updated === 0, `failed backfill result=${JSON.stringify(result)}`);
  assert(fixture.updates.some(x => x.kind === 'retry'), 'failed low-quality AI must write a retry timestamp');
  assert(fixture.binds[0]?.[0] === '-30 minutes', `default retry modifier=${fixture.binds[0]?.[0]}`);
}

{
  const fixture = makeBackfillDb({ validModelOutput: true });
  const result = await enrichTopTopics({ DB: fixture, AI: fixture.AI }, { backfillOnly: true });
  assert(result.selected === 1 && result.failed === 0 && result.updated === 1, `successful backfill result=${JSON.stringify(result)}`);
  assert(fixture.updates.some(x => x.kind === 'full'), 'valid AI must persist complete analysis');
}

const invalidTopic = {
  id: 'bad-ai', canonical_title: '坏 AI 历史数据', category: '科技', current_score: 80, breakout_score: 70,
  ai_summary: '当前热度较高，值得关注后续发展。', ai_why_now: goodWhy,
  ai_opportunities_json: JSON.stringify(goodOpp), ai_risks: '旧风险描述'
};
const validTopic = {
  id: 'good-ai', canonical_title: '高质量 AI 数据', category: '科技', current_score: 79, breakout_score: 69,
  ai_summary: goodSummary, ai_why_now: goodWhy, ai_opportunities_json: JSON.stringify(goodOpp), ai_risks: '需继续验证。'
};
const apiDb = {
  prepare(sql) {
    if (sql.includes('SELECT * FROM topics')) return { async all() { return { results: [invalidTopic, validTopic] }; } };
    if (sql.includes('FROM sources ORDER BY')) return { async all() { return { results: [{ id: 'v2ex', name: 'V2EX', region: 'cn', kind: 'official-api', last_success_at: new Date().toISOString(), last_error: null, last_item_count: 10 }] }; } };
    if (sql.includes('GROUP BY category')) return { async all() { return { results: [{ category: '科技', count: 2, avg_score: 79.5 }] }; } };
    if (sql.includes('FROM topic_snapshots')) return { async all() { return { results: [] }; } };
    throw new Error(`unexpected API SQL: ${sql}`);
  }
};
const response = await routeApi({ DB: apiDb }, new Request('https://example.test/api/dashboard'));
assert(response.status === 200, `dashboard status=${response.status}`);
const dashboard = await response.json();
const bad = dashboard.topics.find(x => x.id === 'bad-ai');
const good = dashboard.topics.find(x => x.id === 'good-ai');
assert(bad.ai_summary === null && bad.ai_why_now === null && bad.opportunities.length === 0 && bad.ai_verified === false, 'invalid historical AI must be hidden from public API');
assert(good.ai_summary === goodSummary && good.opportunities.length === 1, 'valid AI must remain visible');

console.log('AI backlog retry fairness and public quality gate validated');
