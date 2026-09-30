import {createPrivateController} from './private-controller.mjs?v=20260930-grok-dispatch4';
// Single display map for every closed telemetry task type (see core.mjs TASK_LABELS / TELEMETRY_TASKS).
export const TASK_TEXT=Object.freeze({local_tests:'בדיקות מקומיות',git_change:'שינוי קוד',pull_request_review:'סקירת בקשת שינוי',deployment_check:'בדיקת פריסה',
  agent_review_cycle:'מחזור סקירת סוכנים',planner_draft_recovery:'שחזור טיוטת מתכנן',swap_race_review:'סקירת מרוצי החלפות',clean_checkout_gates:'שערי בדיקה בעותק נקי'});
// Never returns 'undefined'. Callers insert the result with textContent only.
export function taskLabel(type){
  if(typeof type!=='string'||!type.trim())return 'פעולה';
  if(Object.hasOwn(TASK_TEXT,type))return TASK_TEXT[type];
  const shown=type.replace(/[\u0000-\u001f\u007f\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g,'').slice(0,64);
  return shown?`פעולה (${shown})`:'פעולה';
}
// Asia/Jerusalem wall-clock stamp "DD/MM/YYYY HH:mm" (seconds in the title/datetime), assembled manually
// from formatToParts('en-GB', h23) BY TYPE. Never Intl format() and never the locale's literal separators.
let stampFormat=null;
const BIDI_MARKS=/[\u200e\u200f\u061c]/g;
const STAMP_PARTS={year:/^\d{4}$/,month:/^\d{2}$/,day:/^\d{2}$/,hour:/^\d{2}$/,minute:/^\d{2}$/,second:/^\d{2}$/};
// Card detail line (existing <small>). Codex liveness today comes only from the gated CI receipt job
// (.github/scripts/telemetry-ci.mjs), so a heartbeat-derived CONNECTED Codex card says so instead of
// implying provider work. Other agents keep the neutral text.
export const CI_LIVE_TEXT='דווח חי ע"י CI';
// Shown (textContent only) when a row stamped too far in the future was dropped.
export const CLOCK_SKEW_TEXT='שעון לא מסונכרן';
export function detailText(agent){
  if(agent?.task)return taskLabel(agent.task);
  if(agent?.agent==='Codex'&&agent?.status==='CONNECTED')return CI_LIVE_TEXT;
  return 'אין משימה חיה מאומתת';
}
// Returns validated wall-clock parts or null. Sorting always uses the numeric timestamp, never this text.
export function displayParts(ms){
  if(!Number.isSafeInteger(ms))return null;
  const date=new Date(ms);if(!Number.isFinite(date.getTime()))return null;
  try{
    stampFormat??=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',numberingSystem:'latn'});
    const parts={};
    for(const {type,value} of stampFormat.formatToParts(date))if(Object.hasOwn(STAMP_PARTS,type))parts[type]=String(value).replace(BIDI_MARKS,'');
    if(parts.hour==='24')parts.hour='00';
    if(!Object.keys(STAMP_PARTS).every(k=>typeof parts[k]==='string'&&STAMP_PARTS[k].test(parts[k])))return null;
    return parts;
  }catch{return null;}
}
export function formatDisplayStamp(ms){const p=displayParts(ms);return p?`${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`:'—';}
export function formatSecondsStamp(ms){const p=displayParts(ms);return p?`${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`:'—';}
// Backwards-compatible name: every date in the private UI now uses the DD/MM/YYYY HH:mm display format.
export const formatStamp=formatDisplayStamp;
// <bdi><time dir="ltr" datetime="full ISO with seconds" title="... HH:mm:ss">DD/MM/YYYY HH:mm</time></bdi>, fallback '—'.
export function renderStamp(doc,ms){
  const bdi=doc.createElement('bdi'),time=doc.createElement('time');time.dir='ltr';time.textContent='—';bdi.append(time);
  const text=formatDisplayStamp(ms);
  if(text!=='—'){try{const iso=new Date(ms).toISOString();time.textContent=text;time.dateTime=iso;time.title=`שעון ישראל · ${formatSecondsStamp(ms)} · ${iso}`;}catch{time.textContent='—';}}
  return bdi;
}
const kindText={heartbeat:'אות חיים',task_started:'התחלת משימה',test_passed:'בדיקה עברה',test_failed:'בדיקה נכשלה',commit_created:'נוצר קומיט',task_completed:'משימה הושלמה',task_failed:'משימה נכשלה'};
const phaseText={signed_out:'יש להתחבר לחשבון הבעלים',denied:'אין הרשאה לצפות בדשבורד',connecting:'מתחבר למקור הפרטי…',connected:'מחובר למקור האירועים הפרטי',offline:'החיבור אינו מאומת — פעילות חיה אינה ידועה',error:'החיבור הופסק — המידע הפרטי הוסתר',paused:'התצוגה מושהית; עבודת הסוכנים לא נעצרה'};
export function signInErrorText(error){
  const messages={
    'auth/popup-blocked':'חלון ההתחברות נחסם. אפשר חלונות קופצים לאתר הזה ולחץ שוב על התחברות.',
    'auth/popup-closed-by-user':'חלון ההתחברות נסגר לפני השלמת הכניסה. אפשר לנסות שוב.',
    'auth/cancelled-popup-request':'בקשת ההתחברות בוטלה. לחץ שוב על התחברות.',
    'auth/web-storage-unsupported':'הדפדפן חוסם אחסון הדרוש להתחברות. נסה לפתוח את הקישור בחלון Safari רגיל.',
    'auth/unauthorized-domain':'כתובת האתר אינה מורשית להתחברות. נדרש תיקון בהגדרות המערכת.',
    'auth/network-request-failed':'ההתחברות לא הושלמה עקב בעיית רשת. בדוק את החיבור ונסה שוב.',
    'auth/oauth-failed':'Google לא השלים את ההתחברות. סגור חלונות התחברות קודמים ונסה שוב.'
  };
  return Object.hasOwn(messages,error?.code)?messages[error.code]:'לא ניתן להתחבר כרגע. נסה שוב.';
}
// dispatchPanel (optional, injected by bootstrap): {element,setIdentity(user),dispose()}. It stays hidden until a
// backend-authorized identity arrives; hiding is UX only, Firestore Rules enforce. This module never imports it.
// listenerStatus (optional, from the active-tasks panel): {text(agent)->string|null, state(agent), onChange(fn)->off}.
// It adds ONE liveness line (אין מאזין / מנותק / מאזין) to the Codex/Grok/Gemini cards; card statuses are unchanged.
// activeTasksPanel (optional): {element,setIdentity(user),dispose()}, hidden until backend authorization like dispatchPanel.
export function mountPrivateDashboard({root,auth,subscribe,dispatchPanel=null,activeTasksPanel=null,listenerStatus=null}){
  if(!root || !auth?.onIdentity || !auth?.signIn || !auth?.signOut)throw Error('INVALID_ADAPTER');
  const doc=root.ownerDocument;
  const node=(tag,text,cls)=>{const n=doc.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,id)=>{const n=node('button',text);n.type='button';n.id=id;return n;};
  const title=node('h1','ResQ — בקרת סוכנים פרטית');
  const message=node('p','','health');message.setAttribute('role','status');
  const login=button('התחברות עם Google','private-login'),logout=button('התנתקות','private-logout');
  const pause=button('השהיית תצוגה','private-pause'),clear=button('ניקוי תצוגה','private-clear');
  const controls=node('div',null,'controls');controls.append(login,logout,pause,clear);
  const cards=node('section',null,'agents');cards.setAttribute('aria-label','מצב הסוכנים');
  const log=node('div',null,'private-terminal');log.id='private-terminal';log.setAttribute('role','log');log.setAttribute('aria-live','off');log.tabIndex=0;
  // The browser's own scroll anchoring is disabled so the manual correction below is the only mechanism
  // (iOS Safari has no overflow-anchor); set via CSSOM, never a style attribute.
  log.style.overflowAnchor='none';
  const hint=node('p','ניקוי והשהיה משפיעים על התצוגה בלבד. אין כאן שליטה מרחוק על הסוכנים.','hint');
  // Announces only ids never seen before, once per data update, and never on the initial load.
  // Visually hidden via CSSOM; lives outside the log (the log itself stays aria-live=off).
  const eventsLive=node('p','','private-events-live');eventsLive.id='private-events-live';eventsLive.setAttribute('aria-live','polite');eventsLive.setAttribute('aria-atomic','true');
  Object.assign(eventsLive.style,{position:'absolute',width:'1px',height:'1px',margin:'-1px',padding:'0',overflow:'hidden',clipPath:'inset(50%)',whiteSpace:'nowrap',border:'0'});
  const panel=dispatchPanel?.element??null;if(panel)panel.hidden=true;
  const tasksPanel=activeTasksPanel?.element??null;if(tasksPanel)tasksPanel.hidden=true;
  root.replaceChildren(...[title,message,controls,panel,tasksPanel,cards,log,eventsLive,hint].filter(Boolean));
  let state=null,paused=false,hidden=new Set(),disposed=false,actionVersion=0,actionNotice=null;
  const stamp=ms=>renderStamp(doc,ms);
  // Keyed log: one element per event id; rows are inserted/removed individually, never a full replacement.
  const rows=new Map(),seen=new Set();let primed=false,emptyNode=null;
  const signature=e=>`${e.agent}|${e.kind}|${e.task}|${e.at}`;
  function rowFor(e){
    // One malformed row must never break the rest of the log.
    let row;
    try{row=node('div',null,'entry');row.dataset.agent=e.agent;
      row.append(stamp(e.at),node('strong',e.agent),node('span',`${kindText[e.kind]??'אירוע'} · ${taskLabel(e.task)}`));}
    catch{row=node('div',null,'entry');row.append(stamp(null),node('span','אירוע לא ניתן להצגה'));}
    row.dataset.id=e.id;return row;
  }
  function clearLog(){log.replaceChildren();rows.clear();emptyNode=null;}
  function renderLog(events,phase){
    const visible=events.filter(e=>!hidden.has(e.id)),keep=new Map(visible.map(e=>[e.id,e]));
    const scrollTop0=log.scrollTop;
    for(const [id,r] of rows){const e=keep.get(id);
      if(!e){r.el.remove();rows.delete(id);} // includes the oldest row dropping off the bottom at the cap
      else if(r.sig!==signature(e)){const el=rowFor(e);r.el.replaceWith(el);rows.set(id,{el,sig:signature(e)});}}
    if(visible.length&&emptyNode){emptyNode.remove();emptyNode=null;}
    const k=visible.findIndex(e=>rows.has(e.id));
    const add=e=>{const el=rowFor(e);rows.set(e.id,{el,sig:signature(e)});return el;};
    if(k<0){for(const e of visible)log.append(add(e));}
    else{
      // Rows newer than the first kept row go on top. Measure scrollHeight around that insert and, when the
      // reader is scrolled down (scrollTop>0), shift scrollTop by the delta so the visible rows stay put.
      const h0=log.scrollHeight,first=rows.get(visible[k].id).el;
      for(const e of visible.slice(0,k))first.before(add(e));
      const delta=log.scrollHeight-h0;
      if(scrollTop0>0&&delta!==0)log.scrollTop=scrollTop0+delta;
      let ref=first;
      for(const e of visible.slice(k+1)){const el=rows.get(e.id)?.el??add(e);if(ref.nextElementSibling!==el)ref.after(el);ref=el;}
    }
    if(!visible.length&&!emptyNode){emptyNode=node('p','אין אירועים להצגה');log.append(emptyNode);}
    if(phase!=='connected')return;
    const fresh=events.filter(e=>!seen.has(e.id));for(const e of events)seen.add(e.id);
    if(!primed){primed=true;return;}
    const shown=fresh.filter(e=>!hidden.has(e.id));
    if(shown.length)eventsLive.textContent=shown.length===1?`אירוע חדש: ${shown[0].agent} · ${kindText[shown[0].kind]??'אירוע'}`:`${shown.length} אירועים חדשים`;
  }
  const panelIdentity=user=>{try{dispatchPanel?.setIdentity(user);}catch{if(panel)panel.hidden=true;}
    try{activeTasksPanel?.setIdentity(user);}catch{if(tasksPanel)tasksPanel.hidden=true;}};
  function renderCards(agents){
    cards.replaceChildren();
    for(const a of agents){const card=node('article',null,'agent');const status=node('p',a.status,'agent-status');status.dataset.status=a.status;
      card.append(node('h2',a.agent),status,node('small',detailText(a)));
      let line=null;try{line=listenerStatus?.text(a.agent)??null;}catch{line=null;}
      if(typeof line==='string'&&line){const p=node('p',line,'agent-listener');p.dataset.listener=listenerStatus.state?.(a.agent)??'';card.append(p);}
      cards.append(card);}
  }
  function render(next){
    if(disposed)return;if(state?.phase!==next.phase)actionNotice=null;
    const statusOnly=next.refresh==='status'&&state!==null&&state.phase===next.phase;
    state=next;message.textContent=actionNotice??(next.phase==='connected'&&next.clockSkew===true?`${phaseText[next.phase]} · ${CLOCK_SKEW_TEXT}`:phaseText[next.phase]);
    const allowed=['connected','connecting','paused','offline','error'].includes(next.phase);
    login.hidden=allowed;logout.hidden=!allowed;pause.hidden=!allowed;clear.hidden=!allowed;
    // Periodic refresh re-renders the agent status cards only; the log is rebuilt only for new data.
    if(statusOnly){if(allowed)renderCards(next.agents);return;}
    if(!allowed){cards.replaceChildren();clearLog();seen.clear();primed=false;eventsLive.textContent='';hidden.clear();paused=false;pause.textContent='השהיית תצוגה';return;}
    hidden=new Set([...hidden].filter(id=>next.events.some(e=>e.id===id)));
    renderCards(next.agents);
    // next.events arrives newest first from the controller (explicit numeric sort on a copy).
    renderLog(next.events,next.phase);
  }
  const controller=createPrivateController({subscribe,render});
  const liveAllowed=()=>state!==null&&['connected','connecting','paused','offline','error'].includes(state.phase);
  let offListeners=null;try{offListeners=listenerStatus?.onChange?.(()=>{if(!disposed&&liveAllowed())renderCards(state.agents);})??null;}catch{offListeners=null;}
  const visibility=()=>controller.setVisible(!doc.hidden&&!paused);
  doc.addEventListener('visibilitychange',visibility);visibility();
  const offAuth=auth.onIdentity(user=>{if(!disposed){actionVersion++;actionNotice=null;login.disabled=false;panelIdentity(user);controller.setIdentity(user);}});
  login.onclick=async()=>{const action=++actionVersion;actionNotice=null;if(state)message.textContent=phaseText[state.phase];login.disabled=true;try{await auth.signIn();}catch(error){if(!disposed&&action===actionVersion){actionNotice=signInErrorText(error);message.textContent=actionNotice;}}finally{if(!disposed&&action===actionVersion)login.disabled=false;}};
  logout.onclick=async()=>{const action=++actionVersion;actionNotice=null;panelIdentity(null);controller.setIdentity(null);try{await auth.signOut();}catch{if(!disposed&&action===actionVersion){actionNotice='המידע הוסתר, אך ניתוק החשבון לא אושר. נסה להתנתק שוב.';message.textContent=actionNotice;logout.hidden=false;}}};
  pause.onclick=()=>{paused=!paused;pause.textContent=paused?'חידוש תצוגה':'השהיית תצוגה';pause.setAttribute('aria-pressed',String(paused));visibility();};
  clear.onclick=()=>{for(const e of state?.events||[])hidden.add(e.id);if(state)render({...state,refresh:'data'});};
  return ()=>{disposed=true;actionVersion++;actionNotice=null;try{dispatchPanel?.dispose?.();}catch{}try{activeTasksPanel?.dispose?.();}catch{}try{offListeners?.();}catch{}controller.dispose();if(typeof offAuth==='function')offAuth();doc.removeEventListener('visibilitychange',visibility);state=null;hidden.clear();root.replaceChildren();};
}
