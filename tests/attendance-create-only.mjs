// Actual source-extracted helper; strict transaction double, NOT native Firestore.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { recordId } from '../hours.js';
const path = new URL('../attendance.html', import.meta.url);
const source = fs.readFileSync(path, 'utf8');
const hash = text => createHash('sha256').update(text).digest('hex');
const start = 'async function createMissingDays(';
const end = 'async function refreshAfterCreation(';
assert.equal(source.split(start).length, 2);
assert.equal(source.split(end).length, 2);
const actual = source.slice(source.indexOf(start), source.indexOf(end));
const target = {sid:'test-station', emp:'101', uid:'worker', month:'2026-09'};
const entry = {date:'2026-09-01', month:'2026-09', emp_number:'101', uid:'worker', hours:8};
const dayPath = 'stations/test-station/attendance/101_2026-09-01';
const reportPath = 'stations/test-station/monthly_reports/101_2026-09';
let passed = 0;
async function scenario({report, existing, retry=false, revoke=false, entries=[entry], reject=false}={}) {
  const store = new Map();
  if (report !== undefined) store.set(reportPath, structuredClone(report));
  if (existing !== undefined) store.set(dayPath, structuredClone(existing));
  let live=true, attempts=0, commits=0;
  const manual={...entry,hours:10,notes:'manual must survive'};
  const context=vm.createContext({recordId,db:{},stamp:x=>x,
    doc:(_, ...parts)=>parts.join('/'),
    requireMonthWrite:()=>{if(!live)throw new Error('stale context');},
    runTransaction:async (_, callback)=>{
      for(let attempt=0;attempt<2;attempt++){
        attempts++;
        const writes=[];
        const tx={get:async p=>{
          assert.equal(writes.length,0,'read after write');
          assert.ok(p===reportPath || /^stations\/test-station\/attendance\/101_2026-09-\d{2}$/.test(p),'canonical path');
          const value=store.get(p);
          if(revoke && p===dayPath)live=false;
          return {exists:()=>store.has(p),data:()=>structuredClone(value)};
        },set:(p,v)=>writes.push([p,structuredClone(v)])};
        const result=await callback(tx);
        if(retry && attempt===0){assert.equal(writes.length,1);store.set(dayPath,structuredClone(manual));continue;}
        writes.forEach(([p,v])=>{store.set(p,v);commits++;});
        return result;
      }
      throw new Error('unexpected retries');
    }});
  const fn=vm.runInContext(actual+';createMissingDays',context);
  if(reject){await assert.rejects(fn(target,entries));assert.equal(commits,0);}
  else {
    const result=await fn(target,entries);
    assert.equal(result.created, existing!==undefined || retry ? 0 : 1);
    assert.equal(result.skipped, existing!==undefined || retry ? 1 : 0);
    assert.equal(attempts,retry?2:1);
    if(retry)assert.deepEqual(store.get(dayPath),manual);
    if(existing!==undefined)assert.deepEqual(store.get(dayPath),existing);
  }
  passed++;
}
await scenario();
await scenario({report:{emp_number:'101',month:'2026-09'}});
await scenario({existing:{...entry,hours:11}});
await scenario({retry:true});
await scenario({revoke:true,reject:true});
for(const status of ['submitted','approved','unknown',null,''])await scenario({report:{emp_number:'101',month:'2026-09',status},reject:true});
for(const patch of [{emp_number:'999'},{month:'2026-08'},{uid:'other'},{uid:null}])await scenario({report:{emp_number:'101',month:'2026-09',...patch},reject:true});
for(const patch of [{date:'2026-09-31'},{date:'2026-10-01'},{uid:'other'},{emp_number:'999'}])await scenario({entries:[{...entry,...patch}],reject:true});
await scenario({entries:[entry,entry],reject:true});
await scenario({entries:Array(32).fill(entry),reject:true});
assert.equal(hash(fs.readFileSync(path,'utf8')),hash(source),'source unchanged');
console.log(`${passed} actual-helper unit-contract checks passed; native Firestore NOT RUN.`);
