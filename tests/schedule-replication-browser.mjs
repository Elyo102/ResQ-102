import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createContainedServer} from './lib/localize-worker.mjs';
import {chromium} from './lib/contained-playwright.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Jerusalem', year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const server = createContainedServer((req,res)=> {
  const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type', ({'.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json'})[path.extname(file)] || 'text/plain');
  res.end(fs.readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser = await chromium.launch();
let passed=0;
try {
  for (const width of [375,430]) {
    const context = await browser.newContext({viewport:{width,height:900},locale:'he-IL'});
    await context.route('**/firebasejs/**',route=> {
      const file=path.join(root,'tests/stub',route.request().url().split('/').pop().split('?')[0]);
      return route.fulfill({status:200,contentType:'text/javascript',body:fs.existsSync(file)?fs.readFileSync(file,'utf8'):'export default {};'});
    });
    const active={publication_id:'p_default',revision:4,content_digest:'digest_default',from:today,to:today};
    const selected={...active,publication_id:'p_selected',revision:7,content_digest:'digest_selected'};
    const applied={...selected,publication_id:'p_applied',revision:8,content_digest:'digest_applied'};
    // A published selected month must work even without a default-month owner.
    const status={mode:'new',configured:true,manager:true,active:width===430?null:active};
    const day={date:today,sub_stations:[{sub_station:'eilat',label:'אילת',minimum:1,people:[{uid:'stub-uid',person:'עובד בדיקה',role_label:'לוחם',hours:'07:00-07:00'}]}],events:[],guards:[],guards_status:'ready'};
    const report={counts:{changes:2,people:1,dates:2},notifications:1,next_revision:8,edit_digest:'preview_digest',changes:[],people_changed:[],warnings:[],below_minimum:[],
      replication:{summary:{skipped_people:1},skipped_people:[{uid:'stub-uid',date:today,reason:'absent'}],skipped_dates:[{date:today,reason:'manual-exists'}],gaps:[]}};
    await context.addInitScript(plans=> {window.__SMOKE_ROLE='firefighter';window.__CALLABLE_PLAN=plans;}, {
      getScheduleRuntimeStatus:[{data:status},{data:{...status,active:selected}},{data:{...status,active:applied}}],
      getScheduleManagerSetup:[{data:{mode:'new',configured:true,policy:{id:'p',version:'1',sub_stations:[{id:'main',label:'אילת',minimum:1,requirements:[]}]},source:{id:'s',version:'1'},people:[{id:'stub-uid',name:'עובד בדיקה',roles:['firefighter'],sub_station:'main'}]}}],
      getMyScheduleV2:[{data:{mode:'new',active:true,days:[],events:[]}},{data:{mode:'new',active:true,days:[],events:[]}}],
      getStationScheduleRange:[{data:{mode:'new',active:true,source:'v2',from:today,to:today,days:[day]}},
        {data:{mode:'new',active:true,source:'v2',from:today,to:today,days:[day],revision:8}}],
      previewScheduleReplication:[{data:report,delay:300},{data:report}],
      applyScheduleEdit:[{data:{publication_id:'p_applied',revision:8,notified_people:2},delay:500}]
    });
    const page=await context.newPage(), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});
    await page.goto(`http://127.0.0.1:${server.address().port}/schedule-management.html?tab=station`);
    await page.locator('.replicate-row').first().click();
    await page.locator('#editCheck:enabled').waitFor();
    await page.locator('#editCheck').click();
    assert.equal(await page.locator('.replication-override input').isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'ביטול השכפול',exact:true}).isDisabled(),true);
    await page.locator('#editReport:not([hidden])').waitFor();
    const call=await page.evaluate(()=>window.__CALLABLE_CALLS.find(c=>c.name==='previewScheduleReplication'));
    assert.deepEqual(call.payload.expected,{publication_id:'p_selected',revision:7,content_digest:'digest_selected'});
    assert.equal(call.payload.replication.mode,'skip_manual');
    assert.equal(call.payload.replication.source.date,today);
    assert.equal(Object.hasOwn(call.payload,'edits'),false);
    assert.ok((await page.locator('#editReport').innerText()).includes('עובד בדיקה'));
    await page.locator('.replication-override input').check();
    await page.locator('#editCheck').click();
    await page.waitForFunction(()=>window.__CALLABLE_CALLS.filter(c=>c.name==='previewScheduleReplication').length===2);
    assert.equal(await page.evaluate(()=>window.__CALLABLE_CALLS.filter(c=>c.name==='previewScheduleReplication').at(-1).payload.replication.mode),'override');
    await page.locator('#editApply:enabled').waitFor();
    await page.locator('#editApply').click();
    assert.equal((await page.locator('#editMessage').innerText()).includes('פורסמה גרסה'),false,
      'publication success must wait for the authoritative receipt');
    await page.waitForFunction(()=>document.getElementById('editMessage').textContent.includes('פורסמה גרסה 8'));
    const receiptMessage=await page.locator('#editMessage').innerText();
    assert.ok(receiptMessage.includes('הוכנו הודעות ל־2 עובדים'));
    assert.ok(receiptMessage.includes('מסירה עדיין לא אומתה'));
    assert.equal(receiptMessage.includes('עובדים קיבלו'),false);
    await page.waitForFunction(()=>window.__CALLABLE_CALLS.filter(c=>c.name==='getScheduleRuntimeStatus').length>=3
      && window.__CALLABLE_CALLS.filter(c=>c.name==='getStationScheduleRange').length>=2);
    const applyCalls=await page.evaluate(()=>window.__CALLABLE_CALLS.filter(c=>c.name==='applyScheduleEdit'));
    assert.equal(applyCalls.length,1);
    assert.deepEqual(applyCalls[0].payload.expected,{publication_id:'p_selected',revision:7,content_digest:'digest_selected'});
    assert.deepEqual(applyCalls[0].payload.replication,{source:{date:today,sub_station:call.payload.replication.source.sub_station},
      month:today.slice(0,7),mode:'override'});
    assert.equal(applyCalls[0].payload.expected_edit_digest,'preview_digest');
    assert.equal(Object.hasOwn(applyCalls[0].payload,'edits'),false);
    assert.deepEqual(errors,[]);
    passed++;console.log(`PASS replication selected-month payload, override and truthful apply receipt at ${width}px`);
    await context.close();
  }
  console.log(`Passed ${passed} focused browser scenarios (mock callables, Chromium only)`);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
