import {test,expect} from 'playwright/test';
import {readFileSync} from 'node:fs';
const source=new URL('../../control-plane/web/',import.meta.url);
async function mount(page){
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!=='http://localhost:41996'){await route.abort();return;}
    const file=url.pathname.split('/').pop();
    if(['private-view.mjs','private-controller.mjs'].includes(file)){await route.fulfill({body:readFileSync(new URL(file,source)),contentType:'text/javascript'});return;}
    if(file==='status.css'){await route.fulfill({body:readFileSync(new URL('../../public/status/status.css',import.meta.url)),contentType:'text/css'});return;}
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
