import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const browser=await chromium.launch();
let passed=0;
const origin='http://127.0.0.1:41992';
async function fixture({width=1100,theme='light',connected=true}={}) {
  const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme,serviceWorkers:'block'});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
    const file=path.resolve(root,'.'+url.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
    let body=fs.readFileSync(file);
    if(file.endsWith('hr.html')&&connected)body=body.toString().replace("createHrHoursUI(document.getElementById('hr-workspace'));","window.__UI=createHrHoursUI(document.getElementById('hr-workspace'),window.__adapter);");
    await route.fulfill({status:200,contentType:file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':'text/javascript',body});
  });
  await context.addInitScript(()=>{
    window.__session={uid:'hr.fixture',stationId:'fixture_station',role:'hr_coordinator',super:false,epoch:1};
    window.__listeners=[];window.__calls=[];window.__held=[];window.__holdDetails=false;window.__holdLists=false;
    window.__people=[{uid:'u1',full_name:'עובד ראשון',state:'draft',historical:false},{uid:'u2',full_name:'עובד שני',state:'approved',historical:false},{uid:'u3',full_name:'עובד לשעבר',state:'draft',historical:true}];
    window.__adapter={currentSession:()=>window.__session,subscribeIdentity:cb=>{window.__listeners.push(cb);return()=>{};},
      listMonth:async data=>{
        window.__calls.push({name:'list',data});
        const result={month:data.month,items:structuredClone(window.__people),next_cursor:window.__cursor||null};
        if(window.__holdLists)return new Promise(resolve=>window.__held.push({kind:'list',resolve:()=>resolve(result)}));
        return result;
      },
      getEmployeeMonth:async data=>{
        window.__calls.push({name:'detail',data});
        const person=window.__people.find(p=>p.uid===data.uid);
        const result={...person,month:data.month,employee_number:'1001',crew:'A',stored_total_hours:24,current_detail_total_hours:22,
          warnings:['reported-total-differs'],rows:[{date:data.month+'-01',day_type_he:'רגיל',start:'08:00',end:'08:00',end_day:1,start2:'18:00',end2:'22:00',site_name:'אילת',notes:'הערה נפרדת',reason:'סיבה ישנה',overtime_reason:'נשארתי באירוע',hours:22}]};
        if(window.__holdDetails)return new Promise(resolve=>window.__held.push({kind:'detail',resolve:()=>resolve(result)}));
        return result;
      }};
    window.__emit=()=>window.__listeners.forEach(cb=>cb());
    window.__release=()=>{const held=window.__held.splice(0);held.forEach(p=>p.resolve());};
  });
  const page=await context.newPage();page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/hr.html');
  if(connected)await page.locator('.hr-person').first().waitFor();
  return {page,context,errors};
}
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
try {
  await check('public disconnected shell has no employee data or calls',async()=>{
    const f=await fixture({connected:false});assert.equal(await f.page.locator('.hr-person').count(),0);
    assert.equal(await f.page.locator('[data-hr="refresh"]').isDisabled(),true);
    assert.equal(await f.page.evaluate(()=>__calls.length),0);assert.deepEqual(f.errors,[]);await f.context.close();
  });
  await check('report shows stored/current totals, discrepancy and split segment',async()=>{
    const f=await fixture();await f.page.locator('[data-uid="u1"]').click();
    await f.page.getByRole('heading',{name:'עובד ראשון',exact:true}).waitFor();
    const t=await f.page.locator('[data-hr="detail"]').innerText();assert.ok(t.includes('24'));assert.ok(t.includes('22'));assert.ok(t.includes('שונה'));assert.ok(t.includes('18:00–22:00'));
    for(const value of ['הערה נפרדת','סיבה ישנה','נשארתי באירוע'])assert.ok(t.includes(value));
    assert.equal(await f.page.locator('tbody bdi').getAttribute('dir'),'ltr');
    assert.equal(await f.page.locator('tbody bdi').innerText(),'18:00–22:00');
    assert.deepEqual(f.errors,[]);await f.context.close();
  });
  await check('left next and right previous use visible navigation',async()=>{
    const f=await fixture();await f.page.locator('[data-uid="u1"]').click();await f.page.keyboard.press('ArrowLeft');
    await f.page.getByRole('heading',{name:'עובד שני',exact:true}).waitFor();await f.page.keyboard.press('ArrowRight');
    await f.page.getByRole('heading',{name:'עובד ראשון',exact:true}).waitFor();await f.context.close();
  });
  await check('arrows do not navigate while editing or using modifiers',async()=>{
    const f=await fixture();await f.page.locator('[data-uid="u1"]').click();await f.page.getByRole('heading',{name:'עובד ראשון',exact:true}).waitFor();
    const count=await f.page.evaluate(()=>__calls.filter(c=>c.name==='detail').length);
    await f.page.locator('[data-hr="month"]').focus();await f.page.keyboard.press('ArrowLeft');await f.page.keyboard.press('Control+ArrowLeft');
    assert.equal(await f.page.evaluate(()=>__calls.filter(c=>c.name==='detail').length),count);await f.context.close();
  });
  await check('historical report is labelled and contains no action buttons',async()=>{
    const f=await fixture();await f.page.locator('[data-uid="u3"]').click();await f.page.getByText('דוח היסטורי של עובד שאינו פעיל בתחנה.').waitFor();
    assert.equal(await f.page.locator('[data-hr="detail"] button').count(),0);await f.context.close();
  });
  await check('later selected report wins reversed detail completion order',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__holdDetails=true;});
    await f.page.locator('[data-uid="u1"]').click();await f.page.locator('[data-uid="u2"]').click();
    await f.page.evaluate(()=>{__held.pop().resolve();});await f.page.getByRole('heading',{name:'עובד שני',exact:true}).waitFor();
    await f.page.evaluate(()=>{__held.pop().resolve();});assert.equal(await f.page.locator('[data-hr="detail"] h2').innerText(),'עובד שני');await f.context.close();
  });
  await check('late previous-month list cannot replace selected-month data',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__holdLists=true;__UI.refresh();});
    await f.page.evaluate(()=>{__people=[{uid:'new-month',full_name:'עובד בחודש החדש',state:'missing'}];});
    await f.page.locator('[data-hr="month"]').fill('2026-08');await f.page.locator('[data-hr="month"]').dispatchEvent('change');
    await f.page.evaluate(()=>{__held.pop().resolve();});await f.page.locator('[data-uid="new-month"]').waitFor();
    await f.page.evaluate(()=>{__release();});assert.equal(await f.page.evaluate(()=>__held.length),0);
    assert.equal(await f.page.locator('[data-uid="u1"]').count(),0);
    assert.equal(await f.page.locator('[data-hr="month"]').inputValue(),'2026-08');await f.context.close();
  });
  await check('identity change before observer clears held private response',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__holdDetails=true;});await f.page.locator('[data-uid="u1"]').click();
    await f.page.evaluate(()=>{__session=null;__release();});await f.page.getByText('נדרש חיבור עם הרשאת משאבי אנוש.').waitFor();
    assert.equal(await f.page.locator('.hr-person').count(),0);assert.equal(await f.page.locator('[data-hr="detail"] h2').count(),0);await f.context.close();
  });
  await check('same uid role revocation synchronously removes displayed report',async()=>{
    const f=await fixture();await f.page.locator('[data-uid="u1"]').click();await f.page.locator('[data-hr="detail"] h2').waitFor();
    await f.page.evaluate(()=>{__session={...__session,role:'firefighter',epoch:2};__emit();});
    assert.equal(await f.page.locator('[data-hr="detail"] h2').count(),0);assert.equal(await f.page.locator('.hr-person').count(),0);await f.context.close();
  });
  await check('unavailable identity clears existing private data without another request',async()=>{
    const f=await fixture();await f.page.locator('[data-uid="u1"]').click();await f.page.locator('[data-hr="detail"] h2').waitFor();
    const before=await f.page.evaluate(()=>__calls.length);
    await f.page.evaluate(()=>{__adapter.currentSession=()=>{throw new Error('identity unavailable');};__emit();});
    assert.equal(await f.page.locator('[data-hr="detail"] h2').count(),0);assert.equal(await f.page.locator('.hr-person').count(),0);
    assert.equal(await f.page.evaluate(()=>__calls.length),before);assert.deepEqual(f.errors,[]);await f.context.close();
  });
  await check('same uid station change discards old list even before observer',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__holdLists=true;__UI.refresh();});
    await f.page.evaluate(()=>{__session={...__session,stationId:'another_station',epoch:2};__people=[];__holdLists=false;__release();});
    await f.page.getByText('אין עובדים להצגה בחודש הזה.').waitFor();assert.equal(await f.page.locator('.hr-person').count(),0);await f.context.close();
  });
  await check('saved old row callback cannot fetch after identity change',async()=>{
    const f=await fixture();const before=await f.page.evaluate(()=>__calls.length);
    await f.page.evaluate(()=>{const b=document.querySelector('[data-uid="u1"]');__session=null;b.click();});
    assert.equal(await f.page.evaluate(()=>__calls.length),before);assert.equal(await f.page.locator('.hr-person').count(),0);await f.context.close();
  });
  await check('empty continuation page preserves ability to advance',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__people=[];__cursor='next-page';__UI.refresh();});
    await f.page.locator('[data-hr="more"]').waitFor({state:'visible'});
    await f.page.evaluate(()=>{__people=[{uid:'next',full_name:'עובד נוסף',state:'missing'}];__cursor=null;});
    await f.page.locator('[data-hr="more"]').click();await f.page.locator('[data-uid="next"]').waitFor();await f.context.close();
  });
  await check('list failure clears existing private detail',async()=>{
    const f=await fixture();await f.page.locator('[data-uid="u1"]').click();await f.page.locator('[data-hr="detail"] h2').waitFor();
    await f.page.evaluate(()=>{__adapter.listMonth=async()=>{throw new Error('fixture failure');};__UI.refresh();});
    await f.page.getByText('טעינת הדוחות נכשלה. לחצו רענון כדי לנסות שוב.').waitFor();assert.equal(await f.page.locator('[data-hr="detail"] h2').count(),0);await f.context.close();
  });
  await check('names are rendered as text and not executable markup',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__people=[{uid:'xss',full_name:'<img src=x onerror=alert(1)>',state:'missing'}];__UI.refresh();});
    await f.page.locator('[data-uid="xss"]').waitFor();assert.equal(await f.page.locator('#hr-workspace img').count(),0);assert.ok((await f.page.locator('[data-uid="xss"]').innerText()).includes('<img'));await f.context.close();
  });
  for(const width of [320,390,1100])for(const theme of ['light','dark'])await check('readable layout '+width+' '+theme,async()=>{
    const f=await fixture({width,theme});await f.page.locator('[data-uid="u1"]').click();await f.page.locator('tbody tr').waitFor();
    assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(f.errors,[]);
    if(width===1100&&theme==='light'&&process.env.HR_SCREENSHOT)await f.page.screenshot({path:process.env.HR_SCREENSHOT,fullPage:true});
    await f.context.close();
  });
  console.log(passed+' HR browser scenarios passed. No production calls.');
}finally{await browser.close();}
