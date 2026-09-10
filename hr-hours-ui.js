// DOM-only controller. The injected adapter owns authenticated transport;
// no personal data is persisted or embedded into URLs.
const labels = { missing:'לא הוגש דוח', draft:'ממתין לאישור העובד', submitted:'ממתין לאישור פיקודי', approved:'מאושר', unavailable:'נדרשת בדיקת נתונים' };
const warnings = { 'detail-hours-missing':'בחלק מהרשומות חסר סך שעות.', 'reported-day-detail-missing':'חסרים פרטים עבור ימים הרשומים בדוח.', 'detail-day-not-in-report':'יש ימי נוכחות שאינם כלולים בדוח השמור.', 'reported-total-missing':'בדוח השמור חסר סך השעות.', 'reported-total-differs':'סך השעות השמור שונה מפירוט הנוכחות הנוכחי.' };
const disconnected = { currentSession:()=>null, subscribeIdentity:()=>()=>{} };
const el = (tag, value, className) => { const node=document.createElement(tag); if(value!=null)node.textContent=String(value); if(className)node.className=className; return node; };
const number = value => typeof value==='number' && Number.isFinite(value) ? value.toLocaleString('he-IL',{maximumFractionDigits:2}) : '—';
const KEY=/^[a-f0-9]{64}$/;
function inspectionBlock(p, detail) {
  const box=el(detail?'div':'span',null,'hr-meta');box.dataset.hr='inspection';
  if(detail)box.append(el('h3','עיון משאבי אנוש — נפרד מאישור הדוח'));
  const show=value=>{box.append(el(detail?'p':'small',value));return box;};
  if(!Object.hasOwn(p,'review')&&!Object.hasOwn(p,'review_unavailable'))return show('מידע על עיון HR אינו זמין בגרסה זו.');
  if(p.review_unavailable===true)return show('נתוני עיון HR אינם זמינים לבדיקה.');
  if(p.review===null&&p.review_unavailable===false)return show('לא נרשם עיון HR.');
  const r=p.review,t=r?.reviewed_at;
  const millis=t&&t.seconds*1000+Math.floor(t.nanoseconds/1000000);
  const valid=r&&p.review_unavailable===false&&typeof r.review_id==='string'&&KEY.test(r.review_id)
    &&typeof r.reviewed_revision==='string'&&KEY.test(r.reviewed_revision)
    &&typeof r.actor_uid==='string'&&r.actor_uid.length>0&&r.actor_uid.length<=128&&!/[\u0000-\u001f\u007f/]/.test(r.actor_uid)
    &&[true,false,null].includes(r.current)&&t&&Number.isSafeInteger(t.seconds)&&t.seconds>=-62135596800&&t.seconds<=253402300799
    &&Number.isInteger(t.nanoseconds)&&t.nanoseconds>=0&&t.nanoseconds<=999999999&&Number.isFinite(new Date(millis).getTime());
  if(!valid)return show('נתוני עיון HR אינם זמינים לבדיקה.');
  if(detail&&r.current!==null&&(typeof p.snapshot_revision!=='string'||!KEY.test(p.snapshot_revision)||p.revision_unavailable!==false
      ||(p.snapshot_revision===r.reviewed_revision)!==r.current))return show('נתוני עיון HR אינם זמינים לבדיקה.');
  box.append(el(detail?'p':'small','עיון אחרון: '+new Date(millis).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'})));
  if(detail){const actor=el('p','מזהה הבודק: ');actor.append(el('bdi',r.actor_uid));box.append(actor);}
  return show(!detail||r.current===null?'עיון היסטורי — התאמה לגרסה הנוכחית לא אומתה.':r.current?'העיון תואם לתמונת הדוח שנטענה.':'הדוח השתנה מאז העיון.');
}
const actionLabels={discovering:'איתור נמענים',queued:'ממתינה להכנה',processing:'בהכנה',deferred:'ההכנה נדחתה',confirmation_required:'נדרש אישור שעות שקט',completed:'הכנת התזכורות הסתיימה',expired:'פג תוקף ההכנה',expired_partial:'פג תוקף לאחר הכנה חלקית',cancelled:'ההכנה בוטלה'};
const childLabels={queued:'ממתינה לטיפול',suppressed:'הושתקה',blocked:'חסומה',deferred:'נדחתה',attempting:'מתבצע ניסיון אצל הספק',no_device:'אין מכשיר זמין',cancelled:'בוטלה',accepted:'הספק קיבל — לא אישור מסירה',failed:'הניסיון נכשל',partial:'תוצאת ספק חלקית',outcome_unknown:'תוצאת הניסיון אינה ידועה'};
const reasons=new Set(['manual-quiet-hours-warning','job-expired','actor-no-longer-authorized','routine','system-silent','manual-quiet-hours-confirmed','invalid-path','identity-unavailable','identity-missing','auth-unavailable','invalid-actor','actor-revoked','actor-profile-unavailable','recipient-moved','recipient-inactive','recipient-invalid','recipient-binding-changed','report-invalid','report-completed','invalid-intent','parent-invalid','parent-cancelled','silent-state-unavailable','tokens-invalid','expired','no-current-token','token-limit','unconfirmed-outcome','attempt-expired','dispatch-window-closed','preflight-unavailable','page-check-unavailable','unavailable']);
const countKeys=['scanned','queued','suppressed','skipped','invalid'];
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const time=n=>integer(n)&&Number.isFinite(new Date(n).getTime());
const optionalTime=n=>n===null||time(n);
const counts=(v,keys)=>v&&keys.every(k=>integer(v[k]));
const uid=v=>typeof v==='string'&&v.length>0&&v.length<=128&&!v.includes('/');
const validReason=r=>r===null||reasons.has(r);
const validCursor=c=>c===null||(typeof c==='string'&&KEY.test(c));
const semantic=audience=>audience==='person'?'active_when_requested':'active_when_enqueue_page_scanned_with_completed_discovery_uid_upper_bound';
function validAction(a,rich,month,sid) {
  return a&&typeof a.action_id==='string'&&KEY.test(a.action_id)&&a.station_id===sid&&a.month===month
    &&['person','station'].includes(a.audience)&&Object.hasOwn(actionLabels,a.status)&&validReason(a.reason)
    &&counts(a.counts,countKeys)&&['person','discovery','enqueue','complete'].includes(a.phase)&&integer(a.discovery_scanned)
    &&time(a.created_at_ms)&&time(a.expires_at_ms)&&optionalTime(a.not_before_ms)
    &&a.delivery_status==='intent_only'&&a.audience_semantics===semantic(a.audience)
    &&(!rich||(a.status_scope==='generation_only'&&time(a.updated_at_ms)&&(a.audience==='person'?uid(a.recipient_uid):a.recipient_uid===null)));
}
function validChild(c,a) {
  return c&&typeof c.id==='string'&&KEY.test(c.id)&&uid(c.recipient_uid)&&(a.audience!=='person'||c.recipient_uid===a.recipient_uid)
    &&['report_submit','report_confirm'].includes(c.type)&&(c.dispatch_type===null||['report_submit','report_confirm'].includes(c.dispatch_type))
    &&Object.hasOwn(childLabels,c.status)&&validReason(c.reason)&&typeof c.terminal==='boolean'
    &&time(c.created_at_ms)&&time(c.expires_at_ms)&&['updated_at_ms','finished_at_ms','not_before_ms','next_check_ms'].every(k=>optionalTime(c[k]))
    &&['intent_only','provider_outcome_only'].includes(c.delivery_status)
    &&(c.outcome_counts===null||counts(c.outcome_counts,['accepted','failed','outcome_unknown']));
}
const definite=new Set(['invalid-argument','already-exists','aborted','not-found','failed-precondition','resource-exhausted','permission-denied','unauthenticated']);
const errorCode=e=>String(e?.code||'').replace(/^functions\//,'');
const stamp=n=>new Date(n).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'});
function sessionKey(adapter) {
  try {
  const s=adapter.currentSession();
  if(!s || typeof s.uid!=='string' || !s.uid || typeof s.stationId!=='string' || !s.stationId || !(s.super===true || s.role==='hr_coordinator'))return null;
  return JSON.stringify([s.uid,s.stationId,s.role,s.super===true,s.epoch]);
  } catch (_) { return null; }
}
export function previousHrMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit'
  }).formatToParts(now);
  const year = Number(parts.find(p => p.type === 'year').value);
  const month = Number(parts.find(p => p.type === 'month').value);
  return String(month === 1 ? year - 1 : year) + '-' + String(month === 1 ? 12 : month - 1).padStart(2, '0');
}
export function createHrHoursUI(root, adapter=disconnected) {
  const q = key => root.querySelector('[data-hr="'+key+'"]');
  let owner=null, generation=0, detailGeneration=0, items=[], cursor=null, selected=-1, loading=false, disposed=false, suspended=false;
  let loadedDetail=null, loadedFreshness=null, pending=null, busy=false, confirmation=null;
  let reviewPending=null, reviewBusy=false, reviewRefresh=null, reviewId=null, reviewUncertain=false;
  let history=[], historyCursor=null, historyLoading=false, historyGeneration=0;
  let action=null, actionId=null, children=[], childCursor=null, statusLoading=false, statusGeneration=0;
  const reviewFeedback=el('div',null,'hr-notice'),reviewMessage=el('p'),reviewRetry=el('button','ניסיון חוזר לאותה שמירת עיון');
  reviewFeedback.dataset.hr='review-feedback';reviewMessage.dataset.hr='review-message';reviewMessage.setAttribute('role','status');
  reviewRetry.type='button';reviewRetry.dataset.hr='review-retry';reviewFeedback.append(reviewMessage,reviewRetry);q('detail').after(reviewFeedback);
  const locked=()=>busy||!!pending||reviewBusy||!!reviewPending||!!reviewRefresh;
  const lockedMonth=()=>pending?.data.month||reviewPending?.data.month||reviewRefresh?.data.month||loadedDetail?.month;
  const sid=()=>JSON.parse(owner)[1];
  // Locale format order is not a date-key contract.
  q('month').value=previousHrMonth();
  const message = value => { q('message').textContent=value; };
  function clearDetail(value='בחרו עובד לצפייה בדוח.') { loadedDetail=null;loadedFreshness=null;q('detail').replaceChildren(el('p',value)); }
  function controls() {
    q('previous').disabled=!owner || locked() || selected<=0;
    q('next').disabled=!owner || locked() || loading || (selected>=items.length-1 && !cursor);
    q('more').hidden=!cursor; q('more').disabled=loading||locked();
    q('refresh').disabled=!owner||locked(); q('month').disabled=!owner||locked();
    q('nudges').hidden=!owner;q('history').hidden=!owner;
    for(const name of ['nudge-station','send-now','history-refresh','confirm'])q(name).disabled=!owner||locked();
    q('retry').disabled=!owner||busy;q('pending').hidden=!pending||busy;
    reviewFeedback.hidden=!reviewMessage.textContent&&!reviewPending;
    reviewRetry.hidden=!reviewPending||reviewBusy;reviewRetry.disabled=!owner||reviewBusy||!!reviewRefresh;
    q('confirmation').hidden=!confirmation;q('actions-more').hidden=!historyCursor;q('actions-more').disabled=locked()||historyLoading;
    q('status-refresh').hidden=!actionId;q('status-refresh').disabled=locked()||statusLoading;
    q('children-more').hidden=!childCursor;q('children-more').disabled=locked()||statusLoading;
    for(const button of root.querySelectorAll('.hr-person,.hr-action-list button,[data-hr="nudge-person"],[data-hr="detail-fresh"],[data-hr="review-save"]'))button.disabled=!owner||locked();
    q('position').textContent=selected<0?'':(selected+1)+' מתוך '+items.length+(cursor?' ומעלה':'');
    q('count').textContent=items.length ? items.length+' עובדים נטענו'+(cursor?' · יש נוספים':'') : '';
  }
  function mayAct(){return alive(generation,owner)&&!locked();}
  function resetStatus() {
    ++historyGeneration;++statusGeneration;history=[];historyCursor=null;historyLoading=false;
    action=null;actionId=null;children=[];childCursor=null;statusLoading=false;
    q('actions').replaceChildren();q('action-detail').replaceChildren();q('history-message').textContent='';q('status-message').textContent='';
  }
  function resetActions() {
    pending=null;busy=false;confirmation=null;q('send-now').checked=false;
    reviewPending=null;reviewBusy=false;reviewRefresh=null;reviewId=null;reviewUncertain=false;reviewMessage.textContent='';
    q('nudge-message').textContent='';q('confirmation-text').textContent='';resetStatus();
  }
  const recipientName=id=>items.find(p=>p.uid===id)?.full_name||'עובד שטרם נטען · שם לא זמין';
  const audienceLabel=a=>a.audience==='station'?'כל התחנה':recipientName(a.recipient_uid);
  function summary(a) {
    const box=el('div',null,'hr-action-summary');
    box.append(el('h3',audienceLabel(a)+' · '+a.month),el('p',actionLabels[a.status]),el('p','נרשמה: '+stamp(a.created_at_ms),'hr-meta'));
    box.append(el('p','הכנה בלבד: נסרקו '+number(a.counts.scanned)+' · בתור '+number(a.counts.queued)+' · הושתקו '+number(a.counts.suppressed)+' · דולגו '+number(a.counts.skipped)+' · נתונים לא תקינים '+number(a.counts.invalid)+'. אותרו בחיפוש: '+number(a.discovery_scanned)+'.'));
    if(a.not_before_ms!==null)box.append(el('p','לא לפני '+stamp(a.not_before_ms)));
    if(a.reason==='system-silent')box.append(el('p','השתקת המערכת חלה.'));
    if(['expired','expired_partial'].includes(a.status)||a.reason==='job-expired')box.append(el('p','תוקף הפעולה פג; לא תתחדש אוטומטית.'));
    return box;
  }
  function renderHistory() {
    q('actions').replaceChildren();
    const g=generation,key=owner,h=historyGeneration;
    for(const a of history){
      const button=el('button',audienceLabel(a)+' · '+stamp(a.created_at_ms)+' · '+actionLabels[a.status]);button.type='button';button.dataset.action=a.action_id;
      button.addEventListener('click',()=>{if(alive(g,key)&&h===historyGeneration&&mayAct())void showStatus(a.action_id);});q('actions').append(button);
    }
    controls();
  }
  async function loadHistory(append=false) {
    if(!mayAct()||historyLoading)return;
    const g=generation,key=owner,month=q('month').value,h=++historyGeneration;
    historyLoading=true;q('history-message').textContent='טוען בקשות…';controls();
    try{
      const result=await adapter.listNudges({month,...(append&&historyCursor?{cursor:historyCursor}:{})});
      if(!alive(g,key)||h!==historyGeneration)return;
      if(!result||result.month!==month||!Array.isArray(result.items)||result.items.length>25||!validCursor(result.next_cursor)||!result.items.every(a=>validAction(a,true,month,sid())))throw new Error('invalid status list');
      const merged=append?history.concat(result.items):result.items;
      if(new Set(merged.map(a=>a.action_id)).size!==merged.length)throw new Error('duplicate action');
      history=merged;historyCursor=result.next_cursor;renderHistory();
      q('history-message').textContent=history.length?'תמונת מצב של הבקשות שלי; עמודים נוספים נטענים רק בלחיצה.':historyCursor?'אין בקשות בעמוד הזה; ניתן להמשיך לעמוד הבא.':'אין בקשות שלי להצגה בחודש הזה.';
    }catch(e){if(alive(g,key)&&h===historyGeneration){history=[];historyCursor=null;renderHistory();q('history-message').textContent='רשימת הבקשות אינה זמינה כרגע. אפשר לרענן; בקשה שנרשמה אינה מתבטלת.';}}
    finally{if(alive(g,key)&&h===historyGeneration){historyLoading=false;controls();}}
  }
  function renderStatus() {
    const target=q('action-detail');target.replaceChildren();if(!action)return;
    target.append(summary(action),el('p','תוצאות ספק מוצגות לכל רשומה בלבד, לא כסיכום של כל התחנה. קבלה אצל הספק אינה הוכחה למסירה או לקריאה. העמודים הם תמונות מצב וייתכנו תזכורות נוספות בזמן ההכנה.','hr-meta'));
    for(const c of children){
      const row=el('div',null,'hr-outcome');row.append(el('h4',recipientName(c.recipient_uid)),el('p',(c.dispatch_type||c.type)==='report_submit'?'תזכורת להגשת דוח':'תזכורת לאישור דוח'),el('p',childLabels[c.status]));
      if(c.reason==='expired'||c.reason==='attempt-expired')row.append(el('p','פג תוקף הטיפול.'));
      if(c.reason==='system-silent')row.append(el('p','השתקת מערכת.'));
      if(c.delivery_status==='provider_outcome_only'&&c.outcome_counts!==null)row.append(el('p','תוצאת ספק לרשומה זו בלבד: התקבלו '+number(c.outcome_counts.accepted)+' · נכשלו '+number(c.outcome_counts.failed)+' · לא ידוע '+number(c.outcome_counts.outcome_unknown)+'.'));
      else row.append(el('p','תוצאת ספק אינה זמינה; אין להסיק אפס ניסיונות או מסירה.'));
      target.append(row);
    }
    if(!children.length)target.append(el('p','אין תוצאות בעמוד הזה. אין בכך אישור למסירה או לסיום כל הטיפול.'));
  }
  async function showStatus(id,append=false) {
    if(!mayAct()||(append&&statusLoading))return;
    const g=generation,key=owner,month=q('month').value,s=++statusGeneration;
    const continuation=append?childCursor:null;actionId=id;statusLoading=true;
    if(!append){action=null;children=[];childCursor=null;renderStatus();}
    q('status-message').textContent='טוען מצב בקשה…';controls();
    try{
      const result=await adapter.getNudgeStatus({action_id:id,...(continuation?{cursor:continuation}:{})});
      if(!alive(g,key)||s!==statusGeneration||id!==actionId)return;
      if(!result||!validAction(result.action,true,month,sid())||result.action.action_id!==id||result.outcomes_scope!=='this_page_only'||!Array.isArray(result.items)||result.items.length>25||!validCursor(result.next_cursor)||!result.items.every(c=>validChild(c,result.action)))throw new Error('invalid status');
      const merged=append?children.concat(result.items):result.items;
      if(new Set(merged.map(c=>c.id)).size!==merged.length)throw new Error('duplicate result');
      action=result.action;children=merged;childCursor=result.next_cursor;renderStatus();q('status-message').textContent='המצב נקרא בלבד; רענון אינו שולח מחדש או מחיה בקשה.';
    }catch(e){if(alive(g,key)&&s===statusGeneration){action=null;children=[];childCursor=null;renderStatus();q('status-message').textContent='מצב הבקשה אינו זמין כרגע. בקשה שכבר נרשמה נשארת רשומה; רעננו את המצב בלבד.';}}
    finally{if(alive(g,key)&&s===statusGeneration){statusLoading=false;controls();}}
  }
  function startNudge(target=null,confirmed=null) {
    if(!mayAct())return;
    if(target&&!(target===loadedDetail&&loadedFreshness?.source==='server'&&target.month===q('month').value&&target.reminder_eligible===true&&target.historical===false&&['missing','draft'].includes(target.state)))return;
    const basis=confirmed?confirmed.data:{month:q('month').value,...(target?{uid:target.uid}:{}),send_now:q('send-now').checked};
    const data=Object.freeze({...basis,request_id:crypto.randomUUID(),send_now:confirmed?true:basis.send_now});
    pending=Object.freeze({data,key:owner,g:generation,name:confirmed?confirmed.name:target?.full_name||'כל התחנה'});
    confirmation=null;q('confirmation-text').textContent='';q('send-now').checked=false;void submitPending();
  }
  async function submitPending() {
    if(!pending||busy||!alive(pending.g,pending.key))return;
    const op=pending;busy=true;controls();q('nudge-message').textContent='רושם בקשת תזכורת…';
    let result;
    try{
      result=await adapter.requestNudge(op.data);
      if(!alive(op.g,op.key)||pending!==op)return;
      if(!validAction(result,false,op.data.month,sid())||result.audience!==(Object.hasOwn(op.data,'uid')?'person':'station'))throw new Error('invalid action response');
    }catch(e){
      if(alive(op.g,op.key)&&pending===op){
        if(definite.has(errorCode(e))){pending=null;q('nudge-message').textContent=errorCode(e)==='resource-exhausted'?'בוצעו פעולות רבות. המתינו לפני בקשה חדשה.':errorCode(e)==='already-exists'?'קיימת בקשה או שמזהה הבקשה מתנגש. בדקו את הרשימה לפני פעולה חדשה.':'לא ניתן לרשום את הבקשה במצב הנוכחי. רעננו את הנתונים או את ההתחברות לפני פעולה חדשה.';}
        else q('nudge-message').textContent='לא ניתן לקבוע אם הבקשה נקלטה. השתמשו רק בניסיון חוזר לאותה בקשה.';
      }
      return;
    }finally{if(alive(op.g,op.key)&&(pending===op||pending===null)){busy=false;controls();}}
    // Registration is a completed mutation. Subsequent read failures cannot
    // recreate a retry record or turn known success into an uncertain write.
    pending=null;busy=false;
    q('nudge-message').textContent='הבקשה נרשמה: '+op.name+' · '+op.data.month+'. '+actionLabels[result.status]+'. אין בכך אישור למסירה או לקריאה.';
    if(result.status==='confirmation_required'){
      confirmation=op;q('confirmation-text').textContent='הבקשה נרשמה ללא תזכורות בשעות השקט 22:00–07:00. לאשר בקשה חדשה כעת עבור '+op.name+' · '+op.data.month+'? השתקת מערכת עדיין חלה.';
    }
    controls();void showStatus(result.action_id);void loadHistory();
  }
  function alive(g, key) {
    if(disposed||suspended)return false;
    if(sessionKey(adapter)!==owner){ resetIdentity(); return false; }
    return generation===g && owner===key && !!owner;
  }
  function reviewOwner(op) {
    if(!alive(op.g,op.key))return false;
    try { if(adapter.currentSession()===op.session)return true; } catch (_) {}
    resetIdentity();return false;
  }
  const currentReview=op=>reviewOwner(op)&&reviewPending===op;
  function validReviewResult(value,op) {
    return value&&typeof value==='object'&&!Array.isArray(value)
      &&Object.keys(value).sort().join(',')==='current,duplicate,review_id,reviewed_revision'
      &&value.review_id===reviewId&&value.reviewed_revision===op.data.expected_revision
      &&typeof value.duplicate==='boolean'&&[true,false,null].includes(value.current)
      &&(value.duplicate||value.current===true);
  }
  function startReview(target) {
    if(!mayAct()||loading||typeof adapter.reviewEmployeeMonth!=='function'
      ||target!==loadedDetail||loadedFreshness?.source!=='server'||items[selected]?.uid!==target.uid
      ||target.month!==q('month').value||!['draft','submitted','approved'].includes(target.state)
      ||target.revision_unavailable!==false||typeof target.snapshot_revision!=='string'||!KEY.test(target.snapshot_revision))return;
    let data,session;
    try {
      session=adapter.currentSession();
      data=Object.freeze({month:target.month,uid:target.uid,expected_revision:target.snapshot_revision,request_id:crypto.randomUUID()});
    } catch (_) {reviewMessage.textContent='לא ניתן להכין שמירת עיון מאובטחת. לא נשלחה בקשה.';controls();return;}
    // Lock the exact intent synchronously, including while its receipt ID hashes.
    ++detailGeneration;
    reviewPending=Object.freeze({data,session,key:owner,g:generation,name:target.full_name||'העובד'});
    reviewId=null;reviewUncertain=false;void submitReview();
  }
  async function submitReview() {
    if(!reviewPending||reviewBusy||reviewRefresh||!currentReview(reviewPending))return;
    const op=reviewPending;reviewBusy=true;reviewMessage.textContent='שומר תיעוד עיון…';controls();
    let result=null,attempted=false;
    try {
      if(reviewId===null){
        const bytes=new TextEncoder().encode(JSON.stringify(['hr-review-event-v1',op.session.uid,op.data.request_id]));
        const digest=await crypto.subtle.digest('SHA-256',bytes);
        if(!currentReview(op))return;
        reviewId=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
      }
      if(!currentReview(op))return;
      attempted=true;
      result=await adapter.reviewEmployeeMonth(op.data);
      if(!currentReview(op))return;
      if(!validReviewResult(result,op))throw new Error('Invalid inspection receipt.');
    } catch (e) {
      result=null;
      if(currentReview(op)){
        if(!attempted){
          reviewPending=null;reviewId=null;reviewMessage.textContent='לא ניתן להכין שמירת עיון מאובטחת. לא נשלחה בקשה.';
        }else if(!reviewUncertain&&definite.has(errorCode(e))){
          reviewPending=null;reviewId=null;
          clearDetail('שמירת העיון לא הושלמה. יש לקרוא את הדוח מחדש לפני פעולה חדשה.');
          reviewMessage.textContent=errorCode(e)==='resource-exhausted'?'בוצעו שמירות עיון רבות. המתינו ורעננו את הדוח לפני פעולה חדשה.':errorCode(e)==='aborted'?'הדוח השתנה. יש לרענן ולעיין בגרסה העדכנית; לא בוצעה שמירה אוטומטית לגרסה אחרת.':'לא ניתן לשמור עיון במצב הנוכחי. יש לרענן את הדוח או את ההתחברות.';
        }else{
          reviewUncertain=true;reviewMessage.textContent='לא ניתן לקבוע אם העיון נשמר. השתמשו רק בניסיון חוזר לאותה שמירת עיון; המזהה והדוח נשמרים ללא שינוי.';
        }
      }
    } finally {
      if(reviewOwner(op)&&(reviewPending===op||reviewPending===null)&&reviewRefresh===null){reviewBusy=false;controls();}
    }
    if(!result||!currentReview(op))return;
    // This is known success. A failed following read cannot resurrect the write.
    reviewPending=null;reviewBusy=false;reviewId=null;reviewUncertain=false;reviewRefresh=op;
    reviewMessage.textContent='העיון נרשם עבור '+op.name+' · '+op.data.month+'. זהו תיעוד עיון בלבד, לא אישור הדוח. התראה כפופה לשעות שקט ולהשתקת המערכת; מצב מסירה אינו מאומת כאן.';
    const d=++detailGeneration;clearDetail('העיון נרשם. טוען את הדוח מחדש…');controls();
    try {
      const response=await adapter.getEmployeeMonth({month:op.data.month,uid:op.data.uid},{forceFresh:true});
      if(!reviewOwner(op)||reviewRefresh!==op||d!==detailGeneration)return;
      const value=response?.report,freshness=response?.freshness;
      if(!value||value.uid!==op.data.uid||value.month!==op.data.month||!Array.isArray(value.rows)
        ||!freshness||freshness.source!=='server'||!time(freshness.fetched_at_ms)||!time(freshness.expires_at_ms)||freshness.expires_at_ms<=freshness.fetched_at_ms)throw new Error('Invalid refreshed report.');
      items=items.map(p=>{
        if(p.uid!==value.uid)return p;
        const updated={...p};
        for(const key of ['review','review_unavailable']){if(Object.hasOwn(value,key))updated[key]=value[key];else delete updated[key];}
        return updated;
      });
      renderPeople();renderDetail(value,freshness);
    }catch(_){
      if(reviewOwner(op)&&reviewRefresh===op&&d===detailGeneration){
        clearDetail('העיון נשמר, אך הדוח לא נטען מחדש. בחרו את העובד או רעננו כדי לקרוא שוב; אין לשלוח שמירה חוזרת.');
        reviewMessage.textContent+=' הרענון נכשל, אך שמירת העיון אינה מתבטלת.';
      }
    }finally{if(reviewOwner(op)&&reviewRefresh===op){reviewRefresh=null;controls();}}
  }
  function renderPeople() {
    q('people').replaceChildren();
    for(const [index,p] of items.entries()) {
      const button=el('button',null,'hr-person'); button.type='button'; button.dataset.uid=p.uid;
      button.setAttribute('aria-pressed',String(index===selected));
      button.append(el('strong',p.full_name || 'שם חסר'),el('small',(labels[p.state]||labels.unavailable)+(p.historical?' · עובד לשעבר':'')));
      button.append(inspectionBlock(p,false));
      const g=generation,key=owner;
      button.addEventListener('click',()=>{ if(alive(g,key))select(index); });
      q('people').append(button);
    }
    controls();
  }
  function renderDetail(p,freshness) {
    loadedDetail=p;loadedFreshness=freshness;
    const detail=q('detail'); detail.replaceChildren(el('h2',p.full_name),el('span',labels[p.state]||labels.unavailable,'hr-tag'),
      el('p','מספר עובד '+p.employee_number+' · '+p.month+(p.crew?' · משמרת '+p.crew:''),'hr-meta'));
    detail.append(el('p',(freshness.source==='memory'?'תמונת מצב מזיכרון הדף בלבד':'נקרא מהשרת')+' · זמן קריאה: '+stamp(freshness.fetched_at_ms)+'. ייתכן שהנתונים השתנו מאז.','hr-meta'));
    if(freshness.source==='memory'){
      detail.append(el('p','לפני בקשת תזכורת אישית או שמירת עיון יש לבדוק את הדוח מחדש מול השרת. הבדיקה אינה שולחת תזכורת ואינה שומרת עיון.','hr-notice'));
      const fresh=el('button','בדיקת דוח עדכני מהשרת');fresh.type='button';fresh.dataset.hr='detail-fresh';
      const g=generation,key=owner,d=detailGeneration,index=selected;
      fresh.addEventListener('click',()=>{if(alive(g,key)&&d===detailGeneration&&mayAct())void select(index,true);});detail.append(fresh);
    }
    detail.append(inspectionBlock(p,true));
    if(typeof adapter.reviewEmployeeMonth==='function'&&freshness.source==='server'&&['draft','submitted','approved'].includes(p.state)
      &&p.revision_unavailable===false&&typeof p.snapshot_revision==='string'&&KEY.test(p.snapshot_revision)){
      const button=el('button','שמירת עיון HR בדוח שנטען');button.type='button';button.dataset.hr='review-save';
      const g=generation,key=owner,d=detailGeneration;
      button.addEventListener('click',()=>{if(alive(g,key)&&d===detailGeneration)startReview(p);});detail.append(button);
    }
    if(p.historical)detail.append(el('p','דוח היסטורי של עובד שאינו פעיל בתחנה.','hr-notice'));
    const totals=el('div',null,'hr-totals');
    for(const [title,value] of [['סך שעות בדוח השמור',p.stored_total_hours],['סך שעות בפירוט הנוכחי',p.current_detail_total_hours]]) {
      const box=el('div',title,'hr-total');box.append(el('strong',number(value)));totals.append(box);
    }
    detail.append(totals,el('p','הפירוט מציג את רשומות הנוכחות הנוכחיות. אם תוקנו מאז אישור הדוח, ההבדל בסכומים מוצג כאן.','hr-meta'));
    for(const warning of p.warnings||[])detail.append(el('p',warnings[warning]||'יש נתונים בדוח הדורשים בדיקה.','hr-notice'));
    if(freshness.source==='server'&&p.reminder_eligible===true&&p.historical===false&&['missing','draft'].includes(p.state)){
      const button=el('button',p.state==='missing'?'בקשת תזכורת להגשת הדוח':'בקשת תזכורת לאישור הדוח');button.type='button';button.dataset.hr='nudge-person';
      const g=generation,key=owner,d=detailGeneration;
      button.addEventListener('click',()=>{if(alive(g,key)&&d===detailGeneration)startNudge(p);});detail.append(button);controls();
    }
    if(!p.rows.length){detail.append(el('p','אין רשומות נוכחות לחודש הזה.'));return;}
    const wrap=el('div',null,'hr-table-wrap');wrap.tabIndex=0;wrap.setAttribute('aria-label','פירוט שעות · ניתן לגלול לרוחב');
    const table=el('table'),head=el('thead'),tr=el('tr');
    for(const title of ['תאריך','סוג יום','כניסה','יציאה','מקום','הערות','שעות']){const th=el('th',title);th.scope='col';tr.append(th);}head.append(tr);table.append(head);
    const body=el('tbody');
    for(const row of p.rows){
      const r=el('tr');
      const end=value=>value===1?' (+יום)':value===2?' (+יומיים)':'';
      const reasons=[['סיבה',row.reason],['הערות',row.notes],['נימוק לחריגה',row.overtime_reason]];
      const notes=reasons.filter((entry,i)=>entry[1]&&reasons.findIndex(other=>other[1]===entry[1])===i)
        .map(([label,value])=>label+': '+value).join('\n');
      [row.date,row.day_type_he||'—',row.start||'—',(row.end||'—')+end(row.end_day),row.site_name||'—',notes,number(row.hours)].forEach((value,i)=>r.append(el('td',value,i===2||i===3?'hr-range':'')));
      if(row.start2){
        const interval=el('bdi',row.start2+'–'+(row.end2||'—'),'hr-range');interval.dir='ltr';
        r.children[5].append(el('br'),document.createTextNode('מקטע נוסף: '),interval,document.createTextNode(end(row.end_day2)));
      }
      body.append(r);
    }
    table.append(body);wrap.append(table);detail.append(wrap);
  }
  async function select(index,forceFresh=false) {
    const g=generation,key=owner;if(!alive(g,key)||locked()||!items[index])return;
    q('send-now').checked=false;
    selected=index;const d=++detailGeneration,p=items[index];
    q('people').querySelectorAll('.hr-person').forEach((button,i)=>button.setAttribute('aria-pressed',String(i===selected)));
    controls();clearDetail('טוען דוח…');
    if(p.state==='unavailable'){clearDetail('נתוני העובד דורשים בדיקה. אפשר להמשיך לדוח הבא.');return;}
    const month=q('month').value;
    try {
      const result=await adapter.getEmployeeMonth({month,uid:p.uid},{forceFresh});
      if(!alive(g,key)||d!==detailGeneration)return;
      const value=result?.report,freshness=result?.freshness;
      if(!value || value.uid!==p.uid || value.month!==month || !Array.isArray(value.rows))throw new Error('invalid response');
      if(!freshness||!['server','memory'].includes(freshness.source)||!time(freshness.fetched_at_ms)||!time(freshness.expires_at_ms)||freshness.expires_at_ms<=freshness.fetched_at_ms||(forceFresh&&freshness.source!=='server'))throw new Error('invalid freshness');
      renderDetail(value,freshness);controls();
    }catch(e){if(alive(g,key)&&d===detailGeneration)clearDetail('לא ניתן לטעון את הדוח כרגע. רעננו או עברו לדוח הבא.');}
  }
  async function loadPage(append=false, selectNew=false) {
    const g=generation,key=owner;if(!alive(g,key)||locked()||loading)return;
    const month=q('month').value,offset=items.length;loading=true;controls();message('טוען דוחות…');
    try {
      const value=await adapter.listMonth({month,...(append&&cursor?{cursor}: {})});
      if(!alive(g,key))return;
      if(!value || value.month!==month || !Array.isArray(value.items) || !(value.next_cursor===null || typeof value.next_cursor==='string'))throw new Error('invalid response');
      const merged=append?items.concat(value.items):value.items;
      if(merged.some(p=>!p||typeof p.uid!=='string') || new Set(merged.map(p=>p.uid)).size!==merged.length)throw new Error('invalid people');
      items=merged;cursor=value.next_cursor;renderPeople();message(items.length?'בחרו עובד, או עברו בין הדוחות עם החצים.':cursor?'לא נמצאו עובדים להצגה בעמוד זה. ניתן להמשיך לעמוד הבא.':'אין עובדים להצגה בחודש הזה.');
      if(selectNew&&items[offset])await select(offset);
    }catch(e){if(alive(g,key)){items=[];cursor=null;selected=-1;++detailGeneration;renderPeople();clearDetail('רשימת הדוחות אינה זמינה כרגע.');message('טעינת הדוחות נכשלה. לחצו רענון כדי לנסות שוב.');}}
    finally{if(alive(g,key)){loading=false;controls();}}
  }
  function refresh() {
    if(suspended||disposed)return;
    if(sessionKey(adapter)!==owner){resetIdentity();return;}
    if(locked()){const month=lockedMonth();if(month)q('month').value=month;return;}
    adapter.clearReportCache?.();
    ++generation;++detailGeneration;items=[];cursor=null;selected=-1;loading=false;renderPeople();clearDetail();
    confirmation=null;q('send-now').checked=false;q('confirmation-text').textContent='';q('nudge-message').textContent='';reviewMessage.textContent='';resetStatus();controls();
    if(owner){void loadPage();void loadHistory();}
  }
  function resetIdentity() {
    adapter.clearReportCache?.();
    owner=suspended?null:sessionKey(adapter);++generation;++detailGeneration;items=[];cursor=null;selected=-1;loading=false;
    resetActions();
    renderPeople();clearDetail(owner?'בחרו עובד לצפייה בדוח.':'נדרש חיבור עם הרשאת משאבי אנוש.');
    message(owner?'טוען…':'ממתין לחיבור מאובטח עם הרשאה מתאימה.');if(owner){void loadPage();void loadHistory();}
  }
  const next=()=>{if(!mayAct())return;if(selected+1<items.length)void select(selected+1);else if(cursor)void loadPage(true,true);};
  const previous=()=>{if(mayAct()&&selected>0)void select(selected-1);};
  const more=()=>{if(mayAct()&&cursor)void loadPage(true);};
  const keydown=e=>{if(e.altKey||e.ctrlKey||e.metaKey||e.shiftKey||e.target.closest('input,textarea,select,[contenteditable]'))return;if(e.key==='ArrowLeft'&&!q('next').disabled){e.preventDefault();next();}else if(e.key==='ArrowRight'&&!q('previous').disabled){e.preventDefault();previous();}};
  q('month').addEventListener('change',refresh);q('refresh').addEventListener('click',refresh);q('next').addEventListener('click',next);q('previous').addEventListener('click',previous);q('more').addEventListener('click',more);root.addEventListener('keydown',keydown);
  const bindings=[['nudge-station',()=>startNudge()],['retry',()=>void submitPending()],['confirm',()=>{if(confirmation)startNudge(null,confirmation);}],
    ['history-refresh',()=>{if(mayAct()){resetStatus();controls();void loadHistory();}}],['actions-more',()=>{if(historyCursor)void loadHistory(true);}],
    ['status-refresh',()=>{if(actionId)void showStatus(actionId);}],['children-more',()=>{if(actionId&&childCursor)void showStatus(actionId,true);}]];
  for(const [name,fn] of bindings)q(name).addEventListener('click',fn);
  const beforeUnload=e=>{if(locked()){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);
  const pagehide=()=>{suspended=true;resetIdentity();};
  const pageshow=()=>{if(!disposed&&suspended){suspended=false;resetIdentity();}};
  reviewRetry.addEventListener('click',submitReview);window.addEventListener('pagehide',pagehide);window.addEventListener('pageshow',pageshow);
  const unsubscribe=adapter.subscribeIdentity(resetIdentity);resetIdentity();
  return { refresh, destroy(){disposed=true;owner=null;++generation;++detailGeneration;unsubscribe();adapter.clearReportCache?.();resetActions();controls();q('people').replaceChildren();clearDetail('המסך נסגר.');root.removeEventListener('keydown',keydown);
    for(const [name,fn] of bindings)q(name).removeEventListener('click',fn);window.removeEventListener('beforeunload',beforeUnload);
    reviewRetry.removeEventListener('click',submitReview);reviewFeedback.remove();window.removeEventListener('pagehide',pagehide);window.removeEventListener('pageshow',pageshow);
    q('month').removeEventListener('change',refresh);q('refresh').removeEventListener('click',refresh);q('next').removeEventListener('click',next);q('previous').removeEventListener('click',previous);q('more').removeEventListener('click',more);} };
}
