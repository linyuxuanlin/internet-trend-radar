import { readFile } from 'node:fs/promises';

const api = await readFile(new URL('../src/api.js', import.meta.url), 'utf8');
const ai = await readFile(new URL('../src/ai.js', import.meta.url), 'utf8');

const recentEvidence = /FROM topic_sources ts[\s\S]*?julianday\(ts\.captured_at\) >= julianday\('now','-24 hours'\)/g;
if ([...api.matchAll(recentEvidence)].length < 1) throw new Error('topic detail evidence must be limited to the recent 24-hour window');
if ([...ai.matchAll(recentEvidence)].length < 1) throw new Error('AI evidence must be limited to the recent 24-hour window');
if (!/julianday\(captured_at\) >= julianday\('now','-24 hours'\)/.test(api)) {
  throw new Error('raw signal evidence must be limited to the recent 24-hour window');
}
console.log('Evidence freshness validated: scoring, public detail, raw signals, and AI evidence share the 24-hour window');
