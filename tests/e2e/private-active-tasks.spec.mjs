import {test,expect} from '../lib/contained-test.mjs';
import {readFileSync} from 'node:fs';
// Synthetic harness for the active-tasks panel and the agent-card liveness line: real view/model/private-view code,
// mocked API (no cloud). UI review conditions 1-11 (control-plane/ACTIVE-TASKS.md).
const source=new URL('../../control-plane/web/',import.meta.url);
const files=['private-view.mjs','private-controller.mjs','active-tasks-view.mjs','active-tasks-model.mjs','dispatch-model.mjs'];
async function mount(page){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!=='http://localhost:41996'){await route.abort();return;}
  const file=url.pathname.split('/').pop();
  if(files.includes(file)){await route.fulfill({body:readFileSync(new URL(file,source)),contentType:'text/javascript'});return;}
  if(file==='private.css'){await route.fulfill({body:readFileSync(new URL('private.css',source)),contentType:'text/css'});return;}
  await route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="he" dir="rtl"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/private.css"><p>בדיקה סינתטית בלבד — לא מחובר לענן</p><main id="root"></main><script type="module">
import {mountPrivateDashboard} from '/private-view.mjs';
import {mountActiveTasksPanel} from '/active-tasks-view.mjs';
let onAuth;window.creates=[];window.verifies=[];window.cancels=[];window.listeners=[];
window.createImpl=()=>new Promise(()=>{});window.verifyImpl=()=>Promise.resolve({exists:false});window.cancelImpl=()=>Promise.resolve();
const api={uid:()=>'synthetic-owner',authTime:async()=>Date.now(),
 watch({next,error}){window.feedNext=next;window.feedError=error;return()=>{};},
 watchListeners({next,error}){window.hbNext=next;return()=>{};},
 create(task){window.creates.push(JSON.parse(JSON.stringify(task)));return window.createImpl(task);},
 verify(id){window.verifies.push(id);return window.verifyImpl(id);},cancel(id){window.cancels.push(id);return window.cancelImpl(id);}};
window.panel=mountActiveTasksPanel({doc:document,api,signIn:()=>new Promise(()=>{}),sendTimeoutMs:1500,tickMs:0});
window.setIdentity=user=>onAuth(user);
const mockAuth={onIdentity(fn){onAuth=fn;return()=>{};},async signIn(){},async signOut(){window.setIdentity(null);}};
window.dispose=mountPrivateDashboard({root:document.getElementById('root'),auth:mockAuth,subscribe(h){window.listeners.push(h);return()=>{};},
 activeTasksPanel:window.panel,listenerStatus:window.panel.listenerStatus});
window.row=(n,extra={})=>({id:'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),taskId:'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),dispatchedBy:'synthetic-owner',
 payload:'משימה '+n,status:'PENDING',timestamp:Date.now()-60000+n,targets:{grok:'EXECUTE',codex:'IGNORE',gemini:'IGNORE'},progress:{},...extra});
window.entry=(state,step,agoMs=1000)=>({state,step,updatedAt:Date.now()-agoMs});
</script></html>`});
 });
 await page.goto('http://localhost:41996/private-active-tasks');await expect(page.locator('#private-login')).toBeVisible();return errors;
}
const authorize=page=>page.evaluate(()=>setIdentity({uid:'synthetic-owner',backendAuthorized:true}));
const events=page=>page.evaluate(()=>listeners.at(-1).next([{id:'00000000-0000-0000-0000-000000000001',agent:'Codex',kind:'heartbeat',task:'local_tests',step:'running',at:Date.now()}],{fromCache:false}));
const chip=(page,n,agent)=>page.locator(`.active-row[data-id="00000000-0000-4000-8000-${String(n).padStart(12,'0')}"] .active-chip[data-agent="${agent}"]`);
const card=(page,agent)=>page.locator('.agent',{has:page.locator('h2',{hasText:agent})});

test('agent cards show listener liveness only: אין מאזין until a real heartbeat, then מאזין, then מנותק; never מוכן',async({page})=>{
 const errors=await mount(page);await page.locator('#private-login').click();await authorize(page);await events(page);
 await expect(page.locator('.agent')).toHaveCount(4);
 for(const a of ['Codex','Grok','Gemini'])await expect(card(page,a).locator('.agent-listener')).toHaveText('משימות: אין מאזין');
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
