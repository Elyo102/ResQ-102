// DOM-only controller. The injected adapter owns authenticated transport;
// no personal data is persisted or embedded into URLs.
const labels = { missing:'לא הוגש דוח', draft:'ממתין לאישור העובד', submitted:'ממתין לאישור פיקודי', approved:'מאושר', unavailable:'נדרשת בדיקת נתונים' };
const warnings = { 'detail-hours-missing':'בחלק מהרשומות חסר סך שעות.', 'reported-day-detail-missing':'חסרים פרטים עבור ימים הרשומים בדוח.', 'detail-day-not-in-report':'יש ימי נוכחות שאינם כלולים בדוח השמור.', 'reported-total-missing':'בדוח השמור חסר סך השעות.', 'reported-total-differs':'סך השעות השמור שונה מפירוט הנוכחות הנוכחי.' };
const disconnected = { currentSession:()=>null, subscribeIdentity:()=>()=>{} };
const el = (tag, value, className) => { const node=document.createElement(tag); if(value!=null)node.textContent=String(value); if(className)node.className=className; return node; };
const number = value => typeof value==='number' && Number.isFinite(value) ? value.toLocaleString('he-IL',{maximumFractionDigits:2}) : '—';
function sessionKey(adapter) {
  try {
  const s=adapter.currentSession();
  if(!s || typeof s.uid!=='string' || !s.uid || typeof s.stationId!=='string' || !s.stationId || !(s.super===true || s.role==='hr_coordinator'))return null;
  return JSON.stringify([s.uid,s.stationId,s.role,s.super===true,s.epoch]);
  } catch (_) { return null; }
}
export function createHrHoursUI(root, adapter=disconnected) {
  const q = key => root.querySelector('[data-hr="'+key+'"]');
  let owner=null, generation=0, detailGeneration=0, items=[], cursor=null, selected=-1, loading=false, disposed=false;
  // Locale format order is not a date-key contract.
  const parts=new Intl.DateTimeFormat('en',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit'}).formatToParts(new Date());
  q('month').value=parts.find(p=>p.type==='year').value+'-'+parts.find(p=>p.type==='month').value;
  const message = value => { q('message').textContent=value; };
  function clearDetail(value='בחרו עובד לצפייה בדוח.') { q('detail').replaceChildren(el('p',value)); }
  function controls() {
    q('previous').disabled=!owner || selected<=0;
    q('next').disabled=!owner || loading || (selected>=items.length-1 && !cursor);
    q('more').hidden=!cursor; q('more').disabled=loading;
    q('refresh').disabled=!owner; q('month').disabled=!owner;
    q('position').textContent=selected<0?'':(selected+1)+' מתוך '+items.length+(cursor?' ומעלה':'');
    q('count').textContent=items.length ? items.length+' עובדים נטענו'+(cursor?' · יש נוספים':'') : '';
  }
  function alive(g, key) {
    if(disposed)return false;
    if(sessionKey(adapter)!==owner){ resetIdentity(); return false; }
    return generation===g && owner===key && !!owner;
  }
  function renderPeople() {
    q('people').replaceChildren();
    for(const [index,p] of items.entries()) {
      const button=el('button',null,'hr-person'); button.type='button'; button.dataset.uid=p.uid;
      button.setAttribute('aria-pressed',String(index===selected));
      button.append(el('strong',p.full_name || 'שם חסר'),el('small',(labels[p.state]||labels.unavailable)+(p.historical?' · עובד לשעבר':'')));
      const g=generation,key=owner;
      button.addEventListener('click',()=>{ if(alive(g,key))select(index); });
      q('people').append(button);
    }
    controls();
  }
  function renderDetail(p) {
    const detail=q('detail'); detail.replaceChildren(el('h2',p.full_name),el('span',labels[p.state]||labels.unavailable,'hr-tag'),
      el('p','מספר עובד '+p.employee_number+' · '+p.month+(p.crew?' · משמרת '+p.crew:''),'hr-meta'));
    if(p.historical)detail.append(el('p','דוח היסטורי של עובד שאינו פעיל בתחנה.','hr-notice'));
    const totals=el('div',null,'hr-totals');
    for(const [title,value] of [['סך שעות בדוח השמור',p.stored_total_hours],['סך שעות בפירוט הנוכחי',p.current_detail_total_hours]]) {
      const box=el('div',title,'hr-total');box.append(el('strong',number(value)));totals.append(box);
    }
    detail.append(totals,el('p','הפירוט מציג את רשומות הנוכחות הנוכחיות. אם תוקנו מאז אישור הדוח, ההבדל בסכומים מוצג כאן.','hr-meta'));
    for(const warning of p.warnings||[])detail.append(el('p',warnings[warning]||'יש נתונים בדוח הדורשים בדיקה.','hr-notice'));
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
  async function select(index) {
    const g=generation,key=owner;if(!alive(g,key)||!items[index])return;
    selected=index;const d=++detailGeneration,p=items[index];
    q('people').querySelectorAll('.hr-person').forEach((button,i)=>button.setAttribute('aria-pressed',String(i===selected)));
    controls();clearDetail('טוען דוח…');
    if(p.state==='unavailable'){clearDetail('נתוני העובד דורשים בדיקה. אפשר להמשיך לדוח הבא.');return;}
    const month=q('month').value;
    try {
      const value=await adapter.getEmployeeMonth({month,uid:p.uid});
      if(!alive(g,key)||d!==detailGeneration)return;
      if(!value || value.uid!==p.uid || value.month!==month || !Array.isArray(value.rows))throw new Error('invalid response');
      renderDetail(value);
    }catch(e){if(alive(g,key)&&d===detailGeneration)clearDetail('לא ניתן לטעון את הדוח כרגע. רעננו או עברו לדוח הבא.');}
  }
  async function loadPage(append=false, selectNew=false) {
    const g=generation,key=owner;if(!alive(g,key)||loading)return;
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
    if(sessionKey(adapter)!==owner){resetIdentity();return;}
    ++generation;++detailGeneration;items=[];cursor=null;selected=-1;loading=false;renderPeople();clearDetail();
    if(owner)void loadPage();
  }
  function resetIdentity() {
    owner=sessionKey(adapter);++generation;++detailGeneration;items=[];cursor=null;selected=-1;loading=false;
    renderPeople();clearDetail(owner?'בחרו עובד לצפייה בדוח.':'נדרש חיבור עם הרשאת משאבי אנוש.');
    message(owner?'טוען…':'ממתין לחיבור מאובטח עם הרשאה מתאימה.');if(owner)void loadPage();
  }
  const next=()=>{if(!alive(generation,owner))return;if(selected+1<items.length)void select(selected+1);else if(cursor)void loadPage(true,true);};
  const previous=()=>{if(alive(generation,owner)&&selected>0)void select(selected-1);};
  const more=()=>{if(cursor)void loadPage(true);};
  const keydown=e=>{if(e.altKey||e.ctrlKey||e.metaKey||e.shiftKey||e.target.closest('input,textarea,select,[contenteditable]'))return;if(e.key==='ArrowLeft'&&!q('next').disabled){e.preventDefault();next();}else if(e.key==='ArrowRight'&&!q('previous').disabled){e.preventDefault();previous();}};
  q('month').addEventListener('change',refresh);q('refresh').addEventListener('click',refresh);q('next').addEventListener('click',next);q('previous').addEventListener('click',previous);q('more').addEventListener('click',more);root.addEventListener('keydown',keydown);
  const unsubscribe=adapter.subscribeIdentity(resetIdentity);resetIdentity();
  return { refresh, destroy(){disposed=true;++generation;++detailGeneration;unsubscribe();q('people').replaceChildren();clearDetail('המסך נסגר.');root.removeEventListener('keydown',keydown);
    q('month').removeEventListener('change',refresh);q('refresh').removeEventListener('click',refresh);q('next').removeEventListener('click',next);q('previous').removeEventListener('click',previous);q('more').removeEventListener('click',more);} };
}
