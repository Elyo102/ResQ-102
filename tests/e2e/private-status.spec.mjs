import {test,expect} from '../lib/contained-test.mjs';
import {readFileSync} from 'node:fs';
const source=new URL('../../control-plane/web/',import.meta.url);
async function mount(page,{css='status'}={}){
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!=='http://localhost:41996'){await route.abort();return;}
    const file=url.pathname.split('/').pop();
    if(['private-view.mjs','private-controller.mjs'].includes(file)){await route.fulfill({body:readFileSync(new URL(file,source)),contentType:'text/javascript'});return;}
    if(file==='status.css'){await route.fulfill({body:readFileSync(css==='private'?new URL('private.css',source):new URL('../../public/status/status.css',import.meta.url)),contentType:'text/css'});return;}
    await route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="he" dir="rtl"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/status.css"><style>[hidden]{display:none!important}.private-terminal{background:#07101e;padding:1rem;min-height:100px}button{min-height:44px}</style><p>בדיקה סינתטית בלבד — לא מחובר לענן</p><main id="root"></main><script type="module">
import {mountPrivateDashboard} from '/private-view.mjs';
let onAuth;window.listeners=[];window.stops=0;window.setIdentity=user=>onAuth(user);
window.mockAuth={onIdentity(fn){onAuth=fn;return()=>{};},async signIn(){onAuth({uid:'synthetic-owner',backendAuthorized:true});},async signOut(){onAuth(null);}};
window.dispose=mountPrivateDashboard({root:document.getElementById('root'),ownerUid:'synthetic-owner',auth:window.mockAuth,subscribe(h){window.listeners.push(h);return()=>window.stops++;}});
</script></html>`});
  });
  await page.goto('http://localhost:41996/private-preview');await expect(page.locator('#private-login')).toBeVisible();return errors;
}
async function send(page,extra={}){await page.evaluate(extra=>listeners.at(-1).next([{id:'00000000-0000-0000-0000-000000000001',agent:'Codex',kind:'heartbeat',task:'local_tests',step:'running',at:Date.now(),...extra}],{fromCache:false}),extra);}

test('popup guidance survives timer ticks and clears on retry and identity change',async({page})=>{
 const errors=await mount(page);
 await page.evaluate(()=>{mockAuth.signIn=async()=>{throw Object.assign(Error('private-data'),{code:'auth/popup-blocked'});};});
 await page.locator('#private-login').click();
 await expect(page.getByRole('status')).toContainText('חלון ההתחברות נחסם');
 await page.waitForTimeout(2200);
 await expect(page.getByRole('status')).toContainText('חלון ההתחברות נחסם');
 await page.evaluate(()=>{mockAuth.signIn=()=>new Promise(resolve=>window.finishLogin=resolve);});
 await page.locator('#private-login').click();
 await expect(page.getByRole('status')).not.toContainText('חלון ההתחברות נחסם');
 await page.evaluate(()=>{setIdentity({uid:'synthetic-owner',backendAuthorized:true});finishLogin();});
 await send(page);await expect(page.getByRole('status')).toContainText('מחובר למקור');
 expect(errors).toEqual([]);
});
test('private stream starts only after identity and signout clears all content',async({page})=>{
  const errors=await mount(page);await expect(page.locator('.agent')).toHaveCount(0);
  await page.locator('#private-login').click();await send(page);await expect(page.locator('.agent')).toHaveCount(4);await expect(page.locator('#private-terminal')).toContainText('אות חיים');
  await page.locator('#private-logout').click();await expect(page.locator('.agent')).toHaveCount(0);await expect(page.locator('#private-terminal')).toBeEmpty();
  await send(page);await expect(page.locator('#private-terminal')).toBeEmpty();expect(errors).toEqual([]);
});
test('wrong owner and malformed stream never render private raw text',async({page})=>{
  const errors=await mount(page);await page.evaluate(()=>setIdentity({uid:'stranger',email:'eldad50@gmail.com',emailVerified:true}));await expect(page.getByRole('status')).toContainText('אין הרשאה');
  expect(await page.evaluate(()=>listeners.length)).toBe(0);await page.locator('#private-login').click();await send(page,{task:'<img src=x onerror=alert(1)>'});
  await expect(page.getByRole('status')).toContainText('החיבור הופסק');await expect(page.locator('#private-terminal')).not.toContainText('<img');expect(errors).toEqual([]);
});
test('private controls remain keyboard accessible and at least44px across widths',async({page})=>{
  const errors=await mount(page);await page.locator('#private-login').focus();await page.keyboard.press('Enter');await send(page);
  for(const width of [320,390,1440]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    for(const b of await page.locator('button:visible').all())expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(44);}
  await page.locator('#private-pause').click();await expect(page.getByRole('status')).toContainText('מושהית');await expect(page.locator('#private-terminal')).not.toContainText('אות חיים');expect(errors).toEqual([]);
});
test('late authentication failures cannot overwrite a newer owner session',async({page})=>{
  const errors=await mount(page);
  await page.evaluate(()=>{mockAuth.signIn=()=>new Promise((_,reject)=>window.rejectOld=reject);});
  await page.locator('#private-login').click();
  await page.evaluate(()=>setIdentity({uid:'synthetic-owner',backendAuthorized:true}));await send(page);
  await page.evaluate(()=>rejectOld(Error('synthetic-secret')));await expect(page.getByRole('status')).toContainText('מחובר למקור');
  await page.evaluate(()=>{mockAuth.signOut=()=>new Promise((_,reject)=>window.rejectLogout=reject);});await page.locator('#private-logout').click();
  await page.evaluate(()=>setIdentity({uid:'synthetic-owner',backendAuthorized:true}));await send(page);
  await page.evaluate(()=>rejectLogout(Error('synthetic-secret')));await expect(page.getByRole('status')).toContainText('מחובר למקור');expect(errors).toEqual([]);
});

const STAMP=/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/;
const uid=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
async function sendAll(page,events){await page.evaluate(events=>listeners.at(-1).next(events,{fromCache:false}),events);}
async function login(page){await page.locator('#private-login').click();await expect.poll(()=>page.evaluate(()=>listeners.length)).toBeGreaterThan(0);}
test.describe('private log stamps in Asia/Jerusalem from a UTC browser',()=>{
 test.use({timezoneId:'UTC'});
 test('DD/MM/YYYY HH:mm with datetime; 21:30Z shows next Israel day; DST 2026-10-25',async({page})=>{
  await page.clock.install({time:new Date('2026-10-25T01:00:00Z')});
  const errors=await mount(page,{css:'private'});await login(page);
  const rows=[['2026-09-29T21:30:00Z','30/09/2026 00:30'],['2026-10-24T22:30:00Z','25/10/2026 01:30'],['2026-10-24T23:30:00Z','25/10/2026 01:30'],['2026-10-25T00:30:00Z','25/10/2026 02:30']];
  await sendAll(page,rows.map(([iso],i)=>({id:uid(i+1),agent:'Grok',kind:'test_passed',task:'swap_race_review',step:'passed',at:Date.parse(iso)})));
  const times=page.locator('#private-terminal .entry time');await expect(times).toHaveCount(rows.length);
  for(const [i,[iso,shown]] of rows.entries()){
   const t=times.nth(i);const text=await t.textContent();
   expect(text).toMatch(STAMP);expect(text).toBe(shown);
   expect(await t.getAttribute('datetime')).toBe(new Date(iso).toISOString());
   expect(await t.getAttribute('title')).toContain(new Date(iso).toISOString());
   expect(await t.evaluate(n=>getComputedStyle(n).direction)).toBe('ltr');
  }
  expect(await page.evaluate(()=>new Date().getTimezoneOffset())).toBe(0);
  expect(errors).toEqual([]);
 });
});
test('every known task type renders a Hebrew name, unknown type falls back, never undefined',async({page})=>{
 await page.clock.install({time:new Date('2026-09-30T06:00:00Z')});
 const errors=await mount(page);await login(page);
 const types=['local_tests','git_change','pull_request_review','deployment_check','agent_review_cycle','planner_draft_recovery','swap_race_review','clean_checkout_gates'];
 const now=await page.evaluate(()=>Date.now());
 await sendAll(page,types.map((task,i)=>({id:uid(i+1),agent:'Claude',kind:'task_completed',task,step:'completed',at:now-10000+i})));
 const spans=page.locator('#private-terminal .entry span');await expect(spans).toHaveCount(types.length);
 for(const text of await spans.allTextContents()){expect(text).not.toMatch(/undefined|null/);expect(text.split(' · ')[1]?.trim()).toBeTruthy();}
 expect(await page.evaluate(async()=>{const m=await import('/private-view.mjs');return [m.taskLabel('mystery_task'),m.taskLabel(undefined)];})).toEqual(['פעולה (mystery_task)','פעולה']);
 expect(errors).toEqual([]);
});
test('status: 30s live, 120s and missing disconnected, expires without reload or new listener',async({page})=>{
 await page.clock.install({time:new Date('2026-09-30T06:00:00Z')});
 const errors=await mount(page);await login(page);
 const now=await page.evaluate(()=>Date.now());
 await sendAll(page,[{id:uid(1),agent:'Codex',kind:'heartbeat',task:'local_tests',step:'running',at:now-30000},
  {id:uid(2),agent:'Grok',kind:'heartbeat',task:'local_tests',step:'running',at:now-120000},
  {id:uid(3),agent:'Claude',kind:'task_started',task:'planner_draft_recovery',step:'started',at:now-1000}]);
 const status=agent=>page.locator('.agent',{has:page.locator('h2',{hasText:agent})}).locator('.agent-status');
 await expect(status('Codex')).toHaveText('CONNECTED');
 await expect(status('Grok')).toHaveText('DISCONNECTED');
 await expect(status('Claude')).toHaveText('DISCONNECTED');
 await expect(status('Gemini')).toHaveText('DISCONNECTED');
 const url=page.url();const navigations=[];page.on('framenavigated',f=>{if(f===page.mainFrame())navigations.push(f.url());});
 await page.evaluate(()=>{window.__marker='same-document';});
 await page.clock.runFor(70000); // Codex heartbeat now >95s old
 await expect(status('Codex')).toHaveText('DISCONNECTED');
 expect(await page.evaluate(()=>[window.__marker,listeners.length])).toEqual(['same-document',1]);
 expect(navigations).toEqual([]);expect(page.url()).toBe(url);
 await expect(page.locator('#private-terminal .entry')).toHaveCount(3);
 expect(errors).toEqual([]);
});
test('private.css keeps no horizontal overflow at 320/390/1440 with long rows',async({page})=>{
 const errors=await mount(page,{css:'private'});await login(page);
 const now=await page.evaluate(()=>Date.now());
 await sendAll(page,['Codex','Grok','Claude','Gemini'].map((agent,i)=>({id:uid(i+1),agent,kind:'task_started',task:'clean_checkout_gates',step:'started',at:now-5000+i})));
 await expect(page.locator('#private-terminal .entry')).toHaveCount(4);
 for(const width of [320,390,1440]){await page.setViewportSize({width,height:900});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  for(const t of await page.locator('#private-terminal time').all())expect(await t.evaluate(n=>getComputedStyle(n).whiteSpace)).toBe('nowrap');
  expect(await page.locator('#private-terminal .entry').first().evaluate(n=>getComputedStyle(n).whiteSpace)).not.toBe('nowrap');}
 expect(errors).toEqual([]);
});
test('clock skew: t+60000 heartbeat live with the rest of the log; t+60001 row dropped with a notice, no reset',async({page})=>{
 await page.clock.install({time:new Date('2026-09-30T06:00:00Z')});
 const errors=await mount(page);
 await page.clock.pauseAt(new Date('2026-09-30T06:00:05Z')); // freeze Date.now so the bounds are exact
 await login(page);
 const now=await page.evaluate(()=>Date.now());
 await sendAll(page,[{id:uid(1),agent:'Codex',kind:'heartbeat',task:'local_tests',step:'running',at:now+60000},
  {id:uid(2),agent:'Grok',kind:'test_passed',task:'swap_race_review',step:'passed',at:now-5000},
  {id:uid(3),agent:'Claude',kind:'task_completed',task:'planner_draft_recovery',step:'completed',at:now-4000}]);
 const codex=page.locator('.agent',{has:page.locator('h2',{hasText:'Codex'})});
 await expect(page.getByRole('status')).toHaveText('מחובר למקור האירועים הפרטי');
 await expect(codex.locator('.agent-status')).toHaveText('CONNECTED');
 await expect(codex.locator('small')).toHaveText('דווח חי ע"י CI');
 await expect(page.locator('#private-terminal .entry')).toHaveCount(3);
 for(const t of await page.locator('#private-terminal .entry time').allTextContents())expect(t).toMatch(STAMP);
 await sendAll(page,[{id:uid(4),agent:'Codex',kind:'heartbeat',task:'local_tests',step:'running',at:now+60001},
  {id:uid(5),agent:'Grok',kind:'test_passed',task:'swap_race_review',step:'passed',at:now-5000},
  {id:uid(6),agent:'Gemini',kind:'heartbeat',task:'local_tests',step:'running',at:now-1000}]);
 await expect(page.getByRole('status')).toHaveText('מחובר למקור האירועים הפרטי · שעון לא מסונכרן');
 await expect(page.locator('#private-terminal .entry')).toHaveCount(2);
 await expect(page.locator('#private-terminal')).not.toContainText('החיבור הופסק');
 await expect(codex.locator('.agent-status')).toHaveText('DISCONNECTED');
 await expect(page.locator('.agent',{has:page.locator('h2',{hasText:'Gemini'})}).locator('.agent-status')).toHaveText('CONNECTED');
 await sendAll(page,[{id:uid(7),agent:'Codex',kind:'heartbeat',task:'unknown_task',step:'running',at:now}]);
 await expect(page.getByRole('status')).toContainText('החיבור הופסק'); // schema violation still fails closed
 expect(errors).toEqual([]);
});
