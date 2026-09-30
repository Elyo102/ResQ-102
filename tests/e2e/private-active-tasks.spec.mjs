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
import {mountPrivateDashboard} from '/private-view.mjs?v=20260930-grok-dispatch4';
import {mountActiveTasksPanel} from '/active-tasks-view.mjs?v=20260930-grok-dispatch4';
let onAuth;window.creates=[];window.verifies=[];window.cancels=[];window.listeners=[];window.uidNow='synthetic-owner';
window.watchStarts=0;window.watchStops=0;window.listenerStarts=0;window.listenerStops=0;
window.createImpl=()=>new Promise(()=>{});window.verifyImpl=()=>Promise.resolve({exists:false});window.cancelImpl=()=>Promise.resolve();window.authImpl=async()=>Date.now();
const api={uid:()=>window.uidNow,authTime:()=>window.authImpl(),
 watch({next,error}){window.watchStarts++;window.feedNext=next;window.feedError=error;return()=>{window.watchStops++;};},
 watchListeners({next,error}){window.listenerStarts++;window.hbNext=next;window.hbError=error;return()=>{window.listenerStops++;};},
 create(task){window.creates.push(JSON.parse(JSON.stringify(task)));return window.createImpl(task);},
 verify(id){window.verifies.push(id);return window.verifyImpl(id);},cancel(id){window.cancels.push(id);return window.cancelImpl(id);}};
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
 await expect(page.locator('#active-tasks-panel')).not.toContainText('בביצוע');
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
 await page.evaluate(long=>{hbNext({grok:Date.now()-95000+700});feedNext([row(1,{payload:long,progress:{grok:entry('IN_PROGRESS','started',60000)}}),row(2)]);},long);
 const summary=page.locator('#active-more-'+rid(1));await expect(summary).toHaveCount(1);
 await summary.click();await expect(summary).toBeFocused();
 await page.evaluate(id=>{document.querySelector(`.active-row[data-id="${id}"]`).__mark='kept';},rid(1));
 await expect(chip(page,1,'grok').locator('.active-chip-text')).toHaveText('בביצוע');
 // heartbeat ages past 95s on the tick alone: chip text changes in place, focus and open state untouched
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
