import { analyzeTopicDetailed } from '../src/ai.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const topic = {
  canonical_title: '真实趋势错误指纹',
  category: '科技',
  current_score: 88,
  breakout_score: 80,
  source_count: 2
};
const evidence = [{ source_id: 'v2ex', title: '真实趋势错误指纹出现新消息', rank: 1 }];

{
  const err = Object.assign(new Error('AiError'), {
    name: 'AiError',
    cause: new Error('400 Invalid request: max_tokens is not supported for this model')
  });
  const result = await analyzeTopicDetailed({
    AI: { async run() { throw err; } },
    AI_MODEL: '@cf/test/model',
    AI_DISABLE_FALLBACK: '1'
  }, topic, evidence);
  assert(result.failureReason.startsWith('inference-error:invalid-request:AiError:'), `nested invalid-request detail missing: ${result.failureReason}`);
  assert(result.failureReason.includes('400-invalid-request-max_tokens-is-not-supported-for-this-model'), `unexpected fingerprint: ${result.failureReason}`);
  const diagnostic = JSON.parse(result.rawText);
  assert(diagnostic.name === 'AiError', `diagnostic name=${diagnostic.name}`);
  assert(diagnostic.messages.some(x => x.includes('max_tokens is not supported')), `diagnostic messages=${JSON.stringify(diagnostic.messages)}`);
}

{
  const err = Object.assign(new Error('AiError'), {
    name: 'AiError',
    cause: new Error('400 Invalid request at https://secret.example/path Authorization: Bearer super-secret user@example.com')
  });
  const result = await analyzeTopicDetailed({
    AI: { async run() { throw err; } },
    AI_MODEL: '@cf/test/model',
    AI_DISABLE_FALLBACK: '1'
  }, topic, evidence);
  assert(!result.rawText.includes('secret.example'), `URL leaked: ${result.rawText}`);
  assert(!result.rawText.includes('super-secret'), `token leaked: ${result.rawText}`);
  assert(!result.rawText.includes('user@example.com'), `email leaked: ${result.rawText}`);
  assert(result.rawText.includes('[url]') && result.rawText.includes('[redacted]') && result.rawText.includes('[email]'), `redaction missing: ${result.rawText}`);
}

{
  const err = Object.assign(new Error('Too many requests: rate limit exceeded'), { status: 429 });
  const result = await analyzeTopicDetailed({
    AI: { async run() { throw err; } },
    AI_MODEL: '@cf/test/model',
    AI_DISABLE_FALLBACK: '1'
  }, topic, evidence);
  assert(result.failureReason === 'inference-error:rate-limit:429', `stable numeric error classification changed: ${result.failureReason}`);
}

console.log('Workers AI nested error fingerprinting and diagnostic redaction validated');
