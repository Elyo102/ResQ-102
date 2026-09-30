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
 await expect(page.locator('#dispatch-note')).toHaveAttribute('dir','auto');   // mixed Hebrew/English: per-paragraph direction
 expect(await page.locator('#dispatch-note').evaluate(e=>getComputedStyle(e).unicodeBidi)).toBe('plaintext');
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
test('10000 limit: counter on every input, one announcement per threshold, over-limit paste kept in full and blocked with a reason',async({page})=>{
 const errors=await mount(page);await authorize(page);const counter=page.locator('#dispatch-counter'),live=page.locator('#dispatch-limit-live'),note=page.locator('#dispatch-note');
 expect(await note.getAttribute('maxlength')).toBeNull();expect(await counter.getAttribute('aria-live')).toBeNull();
 await expect(live).toHaveAttribute('aria-live','polite');await expect(counter).toHaveText('0/10000');await expect(live).toHaveText('');
 await note.fill('a'.repeat(8999));await expect(counter).toHaveText('8999/10000');await expect(live).toHaveText('');
 await note.press('End');await note.type('b');await expect(counter).toHaveText('9000/10000');await expect(live).toContainText('9000');
 const announced=await page.evaluate(()=>{window.announcements=[];new MutationObserver(()=>announcements.push(document.getElementById('dispatch-limit-live').textContent))
  .observe(document.getElementById('dispatch-limit-live'),{childList:true,characterData:true,subtree:true});return true;});expect(announced).toBe(true);
 await note.type('cccc');await expect(counter).toHaveText('9004/10000'); // per-keystroke counter, no new announcement
 expect(await page.evaluate(()=>announcements.length)).toBe(0);
 const over='x'.repeat(10001);await note.fill(over);
 await expect(note).toHaveValue(over); // kept in full: no maxlength truncation
 await expect(counter).toContainText('10001/10000');await expect(counter).toContainText('חריגה של 1 תווים');await expect(live).toContainText('חורגת');
 await expect(page.locator('#dispatch-error')).toContainText('10000');
 await page.locator('#dispatch-task-Grok').selectOption('realtime');await page.locator('#dispatch-preview').click();
 await expect(page.locator('#dispatch-preview-box')).toBeHidden();const send=page.locator('#dispatch-send');await expect(send).toBeDisabled();
 await expect(send).toHaveAttribute('aria-describedby','dispatch-send-reason');await expect(page.locator('#dispatch-send-reason')).toContainText('10000');
 expect(await page.evaluate(()=>announcements.filter(Boolean).length)).toBe(1);expect(await page.evaluate(()=>creates.length)).toBe(0);
 await note.fill('a'.repeat(10000));await expect(counter).toHaveText('10000/10000');await expect(live).toContainText('למגבלה');await expect(page.locator('#dispatch-error')).toHaveText('');
 await note.fill('קצר');await expect(live).toHaveText('');   // back under every threshold: the stale announcement is cleared
 expect(errors).toEqual([]);
});
test('CRLF counts as one, newlines survive to the payload, preview and feed; disallowed characters reported with line; secrets blocked',async({page})=>{
 const errors=await mount(page);await authorize(page);await page.evaluate(()=>feedNext([]));const note=page.locator('#dispatch-note');
 await page.evaluate(()=>{const t=document.getElementById('dispatch-note');t.value='שורה ראשונה\r\nsecond line\r\n\r\n\tlast';t.dispatchEvent(new Event('input',{bubbles:true}));});
 await expect(page.locator('#dispatch-counter')).toHaveText('31/10000'); // 11+1+11+1+1+2+4: each CRLF counts 1, tab -> 2 spaces
 await page.locator('#dispatch-task-Grok').selectOption('realtime');await page.locator('#dispatch-preview').click();
 const human=page.locator('#dispatch-preview-note');await expect(human).toHaveAttribute('dir','auto');
 expect(await human.textContent()).toBe('שורה ראשונה\nsecond line\n\n  last');
 expect(await human.evaluate(n=>[getComputedStyle(n).whiteSpace,getComputedStyle(n).unicodeBidi,getComputedStyle(n).overflowWrap])).toEqual(['pre-wrap','plaintext','anywhere']);
 expect(await page.locator('#dispatch-preview-json').evaluate(n=>[getComputedStyle(n).whiteSpace,getComputedStyle(n).overflowWrap,getComputedStyle(n).overflowY])).toEqual(['pre-wrap','anywhere','auto']);
 await page.locator('#dispatch-send').click();await expect.poll(()=>page.evaluate(()=>creates.length)).toBe(1);
 const sent=await page.evaluate(()=>creates[0].rows[0].data.note);expect(sent).toBe('שורה ראשונה\nsecond line\n\n  last');
 await page.evaluate(()=>resolveCreate());await expect(page.locator('#dispatch-result')).toHaveText('נשלח ואושר על ידי השרת.');
 await page.evaluate(n=>feedNext([{id:'00000000-0000-4000-8000-000000000001',agent:'Grok',taskType:'realtime',note:n,status:'queued',batchId:'00000000-0000-4000-8000-000000000900',createdBy:'synthetic-owner',createdAt:Date.now(),cancelledAt:null}]),sent);
 const feedNote=page.locator('#dispatch-active .dispatch-note-text').first();expect(await feedNote.textContent()).toBe(sent);
 expect((await feedNote.innerText()).split('\n').length).toBe(4);await expect(page.locator('#dispatch-active .dispatch-banner')).toHaveText('הערה לתצוגה בלבד, לא מבוצעת ולא מועברת לסוכן');
 await expect(page.locator('#dispatch-note-banner')).toHaveText('הערה לתצוגה בלבד, לא מבוצעת ולא מועברת לסוכן');
 await note.fill('שורה 1\nline “two”\n\u200f');await expect(page.locator('#dispatch-error')).toContainText('U+201C בשורה 2');await expect(page.locator('#dispatch-error')).toContainText('U+200F בשורה 3');
 await note.fill('deploy with ghp_'+'A'.repeat(36));await expect(page.locator('#dispatch-error')).toContainText('אין להדביק סודות');
 await expect(page.locator('#dispatch-panel')).not.toContainText('ghp_A');await page.locator('#dispatch-preview').click();await expect(page.locator('#dispatch-preview-box')).toBeHidden();
 await expect(page.locator('#dispatch-send')).toBeDisabled();expect(await page.evaluate(()=>creates.length)).toBe(1);expect(errors).toEqual([]);
});
test('long notes: collapsed snippet only, <details> only on real overflow, keyboard toggle kept across feed updates without focus jump',async({page})=>{
 const errors=await mount(page);await authorize(page);
 const long='L'.repeat(9000)+'\nEND-OF-NOTE';const rows=[feedRow(1,{note:long}),feedRow(2,{note:'short one'}),feedRow(3,{note:'l\n'.repeat(20)})];
 await page.evaluate(r=>feedNext(r),rows);
 const row1=page.locator(`[data-id="${uuid(1)}"]`);await expect(row1.locator('.dispatch-note-snippet')).toHaveText('L'.repeat(500));
 await expect(row1.locator('.dispatch-note-full')).toHaveCount(0);await expect(row1).not.toContainText('END-OF-NOTE');
 await expect(page.locator(`[data-id="${uuid(2)}"] details`)).toHaveCount(0);await expect(page.locator(`[data-id="${uuid(3)}"] details`)).toHaveCount(1);
 const summary=page.locator(`#dispatch-more-${uuid(1)}`);await summary.focus();await page.keyboard.press('Enter');
 await expect(row1.locator('.dispatch-note-full')).toHaveCount(1);await expect(row1).toContainText('END-OF-NOTE');await expect(row1.locator('.dispatch-note-snippet')).toBeHidden();
 await page.evaluate(r=>feedNext(r.map(x=>({...x}))),rows); // same data again
 await page.evaluate(r=>feedNext([...r,{...r[1],id:'00000000-0000-4000-8000-000000000009',createdAt:r[0].createdAt+50000}]),rows); // a new row arrives
 await expect(row1.locator('details')).toHaveAttribute('open','');expect(await page.evaluate(()=>document.activeElement?.id)).toBe(`dispatch-more-${uuid(1)}`);
 await page.evaluate(([r,id])=>feedNext(r.map(x=>x.id===id?{...x,status:'cancelled',cancelledAt:Date.now()}:x)),[rows,uuid(1)]); // row moves to history
 await expect(page.locator(`#dispatch-history [data-id="${uuid(1)}"] details`)).toHaveAttribute('open','');
 expect(await page.evaluate(()=>document.activeElement?.id)).toBe(`dispatch-more-${uuid(1)}`);
 await page.keyboard.press('Space');await expect(page.locator(`#dispatch-history [data-id="${uuid(1)}"] .dispatch-note-full`)).toHaveCount(0);
 await expect(page.locator(`#dispatch-history [data-id="${uuid(1)}"] .dispatch-note-snippet`)).toBeVisible();expect(errors).toEqual([]);
});
test('feed: pinned queued by createdAt desc, history capped at 20, server-only text badges, textContent, focus kept on move',async({page})=>{
 const errors=await mount(page);await authorize(page);
 const history=Array.from({length:40},(_,i)=>feedRow(100+i,{status:'cancelled',cancelledAt:Date.parse('2026-09-30T10:00:00Z')+i*1000}));
 await page.evaluate(rows=>feedNext(rows),[feedRow(1),feedRow(3),feedRow(2,{note:'<img src=x onerror=alert(1)>'}),feedRow(4,{status:'claimed',createdAt:Date.parse('2026-09-30T11:00:00Z')}),...history]);
 const active=page.locator('#dispatch-active .dispatch-row');await expect(active).toHaveCount(3);
 expect(await active.evaluateAll(n=>n.map(e=>e.dataset.id))).toEqual([uuid(3),uuid(2),uuid(1)]);
 await expect(page.locator('#dispatch-history .dispatch-row')).toHaveCount(20);
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
 await expect(page.locator('#dispatch-history .dispatch-row')).toHaveCount(20);
 expect(errors).toEqual([]);
});
for(const width of [320,360,375,390,1280]){
 test(`layout at ${width}px: 10k no-space notes, no horizontal scroll, 16px inputs, full-width controls, long labels contained`,async({page})=>{
  await page.setViewportSize({width,height:900});const errors=await mount(page);await authorize(page);
  await page.evaluate(rows=>feedNext(rows),[feedRow(1,{note:'x'.repeat(10000),taskType:'telemetry-relays'}),feedRow(2,{status:'cancelled',cancelledAt:Date.now(),note:'א'.repeat(10000)})]);
  await page.locator('#dispatch-task-Gemini').selectOption('cross-browser');await page.locator('#dispatch-task-Grok').selectOption('telemetry-relays');
  await page.locator('#dispatch-note').fill('y'.repeat(10000));await page.locator('#dispatch-preview').click();await page.locator(`#dispatch-more-${uuid(1)}`).click();await expect(page.locator('.dispatch-note-full')).toHaveCount(1);await expect(page.locator('#dispatch-preview-box')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const ta=await page.locator('#dispatch-note').evaluate(n=>{const c=getComputedStyle(n);return {rows:n.rows,maxH:c.maxHeight,oy:c.overflowY,ob:c.overscrollBehaviorY,h:n.getBoundingClientRect().height};});
  expect(ta.rows).toBe(12);expect(ta.maxH).not.toBe('none');expect(ta.oy).toBe('auto');expect(ta.ob).toBe('auto');expect(ta.h).toBeLessThanOrEqual(Math.min(450,384)+1);
  for(const n of await page.locator('#dispatch-panel .dispatch-note-text, #dispatch-preview-json').all())
   expect(await n.evaluate(e=>[getComputedStyle(e).overflowWrap,getComputedStyle(e).whiteSpace])).toEqual(['anywhere','pre-wrap']);
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
