// Production page functions, synthetic transport and identity; no Firebase connection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('./lib/contained-playwright.cjs');
const source=fs.readFileSync(new URL('../attendance.html',import.meta.url),'utf8');
const extract=(start,end)=>{assert.equal(source.split(start).length,2,start);const at=source.indexOf(start);assert.ok(source.indexOf(end,at)>at);return source.slice(at,source.indexOf(end,at));};
const helpers=extract('function readyReportRows(){','function render(){');
const preview=extract('function submitPreview(){',"$('btnSubmit').onclick = submitPreview;");
const write=extract('async function writeReport(status){','// לפני שליחה');
const correction=extract('async function callCorrection(callable, intent, kind){','function correctionErrorText');
const receipt=extract('function validCorrectionReceipt(kind, data){','async function callCorrection');
const styles=[...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(x=>x[1]).join('\n');
assert.match(source,/SUBJ = ME\.emp \? Object\.assign\(\{\}, ME\) : null/);
assert.match(source,/CAN_EDIT_OTHERS = isSuper \|\| c\.role === 'hr_coordinator'/);
assert.match(source,/if \(CAN_EDIT_OTHERS\) \{[\s\S]*?pickCard/);
assert.doesNotMatch(source,/<h3>1 · הכנת טיוטה/);
assert.match(source,/id="btnFill" hidden/);
assert.match(source,/id="dDel">בטל דיווח טיוטה/);
assert.match(source,/\$\('btnUnsubmit'\)\.onclick/);
const actions=extract("    const td = document.createElement('td');\n    td.className = 'c-act';",'    if (rec &&');
const origin='http://127.0.0.1:41994';
const harness=`
import {DAY_TYPES,dayTypeHe,monthSummary,shapeOf,calcHours} from '/hours.js';
import {reportPage} from '/report.js';
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
const MONTHS=['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר'],SID='demo',sites=[],mySite='';
let SUBJ={uid:'self',emp:'1',full_name:'עובד בדיקה'},viewYear=2026,viewMonth=8,monthLoadGeneration=1,monthDataReady=true,records={},report=null,courseMonth={revision:0},identity=1,other=false;
let pendingCorrectionOperation=null,pendingReadyFill=null,pendingReadySubmit=null,readyConfirmBusy=false,invalidTime=false;
const onOther=()=>other,projectCourseRows=rows=>rows,baseTimes=()=>({start:'07:00',end:'07:00',end_day:invalidTime?null:1}),siteHoursOf=()=>0,shiftHoursFor=()=>24;
const suggestedDays=()=>records['2026-09-12']?[]:['2026-09-12'];
const newRecord=(date,patch)=>({date,notes:'',...patch});
const reportedHours=row=>typeof row.hours==='number'?row.hours:null;
const correctedMonthHours=rows=>rows.some(r=>reportedHours(r)===null)?null:rows.reduce((n,r)=>n+r.hours,0);
const captureMonthWrite=()=>({month:'2026-09',identity,generation:monthLoadGeneration});
const sameCorrectionOrigin=t=>t.identity===identity,sameMonthWrite=t=>sameCorrectionOrigin(t)&&t.generation===monthLoadGeneration;
const requireMonthWrite=t=>{if(!sameMonthWrite(t))throw Error('stale');};
const openOv=()=>{$('ov').classList.add('on');},closeOv=()=>{$('ov').classList.remove('on');},render=()=>{},focusAfterRender=()=>{},userError=(_w,_e,m)=>m;
const msg=(s)=>{window.message=s;};
const ensureFreshAttendanceForWrite=async()=>true;
window.scenario='ok';window.fills=[];window.submits=0;window.shares=[];window.message='';window.submitCalls=[];let remote=[],accepted=false;
const createMissingDays=async(target,rows)=>{requireMonthWrite(target);window.fills.push(structuredClone(rows));if(window.scenario==='uncertain'){pendingCorrectionOperation={key:'same-intent'};const e=Error('network');e.uncertain=true;throw e;}pendingCorrectionOperation=null;remote=rows.map(r=>({...r,_unconfirmed:undefined,_expected_version:{seconds:10,nanoseconds:1},hours:calcHours(r,0)}));};
const loadMonth=async()=>{monthLoadGeneration++;for(const row of remote)records[row.date]=row;remote=[];
 if(records['2026-09-01'])records['2026-09-01']._expected_version=structuredClone(records['2026-09-01']._expected_version);
 if(window.scenario==='saved-change')records['2026-09-01']._expected_version={seconds:11,nanoseconds:1};
 if(window.scenario==='hours-change')records['2026-09-12'].end='08:00';
 if(window.scenario==='course-change')courseMonth.revision++;
 if(window.scenario==='identity-change')identity++;
 return true;};
const newCorrectionRequestId=()=>crypto.randomUUID(),definiteCorrectionRejection=()=>false,clearAttendanceStaticCache=()=>{};
${receipt}
${correction}
const callMutateMyAttendanceMonth=async payload=>{window.submitCalls.push(structuredClone(payload));if(!accepted){accepted=true;window.submits++;}report={status:'submitted',_expected_version:{seconds:20,nanoseconds:1}};
 if(window.scenario==='submit-uncertain'){window.scenario='ok';throw Error('lost-response');}
 return {data:{outcome:'recorded',duplicate:window.submitCalls.length>1,operation:'submit',operation_id:'a'.repeat(64),changed_count:1}};};
${write}
${helpers}
${preview}
window.show=()=>submitPreview();window.readyRows=()=>readyReportRows();
window.setOther=()=>{other=true;};window.stale=()=>{identity++;};
window.seed=()=>{records['2026-09-01']={date:'2026-09-01',day_type:'regular',shape:'regular',start:'07:00',end:'07:00',end_day:1,hours:24,_expected_version:{seconds:1,nanoseconds:1}};};
window.seedCourse=()=>{records['2026-09-12']={date:'2026-09-12',day_type:'course',course_overlay:true,hours:24,_expected_version:{seconds:2,nanoseconds:1}};};
window.setReportStatus=status=>{report={status,_expected_version:{seconds:20,nanoseconds:1}};};
window.invalidateTime=()=>{invalidTime=true;};
window.reset=()=>{records={};report=null;courseMonth={revision:0};identity++;monthLoadGeneration++;pendingCorrectionOperation=null;pendingReadyFill=null;pendingReadySubmit=null;readyConfirmBusy=false;invalidTime=false;other=false;window.fills=[];window.submits=0;window.submitCalls=[];accepted=false;window.message='';window.scenario='ok';remote=[];};
window.rowButtons=()=>{const key='2026-09-12',rec=undefined,isSug=true,overlay=false,correctionContext=null,date=new Date(2026,8,12),p=key.split('-'),DOWS=['א','ב','ג','ד','ה','ו','ש'];const locked=()=>false,editDay=()=>{window.opened=(window.opened||0)+1;};${actions}return td;};
const originalCreate=URL.createObjectURL.bind(URL);URL.createObjectURL=file=>{window.exported=file;return originalCreate(file);};
Object.defineProperty(navigator,'canShare',{value:()=>true,configurable:true});Object.defineProperty(navigator,'share',{value:async data=>window.shares.push(await data.files[0].text()),configurable:true});
window.ready=true;
`;
let passed=0;const browser=await chromium.launch();
try{for(const width of [375,430]){
 const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin)return route.abort();
 if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="he" dir="rtl"><meta name="viewport" content="width=device-width"><style>'+styles+'</style><div id="ov"><div id="dlg" class="dlg"></div></div><script type="module" src="/harness.js"></script>'});
 if(u.pathname==='/harness.js')return route.fulfill({contentType:'text/javascript',body:harness});
 if(['/hours.js','/report.js'].includes(u.pathname))return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(new URL('..'+u.pathname,import.meta.url),'utf8')});return route.abort();});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.text());});
 await page.goto(origin);await page.waitForFunction(()=>window.ready);
 const check=async(name,fn)=>{await page.evaluate(()=>{reset();show();});await fn();passed++;console.log('PASS '+width+' '+name);};
 await check('ready report is automatic view only, explicit unconfirmed 24h day',async()=>{assert.equal(await page.evaluate(()=>fills.length+submits),0);assert.match(await page.textContent('#dlg'),/ימים מהסידור שטרם אושרו/);assert.match(await page.textContent('#dlg'),/2026-09-12.*07:00–07:00.*למחרת/);assert.equal((await page.evaluate(()=>readyRows()))[0].hours,24);});
 await check('one confirmation fills missing only then submits freshly read versions',async()=>{await page.evaluate(()=>{seed();show();});await page.click('#pSend');await page.waitForFunction(()=>submits===1);assert.equal(await page.evaluate(()=>fills.length),1);assert.deepEqual(await page.evaluate(()=>fills[0].map(r=>r.date)),['2026-09-12']);});
 for(const scenario of ['saved-change','hours-change','course-change'])await check(scenario+' requires renewed confirmation, never submit',async()=>{await page.evaluate(s=>{seed();scenario=s;show();},scenario);await page.click('#pSend');await page.waitForFunction(()=>message.includes('אישור מחדש'));assert.equal(await page.evaluate(()=>submits),0);assert.equal(await page.evaluate(()=>fills.length),1);});
 await check('uncertain fill prevents new intent and automatic retry',async()=>{await page.evaluate(()=>scenario='uncertain');await page.click('#pSend');await page.waitForFunction(()=>message.includes('אישור סופי'));await page.evaluate(()=>show());await page.click('#pSend');assert.equal(await page.evaluate(()=>fills.length),1);assert.equal(await page.evaluate(()=>submits),0);});
 await check('explicit recovery repeats exact frozen fill, never auto-submits',async()=>{await page.evaluate(()=>scenario='uncertain');await page.click('#pSend');await page.waitForSelector('#pRecover');await page.evaluate(()=>scenario='ok');await page.click('#pRecover');await page.waitForFunction(()=>message.includes('לא נשלח אוטומטית'));const calls=await page.evaluate(()=>fills);assert.deepEqual(calls[0],calls[1]);assert.equal(await page.evaluate(()=>submits),0);await page.click('#pSend');await page.waitForFunction(()=>submits===1);assert.equal(await page.evaluate(()=>fills.length),2);});
 await check('lost submitted response explicitly replays same request ID without another fill or commit',async()=>{await page.evaluate(()=>scenario='submit-uncertain');await page.click('#pSend');await page.waitForSelector('#pRecoverSubmit');assert.equal(await page.evaluate(()=>submits),1);await page.click('#pRecoverSubmit');await page.waitForFunction(()=>submitCalls.length===2);const calls=await page.evaluate(()=>submitCalls);assert.deepEqual(calls[0],calls[1]);assert.equal(await page.evaluate(()=>fills.length),1);assert.equal(await page.evaluate(()=>submits),1);await page.waitForFunction(()=>message.includes('ממתין לאישור'));});
 await check('invalid configured interval cannot become plausible credited hours',async()=>{await page.evaluate(()=>{invalidateTime();show();});assert.equal((await page.evaluate(()=>readyRows()))[0].hours,null);assert.equal(await page.locator('#pSend').count(),0);assert.equal(await page.isDisabled('#pDownload'),true);assert.equal(await page.isDisabled('#pShare'),true);});
 await check('identity change after fill prevents submit',async()=>{await page.evaluate(()=>scenario='identity-change');await page.click('#pSend');await page.waitForTimeout(20);assert.equal(await page.evaluate(()=>submits),0);});
 await check('explicit day Edit beside Save both open editor without writes',async()=>{assert.deepEqual(await page.evaluate(()=>{const td=rowButtons();return [...td.querySelectorAll('button')].map(b=>b.textContent);}),['שמור','ערוך']);await page.evaluate(()=>{for(const b of rowButtons().querySelectorAll('button'))b.click();});assert.equal(await page.evaluate(()=>opened),2);assert.equal(await page.evaluate(()=>fills.length+submits),0);});
 await check('HR view cannot fill or self-submit',async()=>{await page.evaluate(()=>{seed();setOther();show();});assert.equal(await page.locator('#pSend').count(),0);assert.equal(await page.evaluate(()=>fills.length+submits),0);});
 await check('local share uses explicit preview file, never public URL or automatic send',async()=>{const before=await page.evaluate(()=>shares.length);await page.click('#pShare');await page.waitForFunction(n=>shares.length===n+1,before);const html=await page.evaluate(n=>shares[n],before);assert.match(html,/תצוגה מקדימה · טרם אושר/);assert.match(html,/לפי הסידור בלבד/);assert.equal(await page.evaluate(()=>fills.length+submits),0);});
 await check('actual report renderer preserves approved course red class and Hebrew label',async()=>{await page.evaluate(()=>{seedCourse();show();});const before=await page.evaluate(()=>shares.length);await page.click('#pShare');await page.waitForFunction(n=>shares.length===n+1,before);const html=await page.evaluate(n=>shares[n],before);assert.match(html,/<tr class="day-course">/);assert.match(html,/tr\.day-course td\{background:#ffe3e3/);assert.match(html,/>קורס<\/td>/);assert.match(html,/קורס מאושר/);assert.equal(await page.evaluate(()=>fills.length+submits),0);});
 for(const [status,label] of [['submitted','ממתין לאישור'],['approved','אושר']])await check(status+' export retains actual server status without draft banner',async()=>{await page.evaluate(s=>{seed();setReportStatus(s);show();},status);const before=await page.evaluate(()=>shares.length);await page.click('#pShare');await page.waitForFunction(n=>shares.length===n+1,before);const html=await page.evaluate(n=>shares[n],before);assert.match(html,new RegExp('<b>'+label+'</b>'));assert.doesNotMatch(html,/תצוגה מקדימה|טרם אושר על ידי הכבאי|הדוח טרם נשלח/);assert.equal(await page.evaluate(()=>fills.length+submits),0);});
 await check('saved unsubmitted report remains honestly unsubmitted without schedule claim',async()=>{await page.evaluate(()=>{seedCourse();setReportStatus('draft');show();});const before=await page.evaluate(()=>shares.length);await page.click('#pShare');await page.waitForFunction(n=>shares.length===n+1,before);const html=await page.evaluate(n=>shares[n],before);assert.match(html,/הדוח טרם נשלח לאישור/);assert.doesNotMatch(html,/ימים המסומנים לפי הסידור אינם אישור נוכחות/);assert.equal(await page.evaluate(()=>fills.length+submits),0);});
 await check('stale preview cannot share',async()=>{const before=await page.evaluate(()=>shares.length);await page.evaluate(()=>stale());await page.click('#pShare');assert.equal(await page.evaluate(()=>shares.length),before);});
 await check('no browser errors or mobile overflow',async()=>{assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);});
 await context.close();
}console.log('Ready report browser '+passed+'/'+passed+' PASS');}finally{await browser.close();}
