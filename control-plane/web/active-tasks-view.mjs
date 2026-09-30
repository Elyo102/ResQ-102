// Active tasks panel. DOM via createElement + textContent only (no HTML-string APIs for any content).
// Hidden until a backend-authorized identity arrives; hiding is UX only, Firestore Rules enforce every write.
// The taskId is minted once per draft and is the idempotency key: a retry reuses it, and an already-existing
// document that matches is a success. No success is shown before the server confirms.
// A task is a request for MANUAL pickup; it is never approval for push, deploy, delete or secrets.
// Push trigger (UI review C1-C12, review/push-trigger-verdicts.md): kind selector (TASK/MESSAGE), per-task+agent ack
// lines in the feed (the agent card only gets one "אחרון:" line, C1), the ack kill switch (C5/C9) and the owner's
// manual בביצוע/הסתיים clicks (C10). An automatic summary is framed in VISIBLE text as "אינו אישור" (never a tooltip).
import {TARGET_AGENTS,TARGET_KEYS,payloadProblem,payloadLength,payloadThreshold,payloadThresholdText,blockedChars,blockedCharText,buildTask,previewDoc,draftKey,reconcileTask,
  chipFor,overallStatus,orderTasks,listenerText,listenerState,needsReauth,classifyFailure,renderStamp,PAYLOAD_MAX,SEND_TIMEOUT_MS,
  KINDS,KIND_VALUES,kindSwitch,kindProblem,ackFor,ownerAction,learnOffset,serverNow,MESSAGE_MAX,rowKind,ACK_ANNOUNCE_MS} from './active-tasks-model.mjs?v=20260930-grok-dispatch5';
import {noteSnippet,SECRET_TEXT,formatDisplayStamp} from './dispatch-model.mjs?v=20260930-grok-dispatch5';

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
  listenersTitle:'מצב המאזינים לסוכנים שנבחרו:',loading:'טוען…',listenerLoadingLine:'טוען את מצב המאזין…',
  // push trigger
  kindLabel:'סוג',kind:{TASK:'משימה (לבצע)',MESSAGE:'הודעה (להודיע בלבד)'},notify:'להודיע',
  kindBlocked:'המעבר להודעה חסום: יש סוכן במצב "לבצע". יש להעביר אותו ל"לא נבחר" קודם — שום דבר לא הומר אוטומטית.',
  notifyDropped:'המעבר למשימה איפס את הסוכנים שסומנו "להודיע" ל"לא נבחר".',
  noNotify:'יש לבחור "להודיע" לסוכן אחד לפחות — כל הסוכנים במצב "לא נבחר".',
  messageLength:'הודעה מוגבלת ל-2000 תווים — יש לקצר לפני שמירה (לא נחתך אוטומטית).',
  ackTitle:'אישורי קבלה',understoodLead:'הבנתי:',autoLabel:'סיכום אוטומטי, אינו אישור',
  frame:a=>`סיכום אוטומטי של ${a} — אינו אישור ואינו התחלת עבודה`,waitGo:'ממתין ל-go שלך בסשן',
  expand:'הצג את כל הסיכום',collapse:'הצג פחות',
  announceUnderstood:a=>`${a}: הבנתי — סיכום אוטומטי, אינו אישור`,announceUnreadable:a=>`${a}: לא הצליח לקרוא`,
  cardLast:'אחרון: ',cardTask:' · משימה ',
  switchLoading:'טוען את מצב אישורי הקבלה…',switchOn:'אישורי קבלה פעילים (מאזין שהופעל ידנית כותב "נדלק/הבנתי" בלבד).',
  switchOffSince:'אישורי קבלה כבויים מאז ',switchMissing:'לא מוגדר — אישורי קבלה חסומים',switchUnknown:'מצב אישורי הקבלה לא ידוע (אין חיבור)',
  stopAcks:'עצירת אישורי קבלה',enableAcks:'הפעלה מחדש של אישורי קבלה',seedSwitch:'יצירת המתג (כבוי)',
  confirmEnable:'להפעיל מחדש אישורי קבלה? מאזין שרץ ידנית יקרא משימות חדשות ויכתוב סיכום אוטומטי. זה אינו אישור לביצוע.',
  yesEnable:'כן, להפעיל',switchSaving:'שומר… ממתין לאישור השרת.',switchConfirmed:'השינוי אושר על ידי השרת.',
  switchUnconfirmed:'לא אושר — ייתכן שהשינוי עוד יחול. המצב יתעדכן רק מהשרת.',switchDenied:'השרת דחה את השינוי. המצב לא השתנה.',
  switchSame:'המתג כבר במצב הזה — לא נשלח דבר.',switchReauth:'נדרשת התחברות טרייה (עד 15 דקות) להפעלה או ליצירת המתג. לחץ "התחברות מחדש לאישור" ונסה שוב.',
  start:'בביצוע',complete:'הסתיים',progressSaving:'שומר… ממתין לאישור השרת.',progressConfirmed:'הסימון אושר על ידי השרת.',
  progressUnconfirmed:'לא אושר — הסטטוס יתעדכן רק מהשרת.',progressDenied:'השרת דחה את הסימון. הסטטוס לא השתנה.'
});

export function mountActiveTasksPanel({doc,api,signIn,now=Date.now,uuid=()=>globalThis.crypto.randomUUID(),sendTimeoutMs=SEND_TIMEOUT_MS,tickMs=15000}){
  if(!doc||!api||typeof signIn!=='function')throw Error('INVALID_ACTIVE_TASKS_ADAPTER');
  const win=doc.defaultView;
  const node=(tag,text,cls)=>{const n=doc.createElement(tag);if(text!=null&&text!=='')n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,id,cls)=>{const n=node('button',text,cls);n.type='button';if(id)n.id=id;return n;};
  const panel=node('section',null,'active-tasks');panel.id='active-tasks-panel';panel.hidden=true;panel.setAttribute('aria-labelledby','active-tasks-title');
  const title=node('h2',TEXT.title);title.id='active-tasks-title';
  const kindWrap=node('div',null,'active-field active-kind');const kindLabel=node('label',TEXT.kindLabel);const kindSel=node('select');kindSel.id='active-kind';kindLabel.htmlFor=kindSel.id;
  for(const k of KINDS){const o=node('option',TEXT.kind[k]);o.value=k;kindSel.append(o);}kindSel.value='TASK';kindWrap.append(kindLabel,kindSel);
  const kindNote=node('p','','active-kind-note');kindNote.id='active-kind-note';kindNote.setAttribute('role','status');
  const fields=node('div',null,'active-fields');const selects={};
  const valueText={IGNORE:TEXT.ignore,EXECUTE:TEXT.execute,NOTIFY:TEXT.notify};
  const fillOptions=(select,kind)=>{select.replaceChildren(...KIND_VALUES[kind].map(v=>{const o=node('option',valueText[v]);o.value=v;return o;}));};
  for(const [agent,key] of TARGET_AGENTS){
    const wrap=node('div',null,'active-field');const label=node('label',agent);const select=node('select');select.id='active-target-'+key;label.htmlFor=select.id;
    fillOptions(select,'TASK');select.value='IGNORE';
    selects[key]=select;wrap.append(label,select);fields.append(wrap);
  }
  let kind='TASK';
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
  // C5/C9: ack kill switch banner (persistent; server state only).
  const sw=node('div',null,'active-ack-switch');sw.id='active-ack-switch';
  const swText=node('p',TEXT.switchLoading,'active-ack-switch-text');swText.id='active-ack-switch-text';swText.setAttribute('role','status');
  const swStop=button(TEXT.stopAcks,'active-ack-stop'),swEnable=button(TEXT.enableAcks,'active-ack-enable'),swSeed=button(TEXT.seedSwitch,'active-ack-seed');
  const swConfirm=node('div',null,'active-ack-confirm');swConfirm.hidden=true;
  const swYes=button(TEXT.yesEnable,'active-ack-enable-yes'),swNo=button(TEXT.no,'active-ack-enable-no');swConfirm.append(node('p',TEXT.confirmEnable),swYes,swNo);
  const swReauth=button(TEXT.reauth,'active-ack-reauth');swReauth.hidden=true;
  const swResult=node('p','','active-ack-switch-result');swResult.id='active-ack-switch-result';swResult.setAttribute('aria-live','polite');
  sw.append(swText,swStop,swEnable,swSeed,swConfirm,swReauth,swResult);
  const ackLive=node('p','','active-ack-live');ackLive.id='active-ack-live';ackLive.setAttribute('role','status');ackLive.setAttribute('aria-live','polite');
  panel.append(title,node('p',TEXT.hint,'hint'),sw,kindWrap,kindNote,fields,payloadWrap,error,actions,sendReason,previewBox,result,node('h3',TEXT.feed),feedError,reconnect,ackLive,feedList);

  let uid=null,draftUid=null,taskId=null,preview=null,phase='idle',resume='idle',disposed=false,flight=0,tick=null,lastThreshold=null;
  // Feed/listener stream state: 'idle' | 'live' | 'cache' (offline, cached snapshot ignored) | 'error' (stream ended).
  let stopFeed=null,stopListeners=null,rows=[],feedState='idle',feedAt=null,listenersState='idle',seen={};
  const cancelPending=new Set(),confirming=new Set(),expanded=new Set(),changeFns=new Set(),rowNodes=new Map(),rowSigs=new Map();
  // push trigger state
  let offset=null,listenerMeta={},switchState='idle',switchAt=null,stopSwitch=null,switchWriting=false,switchConfirming=false;
  const ackExpanded=new Set(),ackKinds=new Map(),ackAnnounced=new Set(),sessionTasks=new Set(),progressPending=new Set();
  const reducedMotion=()=>!!win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const draft=()=>({kind,payload:payload.value,targets:Object.fromEntries(TARGET_KEYS.map(k=>[k,selects[k].value]))});
  const online=()=>win?.navigator?.onLine!==false;
  const say=text=>{result.textContent=text||'';};
  const busy=()=>phase==='sending'||phase==='reconciling'||phase==='checking';
  const noTarget=d=>!TARGET_KEYS.some(k=>d.targets[k]===(d.kind==='MESSAGE'?'NOTIFY':'EXECUTE'));
  const hhmm=ms=>{const t=formatDisplayStamp(ms);return t==='—'?'—':t.slice(11);};
  const listenersKnown=()=>listenersState==='live';
  function problemText(d){
    const p=payloadProblem(d.payload);
    if(p==='secret')return SECRET_TEXT;               // never echoes the matched text
    if(p==='length')return TEXT.length;
    if(p==='chars')return TEXT.chars+blockedChars(d.payload).map(blockedCharText).join('; ');
    if(p==='empty'||p==='type')return TEXT.empty;
    if(kindProblem(d.kind,d.payload))return TEXT.messageLength;
    if(noTarget(d))return d.kind==='MESSAGE'?TEXT.noNotify:TEXT.noTarget;
    return '';
  }
  function render(){
    if(disposed)return;
    const d=draft();const n=payloadLength(d.payload);const max=d.kind==='MESSAGE'?MESSAGE_MAX:PAYLOAD_MAX;
    counter.textContent=n>max?`${n}/${max} — חריגה של ${n-max} תווים`:`${n}/${max}`;
    const level=payloadThreshold(d.payload);if(level!==lastThreshold){lastThreshold=level;limitLive.textContent=level?payloadThresholdText(level):'';}
    const payloadIssue=payloadProblem(d.payload)||kindProblem(d.kind,d.payload);
    error.textContent=payloadIssue&&payloadIssue!=='empty'?problemText(d):'';
    const locked=busy()||phase==='unconfirmed';
    for(const s of Object.values(selects))s.disabled=locked;kindSel.disabled=locked;payload.readOnly=locked;previewBtn.disabled=locked;
    const fresh=preview!==null&&preview.key===draftKey(d.payload,d.targets,d.kind);
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
    const lines=TARGET_AGENTS.filter(([,k])=>['EXECUTE','NOTIFY'].includes(preview.task.targets[k])).map(([a,k])=>[a,k,listenerLine(k)]).filter(x=>x[2]);
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
  function setKind(k){kind=k;kindSel.value=k;for(const key of TARGET_KEYS){const v=selects[key].value;fillOptions(selects[key],k);selects[key].value=KIND_VALUES[k].includes(v)?v:'IGNORE';}}
  function clearDraft(){taskId=null;hidePreview();payload.value='';setKind('TASK');kindNote.textContent='';for(const s of Object.values(selects))s.value='IGNORE';phase='idle';resume='idle';}
  function confirmedOk(text,task){if(task)sessionTasks.add(task.taskId);clearDraft();say(text);render();}
  const withTimeout=p=>{let t;return Promise.race([p,new Promise((_,reject)=>{t=setTimeout(()=>reject(Object.assign(Error('ACTIVE_TASK_TIMEOUT'),{code:'deadline-exceeded'})),sendTimeoutMs);})]).finally(()=>clearTimeout(t));};
  async function serverOutcome(task){
    if(rows.some(r=>r.id===task.taskId&&r.dispatchedBy===task.dispatchedBy&&r.payload===task.payload))return 'saved';
    try{return reconcileTask(task,await withTimeout(api.verify(task.taskId)));}catch{return 'unknown';}
  }
  async function reconcileNow(task,afterDenied){
    const ticket=++flight;phase='reconciling';render();
    const outcome=await serverOutcome(task);
    if(disposed||ticket!==flight)return;
    if(outcome==='saved'){confirmedOk(TEXT.alreadySaved,task);return;}
    if(outcome==='missing'&&afterDenied){phase='idle';say(TEXT.denied);render();return;}
    phase='unconfirmed';say(outcome==='conflict'?TEXT.conflict:outcome==='missing'?TEXT.notYet:TEXT.unconfirmed);render();
  }
  async function attempt(task){
    const ticket=++flight;phase='sending';say(TEXT.sending);render();
    try{await withTimeout(api.create(task,sendTimeoutMs));if(disposed||ticket!==flight)return;confirmedOk(TEXT.confirmed,task);}
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
    try{const task=buildTask({taskId,uid:api.uid?.()??uid,payload:d.payload,targets:d.targets,kind:d.kind});preview={task,key:draftKey(d.payload,d.targets,d.kind)};showPreview(task);say('');}
    catch(e){const m=String(e?.message);
      if(m==='INVALID_TASK_ID'){say(TEXT.badId);}
      else{taskId=null;say(m==='UID_REQUIRED'?TEXT.noIdentity:m==='INVALID_PAYLOAD'?(problemText(d)||TEXT.empty):m==='NO_NOTIFY_TARGET'?TEXT.noNotify:TEXT.noTarget);}}
    render();
  };
  send.onclick=async()=>{
    if(phase!=='idle')return;const d=draft();const current=preview;
    if(!current){say(TEXT.needPreview);return;}
    if(current.key!==draftKey(d.payload,d.targets,d.kind)){say(TEXT.stalePreview);return;}
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
      if(outcome==='saved'){confirmedOk(TEXT.alreadySaved,task);return;}
      clearDraft();say(TEXT.resetAfterUnconfirmed);render();return;
    }
    flight++;taskId=null;hidePreview();phase='idle';resume='idle';say(TEXT.resetDone);render();
  };
  for(const s of Object.values(selects))s.addEventListener('change',edited);
  // C8: kind change computes defaults ONCE (never on a heartbeat), invalidates the preview, and BLOCKS TASK -> MESSAGE
  // while any agent is EXECUTE (no silent conversion).
  kindSel.addEventListener('change',()=>{
    const want=kindSel.value;const cur=Object.fromEntries(TARGET_KEYS.map(k=>[k,selects[k].value]));
    const live=Object.fromEntries(TARGET_KEYS.map(k=>[k,listenerState(seen[k],now(),listenersKnown())]));
    const next=kindSwitch(kind,want,cur,live);
    if(!next){kindSel.value=kind;kindNote.textContent=TEXT.kindBlocked;render();return;}
    setKind(want);for(const k of TARGET_KEYS)selects[k].value=next.targets[k];
    kindNote.textContent=next.note==='notify_dropped'?TEXT.notifyDropped:'';edited();
  });
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
  const fresh=()=>feedState==='live';
  const ackOpts=k=>({serverNowMs:serverNow(now(),offset),fresh:fresh(),switchState:['on','off','missing'].includes(switchState)?switchState:'unknown',listenerAck:listenerMeta[k]?.ack??null});
  const acksFor=r=>TARGET_KEYS.map(k=>ackFor(r,k,ackOpts(k))).filter(Boolean);
  // C7: highlight a state change (<= 5 s, none under reduced motion); one polite region announces ONLY UNDERSTOOD /
  // UNREADABLE, and only for tasks created in this session.
  function noteAckChange(r,a,el){
    const id=r.id+':'+a.key;const prev=ackKinds.get(id);ackKinds.set(id,a.kind);
    if(prev===undefined||prev===a.kind)return;
    if(!reducedMotion()){el.classList.add('ack-changed');setTimeout(()=>el.classList.remove('ack-changed'),ACK_ANNOUNCE_MS);}
    if((a.kind==='understood'||a.kind==='unreadable')&&sessionTasks.has(r.id)&&!ackAnnounced.has(id)){
      ackAnnounced.add(id);ackLive.textContent=a.kind==='understood'?TEXT.announceUnderstood(a.agent):TEXT.announceUnreadable(a.agent);}
  }
  function refreshAcks(li,r){
    for(const a of acksFor(r)){const el=li.querySelector(`.active-ack[data-agent="${a.key}"]`);if(!el)continue;
      el.dataset.kind=a.kind;el.dataset.stale=String(a.stale);const st=el.querySelector('.active-ack-state');
      const text=a.kind==='understood'?(a.stale?TEXT.understoodLead+' · '+TEXT.stale:TEXT.understoodLead):a.text;
      if(st.textContent!==text)st.textContent=text;noteAckChange(r,a,el);}
  }
  // C6: clamp to 3 lines; the expand button exists only when the text is truncated; state per taskId+agent.
  function measureClamps(li){
    const run=()=>{for(const box of li.querySelectorAll('.active-ack-summary')){const clamp=box.querySelector('.clamp');const btn=box.parentElement.querySelector('.active-ack-expand');if(!clamp||!btn)continue;
      const id=btn.dataset.ack;const open=ackExpanded.has(id);
      if(open){btn.hidden=false;continue;}
      btn.hidden=!(clamp.scrollHeight>clamp.clientHeight+1);}};
    (win?.requestAnimationFrame??setTimeout)(run);
  }
  function ackBlock(r,a){
    const el=node('div',null,'active-ack');el.dataset.agent=a.key;el.dataset.kind=a.kind;el.dataset.stale=String(a.stale);
    const head=node('p',null,'active-ack-head');head.append(node('strong',a.agent+' '));
    const st=node('span',a.kind==='understood'?(a.stale?TEXT.understoodLead+' · '+TEXT.stale:TEXT.understoodLead):a.text,'active-ack-state');head.append(st);el.append(head);
    if(a.kind==='understood'&&typeof a.summary==='string'){
      const id=r.id+':'+a.key;const domId='active-ack-sum-'+r.id+'-'+a.key;
      el.append(node('p',TEXT.autoLabel,'active-ack-label'),node('p',TEXT.frame(a.agent),'active-ack-frame'));
      const quote=node('blockquote',null,'active-ack-summary');const clamp=node('div',null,'clamp');clamp.id=domId;
      const bdi=doc.createElement('bdi');bdi.setAttribute('dir','rtl');bdi.textContent=a.summary;clamp.append(bdi);quote.append(clamp);
      const open=ackExpanded.has(id);if(open)clamp.classList.add('clamp-open');
      const btn=button(open?TEXT.collapse:TEXT.expand,'active-ack-more-'+r.id+'-'+a.key,'active-ack-expand');btn.dataset.ack=id;
      btn.setAttribute('aria-controls',domId);btn.setAttribute('aria-expanded',String(open));btn.hidden=!open;
      btn.onclick=()=>{const now2=!ackExpanded.has(id);if(now2)ackExpanded.add(id);else ackExpanded.delete(id);
        clamp.classList.toggle('clamp-open',now2);btn.setAttribute('aria-expanded',String(now2));btn.textContent=now2?TEXT.collapse:TEXT.expand;if(!now2)measureClamps(el.closest('li')??el);};
      el.append(quote,btn);
      if(rowKind(r)==='TASK'&&r.targets[a.key]==='EXECUTE')el.append(node('p',TEXT.waitGo,'active-ack-go'));
    }
    return el;
  }
  function ownerButtons(r){
    const box=node('div',null,'active-owner');
    for(const [agent,key] of TARGET_AGENTS){
      const act=ownerAction(r,key);if(!act||r.dispatchedBy!==uid)continue;
      const pk=r.id+':'+key;const b=button(`${agent}: ${act==='start'?TEXT.start:TEXT.complete}`,`active-${act}-${r.id}-${key}`,'active-owner-btn');b.dataset.agent=key;b.dataset.action=act;
      b.disabled=progressPending.has(pk);
      b.onclick=async()=>{if(progressPending.has(pk))return;progressPending.add(pk);renderFeed();say(TEXT.progressSaving);
        try{await withTimeout(api.markProgress(r.id,key,act==='start'?'IN_PROGRESS':'COMPLETED',sendTimeoutMs));if(!disposed)say(TEXT.progressConfirmed);}
        catch(e){if(!disposed)say(classifyFailure(e)==='denied'?TEXT.progressDenied:TEXT.progressUnconfirmed);}
        finally{progressPending.delete(pk);renderFeed();rowNodes.get(r.id)?.focus({preventScroll:true});}};
      box.append(b);
    }
    return box.childElementCount?box:null;
  }
  function refreshLive(li,r){
    const chips=chipsFor(r);const overall=overallStatus(r,chips);refreshAcks(li,r);
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
    const acks=acksFor(r);const ackBox=node('div',null,'active-acks');ackBox.setAttribute('aria-label',TEXT.ackTitle);
    for(const a of acks)ackBox.append(ackBlock(r,a));
    const owner=ownerButtons(r);
    li.replaceChildren(head,times,list,...(acks.length?[ackBox]:[]),...(owner?[owner]:[]),...payloadParts(r));
    const overall=refreshLive(li,r);measureClamps(li);
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
  const sigOf=r=>JSON.stringify([r.status,r.dispatchedBy===uid,r.timestamp,r.payload,r.kind,r.targets,r.progress,r.acks,cancelPending.has(r.id),confirming.has(r.id),
    TARGET_KEYS.map(k=>progressPending.has(r.id+':'+k))]);
  function rowFor(r){
    let li=rowNodes.get(r.id);if(!li){li=node('li',null,'active-row');li.dataset.id=r.id;li.id='active-row-'+r.id;li.tabIndex=-1;rowNodes.set(r.id,li);}
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
    for(const [id,li] of rowNodes)if(!keep.has(id)){li.remove();rowNodes.delete(id);rowSigs.delete(id);expanded.delete(id);for(const k of TARGET_KEYS){ackExpanded.delete(id+':'+k);}}
    feedList.querySelector('.active-empty')?.remove();
    list.forEach((r,i)=>{const li=rowFor(r);if(feedList.children[i]!==li)feedList.insertBefore(li,feedList.children[i]??null);});
    if(!list.length&&feedState==='live')feedList.replaceChildren(node('li',TEXT.none,'active-empty'));
    else if(!list.length&&feedState==='idle'&&uid)feedList.replaceChildren(node('li',TEXT.loading,'active-empty active-loading'));   // before the first snapshot
    renderState();
  }
  function refreshAll(){if(disposed)return;const list=orderTasks(rows);for(const r of list){const li=rowNodes.get(r.id);if(li)refreshLive(li,r);}renderState();renderPreviewListeners();renderSwitch();}
  // C3: learn the server-time offset from server stamps seen on receipt (never used before the first stamp).
  function learnFromRows(list){const t=now();for(const r of list){offset=learnOffset(offset,r.timestamp,t);
    for(const k of TARGET_KEYS){const a=r.acks?.[k];if(a&&Number.isSafeInteger(a.updatedAt))offset=learnOffset(offset,a.updatedAt,t);
      const p=r.progress?.[k];if(p&&Number.isSafeInteger(p.updatedAt))offset=learnOffset(offset,p.updatedAt,t);}}}
  // ---- C5/C9: ack kill switch ----
  function renderSwitch(){
    if(disposed)return;
    const known=['on','off','missing'].includes(switchState);
    swText.textContent=switchState==='idle'?TEXT.switchLoading:switchState==='on'?TEXT.switchOn
      :switchState==='off'?TEXT.switchOffSince+(switchAt===null?'—':hhmm(switchAt)):switchState==='missing'?TEXT.switchMissing:TEXT.switchUnknown;
    sw.dataset.state=switchState;
    swStop.hidden=switchState!=='on';swEnable.hidden=switchState!=='off'||switchConfirming;swSeed.hidden=switchState!=='missing';
    swConfirm.hidden=!(switchConfirming&&switchState==='off');
    for(const b of [swStop,swEnable,swSeed,swYes,swNo])b.disabled=switchWriting||!known;
  }
  async function writeSwitch(enabled){
    if(switchWriting)return;
    const exists=switchState!=='missing';
    if((switchState==='on'&&enabled)||(switchState==='off'&&!enabled&&exists)){swResult.textContent=TEXT.switchSame;return;}
    switchWriting=true;swReauth.hidden=true;swResult.textContent=TEXT.switchSaving;renderSwitch();
    try{
      if(enabled||!exists){let at;try{at=await withTimeout(api.authTime());}catch{at=null;}
        if(disposed)return;if(at===null||needsReauth(at,now())){swResult.textContent=TEXT.switchReauth;swReauth.hidden=false;return;}}
      await withTimeout(api.setAckSwitch(enabled,{exists},sendTimeoutMs));
      if(!disposed){swResult.textContent=TEXT.switchConfirmed;switchConfirming=false;}
    }catch(e){if(!disposed)swResult.textContent=classifyFailure(e)==='denied'?TEXT.switchDenied:TEXT.switchUnconfirmed;}
    finally{switchWriting=false;renderSwitch();refreshAll();}
  }
  swStop.onclick=()=>{void writeSwitch(false);};
  swSeed.onclick=()=>{void writeSwitch(false);};
  swEnable.onclick=()=>{switchConfirming=true;renderSwitch();swYes.focus();};
  swNo.onclick=()=>{switchConfirming=false;renderSwitch();swEnable.focus();};
  swYes.onclick=()=>{void writeSwitch(true);};
  swReauth.onclick=()=>{let p;try{p=signIn();}catch{p=Promise.reject();}swReauth.hidden=true;swResult.textContent=TEXT.reauthDone;Promise.resolve(p).catch(()=>{});};
  function startSwitch(){
    if(stopSwitch||!uid||typeof api.watchAckSwitch!=='function')return;
    try{stopSwitch=api.watchAckSwitch({
      next(v,meta){if(disposed)return;
        if(meta?.fromCache===true||!v){if(switchState==='idle')switchState='unknown';else if(switchState!=='unknown')switchState='unknown';refreshAll();return;}
        switchState=v.state;switchAt=v.updatedAt??null;if(Number.isSafeInteger(switchAt))offset=learnOffset(offset,switchAt,now());refreshAll();notify();},
      error(){if(disposed)return;switchState='unknown';const s=stopSwitch;stopSwitch=null;try{s?.();}catch{}refreshAll();}});}
    catch{switchState='unknown';refreshAll();}
  }
  const notify=()=>{for(const fn of changeFns){try{fn();}catch{}}};
  function startFeed(){
    if(stopFeed||!uid)return;
    try{stopFeed=api.watch({
      next(list,meta){if(disposed)return;
        // A cached / offline snapshot is never shown as current: keep the last server rows, marked stale, with their time.
        if(meta?.fromCache===true||!Array.isArray(list)){feedState='cache';refreshAll();return;}
        rows=list;feedAt=now();feedState='live';learnFromRows(orderTasks(list));renderFeed();notify();},
      error(){if(disposed)return;feedState='error';const s=stopFeed;stopFeed=null;try{s?.();}catch{}refreshAll();}});}
    catch{feedState='error';refreshAll();}
  }
  function startListeners(){
    if(stopListeners||!uid)return;
    try{stopListeners=api.watchListeners({
      next(map,meta){if(disposed)return;
        if(meta?.fromCache===true||!map||typeof map!=='object'){listenersState='cache';}
        else{seen={...map};listenerMeta=meta?.meta&&typeof meta.meta==='object'?{...meta.meta}:{};listenersState='live';const t=now();for(const v of Object.values(seen))offset=learnOffset(offset,v,t);}
        refreshAll();notify();},
      error(){if(disposed)return;listenersState='error';const s=stopListeners;stopListeners=null;try{s?.();}catch{}refreshAll();notify();}});}
    catch{listenersState='error';refreshAll();notify();}
  }
  function start(){
    if(!uid)return;startFeed();startListeners();startSwitch();
    if(!tick&&tickMs>0)tick=setInterval(()=>{if(doc.hidden)return;refreshAll();notify();},tickMs);
  }
  reconnect.onclick=()=>{if(!uid)return;
    if(feedState==='error'){feedState='idle';startFeed();}
    if(listenersState==='error'){listenersState='idle';startListeners();}
    refreshAll();notify();};
  function stop(){for(const s of [stopFeed,stopListeners,stopSwitch]){try{s?.();}catch{}}stopFeed=stopListeners=stopSwitch=null;clearInterval(tick);tick=null;
    rows=[];seen={};feedState='idle';feedAt=null;listenersState='idle';confirming.clear();cancelPending.clear();rowNodes.clear();rowSigs.clear();expanded.clear();
    offset=null;listenerMeta={};switchState='idle';switchAt=null;switchWriting=false;switchConfirming=false;ackExpanded.clear();ackKinds.clear();ackAnnounced.clear();sessionTasks.clear();progressPending.clear();
    ackLive.textContent='';swResult.textContent='';renderSwitch();
    feedList.replaceChildren();renderState();notify();}
  renderSwitch();
  return {element:panel,
    // Agent card liveness line (Codex/Grok/Gemini): אין מאזין / מנותק / מאזין, or "לא ידוע (אין חיבור)" when the
    // listener stream failed — never "אין מאזין" for an unknown state.
    listenerStatus:{
      text(agent){const pair=TARGET_AGENTS.find(([a])=>a===agent);if(!pair||!uid)return null;
        return TEXT.listenerPrefix+(listenersState==='idle'?TEXT.loading:listenerText(seen[pair[1]],now(),listenersKnown()));},
      state(agent){const pair=TARGET_AGENTS.find(([a])=>a===agent);if(!pair||!uid)return null;return listenersState==='idle'?'loading':listenerState(seen[pair[1]],now(),listenersKnown());},
      // C1: the TARGET card's second line only: "אחרון: <ack state> · משימה HH:mm", linked to its feed row. Chips and the
      // summary stay in the feed (the cards are rebuilt with replaceChildren on every tick).
      ackLine(agent){const pair=TARGET_AGENTS.find(([a])=>a===agent);if(!pair||!uid)return null;const key=pair[1];
        const r=orderTasks(rows).find(x=>['EXECUTE','NOTIFY'].includes(x.targets[key]));if(!r)return null;
        const a=ackFor(r,key,ackOpts(key));if(!a)return null;
        return {text:TEXT.cardLast+a.text+TEXT.cardTask+hhmm(r.timestamp),href:'#active-row-'+r.id,rowId:r.id,kind:a.kind,stale:a.stale};},
      focusRow(id){const li=rowNodes.get(id);if(li){li.scrollIntoView?.({block:'center'});li.focus({preventScroll:true});}},
      onChange(fn){changeFns.add(fn);return()=>changeFns.delete(fn);}
    },
    setIdentity(user){
      if(disposed)return;const next=user?.backendAuthorized===true&&typeof user.uid==='string'&&user.uid?user.uid:null;
      // Sign-out: stop streams and clear the draft so no payload stays in the DOM.
      if(next===null){flight++;uid=null;panel.hidden=true;stop();clearDraft();say('');render();return;}
      if(draftUid!==null&&draftUid!==next){flight++;clearDraft();say('');}
      if(uid!==null&&uid!==next)stop();                 // a different identity never sees the previous feed
      draftUid=next;uid=next;panel.hidden=false;start();render();renderFeed();renderSwitch();
    },
    dispose(){disposed=true;flight++;win?.removeEventListener('online',netChange);win?.removeEventListener('offline',netChange);stop();changeFns.clear();},
    debugState(){return {phase,taskId,previewKey:preview?.key??null,feedState,listenersState,rows:rowNodes.size,kind,offset,switchState};}
  };
}
