import {test,expect} from '../lib/contained-test.mjs';
import {readFileSync} from 'node:fs';
// Synthetic harness for the Agent Dispatch Center panel: real view/model/private-view code, mocked dispatch API.
const source=new URL('../../control-plane/web/',import.meta.url);
const files=['private-view.mjs','private-controller.mjs','dispatch-view.mjs','dispatch-model.mjs'];
const OWNER={uid:'synthetic-owner',backendAuthorized:true};
async function mount(page){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!=='http://localhost:41996'){await route.abort();return;}
  const file=url.pathname.split('/').pop();
  if(files.includes(file)){await route.fulfill({body:readFileSync(new URL(file,source)),contentType:'text/javascript'});return;}
  if(file==='private.css'){await route.fulfill({body:readFileSync(new URL('private.css',source)),contentType:'text/css'});return;}
  await route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="he" dir="rtl"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/private.css"><p>בדיקה סינתטית בלבד — לא מחובר לענן</p><main id="root"></main><script type="module">
import {mountPrivateDashboard} from '/private-view.mjs';
import {mountDispatchPanel} from '/dispatch-view.mjs';
let onAuth;window.creates=[];window.verifies=[];window.cancels=[];window.watchCount=0;window.watchStops=0;window.reauth=[];window.shownWhileUnauthorized=false;window.authorizedNow=false;
window.authTimeMs=null;window.createImpl=()=>new Promise((resolve,reject)=>{window.resolveCreate=resolve;window.rejectCreate=reject;});
window.verifyImpl=ids=>Promise.resolve(ids.map(id=>({id,exists:false})));window.cancelImpl=()=>Promise.resolve();
const api={uid:()=>'synthetic-owner',authTime:async()=>window.authTimeMs??Date.now(),
 watch({next,error}){window.watchCount++;window.feedNext=next;window.feedError=error;return()=>window.watchStops++;},
 create(payload,timeout){window.creates.push(JSON.parse(JSON.stringify(payload)));return window.createImpl(payload);},
 verify(ids){window.verifies.push(ids);return window.verifyImpl(ids);},cancel(id){window.cancels.push(id);return window.cancelImpl(id);}};
const signIn=()=>{window.reauth.push(navigator.userActivation.isActive);return new Promise(()=>{});};
window.panel=mountDispatchPanel({doc:document,api,signIn,sendTimeoutMs:1500});
new MutationObserver(()=>{const el=document.getElementById('dispatch-panel');if(el&&!el.hidden&&!window.authorizedNow)window.shownWhileUnauthorized=true;})
 .observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden']});
window.setIdentity=user=>{window.authorizedNow=user?.backendAuthorized===true;onAuth(user);};
window.mockAuth={onIdentity(fn){onAuth=fn;return()=>{};},async signIn(){},async signOut(){window.setIdentity(null);}};
window.dispose=mountPrivateDashboard({root:document.getElementById('root'),auth:window.mockAuth,subscribe(){return()=>{};},dispatchPanel:window.panel});
</script></html>`});
 });
 await page.goto('http://localhost:41996/private-dispatch');await expect(page.locator('#private-login')).toBeVisible();return errors;
}
const authorize=page=>page.evaluate(o=>setIdentity(o),OWNER);
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const feedRow=(n,extra={})=>({id:uuid(n),agent:'Grok',taskType:'realtime',note:'שורה '+n,status:'queued',batchId:uuid(900),createdBy:'synthetic-owner',createdAt:Date.parse('2026-09-30T09:00:00Z')+n*1000,cancelledAt:null,...extra});
async function fill(page,{grok='realtime',gemini='',note='בדיקה ראשונה'}={}){
 await page.locator('#dispatch-task-Grok').selectOption(grok);await page.locator('#dispatch-task-Gemini').selectOption(gemini);await page.locator('#dispatch-note').fill(note);
}

test('panel stays hidden until backend authorization, with no flash; hiding follows identity',async({page})=>{
 const errors=await mount(page);const panel=page.locator('#dispatch-panel');
 await expect(panel).toHaveCount(1);await expect(panel).toBeHidden();
 await page.evaluate(()=>setIdentity({uid:'synthetic-owner',backendAuthorized:false}));await expect(panel).toBeHidden();
 await page.evaluate(()=>setIdentity({uid:'stranger'}));await expect(panel).toBeHidden();
 expect(await page.evaluate(()=>watchCount)).toBe(0);
 await authorize(page);await expect(panel).toBeVisible();expect(await page.evaluate(()=>watchCount)).toBe(1);
 await page.evaluate(()=>setIdentity(null));await expect(panel).toBeHidden();expect(await page.evaluate(()=>watchStops)).toBe(1);
 expect(await page.evaluate(()=>shownWhileUnauthorized)).toBe(false);expect(errors).toEqual([]);
});
test('preview is the exact payload; any edit invalidates it; in-flight disables send; success only after server confirmation',async({page})=>{
 const errors=await mount(page);await authorize(page);
 const send=page.locator('#dispatch-send');await expect(send).toBeDisabled();
 await fill(page,{gemini:'docs'});await page.locator('#dispatch-preview').click();
 const shown=JSON.parse(await page.locator('#dispatch-preview-json').textContent());await expect(send).toBeEnabled();
 await page.locator('#dispatch-note').fill('בדיקה שנייה');await expect(send).toBeDisabled();await expect(page.locator('#dispatch-preview-box')).toBeHidden();
 await page.locator('#dispatch-preview').click();const shown2=JSON.parse(await page.locator('#dispatch-preview-json').textContent());
 expect(shown2.map(r=>r.id)).toEqual(shown.map(r=>r.id)); // same idempotency keys until confirmed success/reset
 await send.click();await expect(send).toBeDisabled();await send.click({force:true});
 await expect(page.locator('#dispatch-result')).toHaveText('שולח… ממתין לאישור השרת.');
 const creates=await page.evaluate(()=>creates);expect(creates).toHaveLength(1);
 expect(creates[0].rows.map(r=>({id:r.id,...r.data}))).toEqual(shown2); // exact snapshot sent
 expect(shown2.every(r=>r.status==='queued'&&r.createdBy==='synthetic-owner'&&r.batchId===creates[0].batchId)).toBe(true);
 await expect(page.locator('#dispatch-note')).toHaveValue('בדיקה שנייה'); // nothing optimistic
 await page.evaluate(()=>resolveCreate());await expect(page.locator('#dispatch-result')).toHaveText('נשלח ואושר על ידי השרת.');
 await expect(page.locator('#dispatch-note')).toHaveValue('');
 await fill(page);await page.locator('#dispatch-preview').click();
 const next=JSON.parse(await page.locator('#dispatch-preview-json').textContent());expect(next[0].id).not.toBe(shown2[0].id); // new keys only after success
 await expect(send).toBeDisabled(); // client cooldown
 expect(errors).toEqual([]);
});
test('timeout shows לא אושר, keeps the form, retries with the same keys, and reconciles PERMISSION_DENIED from the server',async({page})=>{
 const errors=await mount(page);await authorize(page);await fill(page,{note:'retry me'});await page.locator('#dispatch-preview').click();
 await page.locator('#dispatch-send').click();
 await expect(page.locator('#dispatch-result')).toContainText('לא אושר');await expect(page.locator('#dispatch-result')).toContainText('ייתכן שהבקשה עוד תישמר מאוחר יותר');
 await expect(page.locator('#dispatch-note')).toHaveValue('retry me');await expect(page.locator('#dispatch-retry')).toBeVisible();
 await page.evaluate(()=>{createImpl=()=>Promise.reject(Object.assign(Error('x'),{code:'permission-denied'}));
  verifyImpl=ids=>Promise.resolve(ids.map((id,i)=>({id,exists:true,batchId:creates[0].batchId,agent:creates[0].rows[i].data.agent,taskType:creates[0].rows[i].data.taskType,createdBy:'synthetic-owner',status:'queued'})));});
 await page.locator('#dispatch-retry').click();
 await expect(page.locator('#dispatch-result')).toHaveText('הבקשה כבר נשמרה בשרת (אומת מול השרת).');
 const [creates,verifies]=await page.evaluate(()=>[creates,verifies]);expect(creates).toHaveLength(2);
 expect(creates[1]).toEqual(creates[0]);expect(verifies[0]).toEqual(creates[0].rows.map(r=>r.id));
 expect(errors).toEqual([]);
});
test('denied-and-missing keeps form and keys; explicit reset mints new keys; reconcile against the feed',async({page})=>{
 const errors=await mount(page);await authorize(page);await page.evaluate(()=>feedNext([]));
 await page.evaluate(()=>{createImpl=()=>Promise.reject(Object.assign(Error('x'),{code:'permission-denied'}));});
 await fill(page,{note:'denied'});await page.locator('#dispatch-preview').click();
 const before=JSON.parse(await page.locator('#dispatch-preview-json').textContent());
 await page.locator('#dispatch-send').click();await expect(page.locator('#dispatch-result')).toHaveText('השרת דחה את הבקשה ולא נשמר דבר. הטופס נשמר.');
 await expect(page.locator('#dispatch-note')).toHaveValue('denied');expect(await page.evaluate(()=>verifies.length)).toBe(1);
 expect(JSON.parse(await page.locator('#dispatch-preview-json').textContent())).toEqual(before);
 await page.locator('#dispatch-reset').click();await expect(page.locator('#dispatch-result')).toContainText('נוצר מפתח חדש');
 await page.locator('#dispatch-preview').click();const after=JSON.parse(await page.locator('#dispatch-preview-json').textContent());
 expect(after[0].id).not.toBe(before[0].id);expect(after[0].batchId).not.toBe(before[0].batchId);
 await page.evaluate(()=>{createImpl=()=>new Promise(()=>{});});await page.locator('#dispatch-send').click();
 await expect(page.locator('#dispatch-result')).toContainText('לא אושר');
 const sent=await page.evaluate(()=>creates.at(-1));expect(sent.rows[0].id).toBe(after[0].id);
 await page.evaluate(s=>feedNext(s.rows.map(r=>({id:r.id,...r.data,createdAt:Date.now(),cancelledAt:null}))),sent);
 await page.locator('#dispatch-reconcile').click();await expect(page.locator('#dispatch-result')).toHaveText('הבקשה כבר נשמרה בשרת (אומת מול השרת).');
 expect(await page.evaluate(()=>verifies.length)).toBe(1); // matched from the server-confirmed feed, no extra read
 await expect(page.locator('#dispatch-note')).toHaveValue('');expect(errors).toEqual([]);
});
test('offline flag and events disable sending; a lying online flag still ends in לא אושר',async({page,context})=>{
 const errors=await mount(page);await authorize(page);await fill(page);await page.locator('#dispatch-preview').click();
 await context.setOffline(true);await expect(page.locator('#dispatch-net')).toContainText('אין חיבור רשת');await expect(page.locator('#dispatch-send')).toBeDisabled();
 await context.setOffline(false);await expect(page.locator('#dispatch-net')).toHaveText('');await expect(page.locator('#dispatch-send')).toBeEnabled();
 await page.locator('#dispatch-send').click(); // navigator.onLine says online, but the write never confirms
 await expect(page.locator('#dispatch-result')).toContainText('לא אושר');await expect(page.locator('#dispatch-note')).toHaveValue('בדיקה ראשונה');
 expect(await page.evaluate(()=>creates.length)).toBe(1);expect(errors).toEqual([]);
});
test('stale auth_time requires a separate direct re-sign-in click; draft and keys survive token-change resets',async({page})=>{
 const errors=await mount(page);await authorize(page);await fill(page,{note:'fresh please'});await page.locator('#dispatch-preview').click();
 const keys=JSON.parse(await page.locator('#dispatch-preview-json').textContent()).map(r=>r.id);
 await page.evaluate(()=>{authTimeMs=Date.now()-841000;});await page.locator('#dispatch-send').click();
 await expect(page.locator('#dispatch-reauth')).toBeVisible();expect(await page.evaluate(()=>creates.length)).toBe(0);
 await page.locator('#dispatch-reauth').click();expect(await page.evaluate(()=>reauth)).toEqual([true]); // popup inside the click gesture
 await page.evaluate(()=>{setIdentity(null);});await page.evaluate(o=>setIdentity(o),OWNER); // onIdTokenChanged -> controller.reset
 await expect(page.locator('#dispatch-note')).toHaveValue('fresh please');
 await page.evaluate(()=>{authTimeMs=Date.now()-1000;});await page.locator('#dispatch-send').click();
 await expect.poll(()=>page.evaluate(()=>creates.length)).toBe(1);
 expect(await page.evaluate(()=>creates[0].rows.map(r=>r.id))).toEqual(keys);expect(errors).toEqual([]);
});
test('280 code-point counter is polite; disallowed characters and emoji are refused like the Rules',async({page})=>{
 const errors=await mount(page);await authorize(page);const counter=page.locator('#dispatch-counter');
 await expect(counter).toHaveAttribute('aria-live','polite');await expect(counter).toHaveText('0/280');
 await page.locator('#dispatch-note').fill('א'.repeat(280));await expect(counter).toHaveText('280/280');await expect(page.locator('#dispatch-error')).toHaveText('');
 await page.locator('#dispatch-note').fill('א'.repeat(281));await expect(counter).toHaveText('281/280');await expect(page.locator('#dispatch-error')).toContainText('280');
 await page.locator('#dispatch-note').fill('שלום\u200fעולם😀');await expect(counter).toHaveText('10/280');
 await expect(page.locator('#dispatch-error')).toContainText('U+200F');await expect(page.locator('#dispatch-error')).toContainText('U+1F600');
 await page.locator('#dispatch-task-Grok').selectOption('realtime');await page.locator('#dispatch-preview').click();
 await expect(page.locator('#dispatch-preview-box')).toBeHidden();await expect(page.locator('#dispatch-send')).toBeDisabled();expect(errors).toEqual([]);
});
test('feed: pinned queued by createdAt desc, capped history, server-only text badges, textContent, focus kept on move',async({page})=>{
 const errors=await mount(page);await authorize(page);
 const history=Array.from({length:70},(_,i)=>feedRow(100+i,{status:'cancelled',cancelledAt:Date.parse('2026-09-30T10:00:00Z')+i*1000}));
 await page.evaluate(rows=>feedNext(rows),[feedRow(1),feedRow(3),feedRow(2,{note:'<img src=x onerror=alert(1)>'}),feedRow(4,{status:'claimed',createdAt:Date.parse('2026-09-30T11:00:00Z')}),...history]);
 const active=page.locator('#dispatch-active .dispatch-row');await expect(active).toHaveCount(3);
 expect(await active.evaluateAll(n=>n.map(e=>e.dataset.id))).toEqual([uuid(3),uuid(2),uuid(1)]);
 await expect(page.locator('#dispatch-history .dispatch-row')).toHaveCount(50);
 await expect(page.locator('#dispatch-panel img')).toHaveCount(0);await expect(active.nth(1)).toContainText('<img src=x onerror=alert(1)>');
 await expect(active.first().locator('.dispatch-status')).toHaveText('בתור');
 await expect(page.locator(`[data-id="${uuid(4)}"] .dispatch-status`)).toHaveText('סטטוס שרת: claimed');
 await expect(page.locator('#dispatch-panel')).not.toContainText(/RUNNING|CONNECTED|IN_PROGRESS|COMPLETED/);
 const t=active.first().locator('bdi > time');await expect(t).toHaveText('30/09/2026 12:00');
 await expect(t).toHaveAttribute('dir','ltr');await expect(t).toHaveAttribute('datetime','2026-09-30T09:00:03.000Z');await expect(t).toHaveAttribute('title',/30\/09\/2026 12:00:03/);
 // Cancel: request sent, status changes only when the server feed says so.
 await page.locator(`#dispatch-cancel-${uuid(3)}`).focus();await page.keyboard.press('Enter');
 await expect.poll(()=>page.evaluate(()=>cancels)).toEqual([uuid(3)]);await expect(active.first().locator('.dispatch-status')).toHaveText('בתור');
 await page.locator(`[data-id="${uuid(2)}"]`).focus();
 await page.evaluate(([rows,id])=>feedNext(rows.map(r=>r.id===id?{...r,status:'cancelled',cancelledAt:Date.parse('2026-09-30T12:00:00Z')}:r)),
  [[feedRow(1),feedRow(3),feedRow(2),feedRow(4,{status:'claimed',createdAt:Date.parse('2026-09-30T11:00:00Z')}),...history],uuid(2)]);
 await expect(page.locator(`#dispatch-history [data-id="${uuid(2)}"]`)).toHaveCount(1);
 expect(await page.evaluate(id=>document.activeElement?.dataset?.id,uuid(2))).toBe(uuid(2));
 await expect(page.locator(`#dispatch-history .dispatch-row`).first()).toHaveAttribute('data-id',uuid(2));
 await expect(page.locator('#dispatch-history .dispatch-row')).toHaveCount(50);
 expect(errors).toEqual([]);
});
for(const width of [320,360,390,1280]){
 test(`layout at ${width}px: no horizontal scroll, 16px inputs, full-width controls, long labels contained`,async({page})=>{
  await page.setViewportSize({width,height:900});const errors=await mount(page);await authorize(page);
  await page.evaluate(rows=>feedNext(rows),[feedRow(1,{note:'x'.repeat(280),taskType:'telemetry-relays'}),feedRow(2,{status:'cancelled',cancelledAt:Date.now(),note:'א'.repeat(280)})]);
  await page.locator('#dispatch-task-Gemini').selectOption('cross-browser');await page.locator('#dispatch-task-Grok').selectOption('telemetry-relays');
  await page.locator('#dispatch-note').fill('y'.repeat(280));await page.locator('#dispatch-preview').click();await expect(page.locator('#dispatch-preview-box')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const panelBox=await page.locator('#dispatch-panel').boundingBox();expect(panelBox.x).toBeGreaterThanOrEqual(0);expect(panelBox.x+panelBox.width).toBeLessThanOrEqual(width+0.5);
  for(const el of await page.locator('#dispatch-panel select, #dispatch-panel textarea').all()){
   const s=await el.evaluate(n=>{const c=getComputedStyle(n);return {font:parseFloat(c.fontSize),max:c.maxWidth,w:n.getBoundingClientRect().width,parent:n.parentElement.getBoundingClientRect().width};});
   expect(s.font).toBeGreaterThanOrEqual(16);expect(s.max).toBe('100%');expect(s.w).toBeLessThanOrEqual(s.parent+0.5);}
  for(const b of await page.locator('#dispatch-panel button:visible').all()){
   const s=await b.evaluate(n=>{const c=getComputedStyle(n);return {w:c.width,max:c.maxWidth,h:n.getBoundingClientRect().height,right:n.getBoundingClientRect().right};});
   expect(s.max).toBe('100%');expect(s.h).toBeGreaterThanOrEqual(44);expect(s.right).toBeLessThanOrEqual(width+0.5);}
  expect(await page.evaluate(()=>[...document.querySelectorAll('#dispatch-panel *')].every(n=>n.getBoundingClientRect().right<=innerWidth+0.5&&n.getBoundingClientRect().left>=-0.5))).toBe(true);
  expect(errors).toEqual([]);
 });
}
