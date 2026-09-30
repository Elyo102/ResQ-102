'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {calcHours,calculateAttendanceDerived,stampReserveCalculationVersion}=require('./attendance-hours-calculator');
const {attendanceIntervals}=require('./attendance-reserve-overlap');
const row=(patch={})=>({day_type:'reserve_shift',date:'2026-09-30',shape:'regular',start:'07:00',end:'07:00',end_day:1,start2:'',end2:'',end_day2:0,...patch});
const config={siteById:{y:{fixed_hours:25,name:'Synthetic'}},shiftHours:24};
test('v2 full bonus on partial/full/extended shifts, exact client/server parity',async()=>{
 const browser=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(require.resolve('../hours.js'),'utf8')).toString('base64'));
 for(const [patch,want,raw] of [[{start:'19:00'},20.5,12],[{},32.5,24],[{end:'08:00'},33.5,25],[{end:'09:00'},34.5,26],[{start:'08:00',end:'16:00',end_day:0},16.5,8]]){
  const r=stampReserveCalculationVersion(row({...patch,sub_station:'y'}),null);
  assert.equal(calcHours(r,25),want);assert.equal(browser.calcHours(r,25),want);assert.equal(calculateAttendanceDerived(r,config).hours,want);
  assert.equal(browser.overtimeHours(r,25,24),0);
  const [interval]=attendanceIntervals(r);assert.equal((interval.end-interval.start)/60,raw);
 }
});
test('legacy reads, note edits, recalc retain old totals; time edit upgrades',()=>{
 const old=row();assert.equal(calcHours(old),24);assert.equal(calculateAttendanceDerived(old,config).hours,24);
 const note=stampReserveCalculationVersion({...old,notes:'new',reserve_calculation_version:2},old);
 assert.equal(note.reserve_calculation_version,undefined);assert.equal(calcHours(note),24);
 const edit=stampReserveCalculationVersion({...old,end:'09:00'},old);assert.equal(edit.reserve_calculation_version,2);assert.equal(calcHours(edit),34.5);
 assert.equal(stampReserveCalculationVersion({...edit,day_type:'regular'},edit).reserve_calculation_version,undefined);
});
test('invalid intervals and invalid version rejected, legacy >24 not silently accepted',()=>{
 for(const patch of [{end_day:0},{end_day:2},{end_day:'1'},{shape:'split'},{reserve_calculation_version:3}])assert.equal(calcHours(row({reserve_calculation_version:2,...patch})),null);
 assert.equal(calcHours(row({end:'09:00'})),null);assert.throws(()=>attendanceIntervals(row({end:'09:00'})));
 assert.equal(calcHours({day_type:'reserve'}),8.5);assert.equal(calcHours({...row(),day_type:'regular'}),24);
});
test('legacy omitted secondary fields equal editor defaults without upgrading credit',()=>{
 const old=row();delete old.start2;delete old.end2;delete old.end_day2;
 for(const version of [undefined,1,2]){
  const before={...old};if(version!==undefined)before.reserve_calculation_version=version;
  const saved=stampReserveCalculationVersion({...before,start2:'',end2:'',end_day2:0,notes:'note'},before);
  assert.equal(saved.reserve_calculation_version,version);
  assert.equal(calcHours(saved),version===2?32.5:24);
 }
 assert.equal(stampReserveCalculationVersion({...old,end:'09:00',start2:'',end2:'',end_day2:0},old).reserve_calculation_version,2);
 assert.equal(stampReserveCalculationVersion({...old,end_day2:null},old).reserve_calculation_version,2);
});
test('version cannot be supplied in public editable patch contract',()=>{
 const {EDITABLE}=require('./attendance-corrections');assert(!EDITABLE.includes('reserve_calculation_version'));
});
