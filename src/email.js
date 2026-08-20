import { safeJsonParse } from './utils.js';

function esc(s='') { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

export async function buildDigest(env) {
  const { results = [] } = await env.DB.prepare(`SELECT * FROM topics ORDER BY breakout_score DESC,current_score DESC LIMIT 12`).all();
  const date = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const rows = results.map((t, i) => {
    const opportunities = safeJsonParse(t.ai_opportunities_json, []) || [];
    return `<div style="padding:18px 0;border-bottom:1px solid #e5e7eb"><div style="font-size:12px;color:#6b7280">#${i+1} · ${esc(t.category)} · 热度 ${Math.round(t.current_score)} · Breakout ${Math.round(t.breakout_score)}</div><h2 style="font-size:18px;margin:6px 0">${esc(t.canonical_title)}</h2><p style="margin:6px 0;color:#374151">${esc(t.ai_summary || '')}</p>${opportunities[0] ? `<p style="margin:8px 0"><b>机会：</b>${esc(opportunities[0].idea)}</p>` : ''}</div>`;
  }).join('');
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:680px;margin:auto;padding:24px"><h1 style="margin-bottom:4px">Trend Radar</h1><div style="color:#6b7280">${esc(date)} · 每日趋势摘要</div>${rows}<p style="font-size:12px;color:#9ca3af;margin-top:24px">趋势与机会分析仅用于信息发现，不构成投资或收益保证。</p></div>`;
  return { date, subject: `Trend Radar · ${date} 今日趋势`, html };
}

async function sendResend(env, to, subject, html) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error('RESEND_API_KEY / EMAIL_FROM not configured');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html })
  });
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${await res.text()}`);
}

export async function sendDailyDigest(env) {
  const digest = await buildDigest(env);
  await env.DB.prepare(`INSERT OR REPLACE INTO digests(digest_date,subject,html,created_at,sent_count,error_count) VALUES(?,?,?,?,0,0)`)
    .bind(digest.date,digest.subject,digest.html,new Date().toISOString()).run();
  const { results = [] } = await env.DB.prepare(`SELECT email FROM subscribers WHERE active=1`).all();
  let sent=0, errors=0;
  for (const s of results) {
    try { await sendResend(env, s.email, digest.subject, digest.html); sent++; }
    catch (e) { console.error('email failed', s.email, e); errors++; }
  }
  await env.DB.prepare(`UPDATE digests SET sent_count=?,error_count=? WHERE digest_date=?`).bind(sent,errors,digest.date).run();
  return { sent, errors };
}
