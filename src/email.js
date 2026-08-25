import { safeJsonParse } from './utils.js';
import { isStoredAIUsable } from './ai.js';
import { currentSourcePredicate } from './source-health.js';
import { connect } from 'cloudflare:sockets';

function esc(s='') { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

export async function buildDigest(env) {
  const { results = [] } = await env.DB.prepare(`
    SELECT topics.*,
           (SELECT GROUP_CONCAT(DISTINCT ts.source_id)
              FROM topic_sources ts
              JOIN sources active_source ON active_source.id = ts.source_id
               AND ${currentSourcePredicate('active_source')}
             WHERE ts.topic_id = topics.id
               AND julianday(ts.captured_at) >= julianday('now','-2 hours')) AS evidence_sources,
           (SELECT GROUP_CONCAT(
                    ts.source_id || ' · heat=' || COALESCE(CAST(r.heat AS TEXT), 'NULL')
                    || ' · engagement=' || COALESCE(CAST(r.engagement AS TEXT), 'NULL')
                    || ' · fields=' || COALESCE(json_extract(r.raw_json, '$.trendRadarMetrics.heat_path'), 'NULL')
                    || '/' || COALESCE(json_extract(r.raw_json, '$.trendRadarMetrics.engagement_path'), 'NULL')
                    || ' · upstream=' || COALESCE(json_extract(r.raw_json, '$.trendRadarUpstream'), 'NULL'), '；')
               FROM topic_sources ts
               JOIN sources active_source ON active_source.id = ts.source_id
                AND ${currentSourcePredicate('active_source')}
               LEFT JOIN raw_items r ON r.source_id=ts.source_id
                AND r.external_id=ts.external_id AND r.captured_at=ts.captured_at
              WHERE ts.topic_id = topics.id
                AND julianday(ts.captured_at) >= julianday('now','-2 hours')) AS evidence_detail
      FROM topics
     WHERE julianday(last_seen_at) >= julianday('now','-2 hours')
       AND (SELECT COUNT(DISTINCT ts_current.source_id)
              FROM topic_sources ts_current
              JOIN sources current_source ON current_source.id = ts_current.source_id
               AND ${currentSourcePredicate('current_source')}
             WHERE ts_current.topic_id = topics.id
               AND julianday(ts_current.captured_at) >= julianday('now','-2 hours')) >= MAX(1, topics.source_count)
     ORDER BY breakout_score DESC,current_score DESC LIMIT 12
  `).all();
  const date = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const rows = results.map((t, i) => {
    const aiValid = isStoredAIUsable({ ...t, raw_evidence_text: t.evidence_detail || '' }, Number(env.AI_REFRESH_HOURS || 6));
    const opportunities = aiValid ? safeJsonParse(t.ai_opportunities_json, []) || [] : [];
    const analysis = aiValid ? esc(t.ai_summary) : '<span style="color:#9ca3af">暂无已验证 AI 分析；请查看原始来源证据</span>';
    return `<div style="padding:18px 0;border-bottom:1px solid #e5e7eb"><div style="font-size:12px;color:#6b7280">#${i+1} · ${esc(t.category)} · 趋势指数 ${Math.round(t.current_score)}（派生指标） · Breakout ${Math.round(t.breakout_score)}</div><h2 style="font-size:18px;margin:6px 0">${esc(t.canonical_title)}</h2><p style="font-size:12px;color:#6b7280;margin:6px 0">证据来源：${esc(t.evidence_sources || '未记录')}</p><p style="font-size:11px;color:#6b7280;margin:6px 0;word-break:break-word">原始证据：${esc(t.evidence_detail || '未记录')}（NULL 表示上游未提供该指标）</p><p style="margin:6px 0;color:#374151">${analysis}</p>${opportunities[0] ? `<p style="margin:8px 0"><b>机会：</b>${esc(opportunities[0].idea)}</p>` : ''}</div>`;
  }).join('');
  const freshnessNote = results.length
    ? '本邮件只收录最近 2 小时内仍有采集记录的主题；趋势指数是派生指标，不是平台原始热度。'
    : '过去 2 小时没有可验证的新鲜主题，未使用旧数据冒充今日实时热点。请稍后查看数据源恢复情况。';
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:680px;margin:auto;padding:24px"><h1 style="margin-bottom:4px">Trend Radar</h1><div style="color:#6b7280">${esc(date)} · 每日趋势摘要</div><p style="font-size:13px;color:#6b7280">${esc(freshnessNote)}</p>${rows || '<p style="padding:24px 0;color:#6b7280">暂无满足新鲜度门槛的真实趋势。</p>'}<p style="font-size:12px;color:#9ca3af;margin-top:24px">趋势与机会分析仅用于信息发现，不构成投资或收益保证。</p></div>`;
  return { date, subject: `Trend Radar · ${date} 今日趋势`, html };
}

function base64(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function encodeHeader(value) {
  return `=?UTF-8?B?${base64(value)}?=`;
}

function normalizeCrlf(value) {
  return String(value).replace(/\r?\n/g, '\r\n');
}

function dotStuff(value) {
  return normalizeCrlf(value).replace(/^\./gm, '..');
}

function formatAddress(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(.+?)\s*<([^<>\s]+)>$/);
  if (!match) return `<${text}>`;
  return `${encodeHeader(match[1].trim())} <${match[2]}>`;
}

function createLineReader(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async response() {
      let code = null;
      const lines = [];
      while (true) {
        const newline = buffer.indexOf('\r\n');
        if (newline < 0) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('SMTP connection closed before response completed');
          buffer += decoder.decode(chunk.value, { stream: true });
          continue;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        lines.push(line);
        const match = line.match(/^(\d{3})([ -])/);
        if (match) {
          code = Number(match[1]);
          if (match[2] === ' ') break;
        }
      }
      if (!code || code >= 400) throw new Error(`SMTP ${code || 'invalid'}: ${lines.join(' | ')}`);
      return { code, lines };
    }
  };
}

async function sendSmtp(env, to, subject, html) {
  const username = String(env.SMTP_USER || '').trim();
  const password = String(env.SMTP_PASSWORD || '');
  const host = String(env.SMTP_HOST || 'smtp.exmail.qq.com').trim();
  const port = Number(env.SMTP_PORT || 465);
  const from = String(env.EMAIL_FROM || username).trim();
  if (!username || !password || !from) throw new Error('SMTP_USER / SMTP_PASSWORD / EMAIL_FROM not configured');
  if (port !== 465) throw new Error(`unsupported SMTP_PORT ${port}; QQ enterprise SMTP uses implicit TLS on 465`);

  const socket = connect({ hostname: host, port }, { secureTransport: 'on' });
  await socket.opened;
  const reader = createLineReader(socket.readable);
  const writer = socket.writable.getWriter();
  const encoder = new TextEncoder();
  const command = async (value) => {
    await writer.write(encoder.encode(`${value}\r\n`));
    return reader.response();
  };
  try {
    await reader.response();
    await command(`EHLO trend-radar`);
    await command('AUTH LOGIN');
    await command(base64(username));
    await command(base64(password));
    await command(`MAIL FROM:${formatAddress(username)}`);
    await command(`RCPT TO:<${String(to).trim()}>`);
    await command('DATA');
    const message = [
      `From: ${formatAddress(from)}`,
      `To: <${String(to).trim()}>`,
      `Subject: ${encodeHeader(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      dotStuff(html),
      ''
    ].join('\r\n');
    await writer.write(encoder.encode(`${message}.\r\n`));
    await reader.response();
    await command('QUIT');
  } finally {
    writer.releaseLock();
    await socket.close();
  }
}

export async function sendDailyDigest(env) {
  const digest = await buildDigest(env);
  await env.DB.prepare(`INSERT OR REPLACE INTO digests(digest_date,subject,html,created_at,sent_count,error_count) VALUES(?,?,?,?,0,0)`)
    .bind(digest.date,digest.subject,digest.html,new Date().toISOString()).run();
  const { results = [] } = await env.DB.prepare(`SELECT email FROM subscribers WHERE active=1`).all();
  let sent=0, errors=0;
  for (const s of results) {
    try { await sendSmtp(env, s.email, digest.subject, digest.html); sent++; }
    catch (e) { console.error('email failed', s.email, e); errors++; }
  }
  await env.DB.prepare(`UPDATE digests SET sent_count=?,error_count=? WHERE digest_date=?`).bind(sent,errors,digest.date).run();
  return { sent, errors };
}
