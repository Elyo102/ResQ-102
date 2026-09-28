'use strict';
(() => {
  const names = ['Codex', 'Grok', 'Claude', 'Gemini'];
  const $ = id => document.getElementById(id);
  let snapshot = null, filter = 'All Agents', paused = false, hidden = new Set(), pending = false, unavailable = false;
  const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/.test(value);
  function validate(data) {
    if (!data || data.schema !== 1 || !Number.isFinite(Date.parse(data.updated_at)) || Date.parse(data.updated_at) > Date.now() + 60000 || !Array.isArray(data.agents) || data.agents.length !== 4 || !Array.isArray(data.logs) || data.logs.length > 200 || !Array.isArray(data.steps) || data.steps.length > 20) throw Error('Invalid public snapshot');
    if (new Set(data.agents.map(a => a.name)).size !== 4) throw Error('Duplicate agent');
    for (const a of data.agents) if (!names.includes(a.name) || !['ACTIVE','AWAITING','RUNNING'].includes(a.status) || !text(a.task,240) || !text(a.connection,100)) throw Error('Invalid agent');
    for (const l of data.logs) if (!names.includes(l.agent) || !text(l.id,80) || !text(l.message,400) || !Number.isFinite(Date.parse(l.at))) throw Error('Invalid log');
    for (const s of data.steps) if (!['DONE','RUNNING','PENDING'].includes(s.status) || !text(s.title,180)) throw Error('Invalid step');
    if (!names.includes(data.queue_agent)) throw Error('Invalid queue');
    return data;
  }
  function node(tag, value, cls) { const n = document.createElement(tag); if (value !== undefined) n.textContent = value; if(cls) n.className=cls; return n; }
  function freshness(offline = false) {
    const stale = !snapshot || Date.now() - Date.parse(snapshot.updated_at) > 900000;
    $('freshness').parentElement.dataset.state = offline ? 'offline' : stale ? 'stale' : 'fresh';
    $('freshness').textContent = offline ? 'Offline / unavailable — last snapshot only' : paused ? 'Paused — local view frozen' : stale ? 'Stale snapshot — activity is not confirmed live' : 'Snapshot current — not a continuous agent connection';
  }
  function logs() {
    const box = $('terminal'), nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const items = snapshot.logs.filter(l => !hidden.has(l.id) && (filter === 'All Agents' || l.agent === filter));
    box.replaceChildren();
    for (const l of items) {const row=node('div',undefined,'entry');row.dataset.agent=l.agent;const time=node('time',new Date(l.at).toLocaleTimeString([], {hour12:false}));time.dateTime=l.at;row.append(time,node('strong',l.agent),node('span',l.message));box.append(row);}
    if (!items.length) box.append(node('p','No events in this view.','empty'));
    $('count').textContent=items.length+' visible events · source history is unchanged';
    if (nearBottom) box.scrollTop=box.scrollHeight;
  }
  function render() {
    $('agents').replaceChildren();
    for (const a of snapshot.agents) { const card=node('article',undefined,'agent'), top=node('div',undefined,'agent-top'), pill=node('span',a.status,'pill');pill.dataset.state=a.status;top.append(node('h2',a.name),pill);card.append(top,node('p',a.task),node('small',a.connection));$('agents').append(card); }
    $('steps').replaceChildren();snapshot.steps.forEach((s,i)=>{const li=node('li');li.dataset.state=s.status;li.append(node('small',`STEP ${String(i+1).padStart(2,'0')}: ${s.status}`),node('span',s.title));$('steps').append(li);});
    $('queue-agent').textContent=snapshot.queue_agent;
    $('updated').textContent='Last source update: '+new Date(snapshot.updated_at).toLocaleString();
    logs();freshness();
  }
  async function refresh() {
    if (paused || pending || document.hidden) return;
    pending=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try {const response=await fetch('./snapshot.json',{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('unavailable');const raw=await response.text();if(raw.length>100000)throw Error('oversized');const next=validate(JSON.parse(raw));if(!paused){unavailable=false;snapshot=next;render();}}
    catch {unavailable=true;freshness(true);if(!snapshot){$('terminal').replaceChildren(node('p','Status unavailable. No activity is assumed.','empty'));}}
    finally {clearTimeout(timer);pending=false;}
  }
  for (const name of ['All Agents',...names]) {const b=node('button',name);b.type='button';b.setAttribute('aria-pressed',String(name===filter));b.onclick=()=>{filter=name;for(const c of $('filters').children)c.setAttribute('aria-pressed',String(c.textContent===name));if(snapshot)logs();};$('filters').append(b);}
  $('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'Resume':'Pause';$('pause').setAttribute('aria-pressed',String(paused));freshness(unavailable || !navigator.onLine);if(!paused)refresh();};
  $('clear').onclick=()=>{if(snapshot){snapshot.logs.forEach(l=>hidden.add(l.id));logs();}};
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  setInterval(refresh,60000);setInterval(()=>{if(snapshot)freshness(unavailable || !navigator.onLine);},30000);refresh();
})();
