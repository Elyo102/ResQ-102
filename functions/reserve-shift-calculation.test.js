'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {calcHours,calculateAttendanceDerived}=require('./attendance-hours-calculator');
const {projectEmployeeHours}=require('./hr-hours-model');
const reserve=(patch={})=>({day_type:'reserve_shift',shape:'regular',start:'07:00',end:'07:00',end_day:1,...patch});
test('reserve shift is explicit wall-clock 24 across Jerusalem spring/fall and normal days',()=>{
 const cases=[['2026-03-26T07:00:00+02:00','2026-03-27T07:00:00+03:00',23],
  ['2026-10-24T07:00:00+03:00','2026-10-25T07:00:00+02:00',25],
  ['2026-09-29T07:00:00+03:00','2026-09-30T07:00:00+03:00',24]];
 for(const [start,end,elapsed] of cases){
  assert.equal((Date.parse(end)-Date.parse(start))/3600000,elapsed);
  const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Jerusalem',hour:'2-digit',minute:'2-digit'});
  assert.equal(fmt.format(new Date(start)),'07:00');assert.equal(fmt.format(new Date(end)),'07:00');
  assert.equal(calcHours(reserve({date:start.slice(0,10)})),24);
 }
 for(const date of ['2026-09-30','2026-12-31','2028-02-29'])assert.equal(calcHours(reserve({date})),24);
});
test('editable same-day/overnight times control duration even at fixed25 site',()=>{
 for(const [patch,hours]of [[{start:'08:00',end:'16:00',end_day:0},8],[{start:'19:00',end:'07:00'},12],[{end:'06:00'},23]]){
  assert.equal(calcHours(reserve(patch),25),hours);
  assert.equal(calculateAttendanceDerived(reserve({...patch,sub_station:'s'}),{siteById:{s:{fixed_hours:25,name:'Synthetic'}},shiftHours:24}).hours,hours);
 }
});
test('missing offset, zero length, more than24 and extra intervals fail closed',()=>{
 for(const patch of [{end_day:undefined},{end_day:null},{end_day:'1'},{end_day:0},{end_day:2},{end_day:-1},
  {end:'08:00'},{start:'bad'},{shape:'split'},{shape:'continued'},{start2:'08:00',end2:'09:00'},{end_day2:1}]){
  assert.equal(calcHours(reserve(patch)),null);
  assert.throws(()=>calculateAttendanceDerived(reserve(patch),{siteById:{},shiftHours:24}));
 }
});
test('old reserve absence and explicit regular24 remain unchanged; equal same-day is not24',()=>{
 assert.equal(calcHours({day_type:'reserve',start:'07:00',end:'07:00',end_day:1}),8.5);
 assert.equal(calcHours({day_type:'regular',start:'07:00',end:'07:00',end_day:1}),24);
 assert.equal(calcHours({day_type:'regular',start:'07:00',end:'07:00',end_day:0}),null);
});
test('HR projection preserves draft type hours offset and month attribution without absence classification',()=>{
 const row=reserve({uid:'synthetic-user',emp_number:'123',month:'2026-09',date:'2026-09-30',hours:24,day_type_he:'משמרת בזמן מילואים',status:'draft'});
 const p=projectEmployeeHours({month:'2026-09',employee:{uid:'synthetic-user',employee_number:'123'},report:null,attendance:[row]});
 assert.equal(p.rows[0].day_type,'reserve_shift');assert.equal(p.rows[0].end_day,1);
 assert.equal(p.rows[0].status,'draft');assert.equal(p.rows[0].date,'2026-09-30');assert.equal(p.current_detail_total_hours,24);
});
