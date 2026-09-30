// Agent Dispatch Center panel. DOM via createElement + textContent only (no HTML-string APIs for any content).
// Hidden until a backend-authorized identity arrives; hiding is UX only, Firestore Rules enforce every write.
// Draft, preview and idempotency keys live here, OUTSIDE the private controller, so onIdTokenChanged resets
// (which re-run controller.reset) never clear the form or mint new ids. No success is shown before the server
// confirms; a timeout is 'לא אושר' and the same ids are reused on retry.
import {DISPATCH_AGENTS,DISPATCH_TASKS,taskTypeText,noteProblem,invalidCharReport,counterText,noteThreshold,thresholdText,noteSnippet,normalizeNote,NOTE_BANNER,SECRET_TEXT,newKeys,buildPayload,draftKey,
  statusText,orderFeed,needsReauth,classifyFailure,reconcile,renderStamp,COOLDOWN_MS,SEND_TIMEOUT_MS} from './dispatch-model.mjs?v=20260930-grok-dispatch4';

export const TEXT=Object.freeze({
  title:'מרכז שיגור סוכנים',
  hint:'כל שורה היא בקשה לתצוגה בלבד: היא לא מפעילה סוכן ואינה הרשאה. ההערה מוצגת בלבד ואינה משמשת כהוראה.',
  none:'לא לשלוח',noteLabel:'הערה (עד 10000 תווים, כמה שורות: עברית, ניקוד ואנגלית/ASCII)',
  preview:'תצוגה מקדימה',send:'שליחה',retry:'ניסיון חוזר (אותו מפתח)',check:'בדיקה מול השרת',reset:'איפוס ומפתח חדש',reauth:'התחברות מחדש לאישור',
  previewTitle:'זה בדיוק מה שיישלח:',serverTime:'createdAt: שעת השרת',
  stalePreview:'הטופס השתנה — יש ליצור תצוגה מקדימה חדשה לפני שליחה.',needPreview:'יש ליצור תצוגה מקדימה לפני שליחה.',
  noSelection:'יש לבחור סוג משימה לסוכן אחד לפחות.',noteLength:'ההערה ארוכה מ-10000 תווים — יש לקצר לפני שליחה.',
  noteChars:'ההערה מכילה תווים שאינם מותרים: ',offline:'אין חיבור רשת — השליחה מושבתת עד שהחיבור יחזור.',
  sending:'שולח… ממתין לאישור השרת.',confirmed:'נשלח ואושר על ידי השרת.',alreadySaved:'הבקשה כבר נשמרה בשרת (אומת מול השרת).',
  unconfirmed:'לא אושר — השרת לא אישר את השליחה. ייתכן שהבקשה עוד תישמר מאוחר יותר. הטופס נשמר; ניסיון חוזר ישתמש באותו מפתח ולא ייצור בקשה כפולה.',
  notYet:'לא אושר — הבקשה עדיין לא נמצאה בשרת וייתכן שתישמר מאוחר יותר. אפשר לנסות שוב עם אותו מפתח.',
  denied:'השרת דחה את הבקשה ולא נשמר דבר. הטופס נשמר.',conflict:'לא אושר — נמצאה רשומה שאינה תואמת למפתח. יש לאפס לפני שליחה נוספת.',
  reauthNeeded:'ההתחברות ישנה מ-14 דקות. לחץ על "התחברות מחדש לאישור" ואחר כך שוב על שליחה.',
  reauthDone:'לאחר ההתחברות מחדש יש ללחוץ שוב על שליחה.',authUnknown:'לא ניתן לאמת את זמן ההתחברות. נסה שוב.',
  resetDone:'נוצר מפתח חדש. אם שליחה קודמת עוד תגיע, היא תופיע בפיד.',cooldown:'יש להמתין מעט לפני שליחה נוספת.',
  active:'בקשות פעילות',history:'היסטוריה (50 אחרונות)',empty:'אין בקשות להצגה',feedError:'הפיד הופסק — מוצג רק מידע שאושר על ידי השרת.',
  cancel:'ביטול בקשה',cancelSent:'בקשת הביטול נשלחה; הסטטוס יתעדכן רק מהשרת.',cancelFailed:'הביטול לא אושר. הסטטוס לא השתנה.',
  created:'נוצר',cancelled:'בוטל',showAll:'הצג את כל ההערה',noteHuman:'ההערה כפי שתישלח:',
  offlineReason:'השליחה מושבתת: אין חיבור רשת.',cooldownReason:'השליחה מושבתת לרגע (המתנה בין שליחות).',busyReason:'השליחה מושבתת: פעולה קודמת עדיין בתהליך.'
});

export function mountDispatchPanel({doc,api,signIn,now=Date.now,uuid=()=>globalThis.crypto.randomUUID(),sendTimeoutMs=SEND_TIMEOUT_MS}){
  if(!doc||!api||typeof signIn!=='function')throw Error('INVALID_DISPATCH_ADAPTER');
  const win=doc.defaultView;
  const node=(tag,text,cls)=>{const n=doc.createElement(tag);if(text!=null&&text!=='')n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,id)=>{const n=node('button',text);n.type='button';n.id=id;return n;};
  const panel=node('section',null,'dispatch');panel.id='dispatch-panel';panel.hidden=true;panel.setAttribute('aria-labelledby','dispatch-title');
  const title=node('h2',TEXT.title);title.id='dispatch-title';
  const net=node('p','','dispatch-net');net.id='dispatch-net';net.setAttribute('role','status');
  const fields=node('div',null,'dispatch-fields');const selects={};
  for(const agent of DISPATCH_AGENTS){
    const wrap=node('div',null,'dispatch-field');const label=node('label',agent);const select=node('select');select.id='dispatch-task-'+agent;label.htmlFor=select.id;
    const none=node('option',TEXT.none);none.value='';select.append(none);
    for(const type of DISPATCH_TASKS[agent]){const o=node('option',taskTypeText(type));o.value=type;select.append(o);}
    selects[agent]=select;wrap.append(label,select);fields.append(wrap);
  }
  const noteWrap=node('div',null,'dispatch-field');const noteLabel=node('label',TEXT.noteLabel);const note=node('textarea');note.id='dispatch-note';note.rows=12;note.dir='auto';noteLabel.htmlFor=note.id;note.setAttribute('spellcheck','false');
  // Visible counter updates on every input (no live region); a SEPARATE polite region announces threshold crossings only.
  const counter=node('p','','dispatch-counter');counter.id='dispatch-counter';note.setAttribute('aria-describedby','dispatch-counter dispatch-error dispatch-note-banner');
  const limitLive=node('p','','dispatch-limit-live');limitLive.id='dispatch-limit-live';limitLive.setAttribute('aria-live','polite');limitLive.setAttribute('role','status');
  const banner=node('p',NOTE_BANNER,'dispatch-banner');banner.id='dispatch-note-banner';
  noteWrap.append(noteLabel,note,counter,banner,limitLive);
  const error=node('p','','dispatch-error');error.id='dispatch-error';error.setAttribute('aria-live','polite');
  const previewBtn=button(TEXT.preview,'dispatch-preview'),send=button(TEXT.send,'dispatch-send'),retry=button(TEXT.retry,'dispatch-retry');
  const check=button(TEXT.check,'dispatch-reconcile'),reset=button(TEXT.reset,'dispatch-reset'),reauth=button(TEXT.reauth,'dispatch-reauth');
  const sendReason=node('p','','dispatch-send-reason');sendReason.id='dispatch-send-reason';send.setAttribute('aria-describedby','dispatch-send-reason');
  const actions=node('div',null,'dispatch-actions');actions.append(previewBtn,send,retry,check,reauth,reset);
  const previewBox=node('div',null,'dispatch-preview');previewBox.id='dispatch-preview-box';previewBox.hidden=true;
  const result=node('p','','dispatch-result');result.id='dispatch-result';result.setAttribute('role','status');result.setAttribute('aria-live','polite');
  const feedError=node('p','','dispatch-feed-error');feedError.id='dispatch-feed-error';
  const activeList=node('ul',null,'dispatch-feed');activeList.id='dispatch-active';activeList.setAttribute('aria-label',TEXT.active);
  const historyList=node('ul',null,'dispatch-feed');historyList.id='dispatch-history';historyList.setAttribute('aria-label',TEXT.history);
  panel.append(title,node('p',TEXT.hint,'hint'),net,fields,noteWrap,error,actions,sendReason,previewBox,result,node('h3',TEXT.active),activeList,node('h3',TEXT.history),historyList,feedError);

  let uid=null,draftUid=null,keys=null,preview=null,phase='idle',resume='idle',cooldownUntil=0,cooldownTimer=null,disposed=false;
  let stopWatch=null,feed=[],feedFailed=false,flight=0,lastThreshold=null;const cancelPending=new Set(),rowNodes=new Map(),rowKeys=new Map(),expanded=new Set();
  const draft=()=>({selections:Object.fromEntries(DISPATCH_AGENTS.map(a=>[a,selects[a].value])),note:note.value});
  const online=()=>win?.navigator?.onLine!==false;
  const say=text=>{result.textContent=text||'';};
  const busy=()=>phase==='sending'||phase==='reconciling'||phase==='checking';

  function render(){
    if(disposed)return;
    const d=draft();counter.textContent=counterText(d.note);
    const problem=noteProblem(d.note);
    error.textContent=problemText(problem,d.note);
    const level=noteThreshold(d.note);if(level!==lastThreshold){lastThreshold=level;limitLive.textContent=level?thresholdText(level):'';}
    net.textContent=online()?'':TEXT.offline;
    const locked=busy()||phase==='unconfirmed';
    for(const s of Object.values(selects))s.disabled=locked;note.readOnly=locked;
    const fresh=preview!==null&&preview.key===draftKey(d.selections,d.note);
    previewBtn.disabled=locked;
    send.disabled=phase!=='idle'||!fresh||!online()||now()<cooldownUntil||problem!==null;
    // Why the button is disabled, as text (aria-describedby on the button), never color alone.
    sendReason.textContent=!send.disabled?'':problem?problemText(problem,d.note):!online()?TEXT.offlineReason:busy()?TEXT.busyReason:
      !fresh?(preview===null?TEXT.needPreview:TEXT.stalePreview):now()<cooldownUntil?TEXT.cooldownReason:'';
    retry.hidden=check.hidden=phase!=='unconfirmed'&&phase!=='reconciling';retry.disabled=check.disabled=busy();
    reauth.hidden=phase!=='reauth';reset.hidden=keys===null||busy();reset.disabled=busy();
    if(!fresh&&preview===null)previewBox.hidden=true;
  }
  function problemText(problem,raw){
    return problem==='secret'?SECRET_TEXT:problem==='length'?TEXT.noteLength:problem==='chars'?TEXT.noteChars+invalidCharReport(raw).join(', '):'';
  }
  // Note text node: textContent only, pre-wrap, per-line bidi (CSS unicode-bidi:plaintext) plus dir=auto.
  const noteNode=(text,cls='dispatch-note-text')=>{const n=node('div',null,cls);n.dir='auto';n.textContent=text;return n;};
  function showPreview(payload){
    const list=node('ol');
    for(const r of payload.rows){const li=node('li');const d=r.data;
      li.append(node('strong',d.agent),node('span',' · '+taskTypeText(d.taskType)));list.append(li);}
    const exact=node('pre',JSON.stringify(payload.rows.map(r=>({id:r.id,...r.data})),null,1),'dispatch-scroll');exact.dir='ltr';exact.id='dispatch-preview-json';exact.tabIndex=0;
    const human=noteNode(payload.rows[0]?.data.note||'—','dispatch-note-text dispatch-scroll');human.id='dispatch-preview-note';human.tabIndex=0;
    previewBox.replaceChildren(node('p',TEXT.previewTitle),list,node('p',TEXT.noteHuman),human,node('p',NOTE_BANNER,'dispatch-banner'),exact,node('p',TEXT.serverTime,'hint'));previewBox.hidden=false;
  }
  function edited(){if(preview!==null){preview=null;previewBox.hidden=true;previewBox.replaceChildren();if(phase==='idle')say(TEXT.stalePreview);}render();}
  function confirmed(text){keys=null;preview=null;previewBox.hidden=true;previewBox.replaceChildren();
    for(const s of Object.values(selects))s.value='';note.value='';phase='idle';resume='idle';say(text);
    cooldownUntil=now()+COOLDOWN_MS;clearTimeout(cooldownTimer);cooldownTimer=setTimeout(render,COOLDOWN_MS+50);render();}
  const withTimeout=p=>{let t;return Promise.race([p,new Promise((_,reject)=>{t=setTimeout(()=>reject(Object.assign(Error('DISPATCH_TIMEOUT'),{code:'deadline-exceeded'})),sendTimeoutMs);})]).finally(()=>clearTimeout(t));};

  async function reconcileNow(payload,afterDenied){
    const ticket=++flight;phase='reconciling';render();
    const inFeed=payload.rows.every(r=>feed.some(f=>f.id===r.id&&f.batchId===r.data.batchId&&f.createdBy===r.data.createdBy));
    let outcome=inFeed?'saved':null;
    if(!outcome){try{outcome=reconcile(payload,await withTimeout(api.verify(payload.rows.map(r=>r.id))));}catch{outcome='unknown';}}
    if(disposed||ticket!==flight)return;
    if(outcome==='saved'){confirmed(TEXT.alreadySaved);return;}
    if(outcome==='missing'&&afterDenied){phase='idle';say(TEXT.denied);render();return;}
    phase='unconfirmed';say(outcome==='conflict'?TEXT.conflict:outcome==='missing'?TEXT.notYet:TEXT.unconfirmed);render();
  }
  async function attempt(payload){
    const ticket=++flight;phase='sending';say(TEXT.sending);render();
    try{await withTimeout(api.create(payload,sendTimeoutMs));if(disposed||ticket!==flight)return;confirmed(TEXT.confirmed);}
    catch(e){if(disposed||ticket!==flight)return;
      // PERMISSION_DENIED on a retry may mean "already saved": read every id from the server before deciding.
      if(classifyFailure(e)==='denied'){await reconcileNow(payload,true);return;}
      phase='unconfirmed';say(TEXT.unconfirmed);render();}
  }
  // auth_time freshness (not just backend authorization). Runs while the phase is 'checking' (buttons disabled).
  async function freshEnough(back){
    phase='checking';render();
    try{const at=await api.authTime();if(disposed)return false;
      if(needsReauth(at,now())){resume=back;phase='reauth';say(TEXT.reauthNeeded);render();return false;}return true;}
    catch{if(!disposed){phase=back;say(TEXT.authUnknown);render();}return false;}
  }
  previewBtn.onclick=()=>{
    if(busy()||phase==='unconfirmed')return;const d=draft(),currentUid=api.uid?.()??uid;
    const problem=noteProblem(d.note);
    if(!DISPATCH_AGENTS.some(a=>d.selections[a])){say(TEXT.noSelection);return;}
    if(problem){say(problemText(problem,d.note));return;}
    keys??=newKeys(uuid);
    try{const payload=buildPayload({...d,keys,uid:currentUid});preview={payload,key:draftKey(d.selections,d.note)};showPreview(payload);say('');}catch{say(TEXT.noSelection);}
    render();
  };
  send.onclick=async()=>{
    if(phase!=='idle')return;const d=draft();
    if(!preview){say(TEXT.needPreview);return;}
    if(preview.key!==draftKey(d.selections,d.note)){say(TEXT.stalePreview);return;}
    if(now()<cooldownUntil){say(TEXT.cooldown);return;}
    if(!online()){say(TEXT.offline);render();return;}
    // freshEnough() switches to 'checking' synchronously, so the button is disabled before any await: no double send.
    if(!await freshEnough('idle')||disposed)return;
    await attempt(preview.payload);
  };
  retry.onclick=async()=>{
    if(phase!=='unconfirmed'||!preview)return;if(!online()){say(TEXT.offline);render();return;}
    if(!await freshEnough('unconfirmed')||disposed)return;
    await attempt(preview.payload);
  };
  check.onclick=()=>{if(phase==='unconfirmed'&&preview)void reconcileNow(preview.payload,false);};
  // Direct click: the Google popup must open inside this user gesture (Safari), so nothing is awaited first.
  reauth.onclick=()=>{let p;try{p=signIn();}catch{p=Promise.reject();}phase=resume;say(TEXT.reauthDone);render();
    Promise.resolve(p).catch(()=>{if(!disposed)say(TEXT.reauthNeeded);});};
  reset.onclick=()=>{if(busy())return;flight++;keys=null;preview=null;previewBox.hidden=true;previewBox.replaceChildren();phase='idle';resume='idle';say(TEXT.resetDone);render();};
  for(const s of Object.values(selects))s.addEventListener('change',edited);
  note.addEventListener('input',edited);
  const netChange=()=>render();win?.addEventListener('online',netChange);win?.addEventListener('offline',netChange);

  function rowFor(r){
    let li=rowNodes.get(r.id);if(!li){li=node('li',null,'dispatch-row');li.tabIndex=-1;li.dataset.id=r.id;rowNodes.set(r.id,li);}
    // Rebuild only when the server row (or local cancel state) changed: expand state and focus survive feed updates.
    const key=JSON.stringify([r.status,r.cancelledAt,r.createdAt,r.agent,r.taskType,r.note.length,r.createdBy===uid,cancelPending.has(r.id)]);
    if(rowKeys.get(r.id)===key)return li;rowKeys.set(r.id,key);
    const status=node('span',statusText(r.status),'dispatch-status');status.dataset.status=r.status;
    const head=node('div',null,'dispatch-row-head');head.append(node('strong',r.agent),node('span',taskTypeText(r.taskType),'dispatch-type'),status);
    const times=node('p',null,'dispatch-times');times.append(node('span',TEXT.created+' '),renderStamp(doc,r.createdAt));
    if(r.cancelledAt!==null){times.append(node('span',' · '+TEXT.cancelled+' '),renderStamp(doc,r.cancelledAt));}
    const parts=[head,...noteParts(r),node('p',NOTE_BANNER,'dispatch-banner'),times];
    if(r.status==='queued'&&r.createdBy===uid){const b=button(TEXT.cancel,'dispatch-cancel-'+r.id);b.className='dispatch-cancel';b.disabled=cancelPending.has(r.id);
      b.onclick=async()=>{if(cancelPending.has(r.id))return;cancelPending.add(r.id);b.disabled=true;
        try{await withTimeout(api.cancel(r.id,sendTimeoutMs));say(TEXT.cancelSent);}catch{say(TEXT.cancelFailed);}finally{cancelPending.delete(r.id);renderFeed();}};
      parts.push(b);}
    const focusedId=doc.activeElement?.id;const hadFocus=li.contains(doc.activeElement);
    li.replaceChildren(...parts);
    if(hadFocus){const again=focusedId?doc.getElementById(focusedId):null;(again&&li.contains(again)?again:li).focus({preventScroll:true});}
    return li;
  }
  // Collapsed: ~500-character snippet only. <details> appears only when there is real overflow; the full text is
  // rendered into it only when opened. Open state is kept per request id across feed re-renders.
  function noteParts(r){
    const snip=noteSnippet(r.note);
    const short=noteNode(snip.text||'—');short.classList.add('dispatch-note-snippet');
    if(!snip.truncated)return [short];
    const more=node('details',null,'dispatch-more');const summary=node('summary',TEXT.showAll);summary.id='dispatch-more-'+r.id;more.append(summary);
    const fill=()=>{if(more.open){if(!more.querySelector('.dispatch-note-full'))more.append(noteNode(r.note,'dispatch-note-text dispatch-note-full'));short.hidden=true;expanded.add(r.id);}
      else{more.querySelector('.dispatch-note-full')?.remove();short.hidden=false;expanded.delete(r.id);}};
    more.open=expanded.has(r.id);fill();more.addEventListener('toggle',fill);
    return [short,more];
  }
  function renderFeed(){
    if(disposed)return;const {active,history}=orderFeed(feed);
    const focused=doc.activeElement,focusRow=focused?.closest?.('.dispatch-row'),focusId=focused?.id;
    const keep=new Set([...active,...history].map(r=>r.id));
    for(const [id,li] of rowNodes)if(!keep.has(id)){li.remove();rowNodes.delete(id);rowKeys.delete(id);expanded.delete(id);}
    const place=(list,rows)=>{rows.forEach((r,i)=>{const li=rowFor(r);if(list.children[i]!==li)list.insertBefore(li,list.children[i]??null);});
      while(list.children.length>rows.length)list.lastElementChild.remove();};
    place(activeList,active);place(historyList,history);
    if(!active.length)activeList.replaceChildren(node('li',TEXT.empty,'dispatch-empty'));else activeList.querySelector('.dispatch-empty')?.remove();
    if(!history.length)historyList.replaceChildren(node('li',TEXT.empty,'dispatch-empty'));else historyList.querySelector('.dispatch-empty')?.remove();
    // A status change moves the row between lists; restore focus to the same control or the row itself.
    if(focusRow&&doc.activeElement!==focused){const again=focusId?doc.getElementById(focusId):null;
      const row=rowNodes.get(focusRow.dataset.id);(again&&again.isConnected?again:row&&row.isConnected?row:null)?.focus({preventScroll:true});}
    feedError.textContent=feedFailed?TEXT.feedError:'';
  }
  function startWatch(){
    if(stopWatch||!uid)return;feedFailed=false;
    try{stopWatch=api.watch({next(rows){if(disposed)return;feed=rows;feedFailed=false;renderFeed();},
      error(){if(disposed)return;feed=[];feedFailed=true;const s=stopWatch;stopWatch=null;try{s?.();}catch{}renderFeed();}});}
    catch{feedFailed=true;renderFeed();}
  }
  function stopFeed(){const s=stopWatch;stopWatch=null;try{s?.();}catch{}feed=[];rowNodes.clear();rowKeys.clear();activeList.replaceChildren();historyList.replaceChildren();}
  return {element:panel,
    setIdentity(user){
      if(disposed)return;const next=user?.backendAuthorized===true&&typeof user.uid==='string'&&user.uid?user.uid:null;
      if(next===null){uid=null;panel.hidden=true;stopFeed();render();return;}
      if(draftUid!==null&&draftUid!==next){flight++;keys=null;preview=null;previewBox.hidden=true;for(const s of Object.values(selects))s.value='';note.value='';phase='idle';say('');}
      draftUid=next;const changed=uid!==next;uid=next;panel.hidden=false;if(changed)startWatch();render();renderFeed();
    },
    dispose(){disposed=true;clearTimeout(cooldownTimer);win?.removeEventListener('online',netChange);win?.removeEventListener('offline',netChange);stopFeed();},
    // Exposed for tests only (read-only snapshot).
    debugState(){return {phase,keys,previewKey:preview?.key??null};}
  };
}
