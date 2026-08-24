import { analyzeTopicDetailed, enrichTopTopics, isStoredAIValid, validateAIEvidenceClaims } from '../src/ai.js';
import { routeApi } from '../src/api.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let emptyEvidenceModelCalls = 0;
const emptyEvidence = await analyzeTopicDetailed({ AI: { async run() { emptyEvidenceModelCalls++; } } }, { canonical_title: '没有证据的趋势', source_count: 1 }, []);
assert(emptyEvidence.failureReason === 'no-current-evidence', `empty evidence reason=${emptyEvidence.failureReason}`);
assert(emptyEvidenceModelCalls === 0, 'AI model must not run without current evidence');

const goodSummary = '多个真实来源正在围绕同一事件集中报道，核心变化是产品能力从试验阶段进入可被普通用户直接使用的阶段。';
const goodWhy = '过去数小时内不同来源同时出现相关条目，并且排名和覆盖面同步上升，说明讨论正在从单一社区扩散到更广泛受众。';
const goodOpp = [{ idea: '面向具体用户做一个可在一天内验证需求的小工具', rationale: '先通过搜索和评论中的重复问题验证是否存在稳定痛点，再决定是否扩大投入' }];
const goodPayload = { summary: goodSummary, why_now: goodWhy, opportunities: goodOpp, risks: '需继续核对真实用户需求，避免把短时讨论误判为长期需求。' };

assert(isStoredAIValid({ ai_summary: goodSummary, ai_why_now: goodWhy, ai_opportunities_json: JSON.stringify(goodOpp) }), 'valid stored AI should pass');
assert(!isStoredAIValid({ ai_summary: '当前热度较高，值得关注后续发展。', ai_why_now: goodWhy, ai_opportunities_json: JSON.stringify(goodOpp) }), 'low-value summary must fail public quality gate');
const evidenceFixture = [{ source_id: '36kr', title: '真实热点', raw_heat: 39031, raw_engagement: 237, captured_at: '2026-08-24T22:21:03.783Z', upstream: 'https://gateway.36kr.com/api/mis/nav/home/nav/rank/hot' }];
assert(String(validateAIEvidenceClaims({ summary: '真实热点出现新的变化和讨论。', why_now: '根据来源，热度达到 38715，当前需要继续核验。', opportunities: goodOpp }, { canonical_title: '真实热点' }, evidenceFixture)).startsWith('unsupported-evidence-number:'), 'unsupported AI numbers must fail evidence validation');
assert(validateAIEvidenceClaims({ summary: '真实热点出现新的变化和讨论。', why_now: '根据来源，当前证据需要继续核验。', opportunities: [{ type: '内容|工具', idea: '做一个验证工具', rationale: '先核验需求再投入' }] }, { canonical_title: '真实热点' }, evidenceFixture) === 'invalid-opportunity-type', 'unselected opportunity type enum must fail evidence validation');

{
  const topic = { canonical_title: '某品牌发布新手机', category: '科技', current_score: 88, breakout_score: 80, source_count: 1 };
  const evidence = [{ source_id: 'ithome', title: '某品牌发布新手机，首发自研影像芯片', rank: 1 }];
  const calls = [];
  const result = await analyzeTopicDetailed({
    AI_MODEL: '@cf/meta/llama-3.1-8b-instruct-fast',
    AI_DISABLE_FALLBACK: '1',
    AI: {
      async run(model, request) {
        calls.push({ model, request });
        return { response: { ...goodPayload, summary: '某品牌发布新手机后，首发自研影像芯片成为多来源共同提到的核心变化，产品竞争点从参数升级转向自研能力。' } };
      }
    }
  }, topic, evidence);
  assert(result.analysis, `title mention with substantive new information must pass: ${JSON.stringify(result)}`);
  assert(calls[0]?.request?.response_format?.type === 'json_schema', 'production 8B primary call must use JSON schema mode');
}

{
  const topic = { canonical_title: '某品牌发布新手机', category: '科技', current_score: 88, breakout_score: 80, source_count: 1 };
  const evidence = [{ source_id: 'ithome', title: '某品牌发布新手机', rank: 1 }];
  const result = await analyzeTopicDetailed({
    AI_MODEL: '@cf/meta/llama-3.1-8b-instruct-fast',
    AI_DISABLE_FALLBACK: '1',
    AI: { async run() { return { response: { ...goodPayload, summary: '某品牌发布新手机，正式发布。' } }; } }
  }, topic, evidence);
  assert(result.failureReason === 'title-echo', `near-verbatim title echo must still fail: ${JSON.stringify(result)}`);
}

{
  const topic = { canonical_title: '结构化解析测试', category: '科技', current_score: 88, breakout_score: 80, source_count: 1 };
  const evidence = [{ source_id: 'v2ex', title: '结构化解析测试出现新进展', rank: 1 }];
  const fenced = `这里是结果：\n\`\`\`json\n${JSON.stringify(goodPayload)}\n\`\`\`\n以上。`;
  const result = await analyzeTopicDetailed({
    AI_MODEL: '@cf/test/unstructured-model',
    AI_DISABLE_FALLBACK: '1',
    AI: { async run() { return { response: fenced }; } }
  }, topic, evidence);
  assert(result.analysis?.summary === goodSummary, `balanced JSON extraction must tolerate prose/fences: ${JSON.stringify(result)}`);
}

function makeBackfillDb({ validModelOutput, fallbackValid = false, disableFallback = false }) {
  const updates = [];
  const attempts = [];
  const binds = [];
  const aiCalls = [];
  const topic = {
    id: 'topic-1', canonical_title: '测试真实趋势', category: '科技', current_score: 80, breakout_score: 75,
    source_count: 1, ai_summary: null, ai_why_now: null, ai_opportunities_json: null, ai_updated_at: null
  };
  return {
    updates,
    attempts,
    binds,
    aiCalls,
    AI_DISABLE_FALLBACK: disableFallback ? '1' : undefined,
    prepare(sql) {
      if (sql.includes('SELECT * FROM topics')) {
        return {
          bind(...args) { binds.push(args); return this; },
          async all() { return { results: [topic] }; }
        };
      }
      if (sql.includes('FROM topic_sources')) {
        return {
          bind() { return this; },
          async all() { return { results: [{ source_id: 'v2ex', title: '测试真实趋势出现新进展', url: 'https://example.test/1', rank: 1, captured_at: new Date().toISOString() }] }; }
        };
      }
      if (sql.includes('FROM ai_attempts') && sql.includes('quota-or-capacity')) {
        return { async first() { return null; } };
      }
      if (sql.includes('INSERT INTO ai_attempts')) {
        return { bind(...args) { attempts.push(args); return this; }, async run() { return { success: true }; } };
      }
      if (sql.includes('DELETE FROM ai_attempts')) return { async run() { return { success: true }; } };
      if (sql.startsWith('UPDATE topics SET ai_updated_at=')) {
        return { bind(...args) { updates.push({ kind: 'retry', args }); return this; }, async run() { return { success: true }; } };
      }
      if (sql.startsWith('UPDATE topics SET ai_summary=')) {
        return { bind(...args) { updates.push({ kind: 'full', args }); return this; }, async run() { return { success: true }; } };
      }
      throw new Error(`unexpected backfill SQL: ${sql}`);
    },
    AI: {
      async run(model, request) {
        aiCalls.push({ model, request });
        if (validModelOutput) return { response: JSON.stringify(goodPayload) };
        if (fallbackValid && aiCalls.length === 2) return { response: goodPayload };
        return { response: JSON.stringify({ summary: '太短', why_now: '也太短', opportunities: [] }) };
      }
    }
  };
}

{
  const fixture = makeBackfillDb({ validModelOutput: false, disableFallback: true });
  const result = await enrichTopTopics({ DB: fixture, AI: fixture.AI, AI_DISABLE_FALLBACK: fixture.AI_DISABLE_FALLBACK }, { backfillOnly: true });
  assert(result.selected === 1 && result.failed === 1 && result.updated === 0, `failed backfill result=${JSON.stringify(result)}`);
  assert(result.failureReasons['incomplete-output'] === 1, `failure reasons=${JSON.stringify(result.failureReasons)}`);
  assert(fixture.updates.some(x => x.kind === 'retry'), 'failed low-quality AI must write a retry timestamp');
  assert(fixture.binds[0]?.[0] === '-30 minutes', `default retry modifier=${fixture.binds[0]?.[0]}`);
  assert(fixture.attempts.length === 1, 'failed AI inference must persist one attempt diagnostic');
  assert(fixture.attempts[0][3] === 0 && fixture.attempts[0][4] === 'incomplete-output', `failed attempt=${JSON.stringify(fixture.attempts[0])}`);
}

{
  const fixture = makeBackfillDb({ validModelOutput: true });
  const result = await enrichTopTopics({ DB: fixture, AI: fixture.AI }, { backfillOnly: true });
  assert(result.selected === 1 && result.failed === 0 && result.updated === 1, `successful backfill result=${JSON.stringify(result)}`);
  assert(fixture.updates.some(x => x.kind === 'full'), 'valid AI must persist complete analysis');
  assert(fixture.aiCalls.length === 1, 'valid primary AI must not invoke fallback');
  assert(fixture.attempts.length === 1 && fixture.attempts[0][3] === 1 && fixture.attempts[0][4] === null, 'successful AI inference must persist a successful attempt');
}

{
  const fixture = makeBackfillDb({ validModelOutput: false, fallbackValid: true });
  const result = await enrichTopTopics({ DB: fixture, AI: fixture.AI }, { backfillOnly: true });
  assert(result.updated === 1 && result.failed === 0, `structured fallback result=${JSON.stringify(result)}`);
  assert(fixture.aiCalls.length === 2, `structured fallback call count=${fixture.aiCalls.length}`);
  const fallback = fixture.aiCalls[1];
  assert(fallback.model === '@cf/meta/llama-3.1-8b-instruct-fast', `fallback model=${fallback.model}`);
  assert(fallback.request?.response_format?.type === 'json_schema', 'fallback must request JSON schema mode');
  assert(fallback.request?.response_format?.json_schema?.required?.includes('summary'), 'fallback schema must require summary');
  assert(fixture.updates.some(x => x.kind === 'full'), 'object response from JSON mode must persist complete analysis');
}

{
  const topic = { canonical_title: '真实趋势运行时降级', category: '科技', current_score: 88, breakout_score: 80, source_count: 1 };
  const evidence = [{ source_id: 'v2ex', title: '真实趋势运行时降级出现新消息', rank: 1 }];
  const calls = [];
  const rateLimit = Object.assign(new Error('Too many requests: rate limit exceeded'), { status: 429 });
  const result = await analyzeTopicDetailed({
    AI_MODEL: '@cf/test/primary',
    AI_FALLBACK_MODEL: '@cf/test/fallback',
    AI: {
      async run(model, request) {
        calls.push({ model, request });
        if (calls.length === 1) throw rateLimit;
        return { response: goodPayload };
      }
    }
  }, topic, evidence);
  assert(result.analysis?.summary === goodSummary, `runtime fallback analysis=${JSON.stringify(result)}`);
  assert(result.fallbackUsed === true, 'recoverable runtime error must use fallback');
  assert(result.primaryFailureReason === 'inference-error:rate-limit:429', `primary reason=${result.primaryFailureReason}`);
  assert(result.model === '@cf/test/fallback', `fallback result model=${result.model}`);
  assert(calls.length === 2 && calls[1].request?.response_format?.type === 'json_schema', 'runtime fallback must use structured fallback request');
}

{
  const topic = { canonical_title: '真实趋势权限失败', category: '科技', current_score: 88, breakout_score: 80, source_count: 1 };
  const evidence = [{ source_id: 'v2ex', title: '真实趋势权限失败出现新消息', rank: 1 }];
  let calls = 0;
  const forbidden = Object.assign(new Error('Forbidden: permission denied'), { status: 403 });
  const result = await analyzeTopicDetailed({
    AI: { async run() { calls++; throw forbidden; } },
    AI_MODEL: '@cf/test/model'
  }, topic, evidence);
  assert(result.failureReason === 'inference-error:auth-or-permission:403', `auth reason=${result.failureReason}`);
  assert(calls === 1, 'auth/permission failure must not spend a fallback call');
}

{
  const topic = { canonical_title: '真实趋势错误分类', category: '科技', current_score: 88, breakout_score: 80, source_count: 1 };
  const evidence = [{ source_id: 'v2ex', title: '真实趋势错误分类出现新消息', rank: 1 }];
  const rateLimit = Object.assign(new Error('Too many requests: rate limit exceeded'), { status: 429 });
  const result = await analyzeTopicDetailed({ AI: { async run() { throw rateLimit; } }, AI_MODEL: '@cf/test/model', AI_DISABLE_FALLBACK: '1' }, topic, evidence);
  assert(result.failureReason === 'inference-error:rate-limit:429', `rate-limit reason=${result.failureReason}`);
}

{
  const topic = { canonical_title: '真实趋势模型缺失', category: '科技', current_score: 88, breakout_score: 80, source_count: 1 };
  const evidence = [{ source_id: 'v2ex', title: '真实趋势模型缺失出现新消息', rank: 1 }];
  const notFound = Object.assign(new Error('Model not found'), { code: 404 });
  const result = await analyzeTopicDetailed({ AI: { async run() { throw notFound; } }, AI_MODEL: '@cf/test/missing', AI_DISABLE_FALLBACK: '1' }, topic, evidence);
  assert(result.failureReason === 'inference-error:model-not-found:404', `model-not-found reason=${result.failureReason}`);
}

const invalidTopic = {
  id: 'bad-ai', canonical_title: '坏 AI 历史数据', category: '科技', current_score: 80, breakout_score: 70,
  ai_summary: '当前热度较高，值得关注后续发展。', ai_why_now: goodWhy,
  ai_opportunities_json: JSON.stringify(goodOpp), ai_risks: '旧风险描述'
};
const validTopic = {
  id: 'good-ai', canonical_title: '高质量 AI 数据', category: '科技', current_score: 79, breakout_score: 69,
  ai_summary: goodSummary, ai_why_now: goodWhy, ai_opportunities_json: JSON.stringify(goodOpp), ai_risks: '需继续验证。',
  ai_updated_at: new Date().toISOString()
};
const apiDb = {
  prepare(sql) {
    if (sql.includes('SELECT * FROM topics')) return { async all() { return { results: [invalidTopic, validTopic] }; } };
    if (sql.includes('FROM sources s')) return { async all() { return { results: [{ id: 'v2ex', name: 'V2EX', region: 'cn', kind: 'official-api', last_success_at: new Date().toISOString(), last_error: null, last_item_count: 10 }] }; } };
    if (sql.includes('data_quality_contract_probe')) return { async first() { return {
      missing_upstream: 0, invalid_upstream: 0, heat_path_violations: 0, engagement_path_violations: 0,
      contract_heat_violations: 0, contract_engagement_violations: 0,
      definition_heat_path_violations: 0, definition_engagement_path_violations: 0
    }; } };
    if (sql.includes('raw_heat_max')) return {
      bind() { return this; },
      async all() {
        const now = new Date().toISOString();
        const base = { source_id: 'v2ex', source_name: 'V2EX', source_kind: 'official-api', source_weight: 1,
          metadata_json: JSON.stringify({ heat: null, engagement: 'topics[].replies' }), raw_heat_max: null,
          raw_engagement_max: 1, raw_heat_latest: null, raw_engagement_latest: 1, best_rank: 1, observations: 1,
          observed_upstreams: JSON.stringify(['https://example.test/source']), latest_captured_at: now,
          heat_peak_captured_at: null, heat_peak_upstream: null, heat_peak_kind: null,
          engagement_peak_captured_at: now, engagement_peak_upstream: 'https://example.test/source', engagement_peak_kind: 'official-api',
          upstream: 'https://example.test/source', heat_metric_path: null, engagement_metric_path: 'topics[].replies' };
        return { results: [{ ...base, topic_id: 'bad-ai' }, { ...base, topic_id: 'good-ai' }] };
      }
    };
    if (sql.includes('FROM topic_snapshots')) return { bind() { return this; }, async all() { return { results: [] }; } };
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

console.log('AI structured primary output, robust JSON extraction, title-echo quality, backlog retry fairness, fallback, attempt diagnostics, and public quality gate validated');
