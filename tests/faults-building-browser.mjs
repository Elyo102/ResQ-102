import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { FAULT_KINDS, bySubject, createPhotoQueue, faultKind, groupOf, kindHe,
  needsVehicle, reportedLine, reportDateKey, sortFaults } from '../faults.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json' };
const JPEG = 'data:image/jpeg;base64,/9j/2Q==';

assert.equal(kindHe('building'), 'תקלת בינוי ותחזוקה');
assert.equal(needsVehicle('building'), false);
assert.equal(needsVehicle('gear'), true);
assert.equal(groupOf('building'), 'fault');
assert.equal(faultKind('building'), FAULT_KINDS.find(row => row.id === 'building'));
assert.equal(read('functions/index.js').includes("building: 'תקלת בינוי ותחזוקה'"), true);
const queue = createPhotoQueue(3);
assert.equal(queue.add([{ name:'one' }, { name:'two' }]), true);
assert.equal(queue.add([{ name:'three' }]), true);
assert.equal(queue.add([{ name:'four' }]), false);
assert.equal(queue.list().length, 3);
assert.equal(queue.remove(1), true);
assert.deepEqual(queue.list().map(file => file.name), ['one','three']);
assert.equal(reportedLine({ by_name:'ישראל', created_key:'1999-01-01T00:00:00.000Z',
  created_at:{ toDate:() => new Date('2026-09-24T22:30:00.000Z') } }), 'ישראל · 25.9.2026 01:30');
assert.equal(reportDateKey({ created_at:{ seconds:Date.parse('2026-12-24T22:30:00Z') / 1000 } }), '2026-12-25');
const sorted = sortFaults([
  { id:'bad-client', status:'open', severity:'unset', created_key:'2099-01-01T00:00:00.000Z',
    created_at:{ toDate:() => new Date('2026-01-01T00:00:00Z') } },
  { id:'newer', status:'open', severity:'unset', created_key:'2000-01-01T00:00:00.000Z',
    created_at:{ toDate:() => new Date('2026-09-24T00:00:00Z') } }
]);
assert.equal(sorted[0].id, 'newer', 'server time overrides a manipulated client key');
assert.equal(bySubject([
  { id:'b', kind:'building', title:'דלת', status:'open', created_key:'2' },
  { id:'g', kind:'gear', title:'דלת', status:'open', created_key:'1' }
]).length, 2);

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

async function open(browser, role, emptyOtherHandovers = false) {
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL', serviceWorkers:'block' });
  await context.addInitScript(name => { window.__SMOKE_ROLE = name; }, role);
  await context.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    let body = fs.existsSync(path.join(root, 'tests', 'stub', name))
      ? read('tests/stub/' + name) : 'export default {};';
    if (name === 'firebase-auth.js') body = body.replace(/['"][^'"\s]+@[^'"\s]+['"]/g, "'fault-test@example.invalid'");
    if (name === 'firebase-firestore.js') {
      body = body.replace('const FAULTS = [', `const FAULTS = [
        ['building-open', { kind:'building', title:'נזילה בתקרת חדר האוכל', severity:'unset',
          status:'open', photos:0, by_uid:'u2', by_name:'טל', created_key:'2026-09-11T07:00:00.000Z' }],`);
      if (emptyOtherHandovers) body = body.replace(
        'return delayed(listSnap(HANDOVERS));',
        "return delayed(listSnap(p.includes('stations/other_station/') ? [] : HANDOVERS));");
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
  if (window.__FAULT_HOLD_IMAGE) {
    window.__FAULT_IMAGE_PENDING = true;
    return new Promise(resolve => { window.__FAULT_RELEASE_IMAGE = () => resolve({data:'${JPEG}',w:1,h:1}); });
  }
  if (window.__FAULT_SHRINK_FAIL) {
    window.__FAULT_SHRINK_FAIL = false;
    return Promise.reject(new Error('התמונה לא נקראה'));
  }
  return Promise.resolve({data:'${JPEG}',w:1,h:1});
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

const calls = page => page.evaluate(() => (window.__CALLABLE_CALLS || []).filter(row => row.name === 'createFaultReport'));
const tap = locator => locator.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles:true })));
const browser = await chromium.launch();
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('✓ ' + name); }
try {
  const ff = await open(browser, 'firefighter');
  const page = ff.page;
  await test('CTA לדיווח גלוי בנייד', async () => {
    const box = await page.locator('#jumpReport').boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 844);
  });
  await test('ציוד מחייב רכב; בינוי אינו מחייב', async () => {
    await page.locator('#nKind').selectOption('gear');
    assert.equal(await page.locator('#nVehWrap').isVisible(), true);
    await page.locator('#nKind').selectOption('building');
    assert.equal(await page.locator('#nVehWrap').isVisible(), false);
    assert.match(await page.locator('#nKindHelp').innerText(), /אין צורך לבחור רכב/);
  });
  await test('כותרת ארוכה מ־80 תווים זמינה בטופס', async () => {
    assert.equal(await page.locator('#nTitle').getAttribute('maxlength'), '240');
    await page.locator('#nTitle').fill('תקלה '.repeat(25));
    assert.ok((await page.locator('#nTitle').inputValue()).length > 80);
  });
  await test('שלושה צילומים מצטברים משתי בחירות, ולא רק האחרון', async () => {
    await page.locator('#nKind').selectOption('gear');
    await page.locator('#nVeh').selectOption('v1');
    await page.locator('#nShot').setInputFiles({ name:'first.png', mimeType:'image/png', buffer:png });
    await page.locator('#nShot').setInputFiles({ name:'second.png', mimeType:'image/png', buffer:png });
    await page.locator('#nGallery').setInputFiles({ name:'third.png', mimeType:'image/png', buffer:png });
    assert.match(await page.locator('#shotNote').innerText(), /3 מתוך 3/);
    assert.match(await page.locator('#shotList').innerText(), /first\.png.*second\.png.*third\.png/s);
    await page.locator('#nGallery').setInputFiles({ name:'fourth.png', mimeType:'image/png', buffer:png });
    assert.match(await page.locator('#shotNote').innerText(), /3 מתוך 3/);
  });
  await test('דיווח ציוד שולח רכב, כותרת וכל התמונות לשרת פעם אחת', async () => {
    await tap(page.locator('#btnNew'));
    await page.waitForFunction(() => (window.__CALLABLE_CALLS || []).some(row => row.name === 'createFaultReport'));
    const sent = (await calls(page))[0].payload;
    assert.equal(sent.kind, 'gear');
    assert.equal(sent.vehicleId, 'v1');
    assert.equal(sent.photos.length, 3);
    assert.ok(sent.title.length > 80);
    assert.ok(sent.reportId);
    assert.equal(sent.expectedUid, 'stub-uid');
    await page.waitForFunction(() => document.querySelector('#newMsg').textContent.includes('3 תמונות צורפו'));
    assert.equal(await page.locator('#shotList').innerText(), '');
  });
  await test('רשימת רכבים עם סימון בולט פותחת היסטוריה', async () => {
    const button = page.locator('#vehicleIssues button').filter({ hasText:'רכב אלמוג' });
    assert.match(await button.innerText(), /❗/);
    await tap(button);
    assert.match(await page.locator('#dlgTitle').innerText(), /רכב אלמוג.*כל התקלות/);
    assert.match(await page.locator('#dlgBody').innerText(), /נזילת|תקלה/);
    await tap(page.locator('#repX'));
  });
  await test('כשל ברזולוציית תמונה אינו יוצר דיווח חלקי', async () => {
    await page.evaluate(() => { window.__FAULT_SHRINK_FAIL = true; });
    await page.locator('#nKind').selectOption('building');
    await page.locator('#nTitle').fill('רטיבות בחדר ציוד');
    await page.locator('#nShot').setInputFiles({ name:'broken.png', mimeType:'image/png', buffer:png });
    const before = (await calls(page)).length;
    await tap(page.locator('#btnNew'));
    await page.waitForFunction(() => document.querySelector('#newMsg').textContent.includes('לא התקבל אישור'));
    assert.doesNotMatch(await page.locator('#newMsg').innerText(), /Firebase|Error|stack/i);
    assert.equal((await calls(page)).length, before);
  });
  await test('אובדן תשובה שומר את אותו reportId בניסיון חוזר', async () => {
    await page.evaluate(() => {
      window.__CALLABLE_PLAN = { createFaultReport:[
        { reject:true, code:'functions/unavailable', message:'lost response' },
        { data:{ created:false } }
      ] };
    });
    await page.locator('#nGallery').setInputFiles([]);
    await tap(page.locator('#shotList button').first());
    await page.locator('#nTitle').fill('ניסיון חוזר');
    const before = (await calls(page)).length;
    await tap(page.locator('#btnNew'));
    await page.waitForFunction(n => (window.__CALLABLE_CALLS || []).filter(r => r.name === 'createFaultReport').length === n,
      before + 1);
    await page.waitForFunction(() => document.querySelector('#newMsg').textContent.includes('לא התקבל אישור'));
    await tap(page.locator('#btnNew'));
    await page.waitForFunction(n => (window.__CALLABLE_CALLS || []).filter(r => r.name === 'createFaultReport').length === n,
      before + 2);
    const all = await calls(page);
    assert.equal(all.at(-2).payload.reportId, all.at(-1).payload.reportId);
  });
  await test('זהות שהתחלפה בעיבוד תמונה אינה שולחת דיווח בשם אחר', async () => {
    await page.evaluate(() => { window.__FAULT_HOLD_IMAGE = true; });
    await page.locator('#nKind').selectOption('building');
    await page.locator('#nTitle').fill('פעולה ישנה');
    await page.locator('#nShot').setInputFiles({ name:'race.png', mimeType:'image/png', buffer:png });
    const before = (await calls(page)).length;
    await tap(page.locator('#btnNew'));
    await page.waitForFunction(() => window.__FAULT_IMAGE_PENDING === true);
    await page.evaluate(() => window.__SMOKE_EMIT_AUTH('firefighter', 'other-user', {
      stationId:'other_station', shift:'B', email:'other@example.invalid'
    }));
    await page.evaluate(() => window.__FAULT_RELEASE_IMAGE());
    await page.waitForTimeout(150);
    assert.equal((await calls(page)).length, before);
  });
  assert.deepEqual(ff.errors, []);
  await ff.context.close();

  const commander = await open(browser, 'commander');
  await test('מפקד יכול לשלוח דרגת חומרה לבינוי בלי רכב', async () => {
    await commander.page.locator('#nKind').selectOption('building');
    await commander.page.locator('#nSev').selectOption('blocking');
    await commander.page.locator('#nTitle').fill('לוח חשמל נשרף');
    await tap(commander.page.locator('#btnNew'));
    await commander.page.waitForFunction(() => (window.__CALLABLE_CALLS || []).some(row => row.name === 'createFaultReport'));
    const sent = (await calls(commander.page))[0].payload;
    assert.equal(sent.severity, 'blocking');
    assert.equal(sent.vehicleId, '');
  });
  await test('מסירות אינן נקראות בכניסה למסך תקלות רגיל', async () => {
    const paths = await commander.page.evaluate(() => window.__DATA_PATHS || []);
    assert.equal(paths.filter(path => path.endsWith('/handovers')).length, 0);
  });
  await test('כשל בטעינת מסירות חוסם חתימה ומציע ניסיון חוזר', async () => {
    await commander.page.evaluate(() => { window.__SMOKE_FAIL_PATHS = ['/handovers']; });
    await tap(commander.page.locator('#tabShift'));
    await commander.page.locator('#hoState .msg.err').waitFor();
    assert.equal(await commander.page.locator('#hoAcceptWrap').isVisible(), false);
    const beforeWrites = await commander.page.evaluate(() => (window.__FIRESTORE_WRITES || []).length);
    await tap(commander.page.locator('#btnAccept'));
    assert.equal(await commander.page.evaluate(() => (window.__FIRESTORE_WRITES || []).length), beforeWrites);
    const paths = await commander.page.evaluate(() => window.__DATA_PATHS || []);
    assert.equal(paths.filter(path => path.endsWith('/handovers')).length, 1);
  });
  await test('ניסיון חוזר טוען מסירות פעם אחת; מעבר לשונית מהיר משתמש בתוצאה', async () => {
    await commander.page.evaluate(() => { window.__SMOKE_FAIL_PATHS = []; });
    await tap(commander.page.locator('#hoState button'));
    await commander.page.getByText('לוג מסירות').waitFor();
    const before = (await commander.page.evaluate(() => window.__DATA_PATHS || []))
      .filter(path => path.endsWith('/handovers')).length;
    assert.equal(before, 2);
    await tap(commander.page.locator('#tabOpen'));
    await tap(commander.page.locator('#tabShift'));
    const after = (await commander.page.evaluate(() => window.__DATA_PATHS || []))
      .filter(path => path.endsWith('/handovers')).length;
    assert.equal(after, before);
  });
  await test('כשל בכתיבת חתימה משאיר את ההערכה ומציג כשל', async () => {
    await commander.page.evaluate(() => {
      window.confirm = () => true;
      window.__FIRESTORE_WRITE_FAIL_PATHS = ['/handovers/'];
    });
    await commander.page.locator('#hoMsg').fill('הערכת מצב לבדיקה');
    await tap(commander.page.locator('#btnAccept'));
    await commander.page.locator('#hoSignMsg.err').waitFor();
    assert.equal(await commander.page.locator('#hoMsg').inputValue(), 'הערכת מצב לבדיקה');
  });
  await test('מסירה קודמת נלקחת מהקריאה הטרייה; אישור הצלחה דורש אימות חוזר', async () => {
    await commander.page.evaluate(() => { window.__FIRESTORE_WRITE_FAIL_PATHS = []; });
    const before = await commander.page.evaluate(() => (window.__FIRESTORE_WRITES || [])
      .filter(row => row.path.includes('/handovers/')).length);
    await tap(commander.page.locator('#btnAccept'));
    await commander.page.waitForFunction(n => (window.__FIRESTORE_WRITES || [])
      .filter(row => row.path.includes('/handovers/')).length === n + 1, before);
    const rows = await commander.page.evaluate(() => (window.__FIRESTORE_WRITES || [])
      .filter(row => row.path.includes('/handovers/')));
    assert.equal(rows.at(-1).value.from_uid, 'u2');
    assert.equal(rows.at(-1).value.from_name, 'טל חודרה');
    assert.equal(rows.at(-1).value.assessment, 'הערכת מצב לבדיקה');
    await commander.page.getByText('אין לחתום שוב לפני בדיקה').waitFor();
    assert.equal(await commander.page.locator('#hoMsg').inputValue(), 'הערכת מצב לבדיקה');
  });
  assert.deepEqual(commander.errors, []);
  await commander.context.close();

  const delayed = await open(browser, 'commander', true);
  await test('חתימה בזמן טעינה ומסירה מאוחרת מתחנה קודמת אינן נרשמות או מצוירות', async () => {
    const writesBefore = await delayed.page.evaluate(() => (window.__FIRESTORE_WRITES || [])
      .filter(row => row.path.includes('/handovers/')).length);
    await delayed.page.evaluate(() => { window.__SMOKE_LAG_PLAN = [220]; });
    await tap(delayed.page.locator('#tabShift'));
    await delayed.page.waitForFunction(() => (window.__DATA_PATHS || [])
      .some(path => path.endsWith('/handovers')));
    await tap(delayed.page.locator('#btnAccept'));
    assert.equal(await delayed.page.evaluate(() => (window.__FIRESTORE_WRITES || [])
      .filter(row => row.path.includes('/handovers/')).length), writesBefore);
    await delayed.page.evaluate(() => window.__SMOKE_EMIT_AUTH('commander', 'other-user', {
      stationId:'other_station', shift:'B', email:'other@example.invalid'
    }));
    await delayed.page.waitForTimeout(280);
    assert.equal(await delayed.page.getByText('לוג מסירות').count(), 0);
    assert.equal(await delayed.page.evaluate(() => (window.__FIRESTORE_WRITES || [])
      .filter(row => row.path.includes('/handovers/')).length), writesBefore);
  });
  assert.deepEqual(delayed.errors, []);
  await delayed.context.close();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
console.log('Faults browser: ' + passed + '/16 passed.');
