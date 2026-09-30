// Active tasks panel. DOM via createElement + textContent only (no HTML-string APIs for any content).
// Hidden until a backend-authorized identity arrives; hiding is UX only, Firestore Rules enforce every write.
// The taskId is minted once per draft and is the idempotency key: a retry reuses it, and an already-existing
// document that matches is a success. No success is shown before the server confirms.
// A task is a request for MANUAL pickup; it is never approval for push, deploy, delete or secrets.
import {TARGET_AGENTS,TARGET_KEYS,payloadProblem,payloadLength,blockedChars,blockedCharText,buildTask,previewDoc,draftKey,reconcileTask,
  chipFor,overallStatus,orderTasks,listenerText,listenerState,needsReauth,classifyFailure,renderStamp,PAYLOAD_MAX,SEND_TIMEOUT_MS} from './active-tasks-model.mjs?v=20260930-grok-dispatch4';
import {noteSnippet,SECRET_TEXT} from './dispatch-model.mjs?v=20260930-grok-dispatch4';

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
  cancelNote:'ביטול אינו מבטיח עצירה של עבודה שכבר התחילה.',showAll:'הצג את כל התוכן',status:'סטטוס: ',listenerPrefix:'משימות: '
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
  const payloadWrap=node('div',null,'active-field');const payloadLabel=node('label',TEXT.payloadLabel);const payload=node('textarea');payload.id='active-payload';payload.rows=10;
  payloadLabel.htmlFor=payload.id;payload.setAttribute('spellcheck','false');payload.setAttribute('aria-describedby','active-counter active-error');
  const counter=node('p','','active-counter');counter.id='active-counter';
  payloadWrap.append(payloadLabel,payload,counter);
  const error=node('p','','active-error');error.id='active-error';error.setAttribute('aria-live','polite');
  const previewBtn=button(TEXT.preview,'active-preview'),send=button(TEXT.send,'active-send'),retry=button(TEXT.retry,'active-retry');
  const check=button(TEXT.check,'active-reconcile'),reset=button(TEXT.reset,'active-reset'),reauth=button(TEXT.reauth,'active-reauth');
  const sendReason=node('p','','active-send-reason');sendReason.id='active-send-reason';send.setAttribute('aria-describedby','active-send-reason');
  const actions=node('div',null,'active-actions');actions.append(previewBtn,send,retry,check,reauth,reset);
  const previewBox=node('div',null,'active-preview');previewBox.id='active-preview-box';previewBox.hidden=true;
  const result=node('p','','active-result');result.id='active-result';result.setAttribute('role','status');result.setAttribute('aria-live','polite');
  const feedList=node('ul',null,'active-feed');feedList.id='active-feed';feedList.setAttribute('aria-label',TEXT.feed);
  const feedError=node('p','','active-feed-error');feedError.id='active-feed-error';
  panel.append(title,node('p',TEXT.hint,'hint'),fields,payloadWrap,error,actions,sendReason,previewBox,result,node('h3',TEXT.feed),feedList,feedError);

  let uid=null,draftUid=null,taskId=null,preview=null,phase='idle',resume='idle',disposed=false,flight=0,tick=null;
  let stopFeed=null,stopListeners=null,rows=[],feedFailed=false,seen={};const cancelPending=new Set(),confirming=new Set(),expanded=new Set(),changeFns=new Set();
  const draft=()=>({payload:payload.value,targets:Object.fromEntries(TARGET_KEYS.map(k=>[k,selects[k].value]))});
  const online=()=>win?.navigator?.onLine!==false;
  const say=text=>{result.textContent=text||'';};
  const busy=()=>phase==='sending'||phase==='reconciling'||phase==='checking';
  const noTarget=d=>!TARGET_KEYS.some(k=>d.targets[k]==='EXECUTE');
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
  function showPreview(task){
    const json=node('pre',JSON.stringify(previewDoc(task),null,2),'active-preview-json');json.id='active-preview-json';json.dir='ltr';
    const body=node('div',null,'active-payload-text');body.dir='auto';body.textContent=task.payload;
    previewBox.replaceChildren(node('p',TEXT.previewTitle),json,node('p',TEXT.payloadTitle),body);previewBox.hidden=false;
  }
  function edited(){if(preview!==null){preview=null;previewBox.hidden=true;previewBox.replaceChildren();if(phase==='idle')say(TEXT.stalePreview);}render();}
  function confirmedOk(text){taskId=null;preview=null;previewBox.hidden=true;previewBox.replaceChildren();payload.value='';
    for(const s of Object.values(selects))s.value='IGNORE';phase='idle';resume='idle';say(text);render();}
  const withTimeout=p=>{let t;return Promise.race([p,new Promise((_,reject)=>{t=setTimeout(()=>reject(Object.assign(Error('ACTIVE_TASK_TIMEOUT'),{code:'deadline-exceeded'})),sendTimeoutMs);})]).finally(()=>clearTimeout(t));};
  async function reconcileNow(task,afterDenied){
    const ticket=++flight;phase='reconciling';render();
    let outcome=rows.some(r=>r.id===task.taskId&&r.dispatchedBy===task.dispatchedBy&&r.payload===task.payload)?'saved':null;
    if(!outcome){try{outcome=reconcileTask(task,await withTimeout(api.verify(task.taskId)));}catch{outcome='unknown';}}
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
  async function freshEnough(back){
    phase='checking';render();
    try{const at=await api.authTime();if(disposed)return false;
      if(needsReauth(at,now())){resume=back;phase='reauth';say(TEXT.reauthNeeded);render();return false;}return true;}
    catch{if(!disposed){phase=back;say(TEXT.authUnknown);render();}return false;}
  }
  previewBtn.onclick=()=>{
    if(busy()||phase==='unconfirmed')return;const d=draft();const problem=problemText(d);
    if(problem){say(problem);render();return;}
    taskId??=uuid();
    try{const task=buildTask({taskId,uid:api.uid?.()??uid,payload:d.payload,targets:d.targets});preview={task,key:draftKey(d.payload,d.targets)};showPreview(task);say('');}
    catch{taskId=null;say(TEXT.noTarget);}
    render();
  };
  send.onclick=async()=>{
    if(phase!=='idle')return;const d=draft();
    if(!preview){say(TEXT.needPreview);return;}
    if(preview.key!==draftKey(d.payload,d.targets)){say(TEXT.stalePreview);return;}
    if(problemText(d)){say(problemText(d));return;}
    if(!online()){say(TEXT.offline);render();return;}
    if(!await freshEnough('idle')||disposed)return;
    await attempt(preview.task);
  };
  retry.onclick=async()=>{if(phase!=='unconfirmed'||!preview)return;if(!online()){say(TEXT.offline);return;}
    if(!await freshEnough('unconfirmed')||disposed)return;await attempt(preview.task);};
  check.onclick=()=>{if(phase==='unconfirmed'&&preview)void reconcileNow(preview.task,false);};
  reauth.onclick=()=>{let p;try{p=signIn();}catch{p=Promise.reject();}phase=resume;say(TEXT.reauthDone);render();Promise.resolve(p).catch(()=>{if(!disposed)say(TEXT.reauthNeeded);});};
  reset.onclick=()=>{if(busy())return;flight++;taskId=null;preview=null;previewBox.hidden=true;previewBox.replaceChildren();phase='idle';resume='idle';say(TEXT.resetDone);render();};
  for(const s of Object.values(selects))s.addEventListener('change',edited);
  payload.addEventListener('input',edited);
  const netChange=()=>render();win?.addEventListener('online',netChange);win?.addEventListener('offline',netChange);

  function chipNode(c){
    const li=node('li',null,'active-chip');li.dataset.kind=c.kind;li.dataset.agent=c.key;
    li.append(node('strong',c.agent),node('span',c.text,'active-chip-text'));
    if(c.updatedAt!==null){li.append(node('span',' · '+TEXT.updated+' ','active-chip-at'),renderStamp(doc,c.updatedAt));}
    return li;
  }
  function payloadParts(r){
    const snip=noteSnippet(r.payload);const short=node('div',null,'active-payload-text');short.dir='auto';short.textContent=snip.text||'—';
    if(!snip.truncated)return [short];
    const more=node('details',null,'active-more');more.append(node('summary',TEXT.showAll));
    const fill=()=>{if(more.open){if(!more.querySelector('.active-payload-full')){const full=node('div',null,'active-payload-text active-payload-full');full.dir='auto';full.textContent=r.payload;more.append(full);}
      short.hidden=true;expanded.add(r.id);}else{more.querySelector('.active-payload-full')?.remove();short.hidden=false;expanded.delete(r.id);}};
    more.open=expanded.has(r.id);fill();more.addEventListener('toggle',fill);return [short,more];
  }
  function rowNode(r){
    const t=now();const chips=TARGET_KEYS.map(k=>chipFor(r,k,{now:t,seenAt:seen[k]}));const overall=overallStatus(r,chips);
    const li=node('li',null,'active-row');li.dataset.id=r.id;li.dataset.status=r.status;
    const status=node('span',TEXT.status+overall.text,'active-status');status.dataset.kind=overall.kind;
    const head=node('div',null,'active-row-head');head.append(status);
    const times=node('p',null,'active-times');times.append(node('span',TEXT.created+' '),renderStamp(doc,r.timestamp));
    const list=node('ul',null,'active-chips');list.setAttribute('aria-label','התקדמות לפי סוכן');list.append(...chips.map(chipNode));
    const parts=[head,times,list,...payloadParts(r)];
    if(r.status==='PENDING'&&r.dispatchedBy===uid){
      const box=node('div',null,'active-cancel');
      if(confirming.has(r.id)){
        const yes=button(TEXT.yes,'active-cancel-yes-'+r.id,'active-cancel-yes'),no=button(TEXT.no,'active-cancel-no-'+r.id,'active-cancel-no');
        yes.disabled=cancelPending.has(r.id);
        yes.onclick=async()=>{if(cancelPending.has(r.id))return;cancelPending.add(r.id);renderFeed();
          try{await withTimeout(api.cancel(r.id,sendTimeoutMs));say(TEXT.cancelSent);}catch{say(TEXT.cancelFailed);}finally{cancelPending.delete(r.id);confirming.delete(r.id);renderFeed();}};
        no.onclick=()=>{confirming.delete(r.id);renderFeed();doc.getElementById('active-cancel-'+r.id)?.focus();};
        box.append(node('p',TEXT.confirmCancel,'active-confirm-text'),yes,no);
      }else{const b=button(TEXT.cancel,'active-cancel-'+r.id,'active-cancel-btn');b.onclick=()=>{confirming.add(r.id);renderFeed();doc.getElementById('active-cancel-yes-'+r.id)?.focus();};
        box.append(b,node('p',TEXT.cancelNote,'active-cancel-note'));}
      parts.push(box);
    }
    li.append(...parts);return li;
  }
  function renderFeed(){
    if(disposed)return;const list=orderTasks(rows);const focusId=doc.activeElement?.id;
    feedList.replaceChildren(...(list.length?list.map(rowNode):[node('li',TEXT.none,'active-empty')]));
    if(focusId&&feedList.contains(doc.getElementById(focusId)))doc.getElementById(focusId).focus({preventScroll:true});
    feedError.textContent=feedFailed?TEXT.feedError:'';
  }
  const notify=()=>{for(const fn of changeFns){try{fn();}catch{}}};
  function start(){
    if(!uid)return;feedFailed=false;
    if(!stopFeed){try{stopFeed=api.watch({next(list){if(disposed)return;rows=list;feedFailed=false;renderFeed();},
      error(){if(disposed)return;rows=[];feedFailed=true;const s=stopFeed;stopFeed=null;try{s?.();}catch{}renderFeed();}});}catch{feedFailed=true;renderFeed();}}
    if(!stopListeners){try{stopListeners=api.watchListeners({next(map){if(disposed)return;seen={...map};renderFeed();notify();},
      error(){if(disposed)return;seen={};const s=stopListeners;stopListeners=null;try{s?.();}catch{}renderFeed();notify();}});}catch{seen={};}}
    if(!tick&&tickMs>0)tick=setInterval(()=>{renderFeed();notify();},tickMs);
  }
  function stop(){for(const s of [stopFeed,stopListeners]){try{s?.();}catch{}}stopFeed=stopListeners=null;clearInterval(tick);tick=null;rows=[];seen={};confirming.clear();feedList.replaceChildren();notify();}
  return {element:panel,
    // Agent card liveness line (Codex/Grok/Gemini): אין מאזין / מנותק / מאזין only.
    listenerStatus:{
      text(agent){const pair=TARGET_AGENTS.find(([a])=>a===agent);return pair&&uid?TEXT.listenerPrefix+listenerText(seen[pair[1]],now()):null;},
      state(agent){const pair=TARGET_AGENTS.find(([a])=>a===agent);return pair&&uid?listenerState(seen[pair[1]],now()):null;},
      onChange(fn){changeFns.add(fn);return()=>changeFns.delete(fn);}
    },
    setIdentity(user){
      if(disposed)return;const next=user?.backendAuthorized===true&&typeof user.uid==='string'&&user.uid?user.uid:null;
      if(next===null){uid=null;panel.hidden=true;stop();render();return;}
      if(draftUid!==null&&draftUid!==next){flight++;taskId=null;preview=null;previewBox.hidden=true;payload.value='';for(const s of Object.values(selects))s.value='IGNORE';phase='idle';say('');}
      draftUid=next;uid=next;panel.hidden=false;start();render();renderFeed();
    },
    dispose(){disposed=true;win?.removeEventListener('online',netChange);win?.removeEventListener('offline',netChange);stop();changeFns.clear();},
    debugState(){return {phase,taskId,previewKey:preview?.key??null};}
  };
}
