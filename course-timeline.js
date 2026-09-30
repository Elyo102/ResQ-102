// Presentation only: credit comes exclusively from an HR-approved server snapshot.
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const validDate=value=>typeof value==='string'&&DATE.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
export function validateCourseSnapshot(value) {
  if(!value||value.schema!=='course-credit-v1'||!Number.isSafeInteger(value.approval_revision)||value.approval_revision<1
    ||!validDate(value.from_date)||!validDate(value.to_date)||value.from_date>value.to_date
    ||(Date.parse(value.to_date)-Date.parse(value.from_date))/86400000>=400
    ||!['owner_uid','employee_number','crew','role'].every(k=>typeof value[k]==='string'&&value[k].length>0)
    ||value.source_label!=='original-crew-cycle-at-hr-approval'||!/^[a-f0-9]{64}$/.test(value.source_digest)
    ||!Array.isArray(value.days)||value.days.length>400||!Number.isFinite(value.total_hours)||value.total_hours<0)throw new Error('Invalid approved course snapshot');
  let previous='',sum=0;
  for(const day of value.days){
    if(!day||!validDate(day.date)||day.date<value.from_date||day.date>value.to_date||day.date<=previous
      ||typeof day.credit_hours!=='number'||!Number.isFinite(day.credit_hours)||day.credit_hours<=0||day.credit_hours>48)throw new Error('Invalid approved course days');
    previous=day.date;sum+=day.credit_hours;
  }
  if(Math.abs(Math.round(sum*100)/100-value.total_hours)>0.000001)throw new Error('Invalid approved course total');
  return value;
}
export function courseTimelineModel(snapshot,month) {
  const value=validateCourseSnapshot(snapshot);
  if(month!==undefined&&(typeof month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)))throw new Error('Invalid course month');
  const credits=new Map(value.days.map(day=>[day.date,day.credit_hours])),days=[];
  for(let ms=Date.parse(value.from_date+'T00:00:00Z'),end=Date.parse(value.to_date+'T00:00:00Z');ms<=end;ms+=86400000){
    const date=new Date(ms).toISOString().slice(0,10);
    if(month===undefined||date.startsWith(month+'-'))days.push({date,credit_hours:credits.get(date)??null});
  }
  const credited=days.filter(day=>day.credit_hours!==null);
  return {from_date:value.from_date,to_date:value.to_date,full_count:value.days.length,full_hours:value.total_hours,
    count:credited.length,hours:Math.round(credited.reduce((n,d)=>n+d.credit_hours,0)*100)/100,days};
}
export function renderCourseTimeline(snapshot,month) {
  const model=courseTimelineModel(snapshot,month),section=document.createElement('section');
  section.className='course-timeline';section.setAttribute('aria-label','ציר זמן קורס מאושר');section.dir='rtl';
  const title=document.createElement('p');title.textContent='קורס מאושר · '+model.from_date+' — '+model.to_date;
  const summary=document.createElement('p');summary.textContent=model.full_count+' משמרות מקוריות · '+model.full_hours+' שעות תקן מאושרות';
  if(month)summary.textContent+=' · בחודש המוצג: '+model.count+' משמרות, '+model.hours+' שעות';
  const line=document.createElement('ol');line.style.cssText='display:flex;gap:4px;overflow-x:auto;list-style:none;padding:8px 0;margin:0';
  for(const day of model.days){
    const cell=document.createElement('li'),working=day.credit_hours!==null;
    cell.style.cssText='flex:0 0 auto;min-width:44px;padding:8px;text-align:center;border-radius:6px;'+(working?'background:#ffe3e3;color:#692323;border:1px solid #a73535':'border:1px solid currentColor');
    cell.textContent=day.date.slice(5);cell.title=day.date+' · '+(working?day.credit_hours+' שעות תקן קורס':'ללא משמרת מקורית מזכה');
    cell.setAttribute('aria-label',cell.title);line.append(cell);
  }
  const note=document.createElement('p');note.textContent='לפי הסבב המקורי שאושר במשאבי אנוש. השיבוץ המקורי נשמר; אין תוספת כפולה על אותן שעות.';
  section.append(title,summary,line,note);return section;
}

export function validateCourseMonth(value,month,uid) {
  const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
  if(typeof month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||typeof uid!=='string'||!uid
    ||!plain(value)||value.schema!=='attendance-course-month-v1'||typeof value.employee_number!=='string'||!value.employee_number
    ||value.month!==month||value.owner_uid!==uid||!Number.isSafeInteger(value.revision)||value.revision<0
    ||!plain(value.days)||!plain(value.periods)||Object.keys(value.days).length>31||Object.keys(value.periods).length>32)throw new Error('Invalid course month');
  const expected=new Map();
  for(const [id,raw]of Object.entries(value.periods)){
    if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid course case');
    const snapshot=validateCourseSnapshot(raw);
    if(snapshot.owner_uid!==uid||snapshot.employee_number!==value.employee_number)throw new Error('Wrong course owner');
    for(const day of snapshot.days.filter(d=>d.date.startsWith(month+'-'))){
      if(expected.has(day.date))throw new Error('Overlapping approved course credits');
      expected.set(day.date,{case_id:id,approval_revision:snapshot.approval_revision,credit_hours:day.credit_hours});
    }
  }
  if(value.revision===0&&(expected.size||Object.keys(value.periods).length))throw new Error('Unversioned course credit');
  if(expected.size!==Object.keys(value.days).length)throw new Error('Incomplete course month');
  for(const [date,day]of Object.entries(value.days)){
    const e=expected.get(date);
    if(!e||!plain(day)||day.case_id!==e.case_id||day.approval_revision!==e.approval_revision||day.credit_hours!==e.credit_hours)throw new Error('Course credit mismatch');
  }
  return value;
}
// Never mutate base rows: those alone carry editable facts and CAS versions.
export function projectCourseRows(baseRows,courseMonth) {
  validateCourseMonth(courseMonth,courseMonth?.month,courseMonth?.owner_uid);
  const rows=new Map(baseRows.map(row=>[row.date,{...row}]));
  if(rows.size!==baseRows.length)throw new Error('Duplicate attendance date');
  for(const [date,credit]of Object.entries(courseMonth.days)){
    const base=rows.get(date);
    if(base&&base.day_type!=='regular')throw new Error('Course conflicts with original attendance');
    rows.set(date,{...(base||{}),date,day_type:'course',day_type_he:'קורס',course_overlay:true,
      base_day_type:base?.day_type??null,course_case_id:credit.case_id,course_approval_revision:credit.approval_revision,
      hours:credit.credit_hours,shape:'regular',start:'',end:'',start2:'',end2:'',end_day:0,end_day2:0,
      notes:((base?.notes?base.notes+' · ':'')+'קורס מאושר; השיבוץ המקורי נשמר'+(base?' ('+(base.day_type_he||base.day_type)+')':''))});
  }
  return [...rows.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
