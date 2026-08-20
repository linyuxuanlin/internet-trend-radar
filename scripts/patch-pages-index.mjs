import { readFile, writeFile } from 'node:fs/promises';

const path = new URL('../public/index.html', import.meta.url);
let html = await readFile(path, 'utf8');

function replaceOnce(oldText, newText, label) {
  if (!html.includes(oldText)) throw new Error(`Pages patch failed: cannot find ${label}`);
  html = html.replace(oldText, newText);
}

replaceOnce(
  "const state={data:null,category:'全部'};",
  "const state={data:null,snapshot:null,category:'全部',staticMode:false};",
  'state declaration'
);

const oldLoad = "async function load(){try{const q=state.category==='全部'?'':'?category='+encodeURIComponent(state.category);const r=await fetch('/api/dashboard'+q);if(!r.ok)throw new Error('HTTP '+r.status);state.data=await r.json();render()}catch(e){$('#liveText').textContent='API 尚未初始化';console.error(e)}}";
const newLoad = `async function load(){
  const q=state.category==='全部'?'':'?category='+encodeURIComponent(state.category);
  try{
    const r=await fetch('/api/dashboard'+q,{cache:'no-store'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    state.staticMode=false;
    state.snapshot=null;
    state.data=await r.json();
    render();
    return;
  }catch(apiError){
    try{
      const r=await fetch('data/dashboard.json',{cache:'no-store'});
      if(!r.ok)throw new Error('snapshot HTTP '+r.status);
      const d=await r.json();
      if(d.preview!==false||d.ready!==true||!Array.isArray(d.topics)||!d.topics.length)throw new Error('snapshot is not real-data ready');
      const generatedAt=Date.parse(d.generatedAt);
      const snapshotAge=Date.now()-generatedAt;
      if(!Number.isFinite(generatedAt))throw new Error('snapshot timestamp invalid');
      if(snapshotAge < -5*60*1000)throw new Error('snapshot timestamp is in the future');
      if(snapshotAge > 3*60*60*1000)throw new Error('snapshot stale: '+Math.round(snapshotAge/60000)+' minutes old');
      state.staticMode=true;
      state.snapshot=d;
      const topics=state.category==='全部'?d.topics:d.topics.filter(t=>t.category===state.category);
      const categories=state.category==='全部'?(d.categories||[]):(d.categories||[]).filter(x=>x.category===state.category);
      state.data={...d,topics,categories};
      render();
      $('#liveText').textContent='真实快照 · '+new Date(d.generatedAt).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit'});
      return;
    }catch(snapshotError){
      $('#liveText').textContent=String(snapshotError?.message||'').includes('snapshot stale')?'真实数据快照已过期':'真实数据暂不可用';
      console.error('API failed',apiError,'snapshot failed',snapshotError);
    }
  }
}`;
replaceOnce(oldLoad, newLoad, 'load()');

const detailPattern = /async function openDetail\(id\)\{.*?\$\('#detail'\)\.showModal\(\)\}/s;
if (!detailPattern.test(html)) throw new Error('Pages patch failed: cannot find openDetail()');
html = html.replace(detailPattern, `async function openDetail(id){
  let t=null;
  if(!state.staticMode){
    try{const r=await fetch('/api/topic/'+encodeURIComponent(id));if(r.ok)t=await r.json()}catch(e){console.warn('topic API unavailable',e)}
  }
  if(!t)t=(state.snapshot?.topics||state.data?.topics||[]).find(x=>x.id===id)||null;
  if(!t)return;
  $('#dTitle').textContent=t.canonical_title;
  $('#dMeta').textContent=\`${'${t.category}'} · 热度 ${'${Math.round(t.current_score)}'} · Breakout ${'${Math.round(t.breakout_score)}'}\`;
  $('#dSummary').textContent=t.ai_summary||'该快照来自真实榜单数据；AI 解析等待后端恢复后补充';
  $('#dWhy').textContent=t.ai_why_now||'';
  $('#dOpps').innerHTML=(t.opportunities||[]).map(o=>\`<div class="trend"><b>${'${esc(o.type)}'} · ${'${esc(o.idea)}'}</b><div class="summary">${'${esc(o.rationale)}'} · 难度 ${'${esc(o.difficulty)}'} · ${'${esc(o.time_to_market)}'} · 置信 ${'${Number(o.confidence||0)}'}%</div></div>\`).join('')||'<div class="empty">真实趋势已就绪；机会分析等待 AI 后端恢复</div>';
  $('#dEvidence').innerHTML=(t.sources||[]).map(s=>\`<div><span class="chip">${'${esc(s.source_id)}'} #${'${s.rank||\'-\'}'}</span> ${'${s.url?`<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`:esc(s.title)}'}</div>\`).join('')||'<div class="empty">暂无证据</div>';
  $('#detail').showModal()
}`);

replaceOnce(
  "<p class=\"sub\">订阅每日精选趋势。MVP 先保存订阅，配置 Resend 后自动发送。</p>",
  "<p class=\"sub\">订阅每日精选趋势。Cloudflare API 可用时保存订阅；GitHub Pages 快照模式专注真实趋势浏览。</p>",
  'subscription hint'
);

await writeFile(path, html, 'utf8');
console.log('Patched public/index.html for GitHub Pages static real-data fallback with a 3-hour freshness guard.');
