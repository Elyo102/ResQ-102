// Active tasks panel. DOM via createElement + textContent only (no HTML-string APIs for any content).
// Hidden until a backend-authorized identity arrives; hiding is UX only, Firestore Rules enforce every write.
// The taskId is minted once per draft and is the idempotency key: a retry reuses it, and an already-existing
// document that matches is a success. No success is shown before the server confirms.
// A task is a request for MANUAL pickup; it is never approval for push, deploy, delete or secrets.
import {TARGET_AGENTS,TARGET_KEYS,payloadProblem,payloadLength,payloadThreshold,payloadThresholdText,blockedChars,blockedCharText,buildTask,previewDoc,draftKey,reconcileTask,
  chipFor,overallStatus,orderTasks,listenerText,listenerState,needsReauth,classifyFailure,renderStamp,PAYLOAD_MAX,SEND_TIMEOUT_MS} from './active-tasks-model.mjs?v=20260930-grok-dispatch4';
import {noteSnippet,SECRET_TEXT,formatDisplayStamp} from './dispatch-model.mjs?v=20260930-grok-dispatch4';

export const TEXT=Object.freeze({
  title:'משימות פעילות לסוכנים',
  hint:'משימה נשמרת לאיסוף ידני בלבד. היא אינה אישור ל-push, deploy, מחיקה או שימוש בסודות. הסוכן מדווח התקדמות בלבד; הסטטוס הכולל מחושב מההתקדמות.',
  execute:'לבצע',ignore:'לא נבחר',payloadLabel:'תוכן המשימה (עד 10000 תווים: עברית, ניקוד ואנגלית/ASCII)',
  preview:'תצוגה מקדימה',send:'שמירת משימה',retry:'ניסיון חוזר (אותו מזהה)',check:'בדיקה מול השרת',reset:'איפוס ומזהה חדש',reauth:'התחברות מחדש לאישור',
  previewTitle:'זה בדיוק המסמך שיישמר (timestamp ייקבע בשרת):',payloadTitle:'התוכן כפי שיישמר:',
  noTarget:'יש לבחור "לבצע" לסוכן אחד לפחות — כל הסוכנים במצב "לא נבחר".',empty:'יש לכתוב תוכן למשימה.',
  length:'התוכן ארוך מ-10000 תווים — יש לקצר לפני שמירה.',chars:'התוכן מכיל תו שאינו מותר (לא תוקן אוטומטית): ',
  needPreview:'יש ליצור תצוגה מקדימה לפני שמירה.',stalePreview:'הטופס השתנה — התצוגה המקדימה בוטלה. יש ליצור תצוגה מקדימה חדשה.',
  offline:'אין חיבור רשת — השמירה מושבתת.',busy:'פעולה קודמת עדיין בתהליך.',
  sending:'שומר… ממתין לאישור השרת.',confirmed:'המשימה נשמרה ואושרה על ידי השרת.',alreadySaved:'המשימה כבר נשמרה בשרת (אומת מול השרת).',
  unconfirmed:'לא אושר — ייתכן שהמשימה עוד תישמר. ניסיון חוזר ישתמש באותו מזהה ולא ייצור כפילות.',
  notYet:'לא אושר — המשימה עדיין לא נמצאה בשרת. אפשר לנסות שוב עם אותו מזהה.',
  denied:'השרת דחה את המשימה ולא נשמר דבר.',conflict:'לא אושר — קיימת רשומה אחרת עם המזהה. יש לאפס לפני שמירה נוספת.',
  reauthNeeded:'ההתחברות ישנה מ-14 דקות. לחץ על "התחברות מחדש לאישור" ואחר כך שוב על שמירה.',reauthDone:'לאחר ההתחברות מחדש יש ללחוץ שוב על שמירה.',
  authUnknown:'לא ניתן לאמת את זמן ההתחברות. נסה שוב.',resetDone:'נוצר מזהה חדש.',
  feed:'משימות אחרונות (20, החדשות למעלה)',none:'אין משימות להצגה',feedError:'הפיד הופסק — מוצג רק מידע שאושר על ידי השרת.',
  created:'נוצר',updated:'עודכן',cancel:'ביטול משימה',confirmCancel:'לבטל את המשימה? ביטול אינו מבטיח עצירה של עבודה שכבר התחילה.',
  yes:'כן, לבטל',no:'לא',cancelSent:'בקשת הביטול נשלחה; הסטטוס יתעדכן רק מהשרת.',cancelFailed:'הביטול לא אושר. הסטטוס לא השתנה.',
  cancelNote:'ביטול אינו מבטיח עצירה של עבודה שכבר התחילה.',showAll:'הצג את כל התוכן',status:'סטטוס: ',listenerPrefix:'משימות: ',
  cancelDenied:'השרת דחה את הביטול. הסטטוס לא השתנה.',cancelUnconfirmed:'לא אושר — ייתכן שהביטול עוד יחול. הסטטוס יתעדכן רק מהשרת.',
  resetAfterUnconfirmed:'המשימה הקודמת לא נמצאה בשרת כרגע, אך ייתכן שעוד תישמר. הטופס נוקה כדי למנוע כפילות; אם היא תופיע בפיד — היא נשמרה.',
  noIdentity:'אין זהות מאומתת — יש להתחבר מחדש.',badId:'מזהה המשימה אינו תקין — יש ללחוץ על איפוס.',
  feedCache:'אין חיבור — מצב אחרון מ-',feedCacheNone:'אין חיבור — עדיין אין מצב מאושר מהשרת.',feedErrorAt:'הפיד הופסק — מוצג מצב אחרון מ-',feedErrorSuffix:' (לא עדכני)',
  feedErrorNone:'הפיד הופסק — אין מצב מאושר להצגה.',listenersUnknown:'מצב המאזינים לא ידוע (אין חיבור).',reconnect:'התחברות מחדש לפיד',stale:'לא עדכני',
  listenerNoneLine:'אין מאזין — המשימה תישמר בלבד',listenerDownLine:'מנותק — המשימה תישמר עד שהמאזין יחזור',listenerUnknownLine:'מצב המאזין לא ידוע — ייתכן שהמשימה תישמר בלבד',
  listenersTitle:'מצב המאזינים לסוכנים שנבחרו:',loading:'טוען…',listenerLoadingLine:'טוען את מצב המאזין…'
});

export function mountActiveTasksPanel({doc,api,signIn,now=Date.now,uuid=()=>globalThis.crypto.randomUUID(),sendTimeoutMs=SEND_TIMEOUT_MS,tickMs=15000}){
  if(!doc||!api||typeof signIn!=='function')throw Error('INVALID_ACTIVE_TASKS_ADAPTER');
  const win=doc.defaultView;
  const node=(tag,text,cls)=>{const n=doc.createElement(tag);if(text!=null&&text!=='')n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,id,cls)=>{const n=node('button',text,cls);n.type='button';if(id)n.id=id;return n;};
  const panel=node('section',null,'active-tasks');panel.id='active-tasks-panel';panel.hidden=true;panel.setAttribute('aria-labelledby','active-tasks-title');
  const title=node('h2',TEXT.title);title.id='active-tasks-title';
  const fields=node('div',null,'active-fields');const selects={};
  for(const [agent,key] of TARGET_AGENTS){
    const wrap=node('div',null,'active-field');const label=node('label',agent);const select=node('select');select.id='active-target-'+key;label.htmlFor=select.id;
    const ignore=node('option',TEXT.ignore);ignore.value='IGNORE';const exec=node('option',TEXT.execute);exec.value='EXECUTE';select.append(ignore,exec);select.value='IGNORE';
    selects[key]=select;wrap.append(label,select);fields.append(wrap);
  }
  const payloadWrap=node('div',null,'active-field');const payloadLabel=node('label',TEXT.payloadLabel);const payload=node('textarea');payload.id='active-payload';payload.rows=10;payload.dir='auto';
  payloadLabel.htmlFor=payload.id;payload.setAttribute('spellcheck','false');payload.setAttribute('aria-describedby','active-counter active-error');
  const counter=node('p','','active-counter');counter.id='active-counter';
  const limitLive=node('p','','active-limit-live');limitLive.id='active-limit-live';limitLive.setAttribute('role','status');limitLive.setAttribute('aria-live','polite');
  payloadWrap.append(payloadLabel,payload,counter,limitLive);
  const error=node('p','','active-error');error.id='active-error';error.setAttribute('aria-live','polite');
  const previewBtn=button(TEXT.preview,'active-preview'),send=button(TEXT.send,'active-send'),retry=button(TEXT.retry,'active-retry');
  const check=button(TEXT.check,'active-reconcile'),reset=button(TEXT.reset,'active-reset'),reauth=button(TEXT.reauth,'active-reauth');
  const sendReason=node('p','','active-send-reason');sendReason.id='active-send-reason';send.setAttribute('aria-describedby','active-send-reason');
  const actions=node('div',null,'active-actions');actions.append(previewBtn,send,retry,check,reauth,reset);
  const previewBox=node('div',null,'active-preview');previewBox.id='active-preview-box';previewBox.hidden=true;
  const result=node('p','','active-result');result.id='active-result';result.setAttribute('role','status');result.setAttribute('aria-live','polite');
  const feedList=node('ul',null,'active-feed');feedList.id='active-feed';feedList.setAttribute('aria-label',TEXT.feed);
  const feedError=node('p','','active-feed-error');feedError.id='active-feed-error';feedError.setAttribute('role','status');
  const reconnect=button(TEXT.reconnect,'active-reconnect');reconnect.hidden=true;
  panel.append(title,node('p',TEXT.hint,'hint'),fields,payloadWrap,error,actions,sendReason,previewBox,result,node('h3',TEXT.feed),feedError,reconnect,feedList);

  let uid=null,draftUid=null,taskId=null,preview=null,phase='idle',resume='idle',disposed=false,flight=0,tick=null,lastThreshold=null;
  // Feed/listener stream state: 'idle' | 'live' | 'cache' (offline, cached snapshot ignored) | 'error' (stream ended).
  let stopFeed=null,stopListeners=null,rows=[],feedState='idle',feedAt=null,listenersState='idle',seen={};
  const cancelPending=new Set(),confirming=new Set(),expanded=new Set(),changeFns=new Set(),rowNodes=new Map(),rowSigs=new Map();
  const draft=()=>({payload:payload.value,targets:Object.fromEntries(TARGET_KEYS.map(k=>[k,selects[k].value]))});
  const online=()=>win?.navigator?.onLine!==false;
  const say=text=>{result.textContent=text||'';};
  const busy=()=>phase==='sending'||phase==='reconciling'||phase==='checking';
  const noTarget=d=>!TARGET_KEYS.some(k=>d.targets[k]==='EXECUTE');
  const hhmm=ms=>{const t=formatDisplayStamp(ms);return t==='—'?'—':t.slice(11);};
  const listenersKnown=()=>listenersState==='live';
  function problemText(d){
    const p=payloadProblem(d.payload);
    if(p==='secret')return SECRET_TEXT;               // never echoes the matched text
    if(p==='length')return TEXT.length;
    if(p==='chars')return TEXT.chars+blockedChars(d.payload).map(blockedCharText).join('; ');
    if(p==='empty'||p==='type')return TEXT.empty;
    if(noTarget(d))return TEXT.noTarget;
    return '';
  }
  function render(){
    if(disposed)return;
    const d=draft();const n=payloadLength(d.payload);counter.textContent=n>PAYLOAD_MAX?`${n}/${PAYLOAD_MAX} — חריגה של ${n-PAYLOAD_MAX} תווים`:`${n}/${PAYLOAD_MAX}`;
    const level=payloadThreshold(d.payload);if(level!==lastThreshold){lastThreshold=level;limitLive.textContent=level?payloadThresholdText(level):'';}
    const payloadIssue=payloadProblem(d.payload);
    error.textContent=payloadIssue&&payloadIssue!=='empty'?problemText(d):'';
    const locked=busy()||phase==='unconfirmed';
    for(const s of Object.values(selects))s.disabled=locked;payload.readOnly=locked;previewBtn.disabled=locked;
    const fresh=preview!==null&&preview.key===draftKey(d.payload,d.targets);
    const problem=problemText(d);
    send.disabled=phase!=='idle'||!fresh||!online()||problem!=='';
    sendReason.textContent=!send.disabled?'':problem?problem:!online()?TEXT.offline:busy()?TEXT.busy:!fresh?(preview===null?TEXT.needPreview:TEXT.stalePreview):'';
    retry.hidden=check.hidden=phase!=='unconfirmed'&&phase!=='reconciling';retry.disabled=check.disabled=busy();
    reauth.hidden=phase!=='reauth';reset.hidden=taskId===null||busy();
  }
  function listenerLine(key){
    const st=listenerState(seen[key],now(),listenersKnown());
    if(listenersState==='idle')return TEXT.listenerLoadingLine;
    return st==='none'?TEXT.listenerNoneLine:st==='down'?TEXT.listenerDownLine:st==='unknown'?TEXT.listenerUnknownLine:null;
  }
  // The preview's listener warnings follow listener state changes (snapshot, error, heartbeat ageing on the tick).
  let previewLinesSig=null;
  function renderPreviewListeners(){
    const box=previewBox.querySelector('.active-preview-listeners-box');if(!box||!preview)return;
    const lines=TARGET_AGENTS.filter(([,k])=>preview.task.targets[k]==='EXECUTE').map(([a,k])=>[a,k,listenerLine(k)]).filter(x=>x[2]);
    const sig=JSON.stringify(lines);if(sig===previewLinesSig)return;previewLinesSig=sig;
    if(!lines.length){box.replaceChildren();return;}
    const ul=node('ul',null,'active-preview-listeners');ul.id='active-preview-listeners';
    for(const [a,k,text] of lines){const li=node('li',`${a}: ${text}`);li.dataset.agent=k;ul.append(li);}
    box.replaceChildren(node('p',TEXT.listenersTitle),ul);
  }
  function showPreview(task){
    const json=node('pre',JSON.stringify(previewDoc(task),null,2),'active-preview-json');json.id='active-preview-json';json.dir='ltr';
    const body=node('div',null,'active-payload-text');body.id='active-preview-payload';body.dir='auto';body.textContent=task.payload;
    const listenersBox=node('div',null,'active-preview-listeners-box');listenersBox.setAttribute('aria-live','polite');
    previewBox.replaceChildren(node('p',TEXT.previewTitle),json,listenersBox,node('p',TEXT.payloadTitle),body);previewBox.hidden=false;
    previewLinesSig=null;renderPreviewListeners();
  }
  function hidePreview(){preview=null;previewBox.hidden=true;previewBox.replaceChildren();}
  function edited(){if(preview!==null){hidePreview();if(phase==='idle')say(TEXT.stalePreview);}render();}
  function clearDraft(){taskId=null;hidePreview();payload.value='';for(const s of Object.values(selects))s.value='IGNORE';phase='idle';resume='idle';}
  function confirmedOk(text){clearDraft();say(text);render();}
  const withTimeout=p=>{let t;return Promise.race([p,new Promise((_,reject)=>{t=setTimeout(()=>reject(Object.assign(Error('ACTIVE_TASK_TIMEOUT'),{code:'deadline-exceeded'})),sendTimeoutMs);})]).finally(()=>clearTimeout(t));};
  async function serverOutcome(task){
    if(rows.some(r=>r.id===task.taskId&&r.dispatchedBy===task.dispatchedBy&&r.payload===task.payload))return 'saved';
    try{return reconcileTask(task,await withTimeout(api.verify(task.taskId)));}catch{return 'unknown';}
  }
  async function reconcileNow(task,afterDenied){
    const ticket=++flight;phase='reconciling';render();
    const outcome=await serverOutcome(task);
    if(disposed||ticket!==flight)return;
    if(outcome==='saved'){confirmedOk(TEXT.alreadySaved);return;}
    if(outcome==='missing'&&afterDenied){phase='idle';say(TEXT.denied);render();return;}
    phase='unconfirmed';say(outcome==='conflict'?TEXT.conflict:outcome==='missing'?TEXT.notYet:TEXT.unconfirmed);render();
  }
  async function attempt(task){
    const ticket=++flight;phase='sending';say(TEXT.sending);render();
    try{await withTimeout(api.create(task,sendTimeoutMs));if(disposed||ticket!==flight)return;confirmedOk(TEXT.confirmed);}
    catch(e){if(disposed||ticket!==flight)return;
      // already-exists surfaces as PERMISSION_DENIED (create on an existing id): read it from the server first.
      if(classifyFailure(e)==='denied'){await reconcileNow(task,true);return;}
      phase='unconfirmed';say(TEXT.unconfirmed);render();}
  }
  // auth_time freshness with a timeout. The phase switches to 'checking' synchronously (no double submit); after the
  // await the ticket and the SAME preview must still be current (identity switch / reset / dispose abort quietly).
  async function freshEnough(back,expected){
    const ticket=++flight;phase='checking';render();
    let at;
    try{at=await withTimeout(api.authTime());}
    catch{if(!disposed&&ticket===flight){phase=back;say(TEXT.authUnknown);render();}return false;}
    if(disposed||ticket!==flight||preview===null||preview!==expected)return false;
    if(needsReauth(at,now())){resume=back;phase='reauth';say(TEXT.reauthNeeded);render();return false;}
    return true;
  }
  previewBtn.onclick=()=>{
    if(busy()||phase==='unconfirmed')return;const d=draft();const problem=problemText(d);
    if(problem){say(problem);render();return;}
    taskId??=uuid();
    try{const task=buildTask({taskId,uid:api.uid?.()??uid,payload:d.payload,targets:d.targets});preview={task,key:draftKey(d.payload,d.targets)};showPreview(task);say('');}
    catch(e){const m=String(e?.message);
      if(m==='INVALID_TASK_ID'){say(TEXT.badId);}
      else{taskId=null;say(m==='UID_REQUIRED'?TEXT.noIdentity:m==='INVALID_PAYLOAD'?(problemText(d)||TEXT.empty):TEXT.noTarget);}}
    render();
  };
  send.onclick=async()=>{
    if(phase!=='idle')return;const d=draft();const current=preview;
    if(!current){say(TEXT.needPreview);return;}
    if(current.key!==draftKey(d.payload,d.targets)){say(TEXT.stalePreview);return;}
    if(problemText(d)){say(problemText(d));return;}
    if(!online()){say(TEXT.offline);render();return;}
    if(!await freshEnough('idle',current)||disposed)return;
    await attempt(current.task);
  };
  retry.onclick=async()=>{const current=preview;if(phase!=='unconfirmed'||!current)return;if(!online()){say(TEXT.offline);return;}
    if(!await freshEnough('unconfirmed',current)||disposed)return;await attempt(current.task);};
  check.onclick=()=>{if(phase==='unconfirmed'&&preview)void reconcileNow(preview.task,false);};
  reauth.onclick=()=>{let p;try{p=signIn();}catch{p=Promise.reject();}phase=resume;say(TEXT.reauthDone);render();Promise.resolve(p).catch(()=>{if(!disposed)say(TEXT.reauthNeeded);});};
  // Reset: while a write is unconfirmed it may still land, so check the server first; if not found, clear the whole
  // draft (payload too) so the same content cannot be saved again under a new taskId by accident.
  reset.onclick=async()=>{
    if(busy())return;
    if(phase==='unconfirmed'&&preview){
      const task=preview.task,ticket=++flight;phase='reconciling';render();
      const outcome=await serverOutcome(task);
      if(disposed||ticket!==flight)return;
      if(outcome==='saved'){confirmedOk(TEXT.alreadySaved);return;}
      clearDraft();say(TEXT.resetAfterUnconfirmed);render();return;
    }
    flight++;taskId=null;hidePreview();phase='idle';resume='idle';say(TEXT.resetDone);render();
  };
  for(const s of Object.values(selects))s.addEventListener('change',edited);
  payload.addEventListener('input',edited);
  const netChange=()=>render();win?.addEventListener('online',netChange);win?.addEventListener('offline',netChange);

  // ---- feed: keyed rows (by task id). A snapshot rebuilds only rows whose server data changed; the tick updates only
  // chip/status texts and stamps in place, so focus, selection, <details> state and scroll position survive. ----
  const chipsFor=r=>{const t=now();return TARGET_KEYS.map(k=>chipFor(r,k,{now:t,seenAt:seen[k],pulseKnown:listenersKnown()}));};
  function payloadParts(r){
    const snip=noteSnippet(r.payload);const short=node('div',null,'active-payload-text');short.dir='auto';short.textContent=snip.text||'—';
    if(!snip.truncated)return [short];
    const more=node('details',null,'active-more');const summary=node('summary',TEXT.showAll);summary.id='active-more-'+r.id;more.append(summary);
    const fill=()=>{if(more.open){if(!more.querySelector('.active-payload-full')){const full=node('div',null,'active-payload-text active-payload-full');full.dir='auto';full.textContent=r.payload;more.append(full);}
      short.hidden=true;expanded.add(r.id);}else{more.querySelector('.active-payload-full')?.remove();short.hidden=false;expanded.delete(r.id);}};
    more.open=expanded.has(r.id);fill();more.addEventListener('toggle',fill);return [short,more];
  }
  function refreshLive(li,r){
    const chips=chipsFor(r);const overall=overallStatus(r,chips);
    const status=li.querySelector('.active-status');const text=TEXT.status+overall.text;
    if(status.textContent!==text)status.textContent=text;status.dataset.kind=overall.kind;
    for(const c of chips){const el=li.querySelector(`.active-chip[data-agent="${c.key}"]`);if(!el)continue;
      el.dataset.kind=c.kind;const t=el.querySelector('.active-chip-text');if(t.textContent!==c.text)t.textContent=c.text;
      const at=el.querySelector('.active-chip-at');const want=c.updatedAt===null?'':String(c.updatedAt);
      if(at.dataset.at!==want){at.dataset.at=want;at.replaceChildren(...(c.updatedAt===null?[]:[doc.createTextNode(' · '+TEXT.updated+' '),renderStamp(doc,c.updatedAt)]));}}
    const stale=feedState!=='live';li.dataset.stale=String(stale);
    const mark=li.querySelector('.active-stale');mark.hidden=!stale;
    return overall;
  }
  function buildRow(li,r){
    const status=node('span','','active-status');const staleMark=node('span',TEXT.stale,'active-stale');staleMark.hidden=true;
    const head=node('div',null,'active-row-head');head.append(status,staleMark);
    const times=node('p',null,'active-times');times.append(node('span',TEXT.created+' '),renderStamp(doc,r.timestamp));
    const list=node('ul',null,'active-chips');list.setAttribute('aria-label','התקדמות לפי סוכן');
    for(const [agent,key] of TARGET_AGENTS){const c=node('li',null,'active-chip');c.dataset.agent=key;
      const at=node('span',null,'active-chip-at');at.dataset.at='';c.append(node('strong',agent),node('span','','active-chip-text'),at);list.append(c);}
    li.replaceChildren(head,times,list,...payloadParts(r));
    const overall=refreshLive(li,r);
    // Cancel only for own PENDING tasks that are not already finished for every selected agent.
    if(r.status==='PENDING'&&r.dispatchedBy===uid&&overall.kind!=='done'){
      const box=node('div',null,'active-cancel');
      if(confirming.has(r.id)){
        const yes=button(TEXT.yes,'active-cancel-yes-'+r.id,'active-cancel-yes'),no=button(TEXT.no,'active-cancel-no-'+r.id,'active-cancel-no');
        yes.disabled=cancelPending.has(r.id);
        yes.onclick=async()=>{if(cancelPending.has(r.id))return;cancelPending.add(r.id);renderFeed();
          rowNodes.get(r.id)?.focus({preventScroll:true});             // the disabled "yes" cannot keep focus while pending
          try{await withTimeout(api.cancel(r.id,sendTimeoutMs));if(!disposed)say(TEXT.cancelSent);}
          catch(e){if(!disposed)say(classifyFailure(e)==='denied'?TEXT.cancelDenied:TEXT.cancelUnconfirmed);}
          finally{cancelPending.delete(r.id);confirming.delete(r.id);renderFeed();focusAfterCancel(r.id);}};
        no.onclick=()=>{confirming.delete(r.id);renderFeed();doc.getElementById('active-cancel-'+r.id)?.focus();};
        box.append(node('p',TEXT.confirmCancel,'active-confirm-text'),yes,no);
      }else{const b=button(TEXT.cancel,'active-cancel-'+r.id,'active-cancel-btn');b.onclick=()=>{confirming.add(r.id);renderFeed();doc.getElementById('active-cancel-yes-'+r.id)?.focus();};
        box.append(b,node('p',TEXT.cancelNote,'active-cancel-note'));}
      li.append(box);
    }
  }
  // After a cancel attempt: the row's cancel button if it is still offered, else the row itself (tabindex -1), else the result line.
  function focusAfterCancel(id){const target=doc.getElementById('active-cancel-'+id)??rowNodes.get(id)??result;target?.focus?.({preventScroll:true});}
  const sigOf=r=>JSON.stringify([r.status,r.dispatchedBy===uid,r.timestamp,r.payload,r.targets,r.progress,cancelPending.has(r.id),confirming.has(r.id)]);
  function rowFor(r){
    let li=rowNodes.get(r.id);if(!li){li=node('li',null,'active-row');li.dataset.id=r.id;li.tabIndex=-1;rowNodes.set(r.id,li);}
    li.dataset.status=r.status;const sig=sigOf(r);
    if(rowSigs.get(r.id)===sig){refreshLive(li,r);return li;}
    rowSigs.set(r.id,sig);
    const focusId=li.contains(doc.activeElement)?doc.activeElement.id:null;const hadFocus=li.contains(doc.activeElement);
    buildRow(li,r);
    if(hadFocus){const again=focusId?doc.getElementById(focusId):null;(again&&li.contains(again)?again:li).focus({preventScroll:true});}
    return li;
  }
  function renderState(){
    const at=feedAt===null?null:hhmm(feedAt);
    const parts=[];
    if(feedState==='cache')parts.push(at?TEXT.feedCache+at:TEXT.feedCacheNone);
    else if(feedState==='error')parts.push(at?TEXT.feedErrorAt+at+TEXT.feedErrorSuffix:TEXT.feedErrorNone);
    if(uid&&listenersState!=='live'&&listenersState!=='idle')parts.push(TEXT.listenersUnknown);
    feedError.textContent=parts.join(' ');
    reconnect.hidden=!(feedState==='error'||listenersState==='error');
    feedList.classList.toggle('active-feed-stale',feedState!=='live');
  }
  function renderFeed(){
    if(disposed)return;const list=orderTasks(rows);const keep=new Set(list.map(r=>r.id));
    for(const [id,li] of rowNodes)if(!keep.has(id)){li.remove();rowNodes.delete(id);rowSigs.delete(id);expanded.delete(id);}
    feedList.querySelector('.active-empty')?.remove();
    list.forEach((r,i)=>{const li=rowFor(r);if(feedList.children[i]!==li)feedList.insertBefore(li,feedList.children[i]??null);});
    if(!list.length&&feedState==='live')feedList.replaceChildren(node('li',TEXT.none,'active-empty'));
    else if(!list.length&&feedState==='idle'&&uid)feedList.replaceChildren(node('li',TEXT.loading,'active-empty active-loading'));   // before the first snapshot
    renderState();
  }
  function refreshAll(){if(disposed)return;const list=orderTasks(rows);for(const r of list){const li=rowNodes.get(r.id);if(li)refreshLive(li,r);}renderState();renderPreviewListeners();}
  const notify=()=>{for(const fn of changeFns){try{fn();}catch{}}};
  function startFeed(){
    if(stopFeed||!uid)return;
    try{stopFeed=api.watch({
      next(list,meta){if(disposed)return;
        // A cached / offline snapshot is never shown as current: keep the last server rows, marked stale, with their time.
        if(meta?.fromCache===true||!Array.isArray(list)){feedState='cache';refreshAll();return;}
        rows=list;feedAt=now();feedState='live';renderFeed();},
      error(){if(disposed)return;feedState='error';const s=stopFeed;stopFeed=null;try{s?.();}catch{}refreshAll();}});}
    catch{feedState='error';refreshAll();}
  }
  function startListeners(){
    if(stopListeners||!uid)return;
    try{stopListeners=api.watchListeners({
      next(map,meta){if(disposed)return;
        if(meta?.fromCache===true||!map||typeof map!=='object'){listenersState='cache';}else{seen={...map};listenersState='live';}
        refreshAll();notify();},
      error(){if(disposed)return;listenersState='error';const s=stopListeners;stopListeners=null;try{s?.();}catch{}refreshAll();notify();}});}
    catch{listenersState='error';refreshAll();notify();}
  }
  function start(){
    if(!uid)return;startFeed();startListeners();
    if(!tick&&tickMs>0)tick=setInterval(()=>{if(doc.hidden)return;refreshAll();notify();},tickMs);
  }
  reconnect.onclick=()=>{if(!uid)return;
    if(feedState==='error'){feedState='idle';startFeed();}
    if(listenersState==='error'){listenersState='idle';startListeners();}
    refreshAll();notify();};
  function stop(){for(const s of [stopFeed,stopListeners]){try{s?.();}catch{}}stopFeed=stopListeners=null;clearInterval(tick);tick=null;
    rows=[];seen={};feedState='idle';feedAt=null;listenersState='idle';confirming.clear();cancelPending.clear();rowNodes.clear();rowSigs.clear();expanded.clear();
    feedList.replaceChildren();renderState();notify();}
  return {element:panel,
    // Agent card liveness line (Codex/Grok/Gemini): אין מאזין / מנותק / מאזין, or "לא ידוע (אין חיבור)" when the
    // listener stream failed — never "אין מאזין" for an unknown state.
    listenerStatus:{
      text(agent){const pair=TARGET_AGENTS.find(([a])=>a===agent);if(!pair||!uid)return null;
        return TEXT.listenerPrefix+(listenersState==='idle'?TEXT.loading:listenerText(seen[pair[1]],now(),listenersKnown()));},
      state(agent){const pair=TARGET_AGENTS.find(([a])=>a===agent);if(!pair||!uid)return null;return listenersState==='idle'?'loading':listenerState(seen[pair[1]],now(),listenersKnown());},
      onChange(fn){changeFns.add(fn);return()=>changeFns.delete(fn);}
    },
    setIdentity(user){
      if(disposed)return;const next=user?.backendAuthorized===true&&typeof user.uid==='string'&&user.uid?user.uid:null;
      // Sign-out: stop streams and clear the draft so no payload stays in the DOM.
      if(next===null){flight++;uid=null;panel.hidden=true;stop();clearDraft();say('');render();return;}
      if(draftUid!==null&&draftUid!==next){flight++;clearDraft();say('');}
      if(uid!==null&&uid!==next)stop();                 // a different identity never sees the previous feed
      draftUid=next;uid=next;panel.hidden=false;start();render();renderFeed();
    },
    dispose(){disposed=true;flight++;win?.removeEventListener('online',netChange);win?.removeEventListener('offline',netChange);stop();changeFns.clear();},
    debugState(){return {phase,taskId,previewKey:preview?.key??null,feedState,listenersState,rows:rowNodes.size};}
  };
}
