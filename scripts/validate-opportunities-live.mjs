const url = process.env.OPPORTUNITIES_URL;
if (!url) throw new Error('OPPORTUNITIES_URL is required');

const response = await fetch(url, { cache: 'no-store' });
if (!response.ok) throw new Error(`opportunities HTTP ${response.status}`);

const data = await response.json();
if (!data || typeof data !== 'object') throw new Error('invalid opportunities payload');
if (!['healthy', 'degraded'].includes(data.status)) throw new Error(`invalid opportunities status: ${data.status}`);
if (!Array.isArray(data.opportunities)) throw new Error('published opportunities must be an array');

if (data.status === 'degraded') {
  if (data.opportunities.length !== 0) throw new Error('degraded published opportunities must be empty');
  console.log('Live opportunities verified as truthfully degraded: 0 items');
  process.exit(0);
}

if (data.opportunities.length === 0) throw new Error('healthy published opportunities are empty');
console.log(`Live opportunities verified: ${data.opportunities.length} items`);
