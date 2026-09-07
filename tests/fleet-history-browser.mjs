// Actual historical consumer pages, synthetic Firebase data, local HTTP only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const vehicles = [{id:'live',name:'Active test vehicle'}, {id:'retired',name:'Retired test vehicle',active:false}];
const faults = [{id:'history',vehicle_id:'retired',vehicle_name:'Retired test vehicle',kind:'vehicle',
  title:'Historical blocking fault',status:'fixed',severity:'blocking',created_key:'2026-09-01T00:00:00Z',fixed_key:'2026-09-03T00:00:00Z'},
  {id:'open-history',vehicle_id:'retired',kind:'vehicle',title:'Historical open fault',status:'open',severity:'minor',created_key:'2026-09-01T00:00:00Z'},
  {id:'orphan-history',vehicle_id:'missing',kind:'damage',title:'Orphan historical fault',status:'open',severity:'minor',created_key:'2026-09-01T00:00:00Z'}];
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json'};
const server = http.createServer((request,response) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404); response.end(); return;
  }
  response.writeHead(200, {'Content-Type':mime[path.extname(file)] || 'application/octet-stream'});
  response.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch();
const tap = loc => loc.evaluate(el => el.dispatchEvent(new MouseEvent('click',{bubbles:true})));
let passed = 0;

async function scenario(label, url, fn, withViews = true) {
  const context = await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
  const page = await context.newPage(), errors = [];
  page.on('pageerror',error => errors.push(error.message));
  page.on('dialog',dialog => dialog.accept());
  await context.addInitScript(({vehicles,faults,png,withViews}) => {
    window.__SMOKE_ROLE='commander';
    window.__HISTORY_FIXTURE={vehicles,faults,views:withViews ? vehicles.map(v => ({id:v.id+'__right',vehicle_id:v.id,side:'right',photo:png,w:1,h:1})) : []};
  },{vehicles,faults,png,withViews});
  await context.route('**/*',async route => {
    const u = new URL(route.request().url());
    if (u.origin === origin) {
      if (u.pathname === '/vehicle.html') {
        // Expose real lexical callbacks only in the intercepted test response.
        // UI absence alone cannot prove an old callback refuses a write.
        const anchor='async function grade(';
        const original=read('vehicle.html');
        assert.equal(original.split(anchor).length-1,1);
        const body=original.replace(anchor,'window.__HISTORY_ACTIONS={grade,closeFault,wipe,captureFaultTarget};\n'+anchor);
        await route.fulfill({status:200,contentType:'text/html',body}); return;
      }
      if (u.pathname === '/faults.js') {
        let body = read('faults.js');
        const anchor='export function shrinkImage(file, maxEdge, maxBytes) {';
        assert.ok(body.includes(anchor));
        body=body.replace(anchor,'function originalShrinkImage(file, maxEdge, maxBytes) {');
        body += '\nexport function shrinkImage(...args) { if (!window.__HOLD_IMAGE) return originalShrinkImage(...args); window.__IMAGE_PENDING=true; return new Promise(resolve => { window.__RELEASE_IMAGE=()=>resolve({data:'+JSON.stringify(png)+',w:1,h:1}); }); }';
        await route.fulfill({status:200,contentType:'text/javascript',body}); return;
      }
      if (u.pathname === '/v41.js') {
        // Delay module evaluation after the import button was clicked.
        const body='window.__BUNDLE_PENDING=true; await new Promise(resolve=>window.__RELEASE_BUNDLE=resolve); export const SET={right:'+JSON.stringify(png)+'};';
        await route.fulfill({status:200,contentType:'text/javascript',body}); return;
      }
      await route.continue(); return;
    }
    if (u.hostname === 'www.gstatic.com' && u.pathname.includes('/firebasejs/')) {
      const file = path.join(root,'tests/stub',u.pathname.split('/').pop());
      let body=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'export default {};';
      if (u.pathname.endsWith('/firebase-auth.js')) body=body.replace(/['"][^'"\s]+@[^'"\s]+['"]/g,"'history-test@example.invalid'");
      if (u.pathname.endsWith('/firebase-firestore.js')) {
        for (const signature of ['export function getDoc(ref){','export function getDocs(q){','export function onSnapshot(']) assert.ok(body.includes(signature),signature);
        body=body.replace('export function getDoc(ref){',`export function getDoc(ref){
          if (String(ref.path).endsWith('/config/board')) return Promise.resolve(docSnap({vehicles:window.__HISTORY_FIXTURE.vehicles,command:[]},'board'));
          return Promise.resolve(docSnap({full_name:'Synthetic viewer',role:'commander',is_active:true},'viewer'));
        `);
        body=body.replace('export function getDocs(q){',`export function getDocs(q){
          const hp=String(q.path||'');
          const rows=hp.endsWith('/faults')?window.__HISTORY_FIXTURE.faults:hp.endsWith('/vehicle_views')?window.__HISTORY_FIXTURE.views:[];
          return Promise.resolve(listSnap(rows.map(v=>[v.id,v])));
        `);
        body=body.replace('export function onSnapshot(','export function originalOnSnapshot(');
        const deleteStub='export function deleteDoc(){ return Promise.resolve(); }';
        assert.equal(body.split(deleteStub).length-1,1);
        body=body.replace(deleteStub,'export function deleteDoc(ref){ window.__HISTORY_DELETES=(window.__HISTORY_DELETES||[]).concat(ref.path); return Promise.resolve(); }');
        body+='\nexport function onSnapshot(ref,cb){ if(typeof cb==="function") cb(listSnap([])); return ()=>{}; }';
      }
      await route.fulfill({status:200,contentType:'text/javascript',body}); return;
    }
    await route.abort(); // No external transmissions, including SDK/API calls.
  });
  try {
    await page.goto(origin+'/'+url,{waitUntil:'load'});
    await page.locator('#work:not(.hide)').waitFor();
    if(url.startsWith('stats')) await page.locator('#vTbl tbody tr').first().waitFor();
    else await page.locator('#vehChips button').first().waitFor();
    await fn(page);
    assert.deepEqual(errors,[]);
    passed++; console.log('✓ '+label);
  } finally { await context.close(); }
}
const noNewWrites = async page => assert.deepEqual(await page.evaluate(()=>({sets:window.__FIRESTORE_WRITES||[],adds:window.__FIRESTORE_ADDS||[],deletes:window.__HISTORY_DELETES||[]})),{sets:[],adds:[],deletes:[]});
const select = (page,name) => tap(page.locator('#vehChips button').filter({hasText:name}));

try {
  await scenario('stats preserves retired fault counts and downtime with an archived label','stats.html',async page=>{
    const row=page.locator('#vTbl tbody tr').filter({hasText:'Retired test vehicle'});
    assert.equal(await row.count(),1);
    assert.match(await row.innerText(),/הוצא מהצי/);
    assert.equal((await row.locator('[data-l="ימי השבתה"]').innerText()).trim(),'2');
    assert.equal((await row.locator('[data-l="תקלות"]').innerText()).trim(),'2');
    await noNewWrites(page);
  });
  await scenario('retired deep link shows its own map/history and permits existing fault resolution','vehicle.html?v=retired',async page=>{
    assert.match(await page.locator('#vehChips button.on').innerText(),/Retired test vehicle/);
    assert.match(await page.locator('#vehState').innerText(),/הוצא מהצי/);
    assert.match(await page.locator('#list').innerText(),/Historical blocking fault/);
    assert.equal(await page.locator('#photoActs button,#importRow button').count(),0);
    await tap(page.locator('#stageWrap img.base'));
    assert.equal(await page.locator('#nSave').count(),0);
    const closeButton=page.locator('#list .f').filter({hasText:'Historical open fault'}).getByRole('button',{name:'סגור',exact:true});
    assert.equal(await closeButton.count(),1);
    await tap(closeButton);
    await page.waitForFunction(()=>(window.__FIRESTORE_WRITES||[]).length===1);
    assert.equal(await page.evaluate(()=>window.__FIRESTORE_WRITES[0].path),'stations/eilat_102/faults/open-history');
  });
  for(const query of ['?v=missing','?v=']) {
    await scenario('explicit unknown/empty vehicle never substitutes another target '+query,'vehicle.html'+query,async page=>{
      assert.equal(await page.locator('#vehChips button.on').count(),0);
      assert.match(await page.locator('#stageWrap').innerText(),/לא הוצגה מפה של רכב אחר/);
      assert.equal(await page.locator('#stageWrap img,#photoActs button,#importRow button').count(),0);
      await page.locator('#baseGallery').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from(png.split(',')[1],'base64')});
      await noNewWrites(page);
    });
  }
  await scenario('no vehicle parameter defaults to active vehicle and new fault keeps its identity','vehicle.html',async page=>{
    assert.match(await page.locator('#vehChips button.on').innerText(),/Active test vehicle/);
    await tap(page.locator('#stageWrap img.base'));
    await page.locator('#nTitle').fill('Synthetic new fault');
    await tap(page.locator('#nSave'));
    await page.waitForFunction(()=>(window.__FIRESTORE_ADDS||[]).length===1);
    assert.equal(await page.evaluate(()=>window.__FIRESTORE_ADDS[0].value.vehicle_id),'live');
  });
  await scenario('stale new-fault dialog cannot follow selection to retired vehicle','vehicle.html?v=live',async page=>{
    await tap(page.locator('#stageWrap img.base'));
    await page.locator('#nTitle').fill('Must not be written');
    await select(page,'Retired test vehicle');
    await tap(page.locator('#nSave'));
    await page.waitForFunction(()=>document.getElementById('nMsg').textContent.includes('אינו פעיל'));
    await noNewWrites(page);
  });
  await scenario('image upload rechecks original target after image processing','vehicle.html?v=live',async page=>{
    await page.evaluate(()=>window.__HOLD_IMAGE=true);
    await tap(page.locator('#photoActs [data-photo-source="gallery"]'));
    await page.locator('#baseGallery').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from(png.split(',')[1],'base64')});
    await page.waitForFunction(()=>window.__IMAGE_PENDING);
    await select(page,'Retired test vehicle');
    await page.evaluate(()=>window.__RELEASE_IMAGE());
    await page.waitForFunction(()=>document.getElementById('baseMsg').textContent.includes('אינו פעיל'));
    await noNewWrites(page);
  });
  await scenario('picker origin cannot follow a vehicle change before file selection','vehicle.html?v=live',async page=>{
    await tap(page.locator('#photoActs [data-photo-source="gallery"]'));
    await select(page,'Retired test vehicle');
    await page.locator('#baseGallery').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from(png.split(',')[1],'base64')});
    await page.waitForFunction(()=>document.getElementById('baseMsg').textContent.includes('אינו פעיל'));
    await noNewWrites(page);
  });
  await scenario('unknown orphan remains read-only even through existing treatment callbacks','vehicle.html?v=missing',async page=>{
    assert.match(await page.locator('#list').innerText(),/Orphan historical fault/);
    assert.equal(await page.locator('#list .acts button,#list .acts select').count(),0);
    await page.evaluate(async()=>{
      const a=window.__HISTORY_ACTIONS;
      const f=window.__HISTORY_FIXTURE.faults.find(f=>f.id==='orphan-history');
      const target=a.captureFaultTarget(f);
      await a.grade(f,'blocking',{disabled:false},target);
      await a.closeFault(f,target);
      await a.wipe(f,target);
    });
    await noNewWrites(page);
  });
  await scenario('bundled image import rechecks original target after module await','vehicle.html?v=live',async page=>{
    await tap(page.locator('#importRow button'));
    await page.waitForFunction(()=>window.__BUNDLE_PENDING);
    await select(page,'Retired test vehicle');
    await page.evaluate(()=>window.__RELEASE_BUNDLE());
    await page.waitForFunction(()=>document.getElementById('impMsg').textContent.includes('אינו פעיל'));
    await noNewWrites(page);
  },false);
  console.log(passed+' fleet history browser checks passed (local fixtures, not emulator).');
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
