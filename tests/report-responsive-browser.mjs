// Real exported document, synthetic rows, contained browser; no Firebase calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('./lib/contained-playwright.cjs');
const source=fs.readFileSync(new URL('../report.js',import.meta.url),'utf8');
const {reportPage}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const out=process.env.RESQ_CONTAINMENT_DIR;
assert(out,'Contained evidence directory required');
const browser=await chromium.launch();let passed=0;
const errors=[];
const rows=[{date:'2026-09-01',day_type:'course',day_type_he:'קורס',course_overlay:true,hours:20,notes:'קורס מאושר'},
 {date:'2026-09-02',day_type:'reserve_shift',day_type_he:'משמרת בזמן מילואים',start:'07:00',end:'09:00',end_day:1,hours:34.5}];
const head={full_name:'עובד בדיקה',month:'2026-09',station_name:'תחנת בדיקה',total:54.5,status:'approved'};
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
try{
 for(const width of [375,390,414,430]){
  const context=await browser.newContext({viewport:{width,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2,serviceWorkers:'block'});
  try{
   const page=await context.newPage();
   page.on('pageerror',e=>errors.push(e.message));
   page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.type()+': '+m.text());});
   for(const variant of ['normal','long','empty']){
    const data=variant==='empty'?[]:structuredClone(rows);
    const title=variant==='long'?'עובד-בדיקה-'.repeat(16):head.full_name;
    if(variant==='long'){data[0].notes='<script>unsafe()</script>'+'LongUnbrokenToken'.repeat(24)+' הערה בעברית'.repeat(14);data[0].site_name='שםתחנהלבדיקה'.repeat(25);}
    await page.setContent(reportPage({...head,full_name:title,total:variant==='empty'?0:54.5},data));
    await check(`${width}/${variant}: device viewport and document fit`,async()=>{
     const sizes=await page.evaluate(()=>({inner:innerWidth,client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
     assert.equal(sizes.inner,width);assert.equal(sizes.client,width);assert(sizes.scroll<=width+1,JSON.stringify(sizes));
    });
    await check(`${width}/${variant}: full data and readable total`,async()=>{
     assert.equal(await page.locator('thead th').count(),7);assert.equal(await page.locator('tbody tr').count(),data.length);
     assert.equal(await page.locator('.total').textContent(),'סך שעות החודש: '+(variant==='empty'?0:54.5));
     assert.equal(await page.locator('.nm').textContent(),title);assert.equal(await page.locator('script').count(),0);
     const total=await page.locator('.total').evaluate(e=>{const r=e.getBoundingClientRect();return {x:r.x,right:r.right,sw:e.scrollWidth,cw:e.clientWidth};});
     assert(total.x>=0&&total.right<=width+1&&total.sw<=total.cw+1);
     if(data.length){assert.equal(await page.locator('tr.day-course td').first().evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 227, 227)');assert.match(await page.locator('tr.day-reserve').textContent(),/למחרת/);}
    });
    await check(`${width}/${variant}: keyboard-accessible local table scroll`,async()=>{
     const scroll=page.locator('.report-table-scroll');await scroll.focus();
     assert.equal(await scroll.getAttribute('role'),'region');assert(await scroll.getAttribute('aria-label'));
     assert(await scroll.evaluate(e=>document.activeElement===e));
     const geometry=await scroll.evaluate(e=>{e.scrollLeft=0;const r=e.getBoundingClientRect();return {sw:e.scrollWidth,cw:e.clientWidth,x:r.x,right:r.right};});
     assert(geometry.x>=0&&geometry.right<=width+1);assert(geometry.sw>geometry.cw);
     await page.keyboard.press('ArrowLeft');await page.waitForTimeout(160);
     assert(await scroll.evaluate(e=>e.scrollLeft)<0,'RTL keyboard scroll must move');
     await scroll.evaluate(e=>{e.scrollLeft=-e.scrollWidth;});
     assert(await page.locator('td.hrs,th:last-child').first().evaluate(e=>{const r=e.getBoundingClientRect(),s=e.closest('.report-table-scroll').getBoundingClientRect();return r.left>=s.left-1&&r.right<=s.right+1;}),'last column reachable');
    });
    if(variant==='normal')await page.screenshot({path:path.join(out,`report-mobile-${width}.png`),fullPage:true});
   }
  }finally{await context.close();}
 }
 const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
 try{
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.setContent(reportPage(head,rows));
  await check('desktop: original typography and seven-column table',async()=>{
   assert.equal(await page.locator('table').evaluate(e=>getComputedStyle(e).display),'table');
   assert.equal(await page.locator('body').evaluate(e=>getComputedStyle(e).padding),'26px 30px');
   assert.equal(await page.locator('thead th').count(),7);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  });
  await page.emulateMedia({media:'print'});await page.setViewportSize({width:794,height:1123});
  await check('print: original table, unrestricted region and exact colors',async()=>{
   assert.equal(await page.locator('body').evaluate(e=>getComputedStyle(e).padding),'0px');
   assert.equal(await page.locator('.report-table-scroll').evaluate(e=>getComputedStyle(e).overflowX),'visible');
   assert.equal(await page.locator('table').evaluate(e=>getComputedStyle(e).minWidth),'0px');
   assert.equal(await page.locator('table').evaluate(e=>getComputedStyle(e).display),'table');
   assert.equal(await page.locator('thead th').count(),7);
   assert.equal(await page.locator('tr.day-course td').first().evaluate(e=>getComputedStyle(e).printColorAdjust),'exact');
   assert.equal(await page.locator('.total').textContent(),'סך שעות החודש: 54.5');
  });
  await page.screenshot({path:path.join(out,'report-print.png'),fullPage:true});
 }finally{await context.close();}
 assert.deepEqual(errors,[]);console.log(`Report responsive browser: ${passed}/${passed} PASS; zero captured console warnings/errors. Chromium emulation, not physical Safari.`);
}finally{await browser.close();}
