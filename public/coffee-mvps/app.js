const $ = (q, root=document) => root.querySelector(q);
const $$ = (q, root=document) => [...root.querySelectorAll(q)];
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const store={get(k,d){try{return JSON.parse(localStorage.getItem(k))??d}catch{return d}},set(k,v){localStorage.setItem(k,JSON.stringify(v))}};

const APPS = [
  ['01-flavor-atlas','Flavor Atlas','Explore the coffee flavor wheel as a living map.'],
  ['02-flavor-game','Flavor Game','Fast sensory vocabulary drills with scoring.'],
  ['03-brew-pilot','Brew Pilot','A turn-by-turn navigator for hand brewing.'],
  ['04-brew-simulator','Brew Simulator','See how brew variables may shift the cup.'],
  ['05-recipe-matcher','Recipe Matcher','Describe the cup you want; get a starting recipe.'],
  ['06-recipe-github','Recipe GitHub','Star, fork and remix brew recipes.'],
  ['07-recipe-diff','Recipe Diff','Compare two brews variable by variable.'],
  ['08-coffee-genome','Coffee Genome','Encode bean + process + recipe + taste as a fingerprint.'],
  ['09-taste-memory','Taste Memory','Build a personal archive of cups and descriptors.'],
  ['10-blind-cupping','Blind Cupping','Collect ratings first, reveal consensus later.'],
  ['11-barista-training','Barista Training','Five-minute coffee drills with a local streak.'],
  ['12-extraction-doctor','Extraction Doctor','Diagnose a cup and change one variable at a time.'],
  ['13-experiment-lab','Experiment Lab','Generate controlled A/B brewing experiments.'],
  ['14-flavor-galaxy','Flavor Galaxy','Fly through a playful map of flavor families.'],
  ['15-brew-replay','Brew Replay','Record a pour curve and chase your ghost brew.'],
];

const FLAVORS = {
  Floral:['Jasmine','Rose','Chamomile','Black Tea'],
  Fruity:['Blueberry','Strawberry','Peach','Apricot','Grapefruit','Orange','Lemon','Lime'],
  Sweet:['Honey','Brown Sugar','Vanilla','Caramel'],
  Nutty:['Almond','Hazelnut','Peanut','Cocoa'],
  Spice:['Cinnamon','Clove','Nutmeg','Pepper'],
  Green:['Fresh Herb','Pea Pod','Vegetal','Olive Oil'],
  Roasted:['Malt','Grain','Brown Roast','Smoky'],
  Fermented:['Winey','Fermented','Overripe','Whiskey']
};

const shell=(title,kicker,body)=>`
  <header class="topbar"><a class="brand" href="../">COFFEE LAB <span>MVP</span></a><a class="back" href="../">All experiments</a></header>
  <main class="page"><section class="hero"><p class="eyebrow">${kicker}</p><h1>${title}</h1></section>${body}</main>
  <footer>Built as a functional MVP · data stays in this browser unless stated otherwise.</footer>`;

function hub(){
  document.body.classList.add('hub');
  return `<header class="topbar"><div class="brand">COFFEE LAB <span>15 MVPs</span></div><div class="status"><i></i> live prototype collection</div></header>
  <main class="hub-page"><section class="hub-hero"><p class="eyebrow">Taste × Brew × Experiment</p><h1>Fifteen tiny coffee apps,<br><em>each useful on its own.</em></h1><p>Open one, use it, break it, then keep the ideas that actually improve a cup.</p></section>
  <section class="app-grid">${APPS.map((a,i)=>`<a class="app-card" href="./${a[0]}/"><span class="num">${String(i+1).padStart(2,'0')}</span><h2>${a[1]}</h2><p>${a[2]}</p><b>Open MVP →</b></a>`).join('')}</section></main>`;
}

function flavorAtlas(){
  const familyCards=Object.entries(FLAVORS).map(([k,v])=>`<button class="family" data-family="${k}"><span>${k}</span><small>${v.slice(0,3).join(' · ')}</small></button>`).join('');
  const body=`<section class="atlas-layout"><div class="wheel">${familyCards}<div class="wheel-core"><b>COFFEE</b><small>tap a family</small></div></div><aside class="panel detail" id="detail"><p class="muted">Choose a family to open its descriptors.</p></aside></section>`;
  setTimeout(()=>{$$('.family').forEach(b=>{b.onclick=()=>{const f=b.dataset.family; const vals=FLAVORS[f]; $('#detail').innerHTML=`<span class="pill">${f}</span><h2>${vals[0]} → ${vals.at(-1)}</h2><p>Use these words as anchors, not as a test you have to “pass”. Smell or taste a real reference, then compare it with the cup.</p><div class="chips">${vals.map(x=>`<button class="chip flavor-chip">${x}</button>`).join('')}</div><div class="callout" id="atlas-note">Pick one descriptor you genuinely perceive.</div>`; $$('.flavor-chip').forEach(c=>{c.onclick=()=>{$('#atlas-note').innerHTML=`Logged for this cup: <b>${c.textContent}</b>. Now ask: intensity, clarity, and aftertaste?`;}});};});},0);
  return shell('Coffee Flavor Atlas','01 · Sensory map',body);
}

function flavorGame(){
  const pool=Object.values(FLAVORS).flat(); let score=0,round=0,answer='';
  const body=`<section class="center-card panel"><div class="score-row"><span>Score <b id="score">0</b></span><span>Round <b id="round">0</b>/8</span></div><p class="eyebrow">Which descriptor belongs in this family?</p><h2 id="question">Press start</h2><div class="quiz-options" id="options"></div><button class="primary" id="next">Start training</button><p id="feedback" class="muted"></p></section>`;
  setTimeout(()=>{const next=()=>{if(round>=8){$('#question').textContent='Session complete';$('#options').innerHTML='';$('#next').textContent='Play again';round=0;return;} round++; const fam=Object.keys(FLAVORS)[Math.floor(Math.random()*Object.keys(FLAVORS).length)]; answer=FLAVORS[fam][Math.floor(Math.random()*FLAVORS[fam].length)]; const wrong=pool.filter(x=>!FLAVORS[fam].includes(x)).sort(()=>Math.random()-.5).slice(0,3); const opts=[answer,...wrong].sort(()=>Math.random()-.5); $('#question').textContent=fam; $('#round').textContent=round; $('#feedback').textContent=''; $('#options').innerHTML=opts.map(o=>`<button>${o}</button>`).join(''); $$('#options button').forEach(b=>b.onclick=()=>{const ok=b.textContent===answer; if(ok){score++;$('#score').textContent=score;b.classList.add('correct');$('#feedback').textContent='Correct — lock that association in.'}else{b.classList.add('wrong');$('#feedback').textContent=`Not this time. Answer: ${answer}`}; $$('#options button').forEach(x=>x.disabled=true);}); $('#next').textContent='Next';}; $('#next').onclick=next;},0);
  return shell('Flavor Game','02 · Daily drill',body);
}

function brewPilot(){
  const steps=[{t:0,w:45,label:'Bloom to 45g'},{t:40,w:120,label:'Pour to 120g'},{t:75,w:190,label:'Pour to 190g'},{t:110,w:240,label:'Final pour to 240g'},{t:150,w:240,label:'Drawdown · finish'}];
  const body=`<section class="pilot panel"><div class="timer" id="timer">00:00</div><div class="target"><small>NOW</small><strong id="target">Ready</strong><span id="water">15g coffee · 240g water · 93°C</span></div><div class="timeline" id="timeline">${steps.map((s,i)=>`<div data-i="${i}"><b>${String(s.t).padStart(2,'0')}s</b><span>${s.label}</span></div>`).join('')}</div><div class="actions"><button class="primary" id="pilot-start">Start brew</button><button id="pilot-reset">Reset</button></div></section>`;
  setTimeout(()=>{let start=null,iv=null; const render=(sec)=>{const s=[...steps].reverse().find(x=>sec>=x.t)||steps[0]; $('#timer').textContent=`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`; $('#target').textContent=s.label; $('#water').textContent=s.w?`Scale target ${s.w}g`:'Ready'; $$('#timeline>div').forEach((d,i)=>d.classList.toggle('active',sec>=steps[i].t && (i===steps.length-1||sec<steps[i+1].t)));}; $('#pilot-start').onclick=()=>{if(iv)return;start=Date.now();render(0);iv=setInterval(()=>{const sec=Math.floor((Date.now()-start)/1000);render(sec);if(sec>175){clearInterval(iv);iv=null;$('#target').textContent='Brew complete';}},250)}; $('#pilot-reset').onclick=()=>{clearInterval(iv);iv=null;render(0);$('#target').textContent='Ready';$('#water').textContent='15g coffee · 240g water · 93°C';};},0);
  return shell('Brew Pilot','03 · Turn-by-turn brewing',body);
}

function brewSimulator(){
  const body=`<section class="split"><div class="panel controls"><label>Water temperature <output id="temp-o">92°C</output><input id="temp" type="range" min="84" max="98" value="92"></label><label>Grind <output id="grind-o">50</output><input id="grind" type="range" min="0" max="100" value="50"></label><label>Ratio (water ÷ coffee) <output id="ratio-o">16.0</output><input id="ratio" type="range" min="12" max="20" step="0.5" value="16"></label><label>Agitation <output id="agit-o">40</output><input id="agit" type="range" min="0" max="100" value="40"></label><p class="fineprint">Heuristic model for learning directionality — not a physical extraction prediction.</p></div><div class="panel"><h2>Predicted direction</h2><div id="bars" class="bars"></div><div class="callout" id="sim-note"></div></div></section>`;
  setTimeout(()=>{const render=()=>{const t=+$('#temp').value,g=+$('#grind').value,r=+$('#ratio').value,a=+$('#agit').value; $('#temp-o').textContent=t+'°C';$('#grind-o').textContent=g<35?'fine':g>65?'coarse':'medium';$('#ratio-o').textContent=r.toFixed(1);$('#agit-o').textContent=a<35?'low':a>65?'high':'medium'; const extraction=clamp(50+(t-92)*3+(50-g)*.35+(r-16)*4+(a-40)*.18,5,95); const clarity=clamp(72+(g-50)*.18-(a-40)*.25-(r-16)*2,5,95); const body=clamp(62-(r-16)*5-(g-50)*.15,5,95); const sweet=clamp(100-Math.abs(extraction-62)*1.5,10,95); const vals={Extraction:extraction,Sweetness:sweet,Clarity:clarity,Body:body}; $('#bars').innerHTML=Object.entries(vals).map(([k,v])=>`<div><span>${k}</span><i><b style="width:${v}%"></b></i><em>${Math.round(v)}</em></div>`).join(''); $('#sim-note').textContent=extraction<45?'Likely under-extracted direction: consider finer / hotter / more contact.':extraction>78?'Likely over-extracted direction: consider coarser / cooler / less agitation.':'Balanced extraction zone to taste and verify.';}; $$('input[type=range]').forEach(x=>x.oninput=render);render();},0);
  return shell('Brew Simulator','04 · Variable sandbox',body);
}

function recipeMatcher(){
  const body=`<section class="split"><div class="panel"><h2>What cup do you want?</h2><div class="toggle-list"><label><input type="checkbox" value="floral"> Floral & aromatic</label><label><input type="checkbox" value="sweet"> Sweet & round</label><label><input type="checkbox" value="bright"> Bright acidity</label><label><input type="checkbox" value="body"> More body</label><label><input type="checkbox" value="clean"> Clean finish</label></div><button class="primary" id="match">Build starting recipe</button></div><div class="panel recipe" id="recipe"><p class="muted">Choose 2–3 goals. The MVP returns a sensible starting point, not a guarantee.</p></div></section>`;
  setTimeout(()=>{$('#match').onclick=()=>{const picks=$$('.toggle-list input:checked').map(x=>x.value); let temp=92,ratio=16,grind='medium',pours=3,bloom=45; if(picks.includes('floral')){temp=91;grind='medium-coarse'} if(picks.includes('sweet')){temp=93;bloom=50} if(picks.includes('bright')){ratio=16.5;temp=91} if(picks.includes('body')){ratio=15;grind='medium-fine';pours=2} if(picks.includes('clean')){ratio=17;grind='coarse';pours=4} const coffee=15,water=Math.round(coffee*ratio); $('#recipe').innerHTML=`<span class="pill">Generated starting point</span><h2>${coffee}g → ${water}g</h2><dl><div><dt>Water</dt><dd>${temp}°C</dd></div><div><dt>Grind</dt><dd>${grind}</dd></div><div><dt>Bloom</dt><dd>${bloom}g · 40s</dd></div><div><dt>Pours</dt><dd>${pours}</dd></div></dl><div class="callout">Taste first. Next brew, change only one variable.</div>`;};},0);
  return shell('Recipe Matcher','05 · Taste → recipe',body);
}

function recipeGithub(){
  const recipes=[{id:'46',name:'4:6 Clean Cup',author:'Tetsu-inspired',stars:218,ratio:'20:300',temp:93},{id:'single',name:'Single Pour Daily',author:'Community',stars:93,ratio:'15:240',temp:92},{id:'iced',name:'Bright Flash Brew',author:'Coffee Lab',stars:141,ratio:'18:180 + ice',temp:94}];
  const body=`<section><div class="repo-toolbar"><input id="repo-search" placeholder="Search recipes"><button id="new-fork">My forks <span id="fork-count">0</span></button></div><div class="repo-list" id="repo-list"></div></section>`;
  setTimeout(()=>{const saved=store.get('coffee-forks',[]); const render=()=>{const q=$('#repo-search').value.toLowerCase(); $('#fork-count').textContent=saved.length; $('#repo-list').innerHTML=recipes.filter(r=>r.name.toLowerCase().includes(q)).map(r=>`<article class="repo-card panel"><div><span class="pill">recipe/${r.id}</span><h2>${r.name}</h2><p>${r.author} · ${r.ratio} · ${r.temp}°C</p></div><div class="repo-actions"><button data-star="${r.id}">☆ ${r.stars+(store.get('stars',[]).includes(r.id)?1:0)}</button><button data-fork="${r.id}">Fork</button></div></article>`).join(''); $$('[data-star]').forEach(b=>b.onclick=()=>{let s=store.get('stars',[]); const id=b.dataset.star;s=s.includes(id)?s.filter(x=>x!==id):[...s,id];store.set('stars',s);render();}); $$('[data-fork]').forEach(b=>b.onclick=()=>{const id=b.dataset.fork;if(!saved.includes(id)){saved.push(id);store.set('coffee-forks',saved);render();}})}; $('#repo-search').oninput=render;render();},0);
  return shell('Recipe GitHub','06 · Forkable brewing',body);
}

function recipeDiff(){
  const fields=[['temp','Temperature','°C',92,94],['grind','Grind setting','',24,26],['bloom','Bloom','g',45,50],['water','Total water','g',240,250],['time','Brew time','s',150,165]];
  const inputs=(side)=>fields.map(f=>`<label>${f[1]}<input type="number" data-side="${side}" data-key="${f[0]}" value="${side==='a'?f[3]:f[4]}"><span>${f[2]}</span></label>`).join('');
  const body=`<section class="diff-grid"><div class="panel"><span class="pill">A · baseline</span>${inputs('a')}</div><div class="panel"><span class="pill">B · candidate</span>${inputs('b')}</div><div class="panel diff-out"><h2>Diff</h2><div id="diff"></div></div></section>`;
  setTimeout(()=>{const render=()=>{$('#diff').innerHTML=fields.map(f=>{const a=+$(`[data-side=a][data-key=${f[0]}]`).value,b=+$(`[data-side=b][data-key=${f[0]}]`).value,d=b-a;return `<div><span>${f[1]}</span><b class="${d>0?'plus':d<0?'minus':''}">${d>0?'+':''}${d}${f[2]}</b></div>`}).join('')}; $$('input[type=number]').forEach(x=>x.oninput=render);render();},0);
  return shell('Recipe Diff','07 · Brew comparison',body);
}

function coffeeGenome(){
  const body=`<section class="split"><div class="panel controls"><label>Origin<select id="origin"><option>Ethiopia · Guji</option><option>Colombia · Huila</option><option>Kenya · Nyeri</option><option>Panama · Boquete</option></select></label><label>Process<select id="process"><option>Washed</option><option>Natural</option><option>Honey</option><option>Anaerobic</option></select></label><label>Roast<select id="roast"><option>Light</option><option>Light-medium</option><option>Medium</option></select></label><p>Flavor tags</p><div class="chips" id="genome-flavors">${['Jasmine','Peach','Citrus','Berry','Caramel','Cocoa','Black Tea'].map(x=>`<button class="chip">${x}</button>`).join('')}</div><button class="primary" id="encode">Encode genome</button></div><div class="panel genome" id="genome"><p class="muted">Build a compact fingerprint for this cup.</p></div></section>`;
  setTimeout(()=>{$$('#genome-flavors .chip').forEach(b=>b.onclick=()=>b.classList.toggle('selected')); $('#encode').onclick=()=>{const tags=$$('#genome-flavors .selected').map(x=>x.textContent); const str=`${$('#origin').value}|${$('#process').value}|${$('#roast').value}|${tags.join(',')}`; let h=0;for(const c of str)h=(h*31+c.charCodeAt(0))>>>0; const hex=h.toString(16).padStart(8,'0').toUpperCase(); $('#genome').innerHTML=`<span class="pill">COFFEE GENOME</span><div class="dna">${hex.slice(0,4)} · ${hex.slice(4)}</div><h2>${$('#origin').value}</h2><p>${$('#process').value} · ${$('#roast').value}</p><div class="chips">${tags.map(t=>`<span class="chip selected">${t}</span>`).join('')||'<span class="muted">No flavor tags selected</span>'}</div>`;};},0);
  return shell('Coffee Genome','08 · Cup fingerprint',body);
}

function tasteMemory(){
  const body=`<section class="split"><div class="panel"><h2>Save this cup</h2><label>Coffee<input id="mem-name" placeholder="Ethiopia Guji"></label><label>Descriptors<input id="mem-tags" placeholder="jasmine, peach, tea"></label><label>Score<input id="mem-score" type="range" min="1" max="10" value="7"></label><button class="primary" id="mem-save">Add memory</button></div><div><div class="memory-summary panel" id="mem-summary"></div><div class="memory-list" id="mem-list"></div></div></section>`;
  setTimeout(()=>{const render=()=>{const m=store.get('taste-memory',[]); const counts={};m.flatMap(x=>x.tags).forEach(t=>counts[t]=(counts[t]||0)+1); const top=Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,5); $('#mem-summary').innerHTML=`<span class="pill">${m.length} cups remembered</span><h2>Your recurring words</h2><div class="chips">${top.map(([t,c])=>`<span class="chip">${t} ×${c}</span>`).join('')||'<span class="muted">Start with one honest cup.</span>'}</div>`; $('#mem-list').innerHTML=m.slice().reverse().map(x=>`<article class="panel memory"><b>${x.name}</b><span>${x.score}/10</span><p>${x.tags.join(' · ')}</p></article>`).join('');}; $('#mem-save').onclick=()=>{const name=$('#mem-name').value.trim();if(!name)return;const m=store.get('taste-memory',[]);m.push({name,score:+$('#mem-score').value,tags:$('#mem-tags').value.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean),date:Date.now()});store.set('taste-memory',m);$('#mem-name').value='';$('#mem-tags').value='';render();};render();},0);
  return shell('Taste Memory','09 · Personal cup archive',body);
}

function blindCupping(){
  const body=`<section class="split"><div class="panel"><span class="pill">ROOM · LOCAL DEMO</span><h2>Submit a blind score</h2><label>Cup code<input id="cup-code" value="A"></label><label>Acidity <output id="acid-o">6</output><input id="acid" type="range" min="1" max="10" value="6"></label><label>Sweetness <output id="sweet-o">7</output><input id="sweet" type="range" min="1" max="10" value="7"></label><label>Body <output id="body-o">5</output><input id="body" type="range" min="1" max="10" value="5"></label><button class="primary" id="submit-cup">Submit anonymously</button></div><div class="panel" id="reveal"><h2>Consensus is hidden</h2><p>Collect a few scores, then reveal them together.</p><button id="reveal-btn">Reveal group</button></div></section>`;
  setTimeout(()=>{['acid','sweet','body'].forEach(id=>$(`#${id}`).oninput=e=>$(`#${id}-o`).textContent=e.target.value); $('#submit-cup').onclick=()=>{const rows=store.get('cupping-room',[]);rows.push({cup:$('#cup-code').value,acid:+$('#acid').value,sweet:+$('#sweet').value,body:+$('#body').value});store.set('cupping-room',rows);$('#reveal').innerHTML=`<h2>${rows.length} score${rows.length===1?'':'s'} locked</h2><p>No consensus shown yet.</p><button id="reveal-btn">Reveal group</button>`;$('#reveal-btn').onclick=reveal;}; const reveal=()=>{const rows=store.get('cupping-room',[]);if(!rows.length)return; const avg=k=>(rows.reduce((s,x)=>s+x[k],0)/rows.length).toFixed(1);$('#reveal').innerHTML=`<span class="pill">REVEALED · ${rows.length} entries</span><h2>Cup ${rows.at(-1).cup}</h2><div class="big-metrics"><div><b>${avg('acid')}</b><span>Acidity</span></div><div><b>${avg('sweet')}</b><span>Sweetness</span></div><div><b>${avg('body')}</b><span>Body</span></div></div><button id="clear-room">Clear room</button>`;$('#clear-room').onclick=()=>{store.set('cupping-room',[]);location.reload()};}; $('#reveal-btn').onclick=reveal;},0);
  return shell('Blind Cupping','10 · Group tasting room',body);
}

function baristaTraining(){
  const qs=[['A cup is sour, thin and fast. First adjustment?',['Grind finer','Grind coarser','Cool water','Use less coffee'],0],['Which change usually increases extraction?',['Lower temperature','Coarser grind','More contact time','Less agitation'],2],['Why change one variable at a time?',['Looks professional','Makes cause/effect easier to learn','Always tastes better','Uses less coffee'],1],['A “clean” cup usually means…',['No acidity','Distinct flavors with less muddiness','Very dark roast','High body only'],1],['Bloom mainly helps…',['Degas fresh coffee and wet grounds','Cool the brewer','Add bitterness','Measure roast color'],0]]; let i=0,score=0;
  const body=`<section class="center-card panel"><div class="score-row"><span>5-minute drill</span><span>Streak <b id="streak">${store.get('barista-streak',0)}</b></span></div><p class="eyebrow">Question <span id="qnum">1</span>/5</p><h2 id="train-q"></h2><div class="quiz-options" id="train-options"></div><p id="train-feedback" class="muted"></p></section>`;
  setTimeout(()=>{const show=()=>{if(i>=qs.length){const s=store.get('barista-streak',0)+1;store.set('barista-streak',s);$('#train-q').textContent=`${score}/5 complete`;$('#train-options').innerHTML=`<button onclick="location.reload()">Train again</button>`;$('#train-feedback').textContent=`Local streak advanced to ${s}.`;$('#streak').textContent=s;return;} const q=qs[i];$('#qnum').textContent=i+1;$('#train-q').textContent=q[0];$('#train-options').innerHTML=q[1].map((x,n)=>`<button data-n="${n}">${x}</button>`).join('');$$('#train-options button').forEach(b=>b.onclick=()=>{const ok=+b.dataset.n===q[2];if(ok)score++;$('#train-feedback').textContent=ok?'Correct.':'Better answer: '+q[1][q[2]];i++;setTimeout(show,650)});};show();},0);
  return shell('Barista Training','11 · Micro-lessons',body);
}

function extractionDoctor(){
  const symptoms=[['sour','Sour / sharp'],['thin','Thin body'],['bitter','Bitter'],['dry','Dry / astringent'],['flat','Flat / muted'],['fast','Brew ran fast'],['slow','Brew ran slow']];
  const body=`<section class="split"><div class="panel"><h2>What did the cup do?</h2><div class="toggle-list">${symptoms.map(s=>`<label><input type="checkbox" value="${s[0]}">${s[1]}</label>`).join('')}</div><button class="primary" id="diagnose">Diagnose one next move</button></div><div class="panel doctor" id="diagnosis"><p class="muted">Select the symptoms you actually experienced.</p></div></section>`;
  setTimeout(()=>{$('#diagnose').onclick=()=>{const s=$$('.toggle-list input:checked').map(x=>x.value); let title='Keep the recipe',move='Taste again before changing anything.',why='The selected signals are not strong enough for a confident directional diagnosis.'; if((s.includes('sour')||s.includes('thin'))&&(s.includes('fast')||!s.includes('bitter'))){title='Move slightly finer';move='Grind 1–2 small steps finer. Keep everything else fixed.';why='Sour/thin + fast often points toward low extraction.'} if((s.includes('bitter')||s.includes('dry'))&&(s.includes('slow')||!s.includes('sour'))){title='Move slightly coarser';move='Grind 1–2 small steps coarser. Keep temperature and ratio unchanged.';why='Bitter/dry + slow often points toward too much extraction or uneven flow.'} if(s.includes('flat')&&!s.includes('bitter')&&!s.includes('sour')){title='Raise temperature a little';move='Try +1–2°C next brew, with the same grind.';why='Muted aromatics can sometimes open up with slightly more extraction energy.'} $('#diagnosis').innerHTML=`<span class="pill">ONE VARIABLE ONLY</span><h2>${title}</h2><p>${move}</p><div class="callout">${why}</div>`;};},0);
  return shell('Extraction Doctor','12 · One-change diagnosis',body);
}

function experimentLab(){
  const body=`<section class="split"><div class="panel"><h2>Design an A/B brew</h2><label>Variable<select id="exp-var"><option value="grind">Grind</option><option value="temp">Temperature</option><option value="ratio">Ratio</option><option value="agitation">Agitation</option></select></label><label>Baseline<input id="exp-base" value="24 clicks"></label><label>Change size<select id="exp-size"><option>small</option><option>medium</option><option>large</option></select></label><button class="primary" id="make-exp">Generate experiment</button></div><div class="panel" id="experiment"><p class="muted">The app will hold every other variable constant.</p></div></section>`;
  setTimeout(()=>{$('#make-exp').onclick=()=>{const v=$('#exp-var').value,base=$('#exp-base').value,size=$('#exp-size').value; const changes={grind:{small:'1 click finer',medium:'2 clicks finer',large:'4 clicks finer'},temp:{small:'+1°C',medium:'+2°C',large:'+4°C'},ratio:{small:'+0.5 water ratio',medium:'+1.0 water ratio',large:'+2.0 water ratio'},agitation:{small:'one gentle swirl',medium:'two swirls',large:'strong agitation'}}; $('#experiment').innerHTML=`<span class="pill">CONTROLLED A/B</span><h2>Only change ${v}</h2><div class="ab"><div><small>CUP A</small><b>${base}</b><span>baseline</span></div><div><small>CUP B</small><b>${changes[v][size]}</b><span>candidate</span></div></div><div class="callout">Keep coffee dose, water, brewer, pouring pattern and tasting temperature as consistent as possible.</div>`;};},0);
  return shell('Experiment Lab','13 · Controlled learning',body);
}

function flavorGalaxy(){
  const body=`<section class="galaxy-wrap panel"><canvas id="galaxy"></canvas><div class="galaxy-copy"><span class="pill">DRAG · EXPLORE</span><h2 id="galaxy-title">Coffee Universe</h2><p id="galaxy-desc">Tap a star to open its flavor family.</p></div></section>`;
  setTimeout(()=>{const c=$('#galaxy'),ctx=c.getContext('2d'); let stars=[],drag=false,ox=0,oy=0,offx=0,offy=0; const colors=['#d66f8d','#c94545','#d49b31','#8b6d4f','#7ca45c','#365f4d','#8b674a','#80506d']; function size(){const r=c.getBoundingClientRect();c.width=r.width*devicePixelRatio;c.height=r.height*devicePixelRatio;ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);make();draw()} function make(){const w=c.clientWidth,h=c.clientHeight;stars=Object.entries(FLAVORS).flatMap(([fam,vals],fi)=>vals.map((name,j)=>{const a=(fi/Object.keys(FLAVORS).length)*Math.PI*2 + j*.08,rad=75+fi%3*55+j*8;return {fam,name,x:w/2+Math.cos(a)*rad,y:h/2+Math.sin(a)*rad,r:4+(j%3),color:colors[fi]}}));} function draw(){const w=c.clientWidth,h=c.clientHeight;ctx.clearRect(0,0,w,h);ctx.fillStyle='#0c1711';ctx.fillRect(0,0,w,h);ctx.globalAlpha=.18;ctx.strokeStyle='#fff';stars.forEach(s=>{ctx.beginPath();ctx.moveTo(w/2+offx,h/2+offy);ctx.lineTo(s.x+offx,s.y+offy);ctx.stroke()});ctx.globalAlpha=1;stars.forEach(s=>{ctx.beginPath();ctx.fillStyle=s.color;ctx.arc(s.x+offx,s.y+offy,s.r,0,Math.PI*2);ctx.fill()});ctx.fillStyle='#f7f1e6';ctx.font='600 13px system-ui';ctx.textAlign='center';Object.keys(FLAVORS).forEach((fam,fi)=>{const s=stars.find(x=>x.fam===fam); if(s)ctx.fillText(fam,s.x+offx,s.y+offy-12)});} c.onpointerdown=e=>{drag=true;ox=e.clientX-offx;oy=e.clientY-offy;c.setPointerCapture(e.pointerId)};c.onpointermove=e=>{if(drag){offx=e.clientX-ox;offy=e.clientY-oy;draw()}};c.onpointerup=e=>{drag=false;const r=c.getBoundingClientRect(),x=e.clientX-r.left-offx,y=e.clientY-r.top-offy;const s=stars.find(s=>Math.hypot(s.x-x,s.y-y)<14);if(s){$('#galaxy-title').textContent=s.name;$('#galaxy-desc').textContent=`${s.fam} family · build a sensory reference, then look for it in the cup.`}};window.addEventListener('resize',size);size();},0);
  return shell('Flavor Galaxy','14 · Spatial flavor map',body);
}

function brewReplay(){
  const body=`<section class="split"><div class="panel"><h2>Record this brew</h2><div class="timer small" id="replay-time">00:00.0</div><label>Current scale weight<input id="replay-weight" type="number" value="0"> g</label><div class="actions"><button class="primary" id="record">Start recording</button><button id="mark">Mark weight</button><button id="save-ghost">Save ghost</button></div><p class="fineprint">Tap “Mark weight” at each pour target or meaningful point.</p></div><div class="panel"><h2>Pour curve</h2><svg id="curve" viewBox="0 0 600 260" preserveAspectRatio="none"></svg><div class="callout" id="ghost-note">No live recording yet.</div></div></section>`;
  setTimeout(()=>{let start=null,iv=null,points=[]; const saved=store.get('brew-ghost',[]); const draw=()=>{const all=[...saved.map(p=>({...p,ghost:true})),...points]; const maxT=Math.max(150,...all.map(p=>p.t)),maxW=Math.max(240,...all.map(p=>p.w)); const path=(arr)=>arr.length?arr.map((p,i)=>`${i?'L':'M'} ${(p.t/maxT)*580+10} ${245-(p.w/maxW)*220}`).join(' '):''; $('#curve').innerHTML=`<path class="ghost" d="${path(saved)}"/><path class="live" d="${path(points)}"/>`;}; const tick=()=>{if(!start)return;const t=(Date.now()-start)/1000;$('#replay-time').textContent=`${String(Math.floor(t/60)).padStart(2,'0')}:${(t%60).toFixed(1).padStart(4,'0')}`}; $('#record').onclick=()=>{points=[];start=Date.now();clearInterval(iv);iv=setInterval(tick,100);$('#record').textContent='Restart recording';$('#ghost-note').textContent=saved.length?'Ghost loaded. Chase its shape, not exact perfection.':'Recording started.';draw();}; $('#mark').onclick=()=>{if(!start)return;points.push({t:(Date.now()-start)/1000,w:+$('#replay-weight').value});draw();}; $('#save-ghost').onclick=()=>{if(points.length<2)return;store.set('brew-ghost',points);$('#ghost-note').textContent='Ghost saved. Reload or start a new recording to chase it.';};draw();},0);
  return shell('Brew Replay','15 · Ghost brew',body);
}

const renderers={
  hub, '01-flavor-atlas':flavorAtlas,'02-flavor-game':flavorGame,'03-brew-pilot':brewPilot,'04-brew-simulator':brewSimulator,'05-recipe-matcher':recipeMatcher,'06-recipe-github':recipeGithub,'07-recipe-diff':recipeDiff,'08-coffee-genome':coffeeGenome,'09-taste-memory':tasteMemory,'10-blind-cupping':blindCupping,'11-barista-training':baristaTraining,'12-extraction-doctor':extractionDoctor,'13-experiment-lab':experimentLab,'14-flavor-galaxy':flavorGalaxy,'15-brew-replay':brewReplay
};
const key=document.body.dataset.app||'hub';
document.getElementById('app').innerHTML=(renderers[key]||hub)();
