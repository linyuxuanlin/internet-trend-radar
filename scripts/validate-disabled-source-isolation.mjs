import { readFile } from 'node:fs/promises';
import { rebuildTopics } from '../src/scoring.js';

const queries = [];
const db = {
  prepare(sql) {
    queries.push(String(sql));
    const statement = {
      bind: () => statement,
      all: async () => ({ results: [] }),
      run: async () => ({})
    };
    return statement;
  }
};

await rebuildTopics(db, 24);
const scoringQuery = queries.find(sql => sql.includes('WITH recent')) || '';
if (!/COALESCE\(active_source\.enabled, 1\) = 1/.test(scoringQuery)) {
  throw new Error('topic scoring does not exclude disabled sources');
}
const scoring = await readFile(new URL('../src/scoring.js', import.meta.url), 'utf8');
if (!/INSERT OR IGNORE INTO topic_sources[\s\S]*?currentSourcePredicate\('active_source'\)/.test(scoring)) {
  throw new Error('topic evidence persistence does not exclude disabled sources');
}

const api = await readFile(new URL('../src/api.js', import.meta.url), 'utf8');
const ai = await readFile(new URL('../src/ai.js', import.meta.url), 'utf8');
if (!/SELECT r\.\* FROM raw_items r[\s\S]*?currentSourcePredicate\('active_source'\)/.test(api)) {
  throw new Error('public raw evidence query does not exclude disabled sources');
}
if (!/FROM topic_sources ts[\s\S]*?currentSourcePredicate\('active_source'\)/.test(api)) {
  throw new Error('topic detail evidence query does not exclude disabled sources');
}
if (!/FROM topic_sources ts[\s\S]*?currentSourcePredicate\('active_source'\)/.test(ai)) {
  throw new Error('AI evidence query does not exclude disabled sources');
}
console.log('Disabled-source isolation validated: scoring and public evidence use enabled sources only');
