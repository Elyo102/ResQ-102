import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'hr-local-export.js'), 'utf8');
const { exportLocalFiles, localExportSha256, LOCAL_EXPORT_LIMITS } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const enc = new TextEncoder(); let passed = 0;
const missing = () => Object.assign(new Error('missing'), { name: 'NotFoundError' });
class Directory {
  constructor(hooks = {}) { this.children = new Map(); this.hooks = hooks; }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.children.has(name)) { if (!create) throw missing(); this.children.set(name, new Directory(this.hooks)); }
    const value = this.children.get(name); if (!(value instanceof Directory)) throw Error('TypeMismatchError'); return value;
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.children.has(name)) { if (!create) throw missing(); this.children.set(name, new File(this.hooks, name)); }
    const value = this.children.get(name); if (!(value instanceof File)) throw Error('TypeMismatchError'); return value;
  }
}
class File {
  constructor(hooks, name) { this.hooks = hooks; this.name = name; this.bytes = new Uint8Array(); }
  async createWritable() {
    let pending; const self = this;
    return { async write(bytes) { pending = bytes.slice(); self.hooks.write?.(self.name); }, async close() {
      if (self.hooks.failClose?.(self.name)) throw Error('disk full'); self.bytes = pending; self.hooks.closed?.(self.name);
    }, async abort() { pending = null; } };
  }
  async getFile() { const bytes = this.bytes.slice(); if (this.hooks.corrupt?.(this.name)) bytes[0] ^= 1;
    return { size: bytes.length, arrayBuffer: async () => bytes.buffer }; }
}
const flat = (dir, prefix = '') => [...dir.children].flatMap(([name, value]) => value instanceof Directory ? flat(value, prefix + name + '/') : [[prefix + name, value.bytes]]);
const file = (extra = {}) => ({ uid: 'user-1', employeeNumber: '101', fullName: 'שם זהה', kind: 'document', name: 'דוח.pdf', bytes: enc.encode('private bytes'), ...extra });
const options = { stationId: 'eilat_102', guard() {} };
async function check(name, test) { await test(); console.log('PASS ' + name); ++passed; }
await check('real SHA256 known vector', async () => assert.equal(await localExportSha256(enc.encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'));
await check('hierarchy, same names, duplicate filenames, verified manifest', async () => {
  const dir = new Directory(); const out = await exportLocalFiles(dir, [file(), file(), file({ uid:'user-2', employeeNumber:'102', kind:'hours', month:'2026-09' })], options);
  assert.equal(out.files.length, 3); const paths = flat(dir).map(([p]) => p);
  assert(paths.every(p => p.startsWith('תחנת אילת משאבי אנוש/run-')));
  assert(paths.some(p => p.includes('שם זהה [102]/דוחות שעות/2026-09/')));
  assert.equal(new Set(out.files.map(f => f.path)).size, 3);
  const manifest = JSON.parse(new TextDecoder().decode(flat(dir).find(([p]) => p.endsWith('/manifest.json'))[1]));
  assert.equal(manifest.complete, true); for (const f of manifest.files) assert.equal(await localExportSha256(flat(dir).find(([p]) => p.endsWith('/' + f.path))[1]), f.sha256);
});
await check('new run never overwrites previous run', async () => {
  const dir = new Directory(); await exportLocalFiles(dir, [file()], options); const prior = flat(dir).map(([p,b]) => [p, [...b]]);
  await exportLocalFiles(dir, [file()], options); for (const [p,b] of prior) assert.deepEqual([...flat(dir).find(([q]) => q === p)[1]], b);
});
await check('future station receives an isolated station-named root', async () => {
  const dir = new Directory(); const out=await exportLocalFiles(dir, [file()], { ...options, stationId:'north_103' });
  assert.equal(out.complete,true);assert(flat(dir).every(([p])=>p.startsWith('משאבי אנוש - north_103/run-')));
});
await check('blank or unsafe station rejected before any filesystem use', async () => {
  for(const stationId of ['', '../other']){const dir = new Directory(); await assert.rejects(exportLocalFiles(dir, [file()], { ...options, stationId })); assert.equal(dir.children.size, 0);}
});
await check('file and month bounds fail without completion manifest', async () => {
  for (const bad of [file({ bytes:new Uint8Array(LOCAL_EXPORT_LIMITS.fileBytes + 1) }), file({ kind:'hours', month:'2026-13' }), file({ employeeNumber:'../101' })]) {
    const dir = new Directory(); await assert.rejects(exportLocalFiles(dir, [bad], options)); assert(!flat(dir).some(([p]) => p.endsWith('/manifest.json')));
  }
});
await check('employee binding and sanitized-folder collision fail closed', async () => {
  for (const entries of [[file(), file({uid:'other'})], [file({employeeNumber:'a?'}), file({employeeNumber:'a*',uid:'other'})]]) {
    await assert.rejects(exportLocalFiles(new Directory(), entries, options));
  }
});
await check('path traversal and reserved basename cannot escape hierarchy', async () => {
  const out = await exportLocalFiles(new Directory(), [file({fullName:'../CON',name:'../../evil.pdf'})], options);
  assert(!out.files[0].path.split('/').includes('..')); assert(out.files[0].path.includes('[101]/מסמכים/'));
});
await check('identity cancellation aborts pending stream and stops next write', async () => {
  let live = true; const dir = new Directory({write(name) { if(name !== 'run.json') live = false; }});
  await assert.rejects(exportLocalFiles(dir, [file(),file()], { ...options, guard() { assert(live); } }));
  assert.equal(flat(dir).filter(([p,b]) => !p.endsWith('run.json') && b.length).length, 0);
});
await check('read-back corruption prevents completion', async () => {
  const dir = new Directory({corrupt:name=>name !== 'run.json'}); await assert.rejects(exportLocalFiles(dir, [file()], options)); assert(!flat(dir).some(([p])=>p.endsWith('/manifest.json')));
});
await check('close error retains explicit incomplete run marker', async () => {
  const dir = new Directory({failClose:name=>name !== 'run.json'}); await assert.rejects(exportLocalFiles(dir, [file()], options)); assert(flat(dir).some(([p])=>p.endsWith('/run.json')));
});
await check('bounded total bytes accepts64 then rejects65 2MiB files', async () => {
  const dir = new Directory(); let consumed = 0;
  async function* files() { for(let i=0;i<65;i++) { ++consumed; yield file({bytes:new Uint8Array(LOCAL_EXPORT_LIMITS.fileBytes)}); } }
  await assert.rejects(exportLocalFiles(dir, files(), options), e => e.completed === 64); assert.equal(consumed,65);
});
await check('bounded count rejects3001 even empty files', async () => {
  async function* files() { for(let i=0;i<3001;i++) yield file({bytes:new Uint8Array()}); }
  await assert.rejects(exportLocalFiles(new Directory(), files(), options), e => e.completed === 3000);
});

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.route('**/*', route => {
    const name = new URL(route.request().url()).pathname.slice(1);
    return route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : 'text/html', body: ['hr-local-export.js','hr-local-export-ui.js'].includes(name) ? fs.readFileSync(path.join(root,name),'utf8') : '<div id="root"></div><input id="month" value="2026-09">' });
  });
  await page.goto('http://localhost:41999/');
  await check('actual UI unsupported keeps ZIP fallback and has no storage', async () => {
    await page.evaluate(async () => { window.showDirectoryPicker = undefined; const {createLocalExportUI} = await import('/hr-local-export-ui.js'); window.ui = createLocalExportUI(document.querySelector('#root'), {currentSession:()=>({uid:'hr',stationId:'eilat_102',role:'hr_coordinator'}),subscribeIdentity:()=>()=>{}}, {monthElement:document.querySelector('#month')}); });
    assert.equal(await page.locator('#root button').first().isDisabled(),true); assert.match(await page.locator('#root').innerText(), /ZIP/);
    await page.evaluate(()=>window.ui.destroy());
  });
  await check('actual UI picker starts in gesture and held selection cancelled by identity', async () => {
    await page.evaluate(async () => {
      window.live=true; window.exports=0; window.picks=0;
      window.showDirectoryPicker=()=>{window.picks++;return new Promise(resolve=>window.resolvePicker=resolve);};
      const {createLocalExportUI}=await import('/hr-local-export-ui.js');
      window.ui=createLocalExportUI(document.querySelector('#root'),{currentSession:()=>window.live?{uid:'hr',stationId:'eilat_102',role:'hr_coordinator'}:null,subscribeIdentity:f=>(window.change=f,()=>{}),exportFiles:async()=>{window.exports++;return[];}},{monthElement:document.querySelector('#month')});
    });
    await page.locator('#root button').first().click(); assert.equal(await page.evaluate(()=>window.picks),1);
    await page.evaluate(()=>{window.live=false;window.change();window.resolvePicker({});});
    await page.waitForFunction(()=>document.querySelectorAll('#root button')[1].hidden);
    assert.equal(await page.evaluate(()=>window.exports),0); assert.equal(await page.locator('#root button').first().isDisabled(),true);
  });
  await check('actual UI pagehide suspends held picker until pageshow without replay', async () => {
    await page.evaluate(()=>{window.live=true;window.change();});
    await page.locator('#root button').first().click();
    await page.evaluate(()=>{window.dispatchEvent(new Event('pagehide'));window.resolvePicker({});});
    await page.waitForFunction(()=>document.querySelectorAll('#root button')[1].hidden);
    assert.equal(await page.evaluate(()=>window.exports),0);
    assert.equal(await page.locator('#root button').first().isDisabled(),true);
    await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));
    assert.equal(await page.locator('#root button').first().isDisabled(),false);
    assert.equal(await page.evaluate(()=>window.picks),2);
  });
  await check('actual UI and engine produce verified export after one explicit click', async () => {
    await page.evaluate(async () => {
      window.ui.destroy(); window.exportedFiles=[];
      const directory=()=>({ children:new Map(), async getDirectoryHandle(name,{create=false}={}) {
        if(!this.children.has(name)){if(!create)throw new DOMException('missing','NotFoundError');this.children.set(name,directory());}return this.children.get(name);
      }, async getFileHandle(name,{create=false}={}) {
        if(!this.children.has(name)){if(!create)throw new DOMException('missing','NotFoundError');let bytes=new Uint8Array();
          this.children.set(name,{async createWritable(){let pending;return{async write(b){pending=b.slice();},async close(){bytes=pending;window.exportedFiles.push(name);},async abort(){}};},async getFile(){return new Blob([bytes]);}});
        }return this.children.get(name);
      }});
      window.showDirectoryPicker=async()=>directory();
      const {createLocalExportUI}=await import('/hr-local-export-ui.js');
      window.ui=createLocalExportUI(document.querySelector('#root'),{currentSession:()=>({uid:'hr',stationId:'eilat_102',role:'hr_coordinator',epoch:1}),subscribeIdentity:()=>()=>{},exportFiles:async()=>[{uid:'u1',employeeNumber:'101',fullName:'בדיקה',name:'test.pdf',kind:'hours',month:'2026-09',bytes:new TextEncoder().encode('test')}]},{monthElement:document.querySelector('#month')});
    });
    await page.locator('#root button').first().click();
    await page.waitForFunction(()=>document.querySelector('[role="status"]').textContent.includes('הייצוא הושלם'));
    assert.equal(await page.evaluate(()=>window.exportedFiles.length),3);
    assert.equal(await page.evaluate(()=>window.exportedFiles.includes('manifest.json')),true);
    assert.equal(await page.evaluate(()=>localStorage.length + sessionStorage.length),0);
  });
} finally { await browser.close(); }
console.log(`hr-local-export: ${passed}/${passed} PASS (in-memory filesystem; actual browser UI; no native disk picker proof)`);
