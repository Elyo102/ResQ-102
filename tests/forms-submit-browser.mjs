import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const original = fs.readFileSync(path.join(root, 'forms.html'), 'utf8');
const origin = 'http://127.0.0.1:42017';
const failures = [];
let passed = 0;

function submitBody(source) {
  const start = source.indexOf('async function submitForm(){');
  const end = source.indexOf('\n// ---------- כרטיס ----------', start);
  assert.ok(start >= 0 && end > start, 'submitForm source boundary is missing');
  return source.slice(start, end);
}

function auditSource(source) {
  const body = submitBody(source);
  const firstAwait = body.indexOf('await ');
  const latch = body.search(/if\s*\(\s*submitBusy\s*\)\s*return\s*;/);
  assert.ok(latch >= 0 && latch < firstAwait,
    'submitForm must reject a second entry with submitBusy before its first await');
  assert.match(body, /crypto\.randomUUID|crypto\.getRandomValues/,
    'request_id must come from a browser cryptographic generator');
  assert.match(body, /submitStationForm\(submissionIntent\)/,
    'submission and retry must transmit the frozen intent');
  assert.match(body, /getStationFormSubmissionStatus\(\{\s*request_id\s*:\s*submissionIntent\.request_id\s*\}\)/,
    'an uncertain response must reconcile the same request_id');
  assert.match(body, /status\s*===\s*['"]committed['"]/,
    'a committed reconcile result must be recognized');
  assert.doesNotMatch(body,
    /\b(?:localStorage|sessionStorage)\s*\.\s*(?:setItem|getItem|removeItem|clear|key)\s*\(/,
    'sensitive submission intent must remain in memory');
  assert.doesNotMatch(body, /\baddDoc\s*\(/,
    'form submission must not use random-id Firestore writes');
  assert.match(source, /if\s*\(!user\)\s*\{[\s\S]{0,180}submissionIntent\s*=\s*null/,
    'logout must clear the pending intent');
  assert.match(source, /submissionIdentity\s*&&\s*submissionIdentity\s*!==\s*nextIdentity\)\s*submissionIntent\s*=\s*null/,
    'identity change must clear the pending intent');
}

async function check(name, fn) {
  try { await fn(); ++passed; console.log('PASS ' + name); }
  catch (error) { failures.push(name + ': ' + error.message); console.error('FAIL ' + name + ': ' + error.message); }
}

async function fixture(source = original) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    const t = window.__formsTest = {
      calls: [], observers: [], submitMode: 'success', status: 'unobserved', held: [],
      user: null
    };
    t.makeUser = (uid = 'forms-user') => ({
      uid, email: uid + '@example.test',
      getIdTokenResult: async () => ({ claims: {
        role: 'firefighter', stationId: 'eilat_102', shift: 'C', emp: '1',
        auth_time: 1789257600
      } })
    });
    t.user = t.makeUser();
    t.auth = { currentUser: t.user };
    t.emit = async uid => {
      t.user = uid ? t.makeUser(uid) : null;
      t.auth.currentUser = t.user;
      await Promise.all(t.observers.map(fn => fn(t.user)));
    };
    t.transport = (name, payload) => {
      const copy = payload == null ? payload : structuredClone(payload);
      t.calls.push({ name, payload: copy, uid: t.auth.currentUser && t.auth.currentUser.uid });
      if (name === 'getStationFormSubmissionStatus') {
        return Promise.resolve({ data: { status: t.status } });
      }
      if (name !== 'submitStationForm') return Promise.resolve({ data: { ok: true } });
      if (t.submitMode === 'hold') return new Promise(resolve => t.held.push(() => resolve({ data: { status: 'committed' } })));
      if (t.submitMode === 'lost') return Promise.reject(Object.assign(new Error('response lost'), { code: 'functions/unavailable' }));
      return Promise.resolve({ data: { status: 'committed' } });
    };
    t.release = () => t.held.splice(0).forEach(fn => fn());
  });

  const firebase = {
    '/firebase-app.js': 'export function initializeApp(){return {};}',
    '/firebase-auth.js': 'export function getAuth(){return __formsTest.auth;} export function onAuthStateChanged(a,cb){__formsTest.observers.push(cb);queueMicrotask(()=>cb(a.currentUser));return ()=>{};}',
    '/monitored-functions.js': 'export function getFunctions(){return {};} export function httpsCallable(f,n){return p=>__formsTest.transport(n,p);}',
    '/appcheck.js': 'export async function initAppCheck(){}',
    '/callout.js': 'export function watchCallouts(){}',
    '/signature.js': `export async function loadSignature(){return {image:'data:image/png;base64,${'A'.repeat(160)}',full_name:'Form User',emp_number:'1'};} export async function saveSignature(){} export function attachPad(){return {clear(){},isEmpty(){return false},image(){return ''}};} export async function readImageFile(){return '';}`
  };
  const firestore = fs.readFileSync(path.join(root, 'tests/stub/firebase-firestore.js'), 'utf8');
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const key = url.hostname === 'www.gstatic.com' ? '/' + url.pathname.split('/').pop() : url.pathname;
    if (key === '/firebase-firestore.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: firestore });
    if (firebase[key]) return route.fulfill({ status: 200, contentType: 'text/javascript', body: firebase[key] });
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/forms.html') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: source });
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(7000);
  await page.goto(origin + '/forms.html');
  await page.locator('#work').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#sigHave') && !document.querySelector('#sigHave').classList.contains('hide'));
  return {
    page, errors,
    close: async () => { await context.close(); await browser.close(); assert.deepEqual(errors, []); }
  };
}

async function fillValid(page, suffix = '') {
  await page.locator('#fld_from').fill('2026-10-01');
  await page.locator('#fld_to').fill('2026-10-02');
  await page.locator('#fld_where').selectOption('באילת');
  await page.locator('#fld_phone').fill('0500000000' + suffix);
  await page.locator('#sigAgree').evaluate(element => {
    element.checked = true;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const submitCalls = page => page.evaluate(() => __formsTest.calls.filter(c => c.name === 'submitStationForm'));

await check('source contract has a pre-await latch, cryptographic id, reconcile, memory-only intent and no addDoc', () => auditSource(original));

await check('two same-tick handler entries create one in-flight submission', async () => {
  const f = await fixture();
  await fillValid(f.page);
  await f.page.evaluate(() => { __formsTest.submitMode = 'hold'; const h = document.querySelector('#btnSubmit').onclick; h(); h(); });
  await f.page.waitForTimeout(50);
  assert.equal((await submitCalls(f.page)).length, 1);
  await f.page.evaluate(() => __formsTest.release());
  await f.page.waitForFunction(() => !document.querySelector('#btnSubmit').disabled);
  await f.close();
});

await check('new intents use distinct cryptographic request ids', async () => {
  const f = await fixture();
  for (let i = 0; i < 2; ++i) {
    await fillValid(f.page, String(i));
    await f.page.locator('#btnSubmit').click();
    await f.page.waitForFunction(count => __formsTest.calls.filter(c => c.name === 'submitStationForm').length === count, i + 1);
    await f.page.waitForFunction(() => !document.querySelector('#btnSubmit').disabled);
  }
  const ids = (await submitCalls(f.page)).map(c => c.payload.request_id);
  assert.equal(new Set(ids).size, 2);
  ids.forEach(id => assert.match(id, /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{48})$/i));
  await f.close();
});

await check('unobserved response retries the exact frozen payload and request id', async () => {
  const f = await fixture();
  await fillValid(f.page);
  await f.page.evaluate(() => { __formsTest.submitMode = 'lost'; __formsTest.status = 'unobserved'; });
  await f.page.locator('#btnSubmit').click();
  await f.page.waitForFunction(() => __formsTest.calls.some(c => c.name === 'getStationFormSubmissionStatus'));
  const first = (await submitCalls(f.page))[0].payload;
  await f.page.locator('#fld_phone').fill('DIFFERENT');
  await f.page.evaluate(() => { __formsTest.submitMode = 'success'; });
  await f.page.locator('#btnSubmit').click();
  await f.page.waitForFunction(() => __formsTest.calls.filter(c => c.name === 'submitStationForm').length === 2);
  const second = (await submitCalls(f.page))[1].payload;
  assert.deepEqual(second, first);
  await f.close();
});

await check('committed reconcile completes without a duplicate submit', async () => {
  const f = await fixture();
  await fillValid(f.page);
  await f.page.evaluate(() => { __formsTest.submitMode = 'lost'; __formsTest.status = 'committed'; });
  await f.page.locator('#btnSubmit').click();
  await f.page.waitForFunction(() => __formsTest.calls.some(c => c.name === 'getStationFormSubmissionStatus') && !document.querySelector('#btnSubmit').disabled);
  assert.equal((await submitCalls(f.page)).length, 1);
  assert.equal(await f.page.evaluate(() => __formsTest.calls.filter(c => c.name === 'getStationFormSubmissionStatus').length), 1);
  await f.close();
});

await check('identity change discards an unobserved intent before the next submit', async () => {
  const f = await fixture();
  await fillValid(f.page);
  await f.page.evaluate(() => { __formsTest.submitMode = 'lost'; __formsTest.status = 'unobserved'; });
  await f.page.locator('#btnSubmit').click();
  await f.page.waitForFunction(() => __formsTest.calls.some(c => c.name === 'getStationFormSubmissionStatus'));
  const oldId = (await submitCalls(f.page))[0].payload.request_id;
  await f.page.evaluate(() => __formsTest.emit('other-user'));
  await fillValid(f.page, '9');
  await f.page.evaluate(() => { __formsTest.submitMode = 'success'; });
  await f.page.locator('#btnSubmit').click();
  await f.page.waitForFunction(() => __formsTest.calls.filter(c => c.name === 'submitStationForm').length === 2);
  const next = (await submitCalls(f.page))[1];
  assert.equal(next.uid, 'other-user');
  assert.notEqual(next.payload.request_id, oldId);
  await f.close();
});

await check('logout clears the intent and navigates away without another submit', async () => {
  const f = await fixture();
  await fillValid(f.page);
  await f.page.evaluate(() => { __formsTest.submitMode = 'lost'; __formsTest.status = 'unobserved'; });
  await f.page.locator('#btnSubmit').click();
  await f.page.waitForFunction(() => __formsTest.calls.some(c => c.name === 'getStationFormSubmissionStatus'));
  assert.equal((await submitCalls(f.page)).length, 1);
  await f.page.evaluate(() => __formsTest.emit(null));
  await f.page.waitForURL(/login\.html\?next=forms\.html/);
  await f.close();
});

await check('focused source mutations are all killed', () => {
  auditSource(original);
  const mutations = [
    ['remove latch', s => s.replace(/if\s*\(\s*submitBusy\s*\)\s*return\s*;/, '')],
    ['non-crypto id', s => s.replace(/globalThis\.crypto && typeof globalThis\.crypto\.randomUUID[\s\S]*?\.join\(''\);/, "'fixed-request-id-0001';")],
    ['rebuild retry payload', s => s.replace('submitStationForm(submissionIntent)', 'submitStationForm({ request_id: submissionIntent.request_id })')],
    ['skip reconcile', s => s.replace('getStationFormSubmissionStatus({ request_id:submissionIntent.request_id })', 'Promise.resolve({data:{status:"unobserved"}})')],
    ['persist sensitive intent', s => s.replace('submissionIntent = Object.freeze({', 'localStorage.setItem("pending", JSON.stringify(values));\n    submissionIntent = Object.freeze({')],
    ['direct random write', s => s.replace('await submitStationForm(submissionIntent);', 'await addDoc(collection(db,"submissions"), submissionIntent);')],
    ['keep intent across identity', s => s.replace(/if \(submissionIdentity && submissionIdentity !== nextIdentity\) submissionIntent = null;/, '')]
  ];
  for (const [name, mutate] of mutations) {
    const mutant = mutate(original);
    assert.notEqual(mutant, original, name + ' did not apply');
    assert.throws(() => auditSource(mutant), undefined, name + ' survived');
  }
});

if (failures.length) {
  console.error(`\n${passed} passed, ${failures.length} failed`);
  failures.forEach(failure => console.error('BLOCK ' + failure));
  process.exitCode = 1;
} else {
  console.log(`\n${passed} passed; 7/7 focused mutations caught`);
}
