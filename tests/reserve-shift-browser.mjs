// Actual attendance dialog/row functions and real calculators, with synthetic
// identity, schedule and save transport. No Firebase or external network access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { browserPolicy, checkPolicy } from '../reserve-shift-policy-build.mjs';
checkPolicy();
const { chromium } = createRequire(import.meta.url)('playwright');
const source = fs.readFileSync(new URL('../attendance.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(first, last) {
  assert.equal(source.split(first).length, 2, first);
  return source.slice(source.indexOf(first), source.indexOf(last, source.indexOf(first)));
}
const dialog = extract('async function editDay(key, rec){', '// ---------- שליחה ואישור ----------');
const rows = extract('function renderRows(sug){', 'function captureMonthWrite(');
const retry = extract('function newCorrectionRequestId(){', 'function correctionErrorText(');
const style = source.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1];
const origin = 'http://127.0.0.1:41993';
const harness = `
import { DAY_TYPES, REASON_TYPES, SHAPES, shapeOf, needsTimes, calcHours, reasonWhy,
  guessDayOffset, dayTypeHe, isSplit, retroLabel } from '/hours.js';
import { reportHtml } from '/report.js';
import { canSelectReserveShift } from '/reserve-shift-policy.js';
const $=id=>document.getElementById(id), esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
const key='2026-09-29', mySite='', sites=[{id:'fixed',name:'תחנה קבועה',fixed_hours:25}], SUBJ={uid:'fixture'},
  overrides=[], rotations=[], swaps=[], DOWS=['א','ב','ג','ד','ה','ו','ש'], CREW_HE={}, CREW_SHORT={};
let records={}, pendingCorrectionOperation=null;
const locked=()=>false, captureMonthWrite=()=>({month:'2026-09',viewer:'fixture',auth:1,lifecycle:1}), sameMonthWrite=()=>true,
  baseTimes=()=>({start:'08:00',end:'16:00'}), myGuardOn=()=>null, workingOn=()=>true,
  onOther=()=>window.otherSubject, localToday=()=>key, siteHoursOf=id=>id==='fixed'?25:0,
  siteName=id=>id==='fixed'?'תחנה קבועה':'', shiftHoursFor=()=>24,
  overrideOn=()=>null, crewOnDate=()=>null, swapEffect=()=>null,
  openOv=()=>{},closeOv=()=>{},focusAfterRender=()=>{},loadMonth=async()=>{window.reloads++;return true;},
  clearAttendanceStaticCache=()=>{window.cacheClears++;},
  ensureFreshAttendanceForWrite=async()=>{window.refreshes++;return window.refreshAllowed;},
  newRecord=date=>({date}), msg=(message)=>window.messages.push(message),
  userError=(_op,error)=>error.message;
window.messages=[]; window.saved=[]; window.refreshAllowed=true; window.refreshes=0;
window.cacheClears=0; window.reloads=0; window.otherSubject=false;
async function saveRecord(date,record){ window.saved.push(structuredClone(record)); records[date]=record; return window.otherSubject?{corrected:true}:{selfSaved:true}; }
${extract('function reportedHours(row){', 'function correctedMonthHours(')}
${dialog}
${rows}
${retry}
window.callActualCorrection=callCorrection;
window.retryPending=()=>structuredClone(pendingCorrectionOperation);
window.openRecord=record=>editDay(key,record);
window.showRecord=record=>{records={[key]:record};renderRows([]);$('report').innerHTML=reportHtml({month:'2026-09',total:calcHours(record,25)},[{...record,date:key,day_type_he:dayTypeHe(record.day_type),hours:calcHours(record,25)}]);};
window.ready=true;
`;
const browser = await chromium.launch();
let passed = 0;
try {
  for (const width of [360, 1280]) for (const creationEnabled of [false, true]) {
    const context = await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/') return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><style>${style}</style><div id="dlg"></div><table><tbody id="rows"></tbody></table><div id="report"></div><script type="module" src="/harness.js"></script></html>`});
      if (url.pathname === '/harness.js') return route.fulfill({contentType:'text/javascript',body:harness});
      if (url.pathname === '/reserve-shift-policy.js') return route.fulfill({contentType:'text/javascript',body:browserPolicy({creationEnabled})});
      if (['/hours.js','/report.js','/reserve-shift-policy.js'].includes(url.pathname)) return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(new URL('..'+url.pathname,import.meta.url),'utf8')});
      return route.abort();
    });
    const page = await context.newPage();
    const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin); await page.waitForFunction(()=>window.ready);
    async function check(name, fn) { await fn(); passed++; console.log(`PASS ${width}: ${name}`); }
    const state=()=>page.evaluate(()=>Object.fromEntries(['dType','dShape','dStart','dEnd','dReserveEndDay','dStart2','dEnd2'].map(id=>[id,document.getElementById(id).value])));
    if (!creationEnabled) {
      await check('bridge hides new type and blocks injected option', async () => {
        await page.evaluate(()=>openRecord(null));
        assert.equal(await page.locator('#dType option[value="reserve_shift"]').count(),0);
        await page.evaluate(()=>{const option=new Option('Injected','reserve_shift');document.getElementById('dType').add(option);});
        await page.selectOption('#dType','reserve_shift'); await page.click('#dSave');
        assert.equal(await page.evaluate(()=>saved.length),0);
        assert.match(await page.evaluate(()=>messages.at(-1)),/אינה פעילה/);
      });
      await check('bridge existing reserve shift stays editable and calculable', async () => {
        await page.evaluate(()=>openRecord({day_type:'reserve_shift',shape:'regular',start:'07:00',end:'07:00',end_day:1}));
        assert.equal(await page.locator('#dType option[value="reserve_shift"]').count(),1);
        assert.equal(await page.locator('#dHint b').textContent(),'24');
        await page.fill('#dNotes','Existing shift after rollback'); await page.click('#dSave');
        await page.waitForFunction(()=>saved.length===1);
        assert.equal(await page.evaluate(()=>saved[0].day_type),'reserve_shift');
        assert.equal(await page.evaluate(()=>saved[0].end_day),1);
      });
      assert.deepEqual(errors,[]); await context.close(); continue;
    }
    await check('new selection defaults to explicit next-day 24 hours',async()=>{
      await page.evaluate(()=>openRecord(null)); await page.selectOption('#dType','reserve_shift');
      assert.deepEqual(await state(),{dType:'reserve_shift',dShape:'regular',dStart:'07:00',dEnd:'07:00',dReserveEndDay:'1',dStart2:'',dEnd2:''});
      assert.equal(await page.locator('#dHint b').textContent(),'24');
      assert.equal(await page.locator('#dReserveEndDay').isVisible(),true);
      assert.equal(await page.locator('#dShape').isVisible(),false);
      assert.equal(await page.locator('#dType option:checked').textContent(),'משמרת בזמן מילואים');
    });
    await check('edited interval and explicit same-day offset survive site and note edits/save/reopen',async()=>{
      await page.fill('#dStart','09:15');await page.fill('#dEnd','17:45');await page.selectOption('#dReserveEndDay','0');
      await page.selectOption('#dSite','fixed');await page.fill('#dNotes','הערה');
      assert.equal(await page.locator('#dHint b').textContent(),'8.5');
      await page.click('#dSave');await page.waitForFunction(()=>saved.length===1);
      const saved=await page.evaluate(()=>window.saved[0]);
      assert.equal(saved.end_day,0); assert.equal(saved.start,'09:15');assert.equal(saved.end,'17:45');
      await page.evaluate(record=>openRecord(record),saved);
      assert.equal((await state()).dReserveEndDay,'0');assert.equal(await page.locator('#dHint b').textContent(),'8.5');
    });
    await check('saved overnight offset preserved on reopen',async()=>{
      await page.evaluate(()=>openRecord({day_type:'reserve_shift',shape:'regular',start:'19:00',end:'06:00',end_day:1,sub_station:'fixed'}));
      assert.equal((await state()).dReserveEndDay,'1');assert.equal(await page.locator('#dHint b').textContent(),'11');
    });
    await check('split to reserve clears hidden second interval and restoring absence retains 8.5',async()=>{
      await page.evaluate(()=>openRecord({day_type:'regular',shape:'split',start:'08:00',end:'12:00',start2:'15:00',end2:'18:00',end_day2:0}));
      await page.selectOption('#dType','reserve_shift');
      assert.equal((await state()).dStart2,'');assert.equal(await page.locator('#dSeg2').isVisible(),false);
      await page.click('#dSave');await page.waitForFunction(()=>saved.length===2);
      assert.deepEqual(await page.evaluate(()=>[saved[1].shape,saved[1].start2,saved[1].end2,saved[1].end_day2]),['regular','','',0]);
      await page.selectOption('#dType','reserve');assert.equal(await page.locator('#dHint b').textContent(),'8.5');
      assert.equal(await page.locator('#dTimes').isVisible(),false);
    });
    await check('same-day equal times cannot save',async()=>{
      await page.selectOption('#dType','reserve_shift');await page.selectOption('#dReserveEndDay','0');await page.click('#dSave');
      assert.equal(await page.evaluate(()=>saved.length),2);assert.match(await page.locator('#dHint').textContent(),/—/);
    });
    await check('actual attendance row and report distinguish next-day from same-day',async()=>{
      const row={day_type:'reserve_shift',shape:'regular',start:'07:00',end:'07:00',end_day:1};
      await page.evaluate(record=>showRecord(record),row);
      assert.match(await page.locator('#rows').textContent(),/למחרת/);assert.match(await page.locator('#report').textContent(),/למחרת/);
      assert.match(await page.locator('#report').textContent(),/משמרת בזמן מילואים/);
      await page.evaluate(record=>showRecord(record),{...row,start:'09:00',end:'17:00',end_day:0});
      assert.doesNotMatch(await page.locator('#rows').textContent(),/למחרת/);assert.doesNotMatch(await page.locator('#report').textContent(),/למחרת/);
    });
    await check('new equal-time regular entry does not infer a full day',async()=>{
      await page.evaluate(()=>openRecord(null));
      await page.fill('#dStart','07:00');await page.fill('#dEnd','07:00');await page.click('#dSave');
      assert.equal(await page.evaluate(()=>saved.length),2);
    });
    await check('existing explicit full-day regular record retains consent and 24 on reopen',async()=>{
      {
        const record={day_type:'regular',shape:'regular',start:'07:00',end:'07:00',end_day:1};
        await page.evaluate(record=>openRecord(record),record);
        assert.equal(await page.locator('#dHint b').textContent(),'24');
        const before=await page.evaluate(()=>saved.length);
        await page.fill('#dNotes','existing record note edit');await page.click('#dSave');
        await page.waitForFunction(count=>saved.length===count+1,before);
        assert.equal(await page.evaluate(()=>saved.at(-1).end_day),1);
      }
    });
    await check('ambiguous existing equal times require explicit consent, never infer 24',async()=>{
      await page.evaluate(()=>openRecord({day_type:'regular',shape:'regular',start:'07:00',end:'07:00'}));
      assert.equal(await page.locator('#dFullDay').isChecked(),false);
      assert.equal(await page.locator('#dHint b').textContent(),'—');
      const before=await page.evaluate(()=>saved.length);
      await page.click('#dSave');assert.equal(await page.evaluate(()=>saved.length),before);
      await page.check('#dFullDay');assert.equal(await page.locator('#dHint b').textContent(),'24');
      await page.click('#dSave');await page.waitForFunction(count=>saved.length===count+1,before);
      assert.equal(await page.evaluate(()=>saved.at(-1).end_day),1);
    });
    await check('reserve selection clears ordinary consent and switching back requires fresh consent',async()=>{
      await page.evaluate(()=>openRecord({day_type:'regular',shape:'regular',start:'07:00',end:'07:00',end_day:1}));
      await page.selectOption('#dType','reserve_shift');
      assert.equal(await page.locator('#dFullDayWrap').isVisible(),false);
      assert.equal(await page.locator('#dFullDay').isChecked(),false);
      assert.equal(await page.locator('#dHint b').textContent(),'24');
      await page.selectOption('#dType','regular');
      assert.equal(await page.locator('#dFullDayWrap').isVisible(),true);
      assert.equal(await page.locator('#dHint b').textContent(),'—');
    });
    await check('freshness failure prevents opening new editor and saving an existing reserve record',async()=>{
      await page.evaluate(()=>{refreshAllowed=false;document.getElementById('dlg').innerHTML='';});
      await page.evaluate(()=>openRecord(null));assert.equal(await page.locator('#dType').count(),0);
      await page.evaluate(()=>openRecord({day_type:'reserve_shift',shape:'regular',start:'07:00',end:'07:00',end_day:1}));
      const before=await page.evaluate(()=>saved.length);
      await page.click('#dSave');assert.equal(await page.evaluate(()=>saved.length),before);
      await page.evaluate(()=>{refreshAllowed=true;});
    });
    await check('HR correction preserves refresh and cache invalidation after reserve save',async()=>{
      await page.evaluate(()=>{otherSubject=true;});
      await page.evaluate(()=>openRecord({day_type:'reserve_shift',shape:'regular',start:'07:00',end:'07:00',end_day:1}));
      await page.fill('#dCorrectionReason','Synthetic HR correction reason for this fixture');
      const before=await page.evaluate(()=>({saved:saved.length,reloads,cacheClears,refreshes}));
      await page.click('#dSave');await page.waitForFunction(count=>saved.length===count+1,before.saved);
      assert.deepEqual(await page.evaluate(()=>({reloads,cacheClears,refreshes})),{reloads:before.reloads+1,cacheClears:before.cacheClears+1,refreshes:before.refreshes+1});
      await page.evaluate(()=>{otherSubject=false;});
    });
    await check('actual retry keeps exact reserve intent and request ID after lost response/reconnect',async()=>{
      const result=await page.evaluate(async()=>{
        const intent={date:'2026-09-29',operation:'save',expected_version:'absent',patch:{day_type:'reserve_shift',shape:'regular',start:'07:00',end:'07:00',end_day:1}};
        const calls=[];let connected=false,committed=null;
        const transport=async payload=>{
          calls.push(structuredClone(payload));
          if(!committed)committed=structuredClone(payload);
          if(!connected)throw Object.assign(new Error('simulated reply lost after commit'),{code:'functions/unavailable'});
          if(JSON.stringify(payload)!==JSON.stringify(committed))throw Error('changed retry');
          return {data:{outcome:'recorded',duplicate:true,operation:'save',operation_id:'a'.repeat(64)}};
        };
        let first,changed;
        try{await callActualCorrection(transport,intent,'self');first='fabricated-success';}catch(error){first={code:error.code,uncertain:error.uncertain};}
        const pending=retryPending();
        try{await callActualCorrection(transport,{...intent,patch:{...intent.patch,end:'08:00'}},'self');changed='fabricated-success';}catch(error){changed=error.code;}
        connected=true;
        const receipt=await callActualCorrection(transport,intent,'self');
        return {first,changed,pending,calls,receipt:receipt.data,after:retryPending()};
      });
      assert.deepEqual(result.first,{code:'functions/unavailable',uncertain:true});
      assert.equal(result.changed,'correction-pending');assert.equal(result.calls.length,2);
      assert.deepEqual(result.calls[0],result.calls[1]);
      assert.equal(result.calls[0].request_id,result.pending.requestId);
      assert.equal(result.pending.inFlight,false);assert.equal(result.receipt.duplicate,true);assert.equal(result.after,null);
    });
    await check('actual in-flight duplicate is blocked without dispatching a second save',async()=>{
      const result=await page.evaluate(async()=>{
        const intent={date:'2026-09-29',operation:'save',expected_version:'absent',patch:{day_type:'reserve_shift',shape:'regular',start:'07:00',end:'07:00',end_day:1}};
        let release,calls=0;
        const transport=()=>{calls++;return new Promise(resolve=>{release=resolve;});};
        const first=callActualCorrection(transport,intent,'self');
        let second;
        try{await callActualCorrection(transport,intent,'self');second='fabricated-success';}catch(error){second=error.code;}
        const during=retryPending();
        release({data:{outcome:'recorded',duplicate:false,operation:'save',operation_id:'b'.repeat(64)}});
        await first;
        return {calls,second,during,after:retryPending()};
      });
      assert.equal(result.calls,1);assert.equal(result.second,'correction-in-flight');
      assert.equal(result.during.inFlight,true);assert.equal(result.after,null);
    });
    await check('malformed receipt never reports success and exact retry retains identity',async()=>{
      const result=await page.evaluate(async()=>{
        const intent={date:'2026-09-29',operation:'save',expected_version:'absent',patch:{day_type:'reserve_shift',shape:'regular',start:'08:00',end:'16:00',end_day:0}};
        const calls=[];let good=false;
        const transport=async payload=>{calls.push(structuredClone(payload));return {data:good?{outcome:'recorded',duplicate:true,operation:'save',operation_id:'c'.repeat(64)}:{outcome:'recorded'}};};
        let error;
        try{await callActualCorrection(transport,intent,'self');error='fabricated-success';}catch(value){error={code:value.code,uncertain:value.uncertain};}
        good=true;await callActualCorrection(transport,intent,'self');
        return {error,calls,after:retryPending()};
      });
      assert.deepEqual(result.error,{code:'correction-uncertain',uncertain:true});
      assert.deepEqual(result.calls[0],result.calls[1]);assert.equal(result.after,null);
    });
    assert.deepEqual(errors,[]); await context.close();
  }
  console.log(`Reserve shift actual-source browser: ${passed}/${passed} PASS. Synthetic transport; not authenticated end-to-end or production verification.`);
} finally { await browser.close(); }
