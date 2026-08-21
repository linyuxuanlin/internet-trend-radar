import { readFile } from 'node:fs/promises';

const url = process.env.OPPORTUNITIES_URL;
if (!url) throw new Error('OPPORTUNITIES_URL is required');

const response = await fetch(url, { cache: 'no-store' });
if (!response.ok) throw new Error(`opportunities HTTP ${response.status}`);

const data = await response.json();
if (!data || typeof data !== 'object') throw new Error('invalid opportunities payload');
if (data.status !== 'healthy') throw new Error(`opportunities not healthy: ${data.status}`);
if (!Array.isArray(data.opportunities) || data.opportunities.length === 0) {
  throw new Error('published opportunities are empty');
}

console.log(`Live opportunities verified: ${data.opportunities.length} items`);
