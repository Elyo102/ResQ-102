import {createPrivateController} from './private-controller.mjs?v=20260930-grok-stamp1';
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
// Asia/Jerusalem wall-clock stamp "YYYY-MM-DD HH:mm:ss", assembled from formatToParts BY TYPE.
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
export function formatStamp(ms){
  if(!Number.isSafeInteger(ms))return '—';
  const date=new Date(ms);if(!Number.isFinite(date.getTime()))return '—';
  try{
    stampFormat??=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',numberingSystem:'latn'});
    const parts={};
    for(const {type,value} of stampFormat.formatToParts(date))if(Object.hasOwn(STAMP_PARTS,type))parts[type]=String(value).replace(BIDI_MARKS,'');
    if(parts.hour==='24')parts.hour='00';
    if(!Object.keys(STAMP_PARTS).every(k=>typeof parts[k]==='string'&&STAMP_PARTS[k].test(parts[k])))return '—';
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }catch{return '—';}
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
export function mountPrivateDashboard({root,auth,subscribe}){
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
  const hint=node('p','ניקוי והשהיה משפיעים על התצוגה בלבד. אין כאן שליטה מרחוק על הסוכנים.','hint');
  root.replaceChildren(title,message,controls,cards,log,hint);
  let state=null,paused=false,hidden=new Set(),disposed=false,actionVersion=0,actionNotice=null;
  function stamp(ms){
    const text=formatStamp(ms),time=node('time',text);
    if(text!=='—'){try{const iso=new Date(ms).toISOString();time.dateTime=iso;time.title=`שעון ישראל · ${iso}`;}catch{time.textContent='—';}}
    return time;
  }
  function renderCards(agents){
    cards.replaceChildren();
    for(const a of agents){const card=node('article',null,'agent');const status=node('p',a.status,'agent-status');status.dataset.status=a.status;
      card.append(node('h2',a.agent),status,node('small',detailText(a)));cards.append(card);}
  }
  function render(next){
    if(disposed)return;if(state?.phase!==next.phase)actionNotice=null;
    const statusOnly=next.refresh==='status'&&state!==null&&state.phase===next.phase;
    state=next;message.textContent=actionNotice??(next.phase==='connected'&&next.clockSkew===true?`${phaseText[next.phase]} · ${CLOCK_SKEW_TEXT}`:phaseText[next.phase]);
    const allowed=['connected','connecting','paused','offline','error'].includes(next.phase);
    login.hidden=allowed;logout.hidden=!allowed;pause.hidden=!allowed;clear.hidden=!allowed;
    // Periodic refresh re-renders the agent status cards only; the log is rebuilt only for new data.
    if(statusOnly){if(allowed)renderCards(next.agents);return;}
    cards.replaceChildren();log.replaceChildren();
    if(!allowed){hidden.clear();paused=false;pause.textContent='השהיית תצוגה';return;}
    hidden=new Set([...hidden].filter(id=>next.events.some(e=>e.id===id)));
    renderCards(next.agents);
    for(const e of next.events){if(hidden.has(e.id))continue;
      // One malformed row must never break the rest of the log.
      try{const row=node('div',null,'entry');row.dataset.agent=e.agent;
        row.append(stamp(e.at),node('strong',e.agent),node('span',`${kindText[e.kind]??'אירוע'} · ${taskLabel(e.task)}`));log.append(row);}
      catch{const row=node('div',null,'entry');row.append(stamp(null),node('span','אירוע לא ניתן להצגה'));log.append(row);}}
    if(!log.childElementCount)log.append(node('p','אין אירועים להצגה'));
  }
  const controller=createPrivateController({subscribe,render});
  const visibility=()=>controller.setVisible(!doc.hidden&&!paused);
  doc.addEventListener('visibilitychange',visibility);visibility();
  const offAuth=auth.onIdentity(user=>{if(!disposed){actionVersion++;actionNotice=null;login.disabled=false;controller.setIdentity(user);}});
  login.onclick=async()=>{const action=++actionVersion;actionNotice=null;if(state)message.textContent=phaseText[state.phase];login.disabled=true;try{await auth.signIn();}catch(error){if(!disposed&&action===actionVersion){actionNotice=signInErrorText(error);message.textContent=actionNotice;}}finally{if(!disposed&&action===actionVersion)login.disabled=false;}};
  logout.onclick=async()=>{const action=++actionVersion;actionNotice=null;controller.setIdentity(null);try{await auth.signOut();}catch{if(!disposed&&action===actionVersion){actionNotice='המידע הוסתר, אך ניתוק החשבון לא אושר. נסה להתנתק שוב.';message.textContent=actionNotice;logout.hidden=false;}}};
  pause.onclick=()=>{paused=!paused;pause.textContent=paused?'חידוש תצוגה':'השהיית תצוגה';pause.setAttribute('aria-pressed',String(paused));visibility();};
  clear.onclick=()=>{for(const e of state?.events||[])hidden.add(e.id);if(state)render({...state,refresh:'data'});};
  return ()=>{disposed=true;actionVersion++;actionNotice=null;controller.dispose();if(typeof offAuth==='function')offAuth();doc.removeEventListener('visibilitychange',visibility);state=null;hidden.clear();root.replaceChildren();};
}
