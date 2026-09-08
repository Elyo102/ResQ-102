import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:41993';
const productFiles = ['hr.html', 'hr-client.js', 'hr-hours-ui.js', 'functions/index.js'];
const sourceHashes = () => Object.fromEntries(productFiles.map(file => [file,
  createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const before = sourceHashes();
let passed = 0;
async function check(name, run) { await run(); ++passed; console.log('PASS ' + name); }

// Evaluate the actual, bounded export block without initializing any server SDK.
const index = fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8');
const registration = index.match(/const hrHours = hrHoursModule\.createHrHoursService\([\s\S]*?exports\.getHrEmployeeReport = [^\n]+;/)?.[0];
assert.ok(registration, 'actual HR service/export registration block exists');
const db = {}, HttpsError = class {}, exports = {}, registered = [], received = [];
vm.runInNewContext(registration, { db, HttpsError, exports,
  hrHoursModule: { createHrHoursService(deps) {
    assert.deepEqual(Object.keys(deps).sort(), ['HttpsError', 'db']);
    assert.equal(deps.db, db); assert.equal(deps.HttpsError, HttpsError);
    received.push(deps);
    return { listMonth: req => ({ method: 'list', req }), getEmployeeMonth: req => ({ method: 'detail', req }) };
  } },
  onCall(options, handler) { registered.push(options); return handler; }
});
await check('actual export block creates one service with only db and HttpsError', async () => {
  assert.equal(received.length, 1);
});
await check('both actual read-only callables enforce AppCheck and forward original request', async () => {
  assert.equal(registered.length, 2);
  registered.forEach(options => { assert.deepEqual(Object.keys(options), ['enforceAppCheck']); assert.equal(options.enforceAppCheck, true); });
  const request = { auth: { uid: 'synthetic-reviewer' }, data: { month: '2026-09' } };
  const list = await exports.getHrMonthReports(request), detail = await exports.getHrEmployeeReport(request);
  assert.equal(list.method, 'list'); assert.equal(detail.method, 'detail');
  assert.equal(list.req, request); assert.equal(detail.req, request);
});

const browser = await chromium.launch();
const contexts = new Set();
const hrClaims = { role: 'hr_coordinator', stationId: 'fixture_station' };
async function fixture(options = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' }); contexts.add(context);
  await context.addInitScript(config => {
    const h = window.__HR = { calls: [], heldCalls: [], heldClaims: [], events: [], observers: [], errors: [],
      claimStarted: 0, claimSettled: 0, observerSettled: 0, appCheckReady: false, holdNext: null, rejectNext: null };
    h.makeUser = (uid, claims, hold = false) => ({ uid, claims, hold,
      getIdTokenResult() {
        ++h.claimStarted;
        const result = { claims: structuredClone(this.claims) };
        if (this.hold) return new Promise((resolve, reject) => h.heldClaims.push({ uid,
          resolve() { ++h.claimSettled; resolve(result); }, reject() { ++h.claimSettled; reject(new Error('synthetic claims failure')); } }));
        ++h.claimSettled; return Promise.resolve(result);
      }
    });
    h.auth = { currentUser: config.loggedOut ? null : h.makeUser('actor-a', config.claims, config.holdClaims) };
    h.dispatch = candidate => {
      h.auth.currentUser = candidate;
      for (const listener of h.observers) Promise.resolve(listener(candidate)).then(() => ++h.observerSettled);
    };
    h.implicit = () => ({ uid: h.auth.currentUser?.uid, stationId: h.auth.currentUser?.claims?.stationId });
    h.transport = async (name, data) => {
      const identity = h.implicit();
      h.calls.push({ name, data: structuredClone(data), identity, appCheckReady: h.appCheckReady });
      const person = { uid: 'employee-' + identity.uid, full_name: 'Synthetic ' + identity.uid + ' ' + identity.stationId, state: 'draft', historical: false, reminder_eligible: true };
      h.nudgeActions ||= [];
      const action = () => ({action_id:'a'.repeat(64),station_id:identity.stationId,month:data.month,audience:data.uid?'person':'station',status:'completed',reason:null,
        counts:{scanned:1,queued:1,suppressed:0,skipped:0,invalid:0},created_at_ms:1800000000000,expires_at_ms:1800003600000,not_before_ms:null,
        phase:data.uid?'person':'complete',discovery_scanned:0,delivery_status:'intent_only',audience_semantics:data.uid?'active_when_requested':'active_when_enqueue_page_scanned_with_completed_discovery_uid_upper_bound'});
      let value;
      if(name==='getHrMonthReports')value={month:data.month,items:[person],next_cursor:null};
      else if(name==='getHrEmployeeReport')value={...person,uid:data.uid,month:data.month,employee_number:'1001',rows:[],warnings:[],stored_total_hours:24,current_detail_total_hours:24};
      else if(name==='requestHrHoursNudge'){
        let record=h.nudgeActions.find(r=>r.request_id===data.request_id);
        if(!record){record={...action(),recipient_uid:data.uid||null,updated_at_ms:1800000000000,status_scope:'generation_only',actor:identity.uid,request_id:data.request_id};h.nudgeActions.push(record);}
        // Producer result intentionally lacks the richer read-only status fields.
        value=Object.fromEntries(Object.entries(record).filter(([key])=>!['recipient_uid','updated_at_ms','status_scope','actor','request_id'].includes(key)));
      }else if(name==='listHrHoursNudges')value={month:data.month,items:h.nudgeActions.filter(r=>r.actor===identity.uid&&r.station_id===identity.stationId&&r.month===data.month),next_cursor:null};
      else if(name==='getHrHoursNudgeStatus')value={action:h.nudgeActions.find(r=>r.action_id===data.action_id&&r.actor===identity.uid&&r.station_id===identity.stationId),items:[],next_cursor:null,outcomes_scope:'this_page_only'};
      else throw new Error('Unexpected callable '+name);
      const result={data:value};
      if (h.holdNext === name) {
        h.holdNext = null;
        return new Promise((resolve, reject) => h.heldCalls.push({ name, identity,
          resolve: () => resolve(result), reject: code => reject(Object.assign(new Error('synthetic access denial'), { code })) }));
      }
      if (h.rejectNext?.name === name) {
        const code = h.rejectNext.code; h.rejectNext = null;
        throw Object.assign(new Error('synthetic access denial'), { code });
      }
      return result;
    };
    h.initAppCheck = () => {
      h.events.push('appcheck-enter');
      const ready = () => { h.appCheckReady = true; h.events.push('appcheck-ready'); };
      if (config.holdAppCheck) return new Promise(resolve => { h.releaseAppCheck = () => { ready(); resolve(); }; });
      ready(); return Promise.resolve();
    };
  }, { claims: options.claims ?? hrClaims, ...options });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const modules = {
      '/firebase-config.js': 'export const firebaseConfig={projectId:"demo-hr-browser"};',
      '/appcheck.js': 'export function initAppCheck(){return window.__HR.initAppCheck();}',
      '/monitored-functions.js': 'export function getFunctions(app,region){window.__HR.region=region;return {};}; export function httpsCallable(f,name){return data=>window.__HR.transport(name,data);}'
    };
    if (url.hostname === 'www.gstatic.com') {
      if (url.pathname.endsWith('/firebase-app.js')) return route.fulfill({ contentType: 'text/javascript', body: 'export function initializeApp(config){return {config};}' });
      if (url.pathname.endsWith('/firebase-auth.js')) return route.fulfill({ contentType: 'text/javascript', body:
        'export function getAuth(){return window.__HR.auth;} export function onIdTokenChanged(auth,next,error){const h=window.__HR;h.observers.push(next);h.errors.push(error);h.events.push("auth-observer");queueMicrotask(()=>h.dispatch(auth.currentUser));return()=>{};}' });
    }
    if (url.origin !== origin) return route.abort();
    if (modules[url.pathname]) return route.fulfill({ contentType: 'text/javascript', body: modules[url.pathname] });
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
  });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/hr.html', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__HR?.events.includes('appcheck-enter'));
  if (!options.holdAppCheck && !options.holdClaims) await page.waitForFunction(() => __HR.observerSettled > 0);
  return { page, errors, async close() { assert.deepEqual(errors, []); await context.close(); contexts.delete(context); } };
}
async function person(page, uid = 'actor-a') { await page.locator('[data-uid="employee-' + uid + '"]').waitFor(); }
async function openDetail(page, uid = 'actor-a') {
  await person(page, uid); await page.locator('[data-uid="employee-' + uid + '"]').click();
  await page.locator('[data-hr="detail"] h2').waitFor();
}
async function drained(page) { await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0))); }
async function privateEmpty(page) {
  assert.equal(await page.locator('.hr-person').count(), 0);
  assert.equal(await page.locator('[data-hr="detail"] h2').count(), 0);
  assert.equal(await page.locator('[data-hr="refresh"]').isDisabled(), true);
}
try {
  await check('real bootstrap awaits AppCheck before auth registration and any call', async () => {
    const f = await fixture({ holdAppCheck: true });
    assert.deepEqual(await f.page.evaluate(() => [__HR.observers.length, __HR.calls.length]), [0, 0]);
    assert.equal(await f.page.locator('.hr-person').count(), 0);
    await f.page.evaluate(() => __HR.releaseAppCheck()); await person(f.page);
    assert.equal(await f.page.evaluate(() => __HR.calls.every(c => c.appCheckReady)), true); await f.close();
  });
  await check('HR list/detail use SDK region and implicit token station, never station data', async () => {
    const f = await fixture(); await openDetail(f.page);
    const state = await f.page.evaluate(() => ({ calls: __HR.calls, region: __HR.region, storage: [localStorage.length, sessionStorage.length], url: location.href }));
    assert.equal(state.region, 'europe-west1'); assert.equal(state.calls.length, 3);
    assert.deepEqual(Object.keys(state.calls.find(c=>c.name==='getHrMonthReports').data), ['month']);
    assert.deepEqual(Object.keys(state.calls.find(c=>c.name==='listHrHoursNudges').data), ['month']);
    assert.deepEqual(Object.keys(state.calls.find(c=>c.name==='getHrEmployeeReport').data).sort(), ['month', 'uid']);
    state.calls.forEach(c => assert.equal(c.identity.stationId, 'fixture_station'));
    assert.deepEqual(state.storage, [0, 0]); assert.equal(state.url, origin + '/hr.html'); await f.close();
  });
  for (const [label, claims] of [
    ['ordinary role', { role: 'firefighter', stationId: 'fixture_station' }],
    ['command role', { role: 'station_commander', stationId: 'fixture_station' }],
    ['role-only super plus email', { role: 'super_admin', email: 'synthetic-super@example.invalid', stationId: 'fixture_station' }],
    ['string super', { role: 'firefighter', super: 'true', stationId: 'fixture_station' }],
    ['missing station', { role: 'hr_coordinator' }],
    ['blank station', { super: true, stationId: '  ' }]
  ]) await check(label + ' cannot bootstrap private HR calls', async () => {
    const f = await fixture({ claims }); await privateEmpty(f.page);
    assert.equal(await f.page.evaluate(() => __HR.calls.length), 0); await f.close();
  });
  await check('logged out stays empty; verified boolean super needs no employee number', async () => {
    const f = await fixture({ loggedOut: true }); await privateEmpty(f.page);
    assert.equal(await f.page.evaluate(() => __HR.calls.length), 0);
    await f.page.evaluate(() => __HR.dispatch(__HR.makeUser('signed-super', { super: true, stationId: 'fixture_station' })));
    await openDetail(f.page, 'signed-super'); await f.close();
  });
  for (const change of ['role', 'station']) await check('same-user ' + change + ' claims change clears synchronously before claims await', async () => {
    const f = await fixture(); await openDetail(f.page);
    const snapshot = await f.page.evaluate(change => {
      const h = __HR, u = h.auth.currentUser, count = h.calls.length;
      u.claims = change === 'role' ? { role: 'firefighter', stationId: 'fixture_station' } : { role: 'hr_coordinator', stationId: 'second_station' };
      u.hold = true; h.dispatch(u);
      return { people: document.querySelectorAll('.hr-person').length, detail: document.querySelectorAll('[data-hr="detail"] h2').length,
        callsUnchanged: h.calls.length === count, held: h.heldClaims.length };
    }, change);
    assert.deepEqual(snapshot, { people: 0, detail: 0, callsUnchanged: true, held: 1 });
    await f.page.evaluate(() => __HR.heldClaims.shift().resolve()); await drained(f.page);
    if (change === 'role') await privateEmpty(f.page);
    else { await person(f.page); assert.ok((await f.page.locator('.hr-person').innerText()).includes('second_station')); }
    await f.close();
  });
  await check('late old claims cannot restore an older user after new valid claims', async () => {
    const f = await fixture({ holdClaims: true });
    await f.page.waitForFunction(() => __HR.heldClaims.length === 1);
    await f.page.evaluate(() => __HR.dispatch(__HR.makeUser('actor-b', { role: 'hr_coordinator', stationId: 'second_station' })));
    await person(f.page, 'actor-b'); await f.page.evaluate(() => __HR.heldClaims.shift().resolve()); await drained(f.page);
    assert.equal(await f.page.locator('[data-uid="employee-actor-a"]').count(), 0);
    assert.equal(await f.page.evaluate(() => __HR.calls.every(c => c.identity.uid === 'actor-b')), true); await f.close();
  });
  for (const code of ['functions/permission-denied', 'functions/unauthenticated']) await check('current ' + code + ' erases previously rendered list and report', async () => {
    const f = await fixture(); await openDetail(f.page);
    await f.page.evaluate(code => { __HR.rejectNext = { name: 'getHrEmployeeReport', code }; }, code);
    await f.page.locator('.hr-person').click(); await f.page.waitForFunction(() => document.querySelector('[data-hr="refresh"]').disabled);
    await privateEmpty(f.page); assert.equal(await f.page.evaluate(() => __HR.calls.length), 4); await f.close();
  });
  await check('old permission denial cannot clear a newer valid session and report', async () => {
    const f = await fixture(); await person(f.page);
    await f.page.evaluate(() => { __HR.holdNext = 'getHrEmployeeReport'; }); await f.page.locator('.hr-person').click();
    await f.page.waitForFunction(() => __HR.heldCalls.length === 1);
    await f.page.evaluate(() => __HR.dispatch(__HR.makeUser('actor-b', { role: 'hr_coordinator', stationId: 'second_station' })));
    await openDetail(f.page, 'actor-b');
    await f.page.evaluate(() => __HR.heldCalls.shift().reject('functions/permission-denied')); await drained(f.page);
    assert.ok((await f.page.locator('[data-hr="detail"] h2').innerText()).includes('actor-b'));
    assert.equal(await f.page.locator('[data-hr="refresh"]').isDisabled(), false); await f.close();
  });
  await check('auth.currentUser object changes before observer: old private response discarded', async () => {
    const f = await fixture(); await person(f.page);
    await f.page.evaluate(() => { __HR.holdNext = 'getHrEmployeeReport'; }); await f.page.locator('.hr-person').click();
    await f.page.waitForFunction(() => __HR.heldCalls.length === 1);
    await f.page.evaluate(() => {
      // Same uid still requires the exact SDK user object, not a string comparison.
      __HR.auth.currentUser = __HR.makeUser('actor-a', { role: 'hr_coordinator', stationId: 'second_station' });
      __HR.heldCalls.shift().resolve();
    });
    await f.page.waitForFunction(() => document.querySelector('[data-hr="refresh"]').disabled);
    await privateEmpty(f.page); assert.equal(await f.page.evaluate(() => __HR.calls.length), 3);
    await f.page.evaluate(() => __HR.dispatch(__HR.auth.currentUser)); await person(f.page);
    assert.ok((await f.page.locator('.hr-person').innerText()).includes('second_station')); await f.close();
  });
  await check('claims failure and auth observer error remain closed without leaking private data', async () => {
    const f = await fixture(); await openDetail(f.page);
    await f.page.evaluate(() => { const u = __HR.auth.currentUser; u.hold = true; __HR.dispatch(u); __HR.heldClaims.shift().reject(); });
    await drained(f.page); await privateEmpty(f.page);
    await f.page.evaluate(() => { const u = __HR.auth.currentUser; u.hold = false; __HR.dispatch(u); }); await openDetail(f.page);
    await f.page.evaluate(() => __HR.errors.forEach(cb => cb(new Error('synthetic observer failure'))));
    await privateEmpty(f.page); await f.close();
  });
  await check('actual bootstrap routes all three nudge transports through implicit current identity with immutable timeout retry',async()=>{
    const f=await fixture();await openDetail(f.page);
    await f.page.evaluate(()=>{__HR.rejectNext={name:'requestHrHoursNudge',code:'functions/deadline-exceeded'};});
    await f.page.locator('[data-hr="nudge-person"]').click();await f.page.locator('[data-hr="pending"]').waitFor({state:'visible'});
    await f.page.locator('[data-hr="retry"]').click();await f.page.locator('.hr-action-summary').waitFor();
    const calls=await f.page.evaluate(()=>__HR.calls),requests=calls.filter(c=>c.name==='requestHrHoursNudge');
    assert.equal(requests.length,2);assert.deepEqual(requests[0].data,requests[1].data);assert.equal(requests[0].data.uid,'employee-actor-a');
    assert.deepEqual(Object.keys(requests[0].data).sort(),['month','request_id','send_now','uid']);
    assert.deepEqual(Object.keys(calls.find(c=>c.name==='getHrHoursNudgeStatus').data),['action_id']);
    assert.ok(calls.some(c=>c.name==='listHrHoursNudges'));assert.ok(calls.every(c=>c.appCheckReady&&c.identity.uid==='actor-a'&&c.identity.stationId==='fixture_station'));
    assert.equal(await f.page.evaluate(()=>__HR.nudgeActions.length),1);assert.deepEqual(await f.page.evaluate(()=>[localStorage.length,sessionStorage.length,location.search]),[0,0,'']);await f.close();
  });
  await check('current status permission denial clears registered reminders and report through the real client',async()=>{
    const f=await fixture();await openDetail(f.page);await f.page.locator('[data-hr="nudge-person"]').click();await f.page.locator('.hr-action-summary').waitFor();
    await f.page.evaluate(()=>{__HR.rejectNext={name:'getHrHoursNudgeStatus',code:'functions/permission-denied'};});await f.page.locator('[data-hr="status-refresh"]').click();
    await privateEmpty(f.page);assert.equal(await f.page.locator('[data-action]').count(),0);assert.equal(await f.page.locator('.hr-action-summary').count(),0);
    assert.equal(await f.page.locator('[data-hr="nudge-message"]').innerText(),'');await f.close();
  });
  await check('old mutation response cannot attach status to a changed SDK user before observer',async()=>{
    const f=await fixture();await openDetail(f.page);await f.page.evaluate(()=>{__HR.holdNext='requestHrHoursNudge';});await f.page.locator('[data-hr="nudge-person"]').click();
    await f.page.waitForFunction(()=>__HR.heldCalls.length===1);await f.page.evaluate(()=>{__HR.auth.currentUser=__HR.makeUser('actor-b',{role:'hr_coordinator',stationId:'second_station'});__HR.heldCalls.shift().resolve();});
    await privateEmpty(f.page);assert.equal(await f.page.locator('[data-hr="nudge-message"]').innerText(),'');assert.equal(await f.page.evaluate(()=>__HR.calls.filter(c=>c.name==='getHrHoursNudgeStatus').length),0);
    await f.page.evaluate(()=>__HR.dispatch(__HR.auth.currentUser));await person(f.page,'actor-b');assert.equal(await f.page.locator('[data-action]').count(),0);await f.close();
  });
  assert.deepEqual(sourceHashes(), before, 'actual product sources remain unchanged during suite');
  console.log('SOURCE_HASHES ' + JSON.stringify(before));
  console.log('HR client bootstrap: ' + passed + '/' + passed + ' passed');
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
