import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.resolve(root,'../reports/hr-workspace-20260907/archive-validation');fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch();let passed=0;
try{
const page=await browser.newPage();await page.route('**/*',r=>{const name=new URL(r.request().url()).pathname.slice(1);return r.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(root,['hr-month-archive.js','hr-month-archive-ui.js'].includes(name)?name:'hr-month-archive.js'),'utf8')});});
await page.goto('http://127.0.0.1:41993/hr-month-archive.js');
const results=await page.evaluate(async()=>{
  const {buildMonthArchive,buildLocalMonthFiles,renderPdf,zipFiles,safeName}=await import('/hr-month-archive.js');
  const ok=(v,m)=>{if(!v)throw Error(m);};const results=[];const check=async(name,f)=>{await f();results.push(name);};
  const make=(uid='u1')=>({uid,month:'2026-09',full_name:'עובד בדיקה '+uid,employee_number:uid,crew:'ג',state:'approved',historical:false,stored_total_hours:12,current_detail_total_hours:12,warnings:[],rows:[],detail_provenance:'current_attendance_not_historical_snapshot'});
  const adapter={listMonth:async()=>({month:'2026-09',items:[{uid:'u1',state:'approved'}],next_cursor:null}),getEmployeeMonth:async()=>({report:make(),freshness:{source:'server'}})};
  const pdf=async()=>new TextEncoder().encode('%PDF-test');
  await check('local folder stream yields one fresh employee-bound report',async()=>{const files=[];for await(const file of buildLocalMonthFiles(adapter,'2026-09',{pdf}))files.push(file);ok(files.length===1&&files[0].kind==='hours'&&files[0].uid==='u1'&&files[0].employeeNumber==='u1'&&files[0].month==='2026-09','local file binding');});
  await check('local folder accepts a valid employee without crew assignment',async()=>{const files=[];const a={...adapter,getEmployeeMonth:async()=>({report:{...make(),crew:''},freshness:{source:'server'}})};for await(const file of buildLocalMonthFiles(a,'2026-09',{pdf}))files.push(file);ok(files.length===1,'empty crew is a display value, not identity');});
  await check('local folder and ZIP reject the same malformed detail rows',async()=>{for(const row of [
    {date:'2026-09-31',hours:8,day_type_he:'עבודה',start:'08:00',end:'16:00',start2:'',end2:'',site_name:'אילת',notes:'',overtime_reason:'',reason:'',end_day:0,end_day2:null},
    {date:'2026-09-01',hours:8,day_type_he:'עבודה',start:'08:00',end:'16:00',start2:'',end2:'',site_name:'אילת',notes:3,overtime_reason:'',reason:'',end_day:0,end_day2:null}
  ]){const a={...adapter,getEmployeeMonth:async()=>({report:{...make(),rows:[row]},freshness:{source:'server'}})};let localFailed=false,zipFailed=false;try{for await(const file of buildLocalMonthFiles(a,'2026-09',{pdf}))void file;}catch{localFailed=true;}try{await buildMonthArchive(a,'2026-09',{pdf});}catch{zipFailed=true;}ok(localFailed&&zipFailed,'validator parity');}});
  await check('one-person archive and UTF8 folder',async()=>{const r=await buildMonthArchive(adapter,'2026-09',{pdf});ok(r.count===1&&r.name.includes('ספטמבר 2026'),'name');});
  await check('all pages, not visible page only',async()=>{let calls=0;const a={...adapter,listMonth:async({cursor})=>{calls++;return {month:'2026-09',items:cursor?[{uid:'u26',state:'missing'}]:Array.from({length:25},(_,i)=>({uid:'u'+i,state:'approved'})),next_cursor:cursor?null:'u24'};},getEmployeeMonth:async({uid})=>({report:make(uid),freshness:{source:'server'}})};const r=await buildMonthArchive(a,'2026-09',{pdf});ok(r.count===26&&calls===3,'pagination/finalfreshcheck');});
  await check('3,000-person archive boundary completes without truncation',async()=>{let pageNo=0,details=0;const a={...adapter,listMonth:async({cursor}={})=>{if(!cursor&&pageNo===120)return {month:'2026-09',items:Array.from({length:25},(_,i)=>({uid:'p'+i,state:'approved'})),next_cursor:'c0'};const n=pageNo++;return {month:'2026-09',items:Array.from({length:25},(_,i)=>({uid:'p'+(n*25+i),state:'approved'})),next_cursor:n<119?'c'+n:null};},getEmployeeMonth:async({uid})=>{details++;return {report:make(uid),freshness:{source:'server'}};}};const r=await buildMonthArchive(a,'2026-09',{pdf});ok(r.count===3000&&details===3000&&r.bytes.length>0,'3000 complete');});
  const reject=async a=>{let failed=false;try{await buildMonthArchive(a,'2026-09',{pdf});}catch{failed=true;}ok(failed,'must fail');};
  await check('unavailable is never missing',()=>reject({...adapter,listMonth:async()=>({month:'2026-09',items:[{uid:'x',state:'unavailable'}],next_cursor:null})}));
  await check('cached data rejected',()=>reject({...adapter,getEmployeeMonth:async()=>({report:make(),freshness:{source:'memory'}})}));
  await check('invalid total rejected',()=>reject({...adapter,getEmployeeMonth:async()=>({report:{...make(),stored_total_hours:NaN},freshness:{source:'server'}})}));
  await check('120 page bound',async()=>{let n=0;await reject({...adapter,listMonth:async()=>({month:'2026-09',items:[{uid:'p'+(++n),state:'approved'}],next_cursor:'p'+n})});ok(n===120,'page cap');});
  await check('cursor cycle rejected',async()=>{let n=0;await reject({...adapter,listMonth:async()=>({month:'2026-09',items:[{uid:'p'+(++n),state:'approved'}],next_cursor:n%2?'a':'b'})});ok(n===3,'cycle');});
  await check('identity change cancels after awaited detail',async()=>{let alive=true,failed=false;try{await buildMonthArchive({...adapter,getEmployeeMonth:async()=>{alive=false;return {report:make(),freshness:{source:'server'}};}},'2026-09',{pdf,guard:()=>{if(!alive)throw Error('changed');}});}catch{failed=true;}ok(failed,'identity');});
  await check('final permission denial aborts download',async()=>{let n=0;await reject({...adapter,listMonth:async()=>{if(++n===2)throw Error('revoked');return adapter.listMonth();}});});
  await check('path traversal and duplicate ZIP rejected',async()=>{for(const names of [['../bad'],['a','a']]){let failed=false;try{zipFiles(names.map(name=>({name,bytes:new Uint8Array()})));}catch{failed=true;}ok(failed,'zip unsafe');}ok(!safeName('../x\\y').includes('/'),'safe name');});
  const lines=Array.from({length:65},(_,i)=>'שורה '+(i+1)+' — אישור מחלה 12.8.pdf | 07:00 עד 19:00 | שעות: 12');
  const bytes=await renderPdf('ספטמבר 2026 — עובד בדיקה',lines);
  const zip=zipFiles([{name:'דוחות שעות - ספטמבר 2026/עובד בדיקה.pdf',bytes}]);
  window.archiveFixture=adapter;
  return {results,pdf:Array.from(bytes),zip:Array.from(zip)};
});
for(const result of results.results){console.log('PASS '+result);passed++;}
fs.writeFileSync(path.join(output,'sample.pdf'),Buffer.from(results.pdf));fs.writeFileSync(path.join(output,'sample.zip'),Buffer.from(results.zip));
await page.evaluate(async()=>{const {createMonthArchiveUI}=await import('/hr-month-archive-ui.js');document.body.innerHTML='<div id="host"><div class="hr-toolbar"><input data-hr="month" value="2026-09"></div></div>';window.live=true;window.listeners=[];window.downloadClicks=0;const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){window.downloadClicks++;return click.call(this);};window.hostAdapter={...window.archiveFixture,currentSession:()=>window.live?{uid:'hr',stationId:'test',role:'hr_coordinator',epoch:1}:null,subscribeIdentity:f=>{window.listeners.push(f);return()=>{};}};window.hostUI=createMonthArchiveUI(document.getElementById('host'),window.hostAdapter);});
const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'הורדת כל דוחות החודש'}).click();const download=await downloadEvent;await download.saveAs(path.join(output,'actual-archive.zip'));assert.match(download.suggestedFilename(),/ספטמבר 2026/);passed++;console.log('PASS actual host download with real PDF generation');
await page.evaluate(()=>{window.hostAdapter.getEmployeeMonth=()=>new Promise(resolve=>{window.releaseDetail=async()=>resolve(await window.archiveFixture.getEmployeeMonth());});});
await page.getByRole('button',{name:'הורדת כל דוחות החודש'}).click();await page.waitForFunction(()=>!!window.releaseDetail);
await page.evaluate(()=>{window.live=false;window.listeners.forEach(f=>f());window.releaseDetail();});await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.downloadClicks),1);passed++;console.log('PASS host identity invalidation prevents second download');
console.log('PASS generated actual multipage PDF and ZIP for independent verification');console.log(passed+' behavior checks passed');
}finally{await browser.close();}
