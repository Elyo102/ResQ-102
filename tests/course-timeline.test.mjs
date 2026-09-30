import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../course-timeline.js',import.meta.url),'utf8');
const {validateCourseSnapshot,courseTimelineModel,renderCourseTimeline,validateCourseMonth,projectCourseRows}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const snapshot=(count=10)=>({schema:'course-credit-v1',approval_revision:2,from_date:'2026-09-01',to_date:'2026-10-03',owner_uid:'u1',employee_number:'E1',crew:'א',role:'firefighter',
  days:Array.from({length:count},(_,i)=>({date:new Date(Date.UTC(2026,8,1+i*3)).toISOString().slice(0,10),credit_hours:20})),total_hours:count*20,
  source_label:'original-crew-cycle-at-hr-approval',source_digest:'a'.repeat(64)});
for(const count of [9,10,11])test('approved original cycle count '+count+' has no fixed shift/hour default',()=>{
  const value=snapshot(count),before=JSON.stringify(value),model=courseTimelineModel(value);
  assert.equal(model.full_count,count);assert.equal(model.full_hours,count*20);assert.equal(model.days.length,33);
  assert.equal(model.days.filter(d=>d.credit_hours!==null).length,count);assert.equal(JSON.stringify(value),before);
});
test('cross-month clipping preserves full period and shows only approved work dates',()=>{
  const model=courseTimelineModel(snapshot(11),'2026-10');
  assert.equal(model.full_count,11);assert.equal(model.count,1);assert.equal(model.hours,20);
  assert.deepEqual(model.days.map(d=>d.date),['2026-10-01','2026-10-02','2026-10-03']);
  assert.equal(model.days[1].credit_hours,null);
});
test('malformed, duplicated, guessed and inconsistent approval snapshots fail closed',()=>{
  for(const mutate of [s=>delete s.source_digest,s=>s.total_hours=240,s=>s.days[0].credit_hours=0,
    s=>s.days[0].credit_hours='24',s=>s.days.push({...s.days[0]}),s=>s.days.reverse(),
    s=>s.days[0].date='2026-08-31',s=>s.from_date='2026-02-30',s=>s.approval_revision=0,
    s=>s.source_label='client-rotation',s=>s.owner_uid='']){
    const s=snapshot();mutate(s);assert.throws(()=>validateCourseSnapshot(s));
  }
  assert.throws(()=>courseTimelineModel(snapshot(),'2026-13'));
});
test('red horizontal timeline has textual accessible credit and retained-original explanation',()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  class Element{constructor(tag){this.tag=tag;this.children=[];this.attributes={};this.style={};}setAttribute(k,v){this.attributes[k]=v;}append(...nodes){this.children.push(...nodes);}}
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:tag=>new Element(tag)}});
  try{
    const result=renderCourseTimeline(snapshot(9));assert.equal(result.attributes['aria-label'],'ציר זמן קורס מאושר');
    const line=result.children[2];assert.match(line.style.cssText,/overflow-x:auto/);
    assert.equal(line.children.filter(c=>c.style.cssText.includes('background:#ffe3e3')).length,9);
    assert.ok(line.children.every(c=>c.attributes['aria-label']===c.title));
    assert.match(result.children.at(-1).textContent,/השיבוץ המקורי נשמר/);
  }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;}
});
test('existing HR 400-day inclusive bound is retained, 401 rejected',()=>{
  const s=snapshot();s.to_date=new Date(Date.parse(s.from_date+'T00:00Z')+399*86400000).toISOString().slice(0,10);
  assert.equal(courseTimelineModel(s).days.length,400);
  s.to_date=new Date(Date.parse(s.to_date+'T00:00Z')+86400000).toISOString().slice(0,10);
  assert.throws(()=>validateCourseSnapshot(s));
});
test('monthly projection credits each date once, retains base immutable, rejects mismatches',()=>{
  const s=snapshot(9),id='b'.repeat(64),month={schema:'attendance-course-month-v1',employee_number:'E1',month:'2026-09',owner_uid:'u1',revision:1,periods:{[id]:s},days:Object.fromEntries(s.days.map(d=>[d.date,{case_id:id,approval_revision:2,credit_hours:20}]))};
  validateCourseMonth(month,'2026-09','u1');
  const base=[{date:'2026-09-01',day_type:'regular',hours:24,start:'07:00',end:'07:00',_expected_version:{seconds:1,nanoseconds:0}}],before=JSON.stringify(base);
  const rows=projectCourseRows(base,month);assert.equal(rows.length,9);assert.equal(rows.reduce((n,d)=>n+d.hours,0),180);
  assert.equal(rows[0].base_day_type,'regular');assert.equal(rows[0].course_overlay,true);assert.equal(JSON.stringify(base),before);
  for(const mutate of [v=>delete v.days['2026-09-01'],v=>v.owner_uid='wrong',v=>v.days['2026-09-01'].credit_hours=24,v=>v.revision=0]){
    const bad=structuredClone(month);mutate(bad);assert.throws(()=>validateCourseMonth(bad,'2026-09','u1'));
  }
  assert.throws(()=>validateCourseMonth(undefined,'2026-09','u1'));
  assert.throws(()=>projectCourseRows([{...base[0],day_type:'reserve_shift'}],month));
});
test('real hours and HTML report use approved credit once without invented course times',async()=>{
  const load=async file=>import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8')).toString('base64'));
  const hours=await load('hours.js'),report=await load('report.js');
  const row={date:'2026-09-01',day_type:'course',day_type_he:'קורס',course_overlay:true,hours:20,
    base_day_type:'regular',start:'07:00',end:'07:00',end_day:1};
  assert.equal(hours.calcHours(row,25),20);assert.equal(hours.monthSummary([row],()=>25).hours,20);
  assert.equal(hours.overtimeHours(row,25,24),0);
  assert.equal(hours.calcHours({...row,course_overlay:false},25),null);
  const html=report.reportHtml({month:'2026-09',total:20},[row]);
  assert.match(html,/day-course/);assert.match(html,/זיכוי תקן פעם אחת/);assert.doesNotMatch(html,/07:00/);
});
