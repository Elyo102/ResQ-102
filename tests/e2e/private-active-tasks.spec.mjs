import {test,expect} from '../lib/contained-test.mjs';
import {readFileSync} from 'node:fs';
// Synthetic harness for the active-tasks panel and the agent-card liveness line: real view/model/private-view code,
// mocked API (no cloud). UI review conditions 1-11 (control-plane/ACTIVE-TASKS.md).
const source=new URL('../../control-plane/web/',import.meta.url);
const files=['private-view.mjs','private-controller.mjs','active-tasks-view.mjs','active-tasks-model.mjs','dispatch-model.mjs'];
async function mount(page,{tick=0}={}){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!=='http://localhost:41996'){await route.abort();return;}
  const file=url.pathname.split('/').pop();
  if(files.includes(file)){await route.fulfill({body:readFileSync(new URL(file,source)),contentType:'text/javascript'});return;}
  if(file==='private.css'){await route.fulfill({body:readFileSync(new URL('private.css',source)),contentType:'text/css'});return;}
  await route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="he" dir="rtl"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/private.css"><p>בדיקה סינתטית בלבד — לא מחובר לענן</p><main id="root"></main><script type="module">
import {mountPrivateDashboard} from '/private-view.mjs?v=20260930-grok-dispatch6';
import {mountActiveTasksPanel} from '/active-tasks-view.mjs?v=20260930-grok-dispatch6';
let onAuth;window.creates=[];window.verifies=[];window.cancels=[];window.listeners=[];window.uidNow='synthetic-owner';
window.watchStarts=0;window.watchStops=0;window.listenerStarts=0;window.listenerStops=0;
window.createImpl=()=>new Promise(()=>{});window.verifyImpl=()=>Promise.resolve({exists:false});window.cancelImpl=()=>Promise.resolve();window.authImpl=async()=>Date.now();
const api={uid:()=>window.uidNow,authTime:()=>window.authImpl(),
 watch({next,error}){window.watchStarts++;window.feedNext=next;window.feedError=error;return()=>{window.watchStops++;};},
 watchListeners({next,error}){window.listenerStarts++;window.hbNext=next;window.hbError=error;return()=>{window.listenerStops++;};},
 create(task){window.creates.push(JSON.parse(JSON.stringify(task)));return window.createImpl(task);},
 verify(id){window.verifies.push(id);return window.verifyImpl(id);},cancel(id){window.cancels.push(id);return window.cancelImpl(id);},
 watchAckSwitch({next,error}){window.swStarts=(window.swStarts||0)+1;window.swNext=next;window.swError=error;return()=>{};},
 setAckSwitch(enabled,opts){window.switchWrites.push({enabled,exists:opts.exists});return window.switchImpl(enabled,opts);},
 markProgress(id,key,state){window.progressWrites.push([id,key,state]);return window.progressImpl(id,key,state);}};
window.switchWrites=[];window.progressWrites=[];window.switchImpl=()=>Promise.resolve();window.progressImpl=()=>Promise.resolve();
window.panel=mountActiveTasksPanel({doc:document,api,signIn:()=>new Promise(()=>{}),sendTimeoutMs:1500,tickMs:Number(new URLSearchParams(location.search).get('tick')||0)});
window.setIdentity=user=>onAuth(user);
const mockAuth={onIdentity(fn){onAuth=fn;return()=>{};},async signIn(){},async signOut(){window.setIdentity(null);}};
window.dispose=mountPrivateDashboard({root:document.getElementById('root'),auth:mockAuth,subscribe(h){window.listeners.push(h);return()=>{};},
 activeTasksPanel:window.panel,listenerStatus:window.panel.listenerStatus});
window.row=(n,extra={})=>({id:'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),taskId:'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),dispatchedBy:'synthetic-owner',
 payload:'משימה '+n,status:'PENDING',timestamp:Date.now()-60000+n,targets:{grok:'EXECUTE',codex:'IGNORE',gemini:'IGNORE'},progress:{},...extra});
window.entry=(state,step,agoMs=1000)=>({state,step,updatedAt:Date.now()-agoMs});
</script></html>`});
 });
 await page.goto('http://localhost:41996/private-active-tasks'+(tick?'?tick='+tick:''));await expect(page.locator('#private-login')).toBeVisible();return errors;
}
// Optional axe-core scan: the repo does not ship axe (no new dependency); set RESQ_AXE_PATH to an axe.min.js to run it.
async function axeClean(page,include){
 const path=process.env.RESQ_AXE_PATH;if(!path)return null;
 await page.addScriptTag({content:readFileSync(path,'utf8')});
 const r=await page.evaluate(async include=>{const res=await window.axe.run({include},{resultTypes:['violations']});return res.violations.map(v=>v.id+': '+v.nodes.map(n=>n.target.join(' ')).join(', '));},include);
 expect(r).toEqual([]);return r;
}
const authorize=page=>page.evaluate(()=>setIdentity({uid:'synthetic-owner',backendAuthorized:true}));
const events=page=>page.evaluate(()=>listeners.at(-1).next([{id:'00000000-0000-0000-0000-000000000001',agent:'Codex',kind:'heartbeat',task:'local_tests',step:'running',at:Date.now()}],{fromCache:false}));
const chip=(page,n,agent)=>page.locator(`.active-row[data-id="00000000-0000-4000-8000-${String(n).padStart(12,'0')}"] .active-chip[data-agent="${agent}"]`);
const rowEl=(page,n)=>page.locator(`.active-row[data-id="${rid(n)}"]`);
const rid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const card=(page,agent)=>page.locator('.agent',{has:page.locator('h2',{hasText:agent})});

test('agent cards show listener liveness only: אין מאזין until a real heartbeat, then מאזין, then מנותק; never מוכן',async({page})=>{
 const errors=await mount(page);await page.locator('#private-login').click();await authorize(page);await events(page);
 await expect(page.locator('.agent')).toHaveCount(4);
 // before the first server snapshot of task_listeners the state is unknown, never "אין מאזין"
 await expect(card(page,'Grok').locator('.agent-listener')).toHaveText('משימות: טוען…');
 await expect(page.locator('#active-feed .active-loading')).toHaveText('טוען…');   // before the first feed snapshot
 await page.evaluate(()=>{hbNext({});feedNext([]);});await expect(page.locator('.active-loading')).toHaveCount(0);await expect(page.locator('.active-empty')).toHaveCount(1);
 for(const a of ['Codex','Grok','Gemini'])await expect(card(page,a).locator('.agent-listener')).toHaveText('משימות: אין מאזין');
 // telemetry status labelled "CI:" when a listener line is present; the .agent-status text itself is unchanged
 await expect(card(page,'Codex').locator('.agent-status-row .agent-source')).toHaveText('CI:');await expect(card(page,'Codex').locator('.agent-status')).toHaveCount(1);
 await expect(card(page,'Claude').locator('.agent-source')).toHaveCount(0);
 await expect(card(page,'Claude').locator('.agent-listener')).toHaveCount(0);
 await expect(card(page,'Codex').locator('small')).toHaveCount(1);   // the existing detail line is unchanged
 await page.evaluate(()=>hbNext({grok:Date.now()-5000}));
 await expect(card(page,'Grok').locator('.agent-listener')).toHaveText('משימות: מאזין');await expect(card(page,'Codex').locator('.agent-listener')).toHaveText('משימות: אין מאזין');
 await page.evaluate(()=>hbNext({grok:Date.now()-200000}));await expect(card(page,'Grok').locator('.agent-listener')).toHaveText('משימות: מנותק');
 await expect(page.locator('body')).not.toContainText('מוכן');
 await page.evaluate(()=>setIdentity(null));await expect(page.locator('#active-tasks-panel')).toBeHidden();expect(errors).toEqual([]);
});
test('DELIVERED is never shown as בביצוע; delivery-off text; IGNORE chip; updatedAt in <bdi><time>',async({page})=>{
 const errors=await mount(page);await authorize(page);
 await page.evaluate(()=>{hbNext({grok:Date.now()});feedNext([row(1,{targets:{grok:'EXECUTE',codex:'EXECUTE',gemini:'IGNORE'},progress:{grok:entry('READY','delivered'),codex:entry('READY','delivery_off')}})]);});
 await expect(chip(page,1,'grok')).toContainText('נמסר — טרם התחיל');await expect(chip(page,1,'codex')).toContainText('מסירה כבויה, המשימה נשמרה בלבד');
 await expect(chip(page,1,'gemini')).toContainText('לא נבחר');await expect(page.locator('.active-chip')).toHaveCount(3);
 // status/chips never say בביצוע; only the owner's manual button (C10) carries that word, as an action
 await expect(page.locator('.active-chips')).not.toContainText('בביצוע');await expect(page.locator('.active-status')).not.toContainText('בביצוע');
 await expect(page.locator('.active-owner-btn')).toHaveText(['סמן: Grok בביצוע']);
 await expect(page.locator('.active-row .active-status')).toHaveText('סטטוס: נמסר — טרם התחיל');
 await expect(chip(page,1,'grok').locator('bdi > time[datetime]')).toHaveCount(1);expect(errors).toEqual([]);
});
test('IN_PROGRESS: בביצוע only with a fresh heartbeat; stale heartbeat -> "אין דופק מאז HH:mm"; stale progress -> לא ידוע / תקוע',async({page})=>{
 const errors=await mount(page);await authorize(page);
 await page.evaluate(()=>{hbNext({grok:Date.now()-2000});feedNext([row(1,{progress:{grok:entry('IN_PROGRESS','started',5*60000)}}),row(2,{progress:{grok:entry('IN_PROGRESS','started',61*60000)}})]);});
 await expect(chip(page,1,'grok').locator('.active-chip-text')).toHaveText('בביצוע');
 await expect(chip(page,2,'grok').locator('.active-chip-text')).toHaveText(/^לא ידוע \/ תקוע · ללא עדכון מאז \d\d:\d\d$/);
 await page.evaluate(()=>hbNext({grok:Date.now()-10*60000}));
 await expect(chip(page,1,'grok').locator('.active-chip-text')).toHaveText(/^בביצוע — אין דופק מאז \d\d:\d\d$/);
 await page.evaluate(()=>hbNext({}));await expect(chip(page,1,'grok').locator('.active-chip-text')).toHaveText('בביצוע — אין דופק מהמאזין');
 await page.evaluate(()=>feedNext([row(3,{timestamp:Date.now()-31*60000})]));
 await expect(chip(page,3,'grok').locator('.active-chip-text')).toHaveText(/^ממתין למאזין · ללא עדכון מאז \d\d:\d\d$/);expect(errors).toEqual([]);
});
test('all-IGNORE blocks sending; blocked character names the character, line and column; secret never echoed',async({page})=>{
 const errors=await mount(page);await authorize(page);const send=page.locator('#active-send');
 await page.locator('#active-payload').fill('משימה תקינה');await page.locator('#active-preview').click();
 await expect(page.locator('#active-result')).toHaveText('יש לבחור "לבצע" לסוכן אחד לפחות — כל הסוכנים במצב "לא נבחר".');
 await expect(send).toBeDisabled();await expect(page.locator('#active-send-reason')).toContainText('לא נבחר');await expect(page.locator('#active-preview-box')).toBeHidden();
 await page.locator('#active-target-grok').selectOption('EXECUTE');
 await page.locator('#active-payload').fill('שורה ראשונה\nab\u201cc');
 await expect(page.locator('#active-error')).toHaveText('התוכן מכיל תו שאינו מותר (לא תוקן אוטומטית): U+201C (\u201c) בשורה 2, עמודה 3');
 await page.locator('#active-payload').fill('a\tb');await expect(page.locator('#active-error')).toContainText('U+0009 בשורה 1, עמודה 2');
 expect(await page.locator('#active-payload').inputValue()).toBe('a\tb');   // no silent fix
 await page.locator('#active-preview').click();await expect(send).toBeDisabled();
 const secret='ghp_'+'x'.repeat(24);await page.locator('#active-payload').fill('token '+secret);
 await expect(page.locator('#active-error')).toContainText('השליחה חסומה');await expect(page.locator('#active-tasks-panel .active-error')).not.toContainText(secret);
 await expect(page.locator('#active-result')).not.toContainText(secret);
 expect(await page.evaluate(()=>creates.length)).toBe(0);expect(errors).toEqual([]);
});
test('preview is the exact doc; any edit invalidates it; retry and already-exists reuse the same taskId',async({page})=>{
 const errors=await mount(page);await authorize(page);const send=page.locator('#active-send');
 await page.locator('#active-target-codex').selectOption('EXECUTE');await page.locator('#active-payload').fill('בדיקה ראשונה');await page.locator('#active-preview').click();
 const shown=JSON.parse(await page.locator('#active-preview-json').textContent());
 expect(shown).toMatchObject({targets:{codex:'EXECUTE',grok:'IGNORE',gemini:'IGNORE'},status:'PENDING',timestamp:'ייקבע בשרת',progress:{},dispatchedBy:'synthetic-owner'});
 expect(Object.keys(shown)).not.toContain('payloadLength');
 expect(shown.taskId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);await expect(send).toBeEnabled();
 await page.locator('#active-target-gemini').selectOption('EXECUTE');await expect(page.locator('#active-preview-box')).toBeHidden();await expect(send).toBeDisabled();
 await page.locator('#active-preview').click();await page.locator('#active-payload').fill('בדיקה שנייה');await expect(page.locator('#active-preview-box')).toBeHidden();
 await expect(page.locator('#active-result')).toContainText('התצוגה המקדימה בוטלה');
 await page.locator('#active-preview').click();expect(JSON.parse(await page.locator('#active-preview-json').textContent()).taskId).toBe(shown.taskId);
 await send.click();await expect(page.locator('#active-result')).toContainText('לא אושר',{timeout:5000});   // timeout -> unconfirmed
 await expect(page.locator('#active-payload')).toHaveJSProperty('readOnly',true);
 await page.evaluate(()=>{window.createImpl=()=>Promise.reject(Object.assign(Error('exists'),{code:'permission-denied'}));
  window.verifyImpl=id=>Promise.resolve({exists:true,taskId:id,dispatchedBy:'synthetic-owner',payload:'בדיקה שנייה',targets:{grok:'IGNORE',codex:'EXECUTE',gemini:'EXECUTE'},status:'PENDING'});});
 await page.locator('#active-retry').click();await expect(page.locator('#active-result')).toHaveText('המשימה כבר נשמרה בשרת (אומת מול השרת).');
 const ids=await page.evaluate(()=>creates.map(c=>c.taskId));expect(ids).toEqual([shown.taskId,shown.taskId]);
 expect(await page.evaluate(()=>verifies)).toEqual([shown.taskId]);
 await expect(page.locator('#active-payload')).toHaveValue('');expect(errors).toEqual([]);
});
test('cancel cycle: only own PENDING rows, inline confirm with the no-guarantee note, status from the server as text',async({page})=>{
 const errors=await mount(page);await authorize(page);
 await page.evaluate(()=>feedNext([row(1),row(2,{dispatchedBy:'someone-else'}),row(3,{status:'CANCELLED'})]));
 const r1=page.locator('.active-row[data-id="00000000-0000-4000-8000-000000000001"]');
 await expect(page.locator('.active-cancel-btn')).toHaveCount(1);await expect(r1).toContainText('ביטול אינו מבטיח עצירה של עבודה שכבר התחילה.');
 await expect(page.locator('.active-row[data-id="00000000-0000-4000-8000-000000000003"] .active-status')).toHaveText('סטטוס: בוטל');
 await r1.locator('.active-cancel-btn').click();await expect(r1.locator('.active-confirm-text')).toContainText('לבטל את המשימה?');
 await r1.locator('.active-cancel-no').click();await expect(r1.locator('.active-cancel-btn')).toBeVisible();expect(await page.evaluate(()=>cancels.length)).toBe(0);
 await r1.locator('.active-cancel-btn').click();await r1.locator('.active-cancel-yes').click();
 await expect(page.locator('#active-result')).toHaveText('בקשת הביטול נשלחה; הסטטוס יתעדכן רק מהשרת.');
 await expect(r1.locator('.active-cancel-btn')).toBeFocused();   // focus returns to the row's cancel button, not lost to <body>
 expect(await page.evaluate(()=>cancels)).toEqual(['00000000-0000-4000-8000-000000000001']);
 await expect(r1.locator('.active-status')).not.toHaveText('סטטוס: בוטל');   // no optimistic status
 await page.evaluate(()=>feedNext([row(1,{status:'CANCELLED'})]));
 await expect(r1.locator('.active-status')).toHaveText('סטטוס: בוטל');await expect(page.locator('.active-cancel-btn')).toHaveCount(0);expect(errors).toEqual([]);
});
for(const width of [320,360])test(`mobile ${width}px: stacked full-width 16px selects, wrapping chips, no overflow with a 10k no-space payload`,async({page})=>{
 await page.setViewportSize({width,height:740});const errors=await mount(page);await authorize(page);
 const big='a'.repeat(10000);
 await page.evaluate(big=>{hbNext({grok:Date.now()});feedNext([row(1,{payload:big,targets:{grok:'EXECUTE',codex:'EXECUTE',gemini:'EXECUTE'},
  progress:{grok:entry('IN_PROGRESS','started'),codex:entry('READY','delivery_off'),gemini:entry('REJECTED','limit')}})]);},big);
 await page.locator('#active-payload').fill(big);
 // expanded 10k row + a 10k preview (JSON and payload body) must also stay inside the viewport
 await page.locator('#active-more-'+rid(1)).click();await expect(rowEl(page,1).locator('.active-payload-full')).toHaveCount(1);
 await page.locator('#active-target-grok').selectOption('EXECUTE');await page.locator('#active-preview').click();
 await expect(page.locator('#active-preview-payload')).toHaveText(big);await expect(page.locator('#active-preview-listeners')).toHaveCount(0);   // grok is listening
 await expect(page.locator('#active-limit-live')).toHaveText('התוכן הגיע למגבלה של 10000 תווים.');
 const boxes=await Promise.all(['gemini','codex','grok'].map(k=>page.locator('#active-target-'+k).boundingBox()));
 for(let i=1;i<boxes.length;i++){expect(boxes[i].y).toBeGreaterThan(boxes[i-1].y+boxes[i-1].height-1);expect(Math.abs(boxes[i].width-boxes[0].width)).toBeLessThan(1);}
 const field=await page.locator('.active-field').first().boundingBox();expect(Math.abs(boxes[0].width-field.width)).toBeLessThan(1);
 for(const k of ['gemini','codex','grok'])expect(await page.locator('#active-target-'+k).evaluate(e=>getComputedStyle(e).fontSize)).toBe('16px');
 expect(await page.locator('#active-payload').evaluate(e=>getComputedStyle(e).fontSize)).toBe('16px');
 const chipBoxes=await page.locator('.active-chip').evaluateAll(els=>els.map(e=>e.getBoundingClientRect()).map(r=>({top:r.top,left:r.left,right:r.right})));
 expect(new Set(chipBoxes.map(b=>Math.round(b.top))).size).toBeGreaterThan(1);   // chips wrap to more than one line
 for(const b of chipBoxes){expect(b.left).toBeGreaterThanOrEqual(0);expect(b.right).toBeLessThanOrEqual(width);}
 const overflow=await page.evaluate(()=>({doc:document.documentElement.scrollWidth,vw:document.documentElement.clientWidth,
  wide:[...document.querySelectorAll('#active-tasks-panel *')].filter(e=>e.getBoundingClientRect().right>document.documentElement.clientWidth+0.5||e.getBoundingClientRect().left<-0.5).map(e=>e.className||e.tagName)}));
 expect(overflow.doc).toBeLessThanOrEqual(overflow.vw);expect(overflow.wide).toEqual([]);expect(errors).toEqual([]);
});
test('keyed feed: tick updates chips/times in place; focus, <details> and row nodes survive ticks and unrelated snapshots',async({page})=>{
 const errors=await mount(page,{tick:100});await authorize(page);const long='שורה ארוכה\n'.repeat(40);
 await page.evaluate(long=>{hbNext({grok:Date.now()-165000+700});feedNext([row(1,{payload:long,progress:{grok:entry('IN_PROGRESS','started',60000)}}),row(2)]);},long);
 const summary=page.locator('#active-more-'+rid(1));await expect(summary).toHaveCount(1);
 await summary.click();await expect(summary).toBeFocused();
 await page.evaluate(id=>{document.querySelector(`.active-row[data-id="${id}"]`).__mark='kept';},rid(1));
 await expect(chip(page,1,'grok').locator('.active-chip-text')).toHaveText('בביצוע');
 // heartbeat ages past HEARTBEAT_FRESH_MS (165 s, C11) on the tick alone: chip text changes in place, focus and open state untouched
 await expect(chip(page,1,'grok').locator('.active-chip-text')).toHaveText(/^בביצוע — אין דופק מאז \d\d:\d\d$/,{timeout:4000});
 await expect(rowEl(page,1).locator('.active-status')).toHaveAttribute('data-kind','no_pulse');
 await expect(summary).toBeFocused();await expect(rowEl(page,1).locator('details')).toHaveJSProperty('open',true);
 // an unrelated row changes on the server: row 1 is not rebuilt
 await page.evaluate(long=>feedNext([row(1,{payload:long,progress:{grok:entry('IN_PROGRESS','started',60000)}}),row(2,{status:'CANCELLED'})]),long);
 await expect(rowEl(page,2).locator('.active-status')).toHaveText('סטטוס: בוטל');
 expect(await page.evaluate(id=>document.querySelector(`.active-row[data-id="${id}"]`).__mark,rid(1))).toBe('kept');
 await expect(summary).toBeFocused();await expect(rowEl(page,1).locator('details')).toHaveJSProperty('open',true);expect(errors).toEqual([]);
});
test('feed error: last rows kept and marked stale with the snapshot time; reconnect restarts the watchers; listener error -> unknown',async({page})=>{
 const errors=await mount(page);await authorize(page);
 await page.evaluate(()=>{hbNext({grok:Date.now()});feedNext([row(1)]);});await expect(rowEl(page,1)).toBeVisible();
 await expect(page.locator('#active-reconnect')).toBeHidden();await expect(rowEl(page,1).locator('.active-stale')).toBeHidden();
 await page.evaluate(()=>feedError());
 await expect(page.locator('#active-feed-error')).toHaveText(/^הפיד הופסק — מוצג מצב אחרון מ-\d\d:\d\d \(לא עדכני\)$/);
 await expect(rowEl(page,1)).toBeVisible();await expect(rowEl(page,1).locator('.active-stale')).toHaveText('לא עדכני');await expect(rowEl(page,1)).toHaveAttribute('data-stale','true');
 expect(await page.evaluate(()=>[watchStarts,watchStops])).toEqual([1,1]);
 await page.locator('#active-reconnect').click();expect(await page.evaluate(()=>watchStarts)).toBe(2);
 await page.evaluate(()=>feedNext([row(1),row(2)]));await expect(page.locator('#active-feed-error')).toHaveText('');await expect(page.locator('#active-reconnect')).toBeHidden();
 await expect(rowEl(page,1).locator('.active-stale')).toBeHidden();await expect(page.locator('.active-row')).toHaveCount(2);
 await page.evaluate(()=>hbError());
 await expect(card(page,'Grok').locator('.agent-listener')).toHaveText('משימות: לא ידוע (אין חיבור)');await expect(card(page,'Grok').locator('.agent-listener')).toHaveAttribute('data-listener','unknown');
 await page.evaluate(()=>feedNext([row(3,{progress:{grok:entry('IN_PROGRESS','started')}})]));   // stream failed: pulse unknown, never "אין דופק מהמאזין"
 await expect(chip(page,3,'grok').locator('.active-chip-text')).toHaveText('מצב המאזין לא ידוע');await expect(chip(page,3,'grok')).toHaveAttribute('data-kind','pulse_unknown');
 await expect(page.locator('body')).not.toContainText('משימות: אין מאזין');await expect(page.locator('#active-feed-error')).toContainText('מצב המאזינים לא ידוע (אין חיבור).');
 await page.locator('#active-reconnect').click();expect(await page.evaluate(()=>[listenerStarts,watchStarts])).toEqual([2,2]);
 await page.evaluate(()=>hbNext({grok:Date.now()}));await expect(card(page,'Grok').locator('.agent-listener')).toHaveText('משימות: מאזין');expect(errors).toEqual([]);
});
test('fromCache snapshots are never shown as current: "אין חיבור — מצב אחרון מ-HH:mm"; IN_PROGRESS is not בביצוע while the pulse is unknown',async({page})=>{
 const errors=await mount(page);await authorize(page);
 await page.evaluate(()=>feedNext(null,{fromCache:true}));await expect(page.locator('#active-feed-error')).toHaveText('אין חיבור — עדיין אין מצב מאושר מהשרת.');
 await page.evaluate(()=>{hbNext({grok:Date.now()});feedNext([row(1,{progress:{grok:entry('IN_PROGRESS','started')}})]);});
 await expect(chip(page,1,'grok').locator('.active-chip-text')).toHaveText('בביצוע');
 await page.evaluate(()=>{feedNext(null,{fromCache:true});hbNext(null,{fromCache:true});});
 await expect(page.locator('#active-feed-error')).toHaveText(/^אין חיבור — מצב אחרון מ-\d\d:\d\d מצב המאזינים לא ידוע \(אין חיבור\)\.$/);
 await expect(rowEl(page,1)).toHaveAttribute('data-stale','true');await expect(page.locator('#active-reconnect')).toBeHidden();   // the SDK reconnects by itself
 await expect(chip(page,1,'grok').locator('.active-chip-text')).toHaveText('מצב המאזין לא ידוע');await expect(chip(page,1,'grok')).toHaveAttribute('data-kind','pulse_unknown');
 await expect(rowEl(page,1).locator('.active-status')).toHaveAttribute('data-kind','pulse_unknown');await expect(page.locator('#active-tasks-panel')).not.toContainText('אין דופק');
 await expect(card(page,'Grok').locator('.agent-listener')).toHaveText('משימות: לא ידוע (אין חיבור)');expect(errors).toEqual([]);
});
test('preview names agents without a live listener: "אין מאזין — המשימה תישמר בלבד"; no payloadLength; dir=auto + plaintext bidi',async({page})=>{
 const errors=await mount(page);await authorize(page);
 await page.evaluate(()=>hbNext({grok:Date.now(),gemini:Date.now()-200000}));
 for(const k of ['grok','codex','gemini'])await page.locator('#active-target-'+k).selectOption('EXECUTE');
 await page.locator('#active-payload').fill('abc שלום');await page.locator('#active-preview').click();
 await expect(page.locator('#active-preview-listeners li')).toHaveText(['Gemini: מנותק — המשימה תישמר עד שהמאזין יחזור','Codex: אין מאזין — המשימה תישמר בלבד']);
 await expect(page.locator('#active-preview-json')).not.toContainText('payloadLength');
 // the warning follows listener state changes while the preview is open
 await page.evaluate(()=>hbNext({grok:Date.now(),gemini:Date.now(),codex:Date.now()}));await expect(page.locator('#active-preview-listeners')).toHaveCount(0);
 await page.evaluate(()=>hbError());await expect(page.locator('#active-preview-listeners li')).toHaveText(['Gemini: מצב המאזין לא ידוע — ייתכן שהמשימה תישמר בלבד','Codex: מצב המאזין לא ידוע — ייתכן שהמשימה תישמר בלבד','Grok: מצב המאזין לא ידוע — ייתכן שהמשימה תישמר בלבד']);
 await expect(page.locator('#active-payload')).toHaveAttribute('dir','auto');
 expect(await page.locator('#active-payload').evaluate(e=>getComputedStyle(e).unicodeBidi)).toBe('plaintext');
 expect(await page.locator('#active-payload').getAttribute('maxlength')).toBeNull();
 await page.locator('#active-payload').fill('a'.repeat(9000));await expect(page.locator('#active-limit-live')).toHaveText('התוכן הגיע ל-9000 תווים מתוך 10000.');
 await page.locator('#active-payload').fill('קצר');await expect(page.locator('#active-limit-live')).toHaveText('');   // stale announcement cleared
 await expect(page.locator('#active-limit-live')).toHaveAttribute('aria-live','polite');expect(errors).toEqual([]);
});
test('double submit while auth_time is pending creates exactly one write; auth_time timeout returns to idle',async({page})=>{
 const errors=await mount(page);await authorize(page);
 await page.evaluate(()=>{window.authImpl=()=>new Promise(r=>{window.releaseAuth=()=>r(Date.now());});window.createImpl=()=>Promise.resolve();});
 await page.locator('#active-target-grok').selectOption('EXECUTE');await page.locator('#active-payload').fill('פעם אחת');await page.locator('#active-preview').click();
 await page.evaluate(()=>{const b=document.getElementById('active-send');b.click();b.click();b.click();});
 await expect(page.locator('#active-send')).toBeDisabled();await page.evaluate(()=>releaseAuth());
 await expect(page.locator('#active-result')).toHaveText('המשימה נשמרה ואושרה על ידי השרת.');expect(await page.evaluate(()=>creates.length)).toBe(1);
 await page.evaluate(()=>{window.authImpl=()=>new Promise(()=>{});});
 await page.locator('#active-target-grok').selectOption('EXECUTE');await page.locator('#active-payload').fill('פעם שנייה');await page.locator('#active-preview').click();await page.locator('#active-send').click();
 await expect(page.locator('#active-result')).not.toHaveText('',{timeout:4000});
 await expect.poll(()=>page.evaluate(()=>panel.debugState().phase),{timeout:4000}).toBe('idle');
 expect(await page.evaluate(()=>creates.length)).toBe(1);await expect(page.locator('#active-send')).toBeEnabled();expect(errors).toEqual([]);
});
test('identity switch during the auth_time await: no write, draft cleared, previous feed stopped and not shown',async({page})=>{
 const errors=await mount(page);await authorize(page);await page.evaluate(()=>feedNext([row(1)]));
 await page.evaluate(()=>{window.authImpl=()=>new Promise(r=>{window.releaseAuth=()=>r(Date.now());});});
 await page.locator('#active-target-grok').selectOption('EXECUTE');await page.locator('#active-payload').fill('טיוטה של הבעלים');await page.locator('#active-preview').click();
 await page.locator('#active-send').click();
 await page.evaluate(()=>{window.uidNow='other-owner';setIdentity({uid:'other-owner',backendAuthorized:true});releaseAuth();});
 await expect(page.locator('#active-payload')).toHaveValue('');await expect(page.locator('#active-preview-box')).toBeHidden();
 await expect(page.locator('.active-row')).toHaveCount(0);
 expect(await page.evaluate(()=>[creates.length,watchStops,watchStarts,listenerStops,listenerStarts])).toEqual([0,1,2,1,2]);
 // sign-out clears the draft too
 await page.locator('#active-payload').fill('עוד טיוטה');await page.evaluate(()=>setIdentity(null));
 await page.evaluate(()=>setIdentity({uid:'other-owner',backendAuthorized:true}));await expect(page.locator('#active-payload')).toHaveValue('');expect(errors).toEqual([]);
});
test('dispose during a pending write: no errors, later callbacks ignored',async({page})=>{
 const errors=await mount(page);await authorize(page);await page.evaluate(()=>feedNext([row(1)]));
 await page.evaluate(()=>{window.createImpl=()=>new Promise(r=>{window.releaseCreate=r;});});
 await page.locator('#active-target-grok').selectOption('EXECUTE');await page.locator('#active-payload').fill('לפני סגירה');await page.locator('#active-preview').click();
 await page.locator('#active-send').click();await expect(page.locator('#active-result')).toHaveText('שומר… ממתין לאישור השרת.');
 await page.evaluate(()=>{panel.dispose();releaseCreate();feedNext([row(1),row(2)]);hbNext({grok:Date.now()});});
 await page.waitForTimeout(200);
 await expect(page.locator('#active-result')).toHaveText('שומר… ממתין לאישור השרת.');
 expect(await page.evaluate(()=>[watchStops,listenerStops,document.querySelectorAll('.active-row').length])).toEqual([1,1,0]);expect(errors).toEqual([]);
});
test('reset while unconfirmed checks the server first: saved -> already saved; missing -> whole draft cleared; idle reset keeps the payload',async({page})=>{
 const errors=await mount(page);await authorize(page);
 await page.locator('#active-target-grok').selectOption('EXECUTE');await page.locator('#active-payload').fill('אולי נשמר');await page.locator('#active-preview').click();
 await page.locator('#active-reset').click();await expect(page.locator('#active-payload')).toHaveValue('אולי נשמר');await expect(page.locator('#active-result')).toContainText('');
 await page.locator('#active-preview').click();const id1=JSON.parse(await page.locator('#active-preview-json').textContent()).taskId;
 await page.locator('#active-send').click();await expect(page.locator('#active-result')).toContainText('לא אושר',{timeout:5000});
 await page.locator('#active-reset').click();
 await expect(page.locator('#active-result')).toHaveText('המשימה הקודמת לא נמצאה בשרת כרגע, אך ייתכן שעוד תישמר. הטופס נוקה כדי למנוע כפילות; אם היא תופיע בפיד — היא נשמרה.');
 await expect(page.locator('#active-payload')).toHaveValue('');await expect(page.locator('#active-target-grok')).toHaveValue('IGNORE');expect(await page.evaluate(()=>verifies)).toEqual([id1]);
 await page.locator('#active-target-grok').selectOption('EXECUTE');await page.locator('#active-payload').fill('שני');await page.locator('#active-preview').click();
 const id2=JSON.parse(await page.locator('#active-preview-json').textContent()).taskId;expect(id2).not.toBe(id1);
 await page.locator('#active-send').click();await expect(page.locator('#active-result')).toContainText('לא אושר',{timeout:5000});
 await page.evaluate(()=>{window.verifyImpl=id=>Promise.resolve({exists:true,taskId:id,dispatchedBy:'synthetic-owner',payload:'שני',targets:{grok:'EXECUTE',codex:'IGNORE',gemini:'IGNORE'},status:'PENDING'});});
 await page.locator('#active-reset').click();await expect(page.locator('#active-result')).toHaveText('המשימה כבר נשמרה בשרת (אומת מול השרת).');
 expect(await page.evaluate(()=>creates.map(c=>c.taskId))).toEqual([id1,id2]);expect(errors).toEqual([]);
});
test('cancel hidden when every selected agent finished; cancel failure texts (denied vs unconfirmed)',async({page})=>{
 const errors=await mount(page);await authorize(page);
 await page.evaluate(()=>feedNext([row(1,{progress:{grok:entry('COMPLETED','completed')}}),row(2)]));
 await expect(rowEl(page,1).locator('.active-status')).toHaveText('סטטוס: הסתיים');await expect(rowEl(page,1).locator('.active-cancel-btn')).toHaveCount(0);
 const r2=rowEl(page,2);await page.evaluate(()=>{window.cancelImpl=()=>Promise.reject(Object.assign(Error('no'),{code:'permission-denied'}));});
 await r2.locator('.active-cancel-btn').click();await r2.locator('.active-cancel-yes').click();
 await expect(page.locator('#active-result')).toHaveText('השרת דחה את הביטול. הסטטוס לא השתנה.');await expect(r2.locator('.active-cancel-btn')).toBeFocused();
 await page.evaluate(()=>{window.cancelImpl=()=>Promise.reject(Object.assign(Error('x'),{code:'unavailable'}));});
 await r2.locator('.active-cancel-btn').click();await r2.locator('.active-cancel-yes').click();
 await expect(page.locator('#active-result')).toHaveText('לא אושר — ייתכן שהביטול עוד יחול. הסטטוס יתעדכן רק מהשרת.');
 // the server already shows CANCELLED when the request settles: the cancel button is gone, focus goes to the row itself
 await page.evaluate(()=>{window.cancelImpl=()=>new Promise(r=>{window.releaseCancel=r;});});
 await r2.locator('.active-cancel-btn').click();await r2.locator('.active-cancel-yes').click();await expect(r2).toBeFocused();
 await page.evaluate(()=>{feedNext([row(1,{progress:{grok:entry('COMPLETED','completed')}}),row(2,{status:'CANCELLED'})]);releaseCancel();});
 await expect(r2.locator('.active-status')).toHaveText('סטטוס: בוטל');await expect(r2).toBeFocused();expect(errors).toEqual([]);
});

// ---------------- push trigger: UI review C12 (review/push-trigger-verdicts.md) ----------------
const ackEl=(page,n,agent)=>rowEl(page,n).locator(`.active-ack[data-agent="${agent}"]`);
const onSwitch=page=>page.evaluate(()=>swNext({state:'on',updatedAt:Date.now()-3600000}));   // switched ON 1 h before the fixtures (atAckOn cut-off)
test('C12 ack states: only targets light; UNDERSTOOD = "הבנתי:" outside the bdi + ONE visible frame line next to the quote + go; card line on the target card only, linked to the row',async({page})=>{
 const errors=await mount(page);await authorize(page);await events(page);await onSwitch(page);
 const summary='אבדוק את הבדיקות ואחזור עם תוצאה';
 await page.evaluate(summary=>{hbNext({grok:Date.now(),codex:Date.now()},{meta:{grok:{ack:'on',mode:'push'},codex:{ack:'on',mode:'push'}}});
  const A=(state,s='',ago=1000)=>({state,summary:s,updatedAt:Date.now()-ago});
  feedNext([row(1,{acks:{grok:A('UNDERSTOOD',summary)}}),row(2,{kind:'MESSAGE',targets:{grok:'IGNORE',codex:'NOTIFY',gemini:'IGNORE'},acks:{codex:A('LIT')}}),
   row(3,{acks:{grok:A('UNREADABLE')}}),row(4,{targets:{grok:'IGNORE',codex:'EXECUTE',gemini:'IGNORE'},acks:{}})]);},summary);
 const u=ackEl(page,1,'grok');await expect(u).toHaveAttribute('data-kind','understood');
 await expect(u.locator('.active-ack-state')).toHaveText('הבנתי:');
 await expect(u.locator('.active-ack-label')).toHaveCount(0);                                     // UI 25572dc condition 5: the pill is gone, ONE frame line
 expect(await u.locator('.active-ack-frame').evaluate(e=>e.nextElementSibling?.matches('blockquote.active-ack-summary'))).toBe(true);
 await expect(u.locator('.active-ack-frame')).toHaveText('סיכום אוטומטי של Grok — אינו אישור ואינו התחלת עבודה');await expect(u.locator('.active-ack-frame')).toBeVisible();
 await expect(u.locator('blockquote.active-ack-summary > div.clamp > bdi[dir="rtl"]')).toHaveText(summary);
 await expect(u.locator('bdi')).not.toContainText('הבנתי');
 await expect(u.locator('.active-ack-go')).toHaveText('ממתין ל-go שלך בסשן');
 await expect(rowEl(page,1).locator('.active-ack')).toHaveCount(1);                       // non-targets (codex, gemini) never light
 await expect(ackEl(page,2,'codex').locator('.active-ack-state')).toHaveText('נדלק — קורא');await expect(ackEl(page,2,'codex').locator('.active-ack-go')).toHaveCount(0);
 await expect(rowEl(page,2).locator('.active-status')).toHaveText('סטטוס: הודעה');await expect(chip(page,2,'codex').locator('.active-chip-text')).toHaveText('להודיע בלבד');
 await expect(ackEl(page,3,'grok').locator('.active-ack-state')).toHaveText('לא הצליח לקרוא');
 await expect(ackEl(page,4,'codex').locator('.active-ack-state')).toHaveText('ממתין לאישור קבלה');
 // C1: card keeps its liveness line; the target card adds ONE line with the latest ack + task time
 await expect(card(page,'Grok').locator('.agent-listener')).toHaveText('משימות: מאזין');
 await expect(card(page,'Grok').locator('.agent-ack')).toHaveText(/^אחרון: לא הצליח לקרוא · משימה \d\d:\d\d$/);
 await expect(card(page,'Codex').locator('.agent-ack')).toHaveText(/^אחרון: ממתין לאישור קבלה · משימה \d\d:\d\d$/);
 await expect(card(page,'Gemini').locator('.agent-ack')).toHaveCount(0);await expect(card(page,'Claude').locator('.agent-ack')).toHaveCount(0);
 await expect(card(page,'Grok').locator('.agent-ack a')).toHaveAttribute('href','#active-row-'+rid(3));
 await expect(page.locator('.agent .active-ack-summary, .agent .active-chip')).toHaveCount(0);   // chips and summary live in the feed only
 await card(page,'Grok').locator('.agent-ack a').click();await expect(rowEl(page,3)).toBeFocused();
 // condition 5: the card frames an understood ack as automatic; minor: a newer CANCELLED row is skipped by the card line
 await page.evaluate(summary=>{const A=(state,s='')=>({state,summary:s,updatedAt:Date.now()-1000});
  feedNext([row(1,{acks:{grok:A('UNDERSTOOD',summary)}}),row(9,{status:'CANCELLED',acks:{grok:A('UNREADABLE')}})]);},summary);
 await expect(card(page,'Grok').locator('.agent-ack')).toHaveText(/^אחרון: הבנתי \(אוטומטי\) · משימה \d\d:\d\d$/);
 await expect(card(page,'Grok').locator('.agent-ack a')).toHaveAttribute('href','#active-row-'+rid(1));expect(errors).toEqual([]);
});
test('C12 kill switch: missing doc -> blocked + seed (off only); off banner "מאז HH:mm" from server updatedAt; re-enable confirm; success only after the server; timeout -> לא אושר; stale auth -> re-auth',async({page})=>{
 const errors=await mount(page);await authorize(page);
 await expect(page.locator('#active-ack-switch-text')).toHaveText('טוען את מצב אישורי הקבלה…');
 for(const id of ['#active-ack-stop','#active-ack-enable','#active-ack-seed'])await expect(page.locator(id)).toBeHidden();
 await page.evaluate(()=>{swNext({state:'missing',updatedAt:null});hbNext({grok:Date.now()});feedNext([row(1)]);});
 await expect(page.locator('#active-ack-switch-text')).toHaveText('לא מוגדר — אישורי קבלה חסומים');await expect(page.locator('#active-ack-switch')).toHaveAttribute('data-state','missing');
 await expect(ackEl(page,1,'grok').locator('.active-ack-state')).toHaveText('לא מוגדר — אישורי קבלה חסומים');
 await expect(page.locator('#active-ack-stop')).toBeHidden();await page.locator('#active-ack-seed').click();
 await expect(page.locator('#active-ack-switch-result')).toHaveText('השינוי אושר על ידי השרת.');
 expect(await page.evaluate(()=>switchWrites)).toEqual([{enabled:false,exists:false}]);
 await expect(page.locator('#active-ack-switch-text')).toHaveText('לא מוגדר — אישורי קבלה חסומים');   // no optimistic state: only the server snapshot changes it
 await page.evaluate(()=>swNext({state:'off',updatedAt:Date.now()-5000}));
 await expect(page.locator('#active-ack-switch-text')).toHaveText(/^אישורי קבלה כבויים מאז \d\d:\d\d$/);
 await expect(ackEl(page,1,'grok').locator('.active-ack-state')).toHaveText('נעצר — אישורי קבלה כבויים');
 await page.locator('#active-ack-enable').click();await expect(page.locator('.active-ack-confirm')).toContainText('זה אינו אישור לביצוע');await expect(page.locator('#active-ack-enable-yes')).toBeFocused();
 await page.locator('#active-ack-enable-no').click();await expect(page.locator('.active-ack-confirm')).toBeHidden();expect(await page.evaluate(()=>switchWrites.length)).toBe(1);
 await page.evaluate(()=>{window.authImpl=async()=>Date.now()-20*60000;});
 await page.locator('#active-ack-enable').click();await page.locator('#active-ack-enable-yes').click();
 await expect(page.locator('#active-ack-switch-result')).toContainText('נדרשת התחברות טרייה');await expect(page.locator('#active-ack-reauth')).toBeVisible();expect(await page.evaluate(()=>switchWrites.length)).toBe(1);
 await page.evaluate(()=>{window.authImpl=async()=>Date.now();});
 await page.locator('#active-ack-enable-yes').click();await expect(page.locator('#active-ack-switch-result')).toHaveText('השינוי אושר על ידי השרת.');
 expect(await page.evaluate(()=>switchWrites.at(-1))).toEqual({enabled:true,exists:true});
 await expect(page.locator('#active-ack-switch-text')).toHaveText(/^אישורי קבלה כבויים מאז/);            // still off until the server says on
 await onSwitch(page);await expect(page.locator('#active-ack-switch-text')).toContainText('אישורי קבלה פעילים');await expect(page.locator('#active-ack-stop')).toBeVisible();
 await page.evaluate(()=>{window.switchImpl=()=>new Promise(()=>{});});
 await page.locator('#active-ack-stop').click();await expect(page.locator('#active-ack-stop')).toBeDisabled();
 await expect(page.locator('#active-ack-switch-result')).toHaveText('לא אושר — ייתכן שהשינוי עוד יחול. המצב יתעדכן רק מהשרת.',{timeout:5000});
 await expect(page.locator('#active-ack-stop')).toBeEnabled();
 await page.evaluate(()=>{window.switchImpl=()=>Promise.reject(Object.assign(Error('no'),{code:'permission-denied'}));});
 await page.locator('#active-ack-stop').click();await expect(page.locator('#active-ack-switch-result')).toHaveText('השרת דחה את השינוי. המצב לא השתנה.');
 expect(await page.evaluate(()=>switchWrites.map(w=>w.enabled))).toEqual([false,true,false,false]);expect(errors).toEqual([]);
});
test('C12 clock skew: "no answer" is computed from SERVER time (offset), never the client clock, in both directions',async({page})=>{
 const errors=await mount(page);await authorize(page);
 const H=3600000;await page.evaluate(H=>swNext({state:'on',updatedAt:Date.now()-H-60000}),H);   // every stamp here is SERVER time
 // client clock 1 h AHEAD of the server: a client-clock computation would say "no answer" at once
 await page.evaluate(H=>{const S=Date.now()-H;window.S=S;hbNext({grok:S},{meta:{grok:{ack:'on',mode:'push'}}});
  feedNext([row(1,{timestamp:S-10000,acks:{grok:{state:'LIT',summary:'',updatedAt:S-5000}}}),row(2,{timestamp:S-10000,acks:{}})]);},H);
 await expect(ackEl(page,1,'grok').locator('.active-ack-state')).toHaveText('נדלק — קורא');
 await expect(ackEl(page,2,'grok').locator('.active-ack-state')).toHaveText('ממתין לאישור קבלה');
 await page.evaluate(()=>hbNext({grok:S+100000},{meta:{grok:{ack:'on',mode:'push'}}}));   // server time advanced 100 s
 await events(page);await expect(card(page,'Grok').locator('.agent-listener')).toHaveText('משימות: מאזין');   // UI 25572dc condition 3: liveness on server time (fresh heartbeat)
 await expect(ackEl(page,1,'grok').locator('.active-ack-state')).toHaveText('נדלק, אין תשובה');
 await expect(ackEl(page,2,'grok').locator('.active-ack-state')).toHaveText('ממתין לאישור קבלה');   // 110 s < 180 s
 await page.evaluate(()=>hbNext({grok:S+185000},{meta:{grok:{}}}));
 await expect(ackEl(page,2,'grok').locator('.active-ack-state')).toHaveText('אין אישור קבלה (ייתכן שכבוי)');   // heartbeat without the ack field (C5)
 await page.evaluate(()=>hbNext({grok:S+185000},{meta:{grok:{ack:'on',mode:'push'}}}));
 await expect(ackEl(page,2,'grok').locator('.active-ack-state')).toHaveText('לא התקבל אישור קבלה');
 await page.evaluate(()=>hbNext({grok:S+185000},{meta:{grok:{ack:'off',mode:'push'}}}));
 await expect(ackEl(page,2,'grok').locator('.active-ack-state')).toHaveText('אישורי קבלה כבויים במאזין');
 // client clock 1 h BEHIND the server: a client-clock computation would never say "no answer"
 await page.evaluate(()=>setIdentity(null));await authorize(page);
 await page.evaluate(H=>{const S=Date.now()+H;swNext({state:'on',updatedAt:S-60000});feedNext([row(1,{timestamp:S,acks:{grok:{state:'LIT',summary:'',updatedAt:S+1000}}})]);hbNext({grok:S+96000});},H);
 await expect(ackEl(page,1,'grok').locator('.active-ack-state')).toHaveText('נדלק, אין תשובה');
 await page.evaluate(H=>hbNext({grok:Date.now()+H+97000}),H);                                   // the next heartbeat arrives (a fresh server stamp)
 await events(page);await expect(card(page,'Grok').locator('.agent-listener')).toHaveText('משימות: מאזין');   // a client-clock check would say מנותק
 await expect(chip(page,1,'grok').locator('.active-chip-text')).not.toContainText('אין דופק');expect(errors).toEqual([]);
});
test('C12 cache/stale feed: ack marked "לא עדכני" and "no answer" is never computed; card line stale too',async({page})=>{
 const errors=await mount(page);await authorize(page);await events(page);await onSwitch(page);
 await page.evaluate(()=>{hbNext({grok:Date.now()});feedNext([row(1,{acks:{grok:{state:'LIT',summary:'',updatedAt:Date.now()-120000}}}),row(2,{timestamp:Date.now()-400000})]);});
 await expect(ackEl(page,1,'grok').locator('.active-ack-state')).toHaveText('נדלק, אין תשובה');
 await page.evaluate(()=>feedNext(null,{fromCache:true}));
 await expect(ackEl(page,1,'grok').locator('.active-ack-state')).toHaveText('נדלק — קורא · לא עדכני');await expect(ackEl(page,1,'grok')).toHaveAttribute('data-stale','true');
 await expect(ackEl(page,2,'grok').locator('.active-ack-state')).toHaveText('ממתין לאישור קבלה · לא עדכני');
 await expect(page.locator('#active-tasks-panel')).not.toContainText('אין תשובה');await expect(page.locator('#active-tasks-panel')).not.toContainText('לא התקבל אישור');
 await expect(card(page,'Grok').locator('.agent-ack')).toHaveAttribute('data-stale','true');await expect(card(page,'Grok').locator('.agent-ack')).toContainText('לא עדכני');
 await page.evaluate(()=>feedError());await expect(ackEl(page,1,'grok').locator('.active-ack-state')).toHaveText('נדלק — קורא · לא עדכני');
 await expect(page.locator('#active-tasks-panel')).not.toContainText('אין תשובה');expect(errors).toEqual([]);
});
for(const width of [320,360])test(`C12 clamp ${width}px: 280 chars English-first + 39-char token; real 44px button with aria; state per task+agent survives ticks and rebuilds; no overflow`,async({page})=>{
 await page.setViewportSize({width,height:740});const errors=await mount(page,{tick:100});await authorize(page);await onSwitch(page);
 const token='T'+'a1b2c3d4e5'.repeat(3)+'f6g7h8i9';expect(token.length).toBe(39);
 let summary='Build '+token+' ';while([...summary].length<280)summary+='אבדוק ';summary=[...summary].slice(0,280).join('');expect([...summary].length).toBe(280);
 await page.evaluate(summary=>{hbNext({grok:Date.now()});feedNext([row(1,{acks:{grok:{state:'UNDERSTOOD',summary,updatedAt:Date.now()-1000}}}),
  row(2,{acks:{grok:{state:'UNDERSTOOD',summary:'קצר',updatedAt:Date.now()-1000}}})]);},summary);
 const btn=page.locator(`#active-ack-more-${rid(1)}-grok`);await expect(btn).toBeVisible();
 await expect(page.locator(`#active-ack-more-${rid(2)}-grok`)).toBeHidden();                   // not truncated -> no button
 expect(await btn.evaluate(e=>e.tagName)).toBe('BUTTON');await expect(btn).toHaveAttribute('aria-expanded','false');
 await expect(btn).toHaveAttribute('aria-controls',`active-ack-sum-${rid(1)}-grok`);
 const box=await btn.boundingBox();expect(box.height).toBeGreaterThanOrEqual(44);expect(box.width).toBeGreaterThanOrEqual(44);
 const clamp=page.locator(`#active-ack-sum-${rid(1)}-grok`);
 expect(await clamp.evaluate(e=>getComputedStyle(e).overflowWrap)).toBe('anywhere');
 const closedH=(await clamp.boundingBox()).height;
 await btn.click();await expect(btn).toHaveAttribute('aria-expanded','true');await expect(clamp).toHaveClass(/clamp-open/);await expect(btn).toBeFocused();
 expect((await clamp.boundingBox()).height).toBeGreaterThan(closedH);
 await page.waitForTimeout(400);                                                                 // several ticks
 await expect(btn).toHaveAttribute('aria-expanded','true');await expect(btn).toBeFocused();
 // the row is rebuilt (codex ack arrives): the expand state is kept per task+agent
 await page.evaluate(summary=>feedNext([row(1,{targets:{grok:'EXECUTE',codex:'EXECUTE',gemini:'IGNORE'},acks:{grok:{state:'UNDERSTOOD',summary,updatedAt:Date.now()-1000},codex:{state:'LIT',summary:'',updatedAt:Date.now()}}}),
  row(2,{acks:{grok:{state:'UNDERSTOOD',summary:'קצר',updatedAt:Date.now()-1000}}})]),summary);
 await expect(ackEl(page,1,'codex')).toHaveCount(1);await expect(page.locator(`#active-ack-sum-${rid(1)}-grok`)).toHaveClass(/clamp-open/);
 await expect(page.locator(`#active-ack-more-${rid(1)}-grok`)).toHaveAttribute('aria-expanded','true');await expect(page.locator(`#active-ack-more-${rid(1)}-grok`)).toBeFocused();
 await expect(clamp.locator('bdi')).toHaveText(summary);                                         // never cut silently: full text in the DOM
 const overflow=await page.evaluate(()=>({doc:document.documentElement.scrollWidth,vw:document.documentElement.clientWidth,
  wide:[...document.querySelectorAll('#active-tasks-panel *')].filter(e=>e.getBoundingClientRect().right>document.documentElement.clientWidth+0.5||e.getBoundingClientRect().left<-0.5).map(e=>e.className||e.tagName)}));
 expect(overflow.doc).toBeLessThanOrEqual(overflow.vw);expect(overflow.wide).toEqual([]);
 await page.locator(`#active-ack-more-${rid(1)}-grok`).click();await expect(page.locator(`#active-ack-sum-${rid(1)}-grok`)).not.toHaveClass(/clamp-open/);expect(errors).toEqual([]);
});
async function createInSession(page){
 await page.evaluate(()=>{window.createImpl=()=>Promise.resolve();});
 await page.locator('#active-target-grok').selectOption('EXECUTE');await page.locator('#active-payload').fill('משימה בסשן');await page.locator('#active-preview').click();
 await page.locator('#active-send').click();await expect(page.locator('#active-result')).toHaveText('המשימה נשמרה ואושרה על ידי השרת.');
 return page.evaluate(()=>creates.at(-1).taskId);
}
test('C12 reduced motion: no highlight; the ONE polite region announces only UNDERSTOOD/UNREADABLE of tasks created in this session',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});const errors=await mount(page);await authorize(page);await onSwitch(page);
 const tid=await createInSession(page);
 await expect(page.locator('[aria-live="polite"]#active-ack-live')).toHaveCount(1);
 await page.evaluate(tid=>{window.mk=(acks,n=1)=>({...row(n),id:n===1?tid:row(n).id,taskId:n===1?tid:row(n).taskId,acks});hbNext({grok:Date.now()});feedNext([mk({}),mk({},2)]);},tid);
 await page.evaluate(()=>feedNext([mk({grok:{state:'LIT',summary:'',updatedAt:Date.now()}}),mk({},2)]));
 const own=page.locator(`.active-row[data-id="${tid}"] .active-ack[data-agent="grok"]`);await expect(own.locator('.active-ack-state')).toHaveText('נדלק — קורא');
 await expect(page.locator('#active-ack-live')).toHaveText('');                                   // LIT is not announced
 await expect(own).not.toHaveClass(/ack-changed/);
 await page.evaluate(()=>feedNext([mk({grok:{state:'UNDERSTOOD',summary:'סיכום',updatedAt:Date.now()}}),mk({grok:{state:'UNREADABLE',summary:'',updatedAt:Date.now()}},2)]));
 await expect(page.locator('#active-ack-live')).toHaveText('Grok: הבנתי — סיכום אוטומטי, אינו אישור');   // row 2 (not this session) is not announced
 expect(await page.locator('.active-ack.ack-changed').count()).toBe(0);
 expect(await page.locator('.active-ack').first().evaluate(e=>getComputedStyle(e).animationName)).toBe('none');expect(errors).toEqual([]);
});
test('C12 motion allowed: highlight on change lasts at most 5 s',async({page})=>{
 await page.emulateMedia({reducedMotion:'no-preference'});const errors=await mount(page);await authorize(page);await onSwitch(page);
 await page.evaluate(()=>{hbNext({grok:Date.now()});feedNext([row(1)]);});await expect(ackEl(page,1,'grok')).toHaveAttribute('data-kind','waiting');
 await page.evaluate(()=>feedNext([row(1,{acks:{grok:{state:'LIT',summary:'',updatedAt:Date.now()}}})]));
 await expect(ackEl(page,1,'grok')).toHaveClass(/ack-changed/);
 await expect(page.locator('#active-ack-live')).toHaveText('');
 await expect(ackEl(page,1,'grok')).not.toHaveClass(/ack-changed/,{timeout:5600});expect(errors).toEqual([]);
});
test('C12 kind selector: kind in preview + draft key; TASK->MESSAGE blocked with EXECUTE; defaults once (heartbeat never overrides); MESSAGE > 2000 blocked, not cut; MESSAGE needs NOTIFY',async({page})=>{
 const errors=await mount(page);await authorize(page);
 await page.locator('#active-target-grok').selectOption('EXECUTE');await page.locator('#active-payload').fill('בדיקת סוג');await page.locator('#active-preview').click();
 let shown=JSON.parse(await page.locator('#active-preview-json').textContent());expect(shown.kind).toBe('TASK');expect(shown.acks).toEqual({});
 await page.locator('#active-kind').selectOption('MESSAGE');
 await expect(page.locator('#active-kind')).toHaveValue('TASK');await expect(page.locator('#active-kind-note')).toContainText('המעבר להודעה חסום');
 await expect(page.locator('#active-target-grok')).toHaveValue('EXECUTE');
 await page.locator('#active-target-grok').selectOption('IGNORE');await expect(page.locator('#active-preview-box')).toBeHidden();
 await page.evaluate(()=>hbNext({codex:Date.now()}));
 await page.locator('#active-kind').selectOption('MESSAGE');await expect(page.locator('#active-kind')).toHaveValue('MESSAGE');
 await expect(page.locator('#active-target-codex')).toHaveValue('NOTIFY');await expect(page.locator('#active-target-grok')).toHaveValue('IGNORE');await expect(page.locator('#active-target-gemini')).toHaveValue('IGNORE');
 expect(await page.locator('#active-target-grok option').evaluateAll(o=>o.map(x=>x.value))).toEqual(['IGNORE','NOTIFY']);
 await page.evaluate(()=>hbNext({grok:Date.now(),codex:Date.now(),gemini:Date.now()}));await page.waitForTimeout(100);
 await expect(page.locator('#active-target-grok')).toHaveValue('IGNORE');                          // a heartbeat never changes the defaults
 await page.locator('#active-preview').click();shown=JSON.parse(await page.locator('#active-preview-json').textContent());
 expect(shown).toMatchObject({kind:'MESSAGE',targets:{codex:'NOTIFY',grok:'IGNORE',gemini:'IGNORE'},acks:{},progress:{}});
 await page.locator('#active-kind').selectOption('TASK');await expect(page.locator('#active-preview-box')).toBeHidden();   // kind change invalidates the preview
 await expect(page.locator('#active-kind-note')).toContainText('איפס את הסוכנים שסומנו "להודיע"');await expect(page.locator('#active-target-codex')).toHaveValue('IGNORE');
 await page.locator('#active-kind').selectOption('MESSAGE');await page.locator('#active-target-codex').selectOption('NOTIFY');
 await page.locator('#active-payload').fill('א'.repeat(2001));await page.locator('#active-preview').click();
 await expect(page.locator('#active-send')).toBeDisabled();await expect(page.locator('#active-tasks-panel')).toContainText('הודעה מוגבלת ל-2000 תווים');
 expect([...await page.locator('#active-payload').inputValue()].length).toBe(2001);                 // not cut
 await page.locator('#active-payload').fill('א'.repeat(2000));await page.locator('#active-preview').click();await expect(page.locator('#active-send')).toBeEnabled();
 for(const k of ['grok','codex','gemini'])await page.locator('#active-target-'+k).selectOption('IGNORE');await page.locator('#active-preview').click();
 await expect(page.locator('#active-send')).toBeDisabled();await expect(page.locator('#active-tasks-panel')).toContainText('יש לבחור "להודיע" לסוכן אחד לפחות');
 expect(await page.evaluate(()=>creates.length)).toBe(0);expect(errors).toEqual([]);
});
test('C12 owner buttons: shown only when the transition is allowed; double-click guarded; success only after the server; timeout/denied texts',async({page})=>{
 const errors=await mount(page);await authorize(page);await onSwitch(page);
 await page.evaluate(()=>{hbNext({grok:Date.now()});feedNext([row(1,{progress:{grok:entry('READY','delivered')}}),row(2,{progress:{grok:entry('READY','delivery_off')}}),
  row(3,{dispatchedBy:'someone-else',progress:{grok:entry('READY','delivered')}}),row(4,{kind:'MESSAGE',targets:{grok:'NOTIFY',codex:'IGNORE',gemini:'IGNORE'}}),row(5,{progress:{grok:entry('COMPLETED','completed')}})]);});
 await expect(page.locator('.active-owner-btn')).toHaveCount(1);const start=page.locator(`#active-start-${rid(1)}-grok`);await expect(start).toHaveText('סמן: Grok בביצוע');
 await expect(chip(page,1,'grok').locator('.active-chip-text')).toHaveText('נמסר — טרם התחיל');
 await page.evaluate(()=>{window.progressImpl=()=>new Promise(()=>{});});
 await page.evaluate(id=>{const b=document.getElementById(id);b.click();b.click();b.click();},`active-start-${rid(1)}-grok`);
 await expect(start).toBeDisabled();expect(await page.evaluate(()=>progressWrites.length)).toBe(1);
 await expect(page.locator('#active-result')).toHaveText('לא אושר — הסטטוס יתעדכן רק מהשרת.',{timeout:5000});
 await expect(chip(page,1,'grok').locator('.active-chip-text')).toHaveText('נמסר — טרם התחיל');       // nothing optimistic
 await page.evaluate(()=>{window.progressImpl=()=>Promise.reject(Object.assign(Error('no'),{code:'permission-denied'}));});
 await start.click();await expect(page.locator('#active-result')).toHaveText('השרת דחה את הסימון. הסטטוס לא השתנה.');
 await page.evaluate(()=>{window.progressImpl=()=>Promise.resolve();});
 await start.click();await expect(page.locator('#active-result')).toHaveText('הסימון אושר על ידי השרת.');
 await page.evaluate(()=>feedNext([row(1,{progress:{grok:entry('IN_PROGRESS','started')}})]));
 await expect(chip(page,1,'grok').locator('.active-chip-text')).toHaveText('בביצוע');
 await expect(page.locator(`#active-start-${rid(1)}-grok`)).toHaveCount(0);const done=page.locator(`#active-complete-${rid(1)}-grok`);await expect(done).toHaveText('סמן: Grok הסתיים');
 // UI 25572dc minor: הסתיים cannot be undone -> confirm first; "לא" writes nothing and returns focus
 await done.click();await expect(rowEl(page,1).locator('.active-owner-confirm')).toHaveText('לסמן ש-Grok הסתיים? לא ניתן לבטל את הסימון.');
 await expect(page.locator(`#active-complete-yes-${rid(1)}-grok`)).toBeFocused();expect(await page.evaluate(()=>progressWrites.length)).toBe(3);
 await page.locator(`#active-complete-no-${rid(1)}-grok`).click();await expect(done).toBeFocused();expect(await page.evaluate(()=>progressWrites.length)).toBe(3);
 await page.evaluate(()=>{window.progressImpl=()=>new Promise(r=>setTimeout(r,300));});
 await done.click();await page.locator(`#active-complete-yes-${rid(1)}-grok`).click();await expect(rowEl(page,1)).toBeFocused();   // focus on the row while pending
 await expect(page.locator('#active-result')).toHaveText('הסימון אושר על ידי השרת.');
 await page.evaluate(()=>feedNext([row(1,{progress:{grok:entry('COMPLETED','completed')}})]));await expect(page.locator('.active-owner-btn')).toHaveCount(0);
 expect(await page.evaluate(()=>progressWrites.map(w=>w[2]))).toEqual(['IN_PROGRESS','IN_PROGRESS','IN_PROGRESS','COMPLETED']);expect(errors).toEqual([]);
});

// ---------------- UI review of 25572dc: conditions 1-4 (review/push-trigger/ui-verdict-25572dc.md) ----------------
test('25572dc-1 switch stream error: "עצירה" stays available (enabled:false as an update, no fresh sign-in), reconnect restarts the switch stream',async({page})=>{
 const errors=await mount(page);await authorize(page);await onSwitch(page);
 await page.evaluate(()=>{hbNext({grok:Date.now()});feedNext([row(1)]);});
 await expect(page.locator('#active-reconnect')).toBeHidden();expect(await page.evaluate(()=>swStarts)).toBe(1);
 await page.evaluate(()=>swError());
 await expect(page.locator('#active-ack-switch-text')).toHaveText('מצב אישורי הקבלה לא ידוע (אין חיבור)');await expect(page.locator('#active-ack-switch')).toHaveAttribute('data-state','unknown');
 await expect(page.locator('#active-ack-stop')).toBeVisible();await expect(page.locator('#active-ack-stop')).toBeEnabled();
 for(const id of ['#active-ack-enable','#active-ack-seed'])await expect(page.locator(id)).toBeHidden();
 await expect(page.locator('#active-reconnect')).toBeVisible();
 await page.evaluate(()=>{window.authImpl=async()=>Date.now()-20*60000;});                    // stale sign-in does NOT block stopping
 await page.locator('#active-ack-stop').click();await expect(page.locator('#active-ack-switch-result')).toHaveText('השינוי אושר על ידי השרת.');
 expect(await page.evaluate(()=>switchWrites)).toEqual([{enabled:false,exists:true}]);
 await page.evaluate(()=>{window.switchImpl=()=>Promise.reject(Object.assign(Error('nf'),{code:'not-found'}));});
 await page.locator('#active-ack-stop').click();await expect(page.locator('#active-ack-switch-result')).toHaveText('המתג לא קיים בשרת — אישורי קבלה חסומים ממילא. אין צורך בעצירה.');
 await page.locator('#active-reconnect').click();expect(await page.evaluate(()=>swStarts)).toBe(2);
 await expect(page.locator('#active-reconnect')).toBeHidden();                                  // stream running again (no snapshot yet)
 await page.evaluate(()=>swNext({state:'off',updatedAt:Date.now()-1000}));
 await expect(page.locator('#active-ack-switch-text')).toHaveText(/^אישורי קבלה כבויים מאז \d\d:\d\d$/);await expect(page.locator('#active-ack-stop')).toBeHidden();
 await expect(page.locator('#active-ack-enable')).toBeVisible();expect(errors).toEqual([]);
});
test('25572dc-2 LIT with the switch off shows "נעצר — אישורי קבלה כבויים", never "נדלק, אין תשובה"',async({page})=>{
 const errors=await mount(page);await authorize(page);
 await page.evaluate(()=>{swNext({state:'off',updatedAt:Date.now()-600000});hbNext({grok:Date.now()},{meta:{grok:{ack:'on',mode:'push'}}});
  feedNext([row(1,{acks:{grok:{state:'LIT',summary:'',updatedAt:Date.now()-300000}}})]);});
 await expect(ackEl(page,1,'grok').locator('.active-ack-state')).toHaveText('נעצר — אישורי קבלה כבויים');
 await expect(page.locator('#active-tasks-panel')).not.toContainText('אין תשובה');
 // switched ON again just now: the task predates the cut-off (Rules atAckOn) -> "לא תאושר", still never "no answer"
 await page.evaluate(()=>swNext({state:'on',updatedAt:Date.now()-1000}));
 await expect(ackEl(page,1,'grok').locator('.active-ack-state')).toHaveText('נוצרה לפני הפעלת אישורי קבלה — לא תאושר');
 // a snapshot where the switch has been ON since before the task: the LIT timeout applies
 await page.evaluate(()=>swNext({state:'on',updatedAt:Date.now()-3600000}));
 await expect(ackEl(page,1,'grok').locator('.active-ack-state')).toHaveText('נדלק, אין תשובה');expect(errors).toEqual([]);
});
test('25572dc-3 card liveness and the kind defaults follow SERVER time: client clock 1 h ahead still shows "מאזין" and MESSAGE defaults to NOTIFY; old stamps never make a dead listener look alive',async({page})=>{
 const errors=await mount(page);await page.locator('#private-login').click();await authorize(page);await events(page);
 const H=3600000;
 // a DEAD listener whose last heartbeat is 1 h old, with only old stamps on screen: must stay "מנותק" (no stale-offset bias)
 await page.evaluate(H=>{const T=Date.now();swNext({state:'on',updatedAt:T-2*H});hbNext({grok:T-H});feedNext([row(1,{timestamp:T-2*H})]);},H);
 await expect(card(page,'Grok').locator('.agent-listener')).toHaveText('משימות: מנותק');
 await page.evaluate(()=>setIdentity(null));await authorize(page);await events(page);
 // client clock 1 h AHEAD: the first snapshot is old by the client clock; the next heartbeat (a fresh server stamp) fixes the offset
 await page.evaluate(H=>{const S=Date.now()-H;window.S=S;swNext({state:'on',updatedAt:S-1000});hbNext({grok:S-5000});feedNext([row(1,{timestamp:S-10000})]);},H);
 await page.evaluate(()=>hbNext({grok:S+1000}));
 await expect(card(page,'Grok').locator('.agent-listener')).toHaveText('משימות: מאזין');
 await expect(card(page,'Grok').locator('.agent-listener')).toHaveAttribute('data-listener','up');
 await page.locator('#active-kind').selectOption('MESSAGE');await expect(page.locator('#active-target-grok')).toHaveValue('NOTIFY');
 await expect(page.locator('#active-target-codex')).toHaveValue('IGNORE');expect(errors).toEqual([]);
});
test('25572dc-4 clamp re-measured on resize: wide -> no expand button; narrower viewport -> the button appears (and back)',async({page})=>{
 await page.setViewportSize({width:1280,height:800});const errors=await mount(page);await authorize(page);await onSwitch(page);
 let summary='';while([...summary].length<200)summary+='אבדוק את הבדיקות ';summary=[...summary].slice(0,200).join('');
 await page.evaluate(summary=>{hbNext({grok:Date.now()});feedNext([row(1,{acks:{grok:{state:'UNDERSTOOD',summary,updatedAt:Date.now()-1000}}})]);},summary);
 const btn=page.locator(`#active-ack-more-${rid(1)}-grok`);await expect(page.locator(`#active-ack-sum-${rid(1)}-grok`)).toBeVisible();await expect(btn).toBeHidden();
 await page.setViewportSize({width:320,height:740});await expect(btn).toBeVisible();
 await page.setViewportSize({width:1280,height:800});await expect(btn).toBeHidden();expect(errors).toEqual([]);
});
test('536d253 before_switch: a task older than the last switch-ON says "לא תאושר" (Rules atAckOn), never waiting / no answer; visible stop note; axe clean',async({page})=>{
 const errors=await mount(page);await page.locator('#private-login').click();await authorize(page);await events(page);
 await page.evaluate(()=>{const T=Date.now();window.T=T;swNext({state:'on',updatedAt:T-120000});hbNext({grok:T},{meta:{grok:{ack:'on',mode:'push'}}});
  feedNext([row(1,{timestamp:T-600000,acks:{}}),row(2,{timestamp:T-300000,acks:{grok:{state:'LIT',summary:'',updatedAt:T-290000}}}),
   row(3,{timestamp:T-60000,acks:{}}),row(4,{timestamp:T-900000,acks:{grok:{state:'UNDERSTOOD',summary:'סיכום',updatedAt:T-890000}}})]);});
 const B='נוצרה לפני הפעלת אישורי קבלה — לא תאושר';
 await expect(ackEl(page,1,'grok').locator('.active-ack-state')).toHaveText(B);await expect(ackEl(page,1,'grok')).toHaveAttribute('data-kind','before_switch');
 await expect(ackEl(page,2,'grok').locator('.active-ack-state')).toHaveText(B);                               // LIT before the switch: not "no answer"
 await expect(ackEl(page,3,'grok').locator('.active-ack-state')).toHaveText('ממתין לאישור קבלה');              // created after the switch-ON
 await expect(ackEl(page,4,'grok')).toHaveAttribute('data-kind','understood');                                 // a final ack stays
 await expect(page.locator('#active-tasks-panel')).not.toContainText('אין תשובה');await expect(page.locator('#active-tasks-panel')).not.toContainText('לא התקבל אישור');
 // the stop note is visible text next to the stop button (not a tooltip), described-by for AT
 const note=page.locator('#active-ack-stop-note');await expect(note).toBeVisible();await expect(note).toHaveText('משימות שנוצרו לפני העצירה לא יאושרו גם אחרי הפעלה מחדש');
 await expect(page.locator('#active-ack-stop')).toHaveAttribute('aria-describedby','active-ack-stop-note');await expect(page.locator('#active-ack-stop')).not.toHaveAttribute('title',/./);
 await page.evaluate(()=>swNext({state:'off',updatedAt:Date.now()}));await expect(note).toBeHidden();
 await expect(ackEl(page,3,'grok').locator('.active-ack-state')).toHaveText('נעצר — אישורי קבלה כבויים');
 // OFF -> ON moves the cut-off: task 3 (created before this ON) now says "לא תאושר" too
 await page.evaluate(()=>swNext({state:'on',updatedAt:Date.now()}));await expect(note).toBeVisible();
 await expect(ackEl(page,3,'grok').locator('.active-ack-state')).toHaveText(B);
 await expect(card(page,'Grok').locator('.agent-ack')).toHaveText(new RegExp('^אחרון: '+B+' · משימה \\d\\d:\\d\\d$'));
 await axeClean(page,['#active-ack-switch','#active-feed','.agent-ack']);expect(errors).toEqual([]);
});
test('536d253 LOW: focus stays on the card\'s "אחרון:" link when the card re-renders',async({page})=>{
 const errors=await mount(page);await page.locator('#private-login').click();await authorize(page);await events(page);await onSwitch(page);
 await page.evaluate(()=>{hbNext({grok:Date.now()});feedNext([row(1,{acks:{}})]);});
 const link=card(page,'Grok').locator('.agent-ack a');await link.focus();await expect(link).toBeFocused();
 await page.evaluate(()=>feedNext([row(1,{acks:{grok:{state:'LIT',summary:'',updatedAt:Date.now()}}})]));   // card content changes -> rebuild
 await expect(card(page,'Grok').locator('.agent-ack')).toContainText('נדלק — קורא');
 await expect(card(page,'Grok').locator('.agent-ack a')).toBeFocused();expect(errors).toEqual([]);
});
test('ACL UI 5 FRESH+1: after the last forward-moving heartbeat the card says "מאזין" through HEARTBEAT_FRESH_MS and "מנותק" at +1 ms, against SERVER time (liveOffset, client clock 1 h ahead); a stopped listener (exit 6) writes nothing, so the card goes מנותק by age alone',async({page})=>{
 const FRESH=165000,H=3600000;
 await page.clock.install({time:new Date('2026-09-30T20:00:00Z')});
 const errors=await mount(page);await page.locator('#private-login').click();await authorize(page);await events(page);
 const line=card(page,'Grok').locator('.agent-listener');
 await page.clock.pauseAt(new Date('2026-09-30T20:01:00Z'));   // frozen: only runFor moves time, so the boundary is exact
 // client clock 1 h AHEAD of the server; the second snapshot's heartbeat moved forward -> liveOffset = -1 h exactly
 await page.evaluate(H=>{window.T0=Date.now()-H;hbNext({grok:T0-120000});hbNext({grok:T0});},H);
 await expect(line).toHaveText('משימות: מאזין');
 expect(await page.evaluate(()=>panel.debugState().liveOffset)).toBe(-H);
 // no further heartbeat (the runner stopped with exit 6): only the clock moves; re-deliver the SAME stamp (no forward move) to re-render
 const refresh=()=>page.evaluate(()=>hbNext({grok:T0}));
 await page.clock.runFor(FRESH);await refresh();
 await expect(line).toHaveText('משימות: מאזין');await expect(line).toHaveAttribute('data-listener','up');
 await page.clock.runFor(1);await refresh();
 await expect(line).toHaveText('משימות: מנותק');await expect(line).toHaveAttribute('data-listener','down');
 expect(await page.evaluate(()=>panel.debugState().liveOffset)).toBe(-H);   // a repeated stamp never moves the offset
 // UI MUST_NOT: no cause inference on the card (no ACL/exit wording); the cause is only in the listener's local log
 await expect(card(page,'Grok')).not.toContainText(/ACL|הרשא|exit|יציאה/);
 expect(errors).toEqual([]);
});
