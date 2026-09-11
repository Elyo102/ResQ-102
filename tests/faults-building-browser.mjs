import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { FAULT_KINDS, bySubject, faultKind, groupOf, kindHe, needsVehicle } from '../faults.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(root, 'tests', 'stub');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json' };

assert.equal(kindHe('building'), 'תקלת בינוי ותחזוקה');
assert.equal(needsVehicle('building'), false);
assert.equal(groupOf('building'), 'fault');
assert.equal(faultKind('building'), FAULT_KINDS.find(row => row.id === 'building'));
assert.equal(read('functions/index.js').includes("building: 'תקלת בינוי ותחזוקה'"), true,
  'מפת ההתראות של השרת משתמשת באותה תווית');
for (const file of ['faults.js', 'faults.html', 'functions/index.js']) {
  assert.equal(read(file).includes('תקלת מבנה'), false, file + ': אין תווית ישנה למשתמש');
}

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404); response.end('not found'); return;
  }
  response.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'application/octet-stream' });
  response.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;

async function open(browser, role) {
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL', serviceWorkers:'block' });
  await context.addInitScript(roleName => { window.__SMOKE_ROLE = roleName; }, role);
  await context.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    let body = fs.existsSync(path.join(stub, name)) ? read('tests/stub/' + name) : 'export default {};';
    if (name === 'firebase-auth.js') body = body.replace(/['"][^'"\s]+@[^'"\s]+['"]/g, "'fault-test@example.invalid'");
    if (name === 'firebase-firestore.js') {
      const anchor = 'const FAULTS = [';
      assert.equal(body.split(anchor).length - 1, 1);
      body = body.replace(anchor, anchor + `
        ['building-open', { kind:'building', vehicle_id:'', vehicle_name:'', title:'נזילה בתקרת חדר האוכל',
          desc:'טפטוף ליד גוף התאורה', severity:'unset', status:'open', photos:0,
          by_uid:'u2', by_name:'טל חודרה', crew:'A', date:'2026-09-11', created_key:'2026-09-11T07:00:00.000Z' }],
        ['building-fixed', { kind:'building', vehicle_id:'', vehicle_name:'', title:'דלת מחסן אינה נסגרת',
          desc:'תוקן הציר', severity:'minor', status:'fixed', photos:0,
          by_uid:'u2', by_name:'טל חודרה', crew:'A', date:'2026-09-10', created_key:'2026-09-10T07:00:00.000Z' }],`);
      const oldBatch = /export function writeBatch\(\)\{\r?\n  return \{ set\(\)\{\}, delete\(\)\{\}, commit\(\)\{ return Promise\.resolve\(\); \} \};\r?\n\}/;
      assert.equal(oldBatch.test(body), true, 'writeBatch stub shape');
      body = body.replace(oldBatch, `export function writeBatch(){
  const sets = [];
  return {
    set(ref, value){ assertWritable(value, false, ''); sets.push({ ref, value }); },
    delete(){},
    async commit(){
      window.__FAULT_BATCH_ATTEMPTS = window.__FAULT_BATCH_ATTEMPTS || [];
      const parent = sets[0] && sets[0].ref;
      const parentPath = parent ? parent.path + '/' + parent.id : '';
      const materialized = sets.map(function (row, index) {
        return { id:row.ref.id, path:index ? parentPath + '/photos/' + row.ref.id : parentPath,
                 value:row.value };
      });
      window.__FAULT_BATCH_ATTEMPTS.push(materialized);
      if (window.__FAULT_BATCH_HOLD) {
        await new Promise(function (resolve) { window.__FAULT_RELEASE_BATCH = resolve; });
      }
      if (window.__FAULT_BATCH_FAIL_BEFORE) {
        window.__FAULT_BATCH_FAIL_BEFORE = false;
        throw Object.assign(new Error('stub batch failed before commit'), { code:'unavailable' });
      }
      window.__FAULT_BATCH_COMMITS = window.__FAULT_BATCH_COMMITS || [];
      window.__FAULT_BATCH_COMMITS.push(materialized);
      if (window.__FAULT_BATCH_FAIL_AFTER) {
        window.__FAULT_BATCH_FAIL_AFTER = false;
        throw Object.assign(new Error('stub response lost after commit'), { code:'unavailable' });
      }
    }
  };
}`);
      const txAnchor = 'export async function runTransaction(dbRef, updateFunction){';
      assert.equal(body.split(txAnchor).length - 1, 1, 'runTransaction stub shape');
      body = body.replace(txAnchor, 'async function originalRunTransaction(dbRef, updateFunction){');
      body += `
export async function runTransaction(dbRef, updateFunction){
  const sets = [];
  const docs = window.__FAULT_TX_DOCS = window.__FAULT_TX_DOCS || {};
  let parentPath = '';
  const tx = {
    async get(ref){
      parentPath = ref.path + '/' + ref.id;
      const value = docs[parentPath];
      return { exists:function(){ return value !== undefined; }, data:function(){ return value; }, id:ref.id };
    },
    set(ref, value){ assertWritable(value, false, ''); sets.push({ ref:ref, value:value }); return tx; },
    update(ref, value){ return tx.set(ref, value); }
  };
  await updateFunction(tx);
  const materialized = sets.map(function (row, index) {
    return { id:row.ref.id,
      path:index ? parentPath + '/photos/' + row.ref.id : parentPath,
      value:row.value };
  });
  window.__FAULT_TX_ATTEMPTS = window.__FAULT_TX_ATTEMPTS || [];
  window.__FAULT_TX_ATTEMPTS.push(materialized);
  if (window.__FAULT_TX_HOLD) {
    await new Promise(function (resolve) { window.__FAULT_TX_RELEASE = resolve; });
  }
  if (window.__FAULT_TX_FAIL_BEFORE) {
    window.__FAULT_TX_FAIL_BEFORE = false;
    throw Object.assign(new Error('stub transaction failed before commit'), { code:'unavailable' });
  }
  materialized.forEach(function (row) { docs[row.path] = Object.assign({}, row.value); });
  window.__FAULT_TX_COMMITS = window.__FAULT_TX_COMMITS || [];
  window.__FAULT_TX_COMMITS.push(materialized);
  if (window.__FAULT_TX_FAIL_AFTER) {
    window.__FAULT_TX_FAIL_AFTER = false;
    throw Object.assign(new Error('stub response lost after commit'), { code:'unavailable' });
  }
}`;
    }
    route.fulfill({ status:200, contentType:'text/javascript', body });
  });
  await context.route(origin + '/faults.js*', route => {
    let body = read('faults.js');
    const anchor = 'export function shrinkImage(file, maxEdge, maxBytes) {';
    assert.equal(body.split(anchor).length - 1, 1);
    body = body.replace(anchor, 'function originalShrinkImage(file, maxEdge, maxBytes) {');
    body += `
export function shrinkImage() {
  if (window.__FAULT_SHRINK_FAIL) {
    window.__FAULT_SHRINK_FAIL = false;
    return Promise.reject(new Error('stub image decode failure'));
  }
  if (window.__FAULT_HOLD_IMAGE) {
    window.__FAULT_IMAGE_PENDING = true;
    return new Promise(function (resolve) {
      window.__FAULT_RELEASE_IMAGE = function () {
        resolve({ data:'data:image/png;base64,AA==', w:1, h:1, bytes:2 });
      };
    });
  }
  return Promise.resolve({ data:'data:image/png;base64,AA==', w:1, h:1, bytes:2 });
}`;
    route.fulfill({ status:200, contentType:'text/javascript', body });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/faults.html', { waitUntil:'load' });
  await page.locator('#work:not(.hide)').waitFor();
  return { context, page, errors };
}

const tap = locator => locator.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles:true })));
const browser = await chromium.launch();
let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log('✓ ' + name); }

try {
  const ff = await open(browser, 'firefighter');
  const page = ff.page;

  await test('CTA לדיווח גלוי מיד בנייד גם כשהרשימה ארוכה', async () => {
    const box = await page.locator('#jumpReport').boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 844, JSON.stringify(box));
    await tap(page.locator('#jumpReport'));
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'nKind');
    await page.waitForFunction(() => {
      const box = document.querySelector('#reportCard').getBoundingClientRect();
      return box.top < innerHeight && box.bottom > 0;
    });
  });

  await test('מעבר רכב → בינוי ותחזוקה → רכב מסתיר ומחזיר את שדה הרכב', async () => {
    await page.locator('#nKind').selectOption('vehicle');
    assert.equal(await page.locator('#nVehWrap').isVisible(), true);
    await page.locator('#nKind').selectOption('building');
    assert.equal(await page.locator('#nVehWrap').isVisible(), false);
    assert.match(await page.locator('#nTitle').getAttribute('placeholder'), /נזילה.*חשמל.*מיזוג/);
    assert.match(await page.locator('#nKindHelp').innerText(), /אין צורך לבחור רכב/);
    await page.locator('#nKind').selectOption('vehicle');
    assert.equal(await page.locator('#nVehWrap').isVisible(), true);
  });

  await test('כבאי שולח תקלת בינוי ותמונה באותה אצווה וללא זהות רכב', async () => {
    await page.locator('#nKind').selectOption('building');
    await page.locator('#nTitle').fill('שקע חשמל שבור במטבח');
    await page.locator('#nDesc').fill('השקע רופף ונדרש טיפול');
    await page.locator('#nShot').setInputFiles({ name:'evidence.png', mimeType:'image/png', buffer:png });
    await tap(page.locator('#btnNew'));
    await page.waitForFunction(() => (window.__FAULT_TX_COMMITS || []).length === 1);
    const result = await page.evaluate(() => window.__FAULT_TX_COMMITS[0]);
    assert.equal(result.length, 2, 'מסמך התקלה והתמונה מתחייבים יחד');
    assert.match(result[0].path, /^stations\/eilat_102\/faults\/gen\d+$/);
    assert.equal(result[0].value.kind, 'building');
    assert.equal(result[0].value.vehicle_id, '');
    assert.equal(result[0].value.vehicle_name, '');
    assert.equal(result[0].value.severity, 'unset', 'כבאי אינו מדרג חומרה');
    assert.equal(result[0].value.photos, 1);
    assert.match(result[1].path, /\/photos\/p0$/);
    assert.equal((await page.locator('#newMsg').innerText()).includes('התקלה נפתחה'), true);
  });

  await test('רשומת בינוי מופיעה בפתוחות, בחפיפה ובהיסטוריה בשם האחיד', async () => {
    assert.match(await page.locator('#openList').innerText(), /תקלת בינוי ותחזוקה/);
    await tap(page.locator('#tabShift'));
    assert.match(await page.locator('#viewShift').innerText(), /תקלות ציוד, בינוי ותחזוקה/);
    assert.match(await page.locator('#hoGear').innerText(), /נזילה בתקרת חדר האוכל/);
    await tap(page.locator('#tabHist'));
    assert.match(await page.locator('#histList').innerText(), /תקלת בינוי ותחזוקה/);
    assert.match(await page.locator('#histList').innerText(), /דלת מחסן אינה נסגרת/);
  });

  await test('סינון לפי רכב מסתיר בינוי ומצב כל התקלות מחזיר אותו', async () => {
    await tap(page.locator('#tabOpen'));
    await page.locator('#fFilter').selectOption('v1');
    assert.doesNotMatch(await page.locator('#openList').innerText(), /נזילה בתקרת חדר האוכל/);
    await page.locator('#fFilter').selectOption('');
    assert.match(await page.locator('#openList').innerText(), /נזילה בתקרת חדר האוכל/);
  });

  await test('כותרת זהה בציוד ובבינוי נשארת שני נושאים נפרדים', async () => {
    const rows = bySubject([
      { id:'b', kind:'building', title:'דלת שבורה', status:'open', created_key:'2' },
      { id:'g', kind:'gear', title:'דלת שבורה', status:'open', created_key:'1' }
    ]);
    assert.equal(rows.length, 2);
  });

  await test('החלפת משתמש בזמן עיבוד תמונה מבטלת את הדיווח הישן', async () => {
    await page.evaluate(() => { window.__FAULT_HOLD_IMAGE = true; });
    await page.locator('#nKind').selectOption('building');
    await page.locator('#nTitle').fill('צינור שהתפוצץ');
    await page.locator('#nShot').setInputFiles({ name:'race.png', mimeType:'image/png', buffer:png });
    await tap(page.locator('#btnNew'));
    await page.waitForFunction(() => window.__FAULT_IMAGE_PENDING === true);
    await page.evaluate(() => window.__SMOKE_EMIT_AUTH('firefighter', 'other-user', {
      stationId:'other_station', shift:'B', email:'other@example.invalid'
    }));
    await page.evaluate(() => window.__FAULT_RELEASE_IMAGE());
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => (window.__FAULT_TX_ATTEMPTS || []).length), 1,
      'לא יצאה עסקה נוספת אחרי החלפת הזהות');
    assert.equal(await page.locator('#nTitle').inputValue(), '', 'תוכן הטופס הישן נוקה');
  });

  await test('פעולה ישנה אינה מוחקת אסימון retry של משתמש חדש', async () => {
    await page.evaluate(() => { window.__FAULT_TX_HOLD = true; });
    await page.locator('#nKind').selectOption('building');
    await page.locator('#nTitle').fill('פעולה ישנה בהמתנה');
    await tap(page.locator('#btnNew'));
    await page.waitForFunction(() => (window.__FAULT_TX_ATTEMPTS || []).length === 2);

    await page.evaluate(() => window.__SMOKE_EMIT_AUTH('firefighter', 'third-user', {
      stationId:'third_station', shift:'C', email:'third@example.invalid'
    }));
    await page.locator('#work:not(.hide)').waitFor();
    await page.evaluate(() => {
      window.__FAULT_TX_HOLD = false;
      window.__FAULT_TX_FAIL_AFTER = true;
    });
    await page.locator('#nKind').selectOption('building');
    await page.locator('#nTitle').fill('פעולה חדשה עם תשובה שאבדה');
    await tap(page.locator('#btnNew'));
    await page.waitForFunction(() => (window.__FAULT_TX_COMMITS || []).length === 2);

    await page.evaluate(() => window.__FAULT_TX_RELEASE());
    await page.waitForFunction(() => (window.__FAULT_TX_COMMITS || []).length === 3);
    await tap(page.locator('#btnNew'));
    await page.waitForFunction(() => (window.__FAULT_TX_COMMITS || []).length === 4);
    const retry = await page.evaluate(() => window.__FAULT_TX_COMMITS[3]);
    assert.deepEqual(retry, [], 'retry זיהה את המסמך הקיים ולא כתב עליו שוב');
  });
  assert.deepEqual(ff.errors, []);
  await ff.context.close();

  const commander = await open(browser, 'commander');
  await test('סגל רואה חומרה בניסוח הכולל מקום ומבנה', async () => {
    await commander.page.locator('#nKind').selectOption('building');
    assert.equal(await commander.page.locator('#sevWrap').isVisible(), true);
    await commander.page.locator('#nSev').selectOption('blocking');
    assert.match(await commander.page.locator('#sevNote').innerText(), /המקום.*בטוחים|המקום.*כשירים/);
  });
  await test('סגל שולח חומרה משביתה בבינוי בלי רכב', async () => {
    await commander.page.locator('#nKind').selectOption('building');
    await commander.page.locator('#nSev').selectOption('blocking');
    await commander.page.locator('#nTitle').fill('לוח חשמל נשרף');
    await tap(commander.page.locator('#btnNew'));
    await commander.page.waitForFunction(() => (window.__FAULT_TX_COMMITS || []).length === 1);
    const parent = await commander.page.evaluate(() => window.__FAULT_TX_COMMITS[0][0].value);
    assert.equal(parent.severity, 'blocking');
    assert.equal(parent.vehicle_id, '');
  });

  await test('אובדן תשובה אחרי commit וניסיון חוזר משתמשים באותו מזהה', async () => {
    await commander.page.evaluate(() => { window.__FAULT_TX_FAIL_AFTER = true; });
    await commander.page.locator('#nKind').selectOption('building');
    await commander.page.locator('#nTitle').fill('תקלה חוזרת במזגן');
    await tap(commander.page.locator('#btnNew'));
    await commander.page.waitForFunction(() => (window.__FAULT_TX_COMMITS || []).length === 2);
    assert.match(await commander.page.locator('#newMsg').innerText(), /לא התקבל אישור/);
    await commander.page.evaluate(() => {
      const committed = window.__FAULT_TX_COMMITS[1][0];
      window.__FAULT_TX_DOCS[committed.path] = Object.assign({}, committed.value,
        { status:'fixed', severity:'minor', fix_note:'טופל לפני ניסיון חוזר' });
    });
    await tap(commander.page.locator('#btnNew'));
    await commander.page.waitForFunction(() => (window.__FAULT_TX_COMMITS || []).length === 3);
    const retry = await commander.page.evaluate(() => ({
      first:window.__FAULT_TX_COMMITS[1][0],
      second:window.__FAULT_TX_COMMITS[2],
      stored:Object.values(window.__FAULT_TX_DOCS).find(x => x.fix_note === 'טופל לפני ניסיון חוזר')
    }));
    assert.equal(retry.second.length, 0, 'מסמך קיים אינו נכתב מחדש');
    assert.equal(retry.stored.status, 'fixed');
    assert.equal(retry.stored.severity, 'minor');
  });
  await test('כשל בעיבוד צילום אינו מעלים את התקלה ומוצג למשתמש', async () => {
    await commander.page.evaluate(() => { window.__FAULT_SHRINK_FAIL = true; });
    await commander.page.locator('#nKind').selectOption('building');
    await commander.page.locator('#nTitle').fill('רטיבות בחדר ציוד');
    await commander.page.locator('#nShot').setInputFiles({ name:'broken.png', mimeType:'image/png', buffer:png });
    await tap(commander.page.locator('#btnNew'));
    await commander.page.waitForFunction(() => (window.__FAULT_TX_COMMITS || []).length === 4);
    const parent = await commander.page.evaluate(() => window.__FAULT_TX_COMMITS[3][0].value);
    assert.equal(parent.photos, 0);
    assert.match(await commander.page.locator('#newMsg').innerText(), /לא נשמרו.*broken\.png/);
  });
  assert.deepEqual(commander.errors, []);
  await commander.context.close();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log('Faults building and maintenance: ' + passed + '/12 passed.');
