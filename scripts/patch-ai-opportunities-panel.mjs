import { readFile, writeFile } from 'node:fs/promises';

const path = new URL('../public/index.html', import.meta.url);
let html = await readFile(path, 'utf8');

if (html.includes('id="ai-opportunities-panel"')) {
  console.log('AI opportunities panel already exists');
  process.exit(0);
}

const marker = '<main>';
if (!html.includes(marker)) throw new Error('cannot find page main container');

const panel = `
<section id="ai-opportunities-panel" class="panel">
  <h2>🔥 今日 AI 机会分析</h2>
  <div id="ai-opportunities-content">加载中...</div>
</section>
<script>
(async()=>{
 try{
  const r=await fetch('data/opportunities.json',{cache:'no-store'});
  if(!r.ok) throw new Error('HTTP '+r.status);
  const d=await r.json();
  const box=document.getElementById('ai-opportunities-content');
  if(d.status!=='healthy'||!Array.isArray(d.opportunities)||!d.opportunities.length){
    box.textContent='AI 洞察暂不可用，真实趋势数据正常';
    return;
  }
  box.innerHTML=d.opportunities.slice(0,5).map(o=>
    '<div class="trend"><b>'+((o.title||o.topic||o.idea||'机会'))+'</b>'+
    '<div class="summary">为什么现在：'+(o.whyNow||o.why_now||o.rationale||'暂无')+'</div>'+
    '<div class="summary">'+(o.businessOpportunity||o.business_opportunity||o.technicalOpportunity||o.technical_opportunity||'')+'</div></div>'
  ).join('');
 }catch(e){
  document.getElementById('ai-opportunities-content').textContent='AI 洞察暂不可用，真实趋势数据正常';
 }
})();
</script>
`;

html = html.replace(marker, marker + panel);
await writeFile(path, html, 'utf8');
console.log('Injected AI opportunities panel');
