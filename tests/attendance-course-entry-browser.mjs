// Real shared editor + entry handlers, synthetic transport only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('./lib/contained-playwright.cjs');
const source=fs.readFileSync(new URL('../attendance.html',import.meta.url),'utf8');
const style=[...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(x=>x[1]).join('\n');
assert.match(fs.readFileSync(new URL('../firebase-messaging-sw.js',import.meta.url),'utf8'),/'\.\/attendance-course-entry\.js'/);
const extract=(start,end)=>{assert.equal(source.split(start).length,2);const at=source.indexOf(start);return source.slice(at,source.indexOf(end,at));};
const manual=extract("$('btnManual').onclick = () => {",'// ---------- תיקון וחישוב מחדש ----------');
const editor=extract('async function editDay(key, rec){','// ---------- שליחה ואישור ----------');
const origin='http://127.0.0.1:41993';
const harness=`
import {createCourseEntry,mountManualDateChooser} from '/attendance-course-entry.js';
import {DAY_TYPES,REASON_TYPES,SHAPES,shapeOf,needsTimes,calcHours,reasonWhy,guessDayOffset,retroLabel} from '/hours.js';
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
let identity=1,view=1,records={},monthDataReady=true;const mySite='',sites=[],SUBJ={uid:'mock'},locked=()=>false,onOther=()=>false;
const captureMonthWrite=()=>({month:'2026-09',identity,view}),sameMonthWrite=t=>t.identity===identity&&t.view===view;
const localToday=()=> '2026-10-01',openOv=()=>{$('ov').classList.add('on');},closeOv=()=>{$('ov').classList.remove('on');$('dlg').innerHTML='';},msg=()=>{},
baseTimes=()=>({start:'07:00',end:'07:00'}),myGuardOn=()=>null,workingOn=()=>true,siteHoursOf=()=>0,shiftHoursFor=()=>24,
canSelectReserveShift=()=>true,loadMonth=async()=>{},render=()=>{},saveRecord=async()=>{window.rawSaves++;},newRecord=()=>({});
const ensureFreshAttendanceForWrite=async()=>true;
window.rawSaves=0;window.sent=[];window.mode='uncertain';let release;
const mount=createCourseEntry({capture:captureMonthWrite,current:t=>t.identity===identity,currentView:sameMonthWrite,
send:async payload=>{window.sent.push(structuredClone(payload));if(window.mode==='uncertain')throw Error('network');if(window.mode==='delay')await new Promise(r=>release=r);return {case_id:'a'.repeat(64),revision:1,outcome:'saved'};}});
function openCourseRequest(key){mount($('dlg'),key,closeOv);openOv();}
window.updateSafe=()=>mount.updateGuard();
${manual}
${editor}
window.openRow=()=>editDay('2026-09-12',undefined);
window.stale=()=>{view++;};window.other=()=>{identity++;view++;};window.resolve=()=>release();
window.ready=true;
`;
const browser=await chromium.launch();let passed=0;
try{for(const width of [375,430]){
 const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin)return route.abort();
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width"><html lang="he" dir="rtl"><style>'+style+'</style><button id="btnManual">ידני</button><div id="ov"><div class="dlg" id="dlg"></div></div><script type="module" src="/harness.js"></script>'});
  if(u.pathname==='/harness.js')return route.fulfill({contentType:'text/javascript',body:harness});
  if(['/hours.js','/attendance-course-entry.js'].includes(u.pathname))return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(new URL('..'+u.pathname,import.meta.url),'utf8')});return route.abort();});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.text());});await page.goto(origin);await page.waitForFunction(()=>window.ready);
 const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+width+' '+name);};
 await check('manual historical month chooses explicit date and same complete editor',async()=>{await page.click('#btnManual');assert.equal(await page.inputValue('#manualDate'),'2026-09-01');await page.fill('#manualDate','2026-09-18');await page.click('#manualChoose');assert.match(await page.textContent('#dlgTitle'),/18.9.2026/);assert.equal(await page.locator('#dType option').count(),10);assert.equal(await page.locator('#dShape option').count(),3);assert.equal(await page.locator('#dType option[value=course]').count(),1);});
 await check('row path uses same full types and dropdown course request action',async()=>{await page.evaluate(()=>openRow());assert.equal(await page.locator('#dType option').count(),10);await page.selectOption('#dType','course');assert.equal(await page.inputValue('#courseFrom'),'2026-09-12');assert.match(await page.textContent('#dlg'),/אין זיכוי כעת/);assert.equal(await page.evaluate(()=>updateSafe()),false);});
 await check('programmatic course selection followed by save cannot write raw attendance',async()=>{await page.evaluate(async()=>{await openRow();document.getElementById('dType').value='course';});await page.click('#dSave');assert.equal(await page.locator('#courseFrom').count(),1);assert.equal(await page.evaluate(()=>rawSaves),0);});
 await check('invalid range never sends',async()=>{await page.fill('#courseTo','2026-09-01');await page.click('#courseSend');assert.equal(await page.evaluate(()=>sent.length),0);assert.match(await page.textContent('#courseMessage'),/טווח/);});
 await check('uncertain retry preserves exact payload even after closing and reopening',async()=>{await page.fill('#courseTo','2026-10-12');await page.click('#courseSend');await page.waitForFunction(()=>sent.length===1);await page.click('#courseCancel');await page.click('#btnManual');await page.click('#manualCourse');assert.equal(await page.inputValue('#courseTo'),'2026-10-12');await page.evaluate(()=>mode='saved');await page.click('#courseSend');await page.waitForFunction(()=>sent.length===2);const calls=await page.evaluate(()=>sent);assert.deepEqual(calls[0],calls[1]);assert.match(await page.textContent('#courseMessage'),/לא נוספו שעות/);});
 await check('stale view response cannot confirm or recreate; same owner retry stays stable',async()=>{await page.evaluate(()=>openRow());await page.click('#dCourseRequest');await page.evaluate(()=>mode='delay');await page.click('#courseSend');await page.waitForFunction(()=>sent.length===3);await page.evaluate(()=>{stale();resolve();});await page.waitForTimeout(10);assert.doesNotMatch(await page.textContent('#courseMessage'),/נקלטה/);await page.evaluate(()=>openRow());await page.click('#dCourseRequest');await page.evaluate(()=>mode='saved');await page.click('#courseSend');await page.waitForFunction(()=>sent.length===4);const calls=await page.evaluate(()=>sent);assert.deepEqual(calls[2],calls[3]);});
 await check('changed identity cannot send stale dialog',async()=>{await page.evaluate(()=>openRow());await page.click('#dCourseRequest');await page.evaluate(()=>other());await page.click('#courseSend');assert.equal(await page.evaluate(()=>sent.length),4);});
 await check('close and remount during busy restores retry controls without duplicate send',async()=>{await page.evaluate(()=>openRow());await page.click('#dCourseRequest');await page.evaluate(()=>mode='delay');await page.click('#courseSend');await page.waitForFunction(()=>sent.length===5);await page.click('#courseCancel');assert.equal(await page.evaluate(()=>updateSafe()),false);await page.click('#btnManual');await page.click('#manualCourse');assert.equal(await page.isDisabled('#courseSend'),true);await page.evaluate(()=>resolve());await page.waitForFunction(()=>!document.getElementById('courseSend').disabled);assert.equal(await page.evaluate(()=>sent.length),5);await page.evaluate(()=>mode='saved');await page.click('#courseSend');await page.waitForFunction(()=>sent.length===6);const calls=await page.evaluate(()=>sent);assert.deepEqual(calls[4],calls[5]);assert.equal(await page.evaluate(()=>updateSafe()),true);});
 await check('no browser errors and no horizontal overflow',async()=>{assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);});
 await context.close();
}console.log('Course entry browser '+passed+'/'+passed+' PASS');}finally{await browser.close();}
