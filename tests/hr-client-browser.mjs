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
const registration = index.match(/const hrHours = hrHoursModule\.createHrHoursService\([\s\S]*?exports\.saveHrEmployeeReview = [^\n]+;/)?.[0];
assert.ok(registration, 'actual HR service/export registration block exists');
const db = {}, HttpsError = class {}, exports = {}, registered = [], received = [];
const injectedAuth = {}, authFactoryCalls = [];
const timestampValue = Object.freeze({fixture:'server-timestamp'}), timestampCalls=[];
let reviewCall = req => ({method:'review',req});
vm.runInNewContext(registration, { db, HttpsError, exports, FV:{serverTimestamp(){timestampCalls.push(true);return timestampValue;}},
  admin: { auth() { authFactoryCalls.push(true); return injectedAuth; } },
  hrHoursModule: { createHrHoursService(deps) {
    assert.deepEqual(Object.keys(deps).sort(), ['HttpsError', 'auth', 'db', 'serverTimestamp']);
    assert.equal(deps.auth, injectedAuth);
    assert.equal(deps.db, db); assert.equal(deps.HttpsError, HttpsError);
    received.push(deps);
    return { listMonth: req => ({ method: 'list', req }), getEmployeeMonth: req => ({ method: 'detail', req }), overHoursAlert: req => ({ method: 'retired-overHours', req }), reviewEmployeeMonth: req => reviewCall(req) };
  } },
  onCall(options, handler) { registered.push(options); return handler; },
  getHrOverHoursCompatibility(req) { return { method: 'overHoursCompatibility', req }; }
});
await check('actual export block creates one service with exact db Auth and HttpsError', async () => {
  assert.equal(received.length, 1);
  assert.equal(authFactoryCalls.length, 1);
  assert.equal(timestampCalls.length,0,'timestamp must not be evaluated at factory construction');
  assert.equal(received[0].serverTimestamp(),timestampValue);assert.equal(timestampCalls.length,1);
});
await check('three actual read-only callables enforce AppCheck and forward original request', async () => {
  assert.equal(registered.length, 4);
  registered.slice(0,3).forEach(options => { assert.deepEqual(Object.keys(options), ['enforceAppCheck']); assert.equal(options.enforceAppCheck, true); });
  const request = { auth: { uid: 'synthetic-reviewer' }, data: { month: '2026-09' } };
  const list = await exports.getHrMonthReports(request), detail = await exports.getHrEmployeeReport(request), overHours = await exports.getHrOverHoursAlert(request);
  assert.equal(list.method, 'list'); assert.equal(detail.method, 'detail'); assert.equal(overHours.method, 'overHoursCompatibility');
  assert.equal(list.req, request); assert.equal(detail.req, request); assert.equal(overHours.req, request);
});
await check('legacy alert export is wired to the current monthly truth, never the retired reader', async () => {
  assert.match(registration, /exports\.getHrOverHoursAlert\s*=\s*onCall\([^\n]+getHrOverHoursCompatibility\(req\)/);
  assert.doesNotMatch(registration, /exports\.getHrOverHoursAlert\s*=.*hrHours\.overHoursAlert/);
});
await check('legacy alert compatibility keeps an empty body and returns current monthly truth', async () => {
  const source = index.match(/async function getHrOverHoursCompatibility\(req\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(source, 'compatibility function exists');
  const capture = {}, calls = [], request = Object.freeze({ auth: Object.freeze({ uid: 'legacy-client' }) });
  vm.runInNewContext(source + '\ncapture.fn = getHrOverHoursCompatibility;', {
    capture,
    hrMonthlyContext(req) { assert.equal(req, request); return { sid: 'fixture_station' }; },
    hrMonthlyFields(req, keys) { assert.equal(req, request); assert.deepEqual([...keys], []); return {}; },
    hrMonthlyMonth(value) { assert.equal(value, undefined); return '2026-08'; },
    hrMonthly: { overHours(input) { calls.push(input); return { state: 'not_built', month: input.month,
      hour_limit: null, coverage: null, over_employees: [] }; } }
  });
  const value = await capture.fn(request);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ station_id: 'fixture_station', month: '2026-08' }]);
  assert.equal(value.state, 'not_built');
  assert.equal(value.month, '2026-08');
});
await check('review callable has exact bounded options and preserves completion and rejection',async()=>{
  assert.deepEqual(Object.keys(exports).sort(),['getHrEmployeeReport','getHrMonthReports','getHrOverHoursAlert','saveHrEmployeeReview']);
  assert.equal((index.match(/exports\.saveHrEmployeeReview\s*=/g)||[]).length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(registered[3])),{region:'europe-west1',enforceAppCheck:true,timeoutSeconds:60,memory:'256MiB',maxInstances:3,concurrency:1});
  const request=Object.freeze({data:{month:'2026-09',uid:'employee',expected_revision:'a'.repeat(64),request_id:'request_001'}});
  const result=Object.freeze({review_id:'b'.repeat(64),reviewed_revision:'a'.repeat(64),current:true,duplicate:false});
  let release,settled=false;reviewCall=req=>{assert.equal(req,request);return new Promise(resolve=>{release=resolve;});};
  const pending=exports.saveHrEmployeeReview(request).then(v=>{settled=true;return v;});await Promise.resolve();assert.equal(settled,false);
  release(result);assert.equal(await pending,result);
  const failure=Error('synthetic save failure');reviewCall=()=>Promise.reject(failure);
  await assert.rejects(()=>exports.saveHrEmployeeReview(request),e=>e===failure);
});

const browser = await chromium.launch();
const contexts = new Set();
const hrClaims = { role: 'hr_coordinator', stationId: 'fixture_station' };
async function fixture(options = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' }); contexts.add(context);
  await context.addInitScript(config => {
    const h = window.__HR = { calls: [], heldCalls: [], heldClaims: [], events: [], observers: [], errors: [],
      claimStarted: 0, claimSettled: 0, observerSettled: 0, appCheckReady: false, holdNext: null, rejectNext: null };
    h.now = Date.now(); Date.now = () => h.now;
    if(config.nativeDirectory){
      class TestFile{constructor(){this.bytes=new Uint8Array();}async createWritable(){const self=this;return{async write(bytes){self.bytes=new Uint8Array(bytes);},async close(){},async abort(){}};}async getFile(){return new Blob([this.bytes]);}}
      class TestDirectory{constructor(){this.children=new Map();}async getDirectoryHandle(name,{create=false}={}){const v=this.children.get(name);if(v instanceof TestDirectory)return v;if(v||!create)throw new DOMException('missing','NotFoundError');const d=new TestDirectory();this.children.set(name,d);return d;}async getFileHandle(name,{create=false}={}){const v=this.children.get(name);if(v instanceof TestFile)return v;if(v||!create)throw new DOMException('missing','NotFoundError');const f=new TestFile();this.children.set(name,f);return f;}}
      h.directoryRoot=new TestDirectory();h.directoryPaths=(dir=h.directoryRoot,p='')=>[...dir.children].flatMap(([name,v])=>v instanceof TestDirectory?h.directoryPaths(v,p+name+'/'):[p+name]);
      window.showDirectoryPicker=()=>Promise.resolve(h.directoryRoot);
    }
    h.detailVersion = 0; h.detailText = '';
    // ערכי כפיל שצריכים להיות במקום לפני שהמודולים של הדף רצים:
    // הקריאה הראשונה קורה לפני ש-`evaluate` מגיע, ולכן ערך שנקבע
    // אחריה אינו נבדק באמת.
    if (config.preset) Object.assign(h, config.preset);
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
      const people = Array.from({length:config.peopleCount||1},(_,i)=>({...person,
        uid:person.uid+(i?'-'+(i+1):''),full_name:person.full_name+(i?' person '+(i+1):'')}));
      h.nudgeActions ||= [];
      const action = () => ({action_id:'a'.repeat(64),station_id:identity.stationId,month:data.month,audience:data.uid?'person':'station',status:'completed',reason:null,
        counts:{scanned:1,queued:1,suppressed:0,skipped:0,invalid:0},created_at_ms:1800000000000,expires_at_ms:1800003600000,not_before_ms:null,
        phase:data.uid?'person':'complete',discovery_scanned:0,delivery_status:'intent_only',audience_semantics:data.uid?'active_when_requested':'active_when_enqueue_page_scanned_with_completed_discovery_uid_upper_bound'});
      let value;
      if(name==='getHrMonthReports')value={month:data.month,items:people,next_cursor:null};
      else if(name==='listHrWorkforceCases')value={items:[],next_cursor:null};
      else if(name==='getHrEmployeeReport')value={...(people.find(p=>p.uid===data.uid)||person),uid:data.uid,month:data.month,
        full_name:(people.find(p=>p.uid===data.uid)||person).full_name+' v'+h.detailVersion,employee_number:'1001',crew:'ג',
        rows:h.detailText?[{date:data.month+'-01',day_type_he:'עבודה',start:'08:00',end:'16:00',start2:'',end2:'',site_name:'אילת',notes:h.detailText,overtime_reason:'',reason:'',end_day:0,end_day2:null,hours:24}]:[],warnings:[],stored_total_hours:24,current_detail_total_hours:24,detail_provenance:'current_attendance_not_historical_snapshot'};
      else if(name==='requestHrHoursNudge'){
        let record=h.nudgeActions.find(r=>r.request_id===data.request_id);
        if(!record){record={...action(),recipient_uid:data.uid||null,updated_at_ms:1800000000000,status_scope:'generation_only',actor:identity.uid,request_id:data.request_id};h.nudgeActions.push(record);}
        // Producer result intentionally lacks the richer read-only status fields.
        value=Object.fromEntries(Object.entries(record).filter(([key])=>!['recipient_uid','updated_at_ms','status_scope','actor','request_id'].includes(key)));
      }else if(name==='listHrHoursNudges')value={month:data.month,items:h.nudgeActions.filter(r=>r.actor===identity.uid&&r.station_id===identity.stationId&&r.month===data.month),next_cursor:null};
      else if(name==='getHrHoursNudgeStatus')value={action:h.nudgeActions.find(r=>r.action_id===data.action_id&&r.actor===identity.uid&&r.station_id===identity.stationId),items:[],next_cursor:null,outcomes_scope:'this_page_only'};
      /* ⭐ שלושת המצבים של חריגת השעות, מהדור הפעיל של הדוח
       * החודשי החדש. ברירת המחדל היא `not_built` — מצב שהיה
       * קודם בלתי-ניתן להבדלה מ‎-`clear`, וזו התקלה שתוקנה. */
      else if(name==='getHrMonthlyOverHours')value=h.overHours||{state:'not_built',month:null,hour_limit:null,coverage:null,over_employees:[]};
      else if(name==='buildHrMonthlySummaryNow'){h.builds=(h.builds||0)+1;h.overHours=h.afterBuild||h.overHours;value={generation_id:'a'.repeat(64),complete:true,activated:true,slices:1,written:1};}
      else if(name==='getHrMonthlySummary')value=h.monthly||{month:data.month,state:'not_built',rows:[],next_cursor:null};
      else if(name==='saveHrEmployeeReview')value={review_id:'b'.repeat(64),reviewed_revision:data.expected_revision,current:true,duplicate:false};
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
      if (url.pathname.endsWith('/firebase-firestore.js')) return route.fulfill({ contentType: 'text/javascript', body:
        'export function getFirestore(){return {};} export function collection(){return {};} export function query(){return {};} export function where(){return {};} export function limit(){return {};} export async function getDocsFromServer(){return {docs:[]};}' });
    }
    if (url.origin !== origin) return route.abort();
    if (modules[url.pathname]) return route.fulfill({ contentType: 'text/javascript', body: modules[url.pathname] });
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    let body=fs.readFileSync(file);
    if(options.exposeAdapter&&file===path.join(root,'hr-hours-ui.js')){
      const text=body.toString('utf8'),entry='export function createHrHoursUI(root, adapter=disconnected) {';
      assert.equal(text.split(entry).length,2,'single actual controller entry for read-only adapter capture');
      body=text.replace(entry,entry+'\nwindow.__HR.adapter=adapter;');
    }
    return route.fulfill({ contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'text/javascript', body });
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
    assert.equal(state.region, 'europe-west1'); assert.equal(state.calls.length, 5);
    assert.deepEqual(Object.keys(state.calls.find(c=>c.name==='getHrMonthReports').data), ['month']);
    assert.deepEqual(Object.keys(state.calls.find(c=>c.name==='listHrHoursNudges').data), ['month']);
    assert.deepEqual(Object.keys(state.calls.find(c=>c.name==='getHrEmployeeReport').data).sort(), ['month', 'uid']);
    assert.deepEqual(Object.keys(state.calls.find(c=>c.name==='listHrWorkforceCases').data), []);
    assert.deepEqual(Object.keys(state.calls.find(c=>c.name==='getHrMonthlyOverHours').data), []);
    // ה-callable הישן, שקורא אוסף שאין לו כותב חי, אינו נקרא מהמסך בכלל.
    assert.equal(state.calls.some(c=>c.name==='getHrOverHoursAlert'), false);
    // והדוח החודשי עצמו אינו נטען בפתיחת המסך: 3,000 שורות
    // אינן מחיר שמשלמים כדי לראות אריח חריגות.
    assert.equal(state.calls.some(c=>c.name==='getHrMonthlySummary'), false);
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
    await f.page.locator('.hr-person').click();await f.page.locator('[data-hr="detail-fresh"]').waitFor();
    await f.page.evaluate(code => { __HR.rejectNext = { name: 'getHrEmployeeReport', code }; }, code);
    await f.page.locator('[data-hr="detail-fresh"]').click(); await f.page.waitForFunction(() => document.querySelector('[data-hr="refresh"]').disabled);
    await privateEmpty(f.page); assert.equal(await f.page.evaluate(() => __HR.calls.length), 6); await f.close();
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
    await privateEmpty(f.page); assert.equal(await f.page.evaluate(() => __HR.calls.length), 5);
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
  await check('real UI A to B to A saves a detail GET and cached view requires a separate fresh read before nudge',async()=>{
    const f=await fixture({peopleCount:2});await openDetail(f.page);
    await f.page.locator('[data-uid="employee-actor-a-2"]').click();await f.page.getByRole('heading',{name:/person 2 v0/}).waitFor();
    await f.page.locator('[data-uid="employee-actor-a"]').click();await f.page.locator('[data-hr="detail-fresh"]').waitFor();
    assert.equal(await f.page.evaluate(()=>__HR.calls.filter(c=>c.name==='getHrEmployeeReport').length),2);
    assert.ok((await f.page.locator('[data-hr="detail"]').innerText()).includes('תמונת מצב מזיכרון הדף בלבד'));
    assert.ok((await f.page.locator('[data-hr="detail"]').innerText()).includes('זמן קריאה'));
    assert.equal(await f.page.locator('[data-hr="nudge-person"]').count(),0);
    await f.page.locator('[data-hr="detail-fresh"]').click();await f.page.locator('[data-hr="nudge-person"]').waitFor();
    const beforeNudge=await f.page.evaluate(()=>__HR.calls);
    assert.equal(beforeNudge.filter(c=>c.name==='getHrEmployeeReport').length,3);
    assert.equal(beforeNudge.filter(c=>c.name==='requestHrHoursNudge').length,0,'fresh read is not a business mutation');
    beforeNudge.filter(c=>c.name==='getHrEmployeeReport').forEach(c=>assert.deepEqual(Object.keys(c.data).sort(),['month','uid']));
    await f.page.locator('[data-hr="nudge-person"]').click();await f.page.locator('.hr-action-summary').waitFor();
    assert.equal(await f.page.evaluate(()=>__HR.calls.filter(c=>c.name==='requestHrHoursNudge').length),1);await f.close();
  });
  await check('actual cache TTL is 30 seconds from server completion, never sliding, and clock rollback misses',async()=>{
    const f=await fixture({exposeAdapter:true});
    const result=await f.page.evaluate(async()=>{
      const h=__HR,a=h.adapter,data={month:'2026-09',uid:'employee-actor-a'};
      h.holdNext='getHrEmployeeReport';const pending=a.getEmployeeMonth(data);h.now+=10000;h.heldCalls.shift().resolve();
      const first=await pending;h.now+=29000;const hit=await a.getEmployeeMonth(data);h.now+=1000;const expired=await a.getEmployeeMonth(data);
      h.now=first.freshness.fetched_at_ms-1;const reversed=await a.getEmployeeMonth(data);
      return {first:first.freshness,hit:hit.freshness,expired:expired.freshness,reversed:reversed.freshness,calls:h.calls.filter(c=>c.name==='getHrEmployeeReport').length};
    });
    assert.equal(result.first.source,'server');assert.equal(result.first.expires_at_ms-result.first.fetched_at_ms,30000);
    assert.equal(result.hit.source,'memory');assert.equal(result.hit.fetched_at_ms,result.first.fetched_at_ms);
    assert.equal(result.expired.source,'server');assert.equal(result.reversed.source,'server');assert.equal(result.calls,3);await f.close();
  });
  await check('actual cache LRU is ten entries and UTF8 aggregate cap is 512 KiB without slicing',async()=>{
    const f=await fixture({exposeAdapter:true,peopleCount:12});
    const result=await f.page.evaluate(async()=>{
      const h=__HR,a=h.adapter,read=i=>a.getEmployeeMonth({month:'2026-09',uid:'employee-actor-a'+(i?'-'+(i+1):'')});
      for(let i=0;i<10;i++)await read(i);const touch=await read(0);await read(10);const kept=await read(0),evicted=await read(1);
      const lruCalls=h.calls.filter(c=>c.name==='getHrEmployeeReport').length;
      a.clearReportCache();h.detailText='א'.repeat(100000);const before=h.calls.length;
      await read(0);await read(1);await read(2);const byteEvicted=await read(0),byteCalls=h.calls.length-before;
      a.clearReportCache();h.detailText='א'.repeat(300000);const beforeBig=h.calls.length;
      const big1=await read(0),big2=await read(0);
      return {touch:touch.freshness.source,kept:kept.freshness.source,evicted:evicted.freshness.source,lruCalls,
        byteEvicted:byteEvicted.freshness.source,byteCalls,bigCalls:h.calls.length-beforeBig,
        bigSources:[big1.freshness.source,big2.freshness.source],bigLength:big2.report.rows[0].notes.length};
    });
    assert.deepEqual([result.touch,result.kept,result.evicted],['memory','memory','server']);assert.equal(result.lruCalls,12);
    assert.equal(result.byteEvicted,'server');assert.equal(result.byteCalls,4);assert.equal(result.bigCalls,2);
    assert.deepEqual(result.bigSources,['server','server']);assert.equal(result.bigLength,300000);await f.close();
  });
  await check('returned cache reports are independent clones and forceFresh is local-only',async()=>{
    const f=await fixture({exposeAdapter:true});
    const result=await f.page.evaluate(async()=>{
      const h=__HR,a=h.adapter,data={month:'2026-09',uid:'employee-actor-a'};h.detailText='original note';
      const one=await a.getEmployeeMonth(data);one.report.full_name='MUTATED';one.report.rows[0].notes='MUTATED';
      const two=await a.getEmployeeMonth(data);two.report.rows[0].notes='MUTATED_AGAIN';
      const three=await a.getEmployeeMonth(data),fresh=await a.getEmployeeMonth(data,{forceFresh:true});
      return {name:three.report.full_name,note:three.report.rows[0].notes,source:three.freshness.source,
        fresh:fresh.freshness.source,calls:h.calls.filter(c=>c.name==='getHrEmployeeReport')};
    });
    assert.ok(!result.name.includes('MUTATED'));assert.equal(result.note,'original note');assert.equal(result.source,'memory');assert.equal(result.fresh,'server');
    assert.equal(result.calls.length,2);result.calls.forEach(c=>assert.deepEqual(Object.keys(c.data).sort(),['month','uid']));await f.close();
  });
  await check('reversed same-key network completions cannot replace newer cached report',async()=>{
    const f=await fixture({exposeAdapter:true});
    const result=await f.page.evaluate(async()=>{
      const h=__HR,a=h.adapter,data={month:'2026-09',uid:'employee-actor-a'};
      h.detailVersion=1;h.holdNext='getHrEmployeeReport';const old=a.getEmployeeMonth(data);
      h.detailVersion=2;h.holdNext='getHrEmployeeReport';const latest=a.getEmployeeMonth(data);
      h.heldCalls.pop().resolve();await latest;h.heldCalls.pop().resolve();await old;
      const cached=await a.getEmployeeMonth(data);return {name:cached.report.full_name,source:cached.freshness.source,calls:h.calls.filter(c=>c.name==='getHrEmployeeReport').length};
    });
    assert.ok(result.name.endsWith('v2'));assert.equal(result.source,'memory');assert.equal(result.calls,2);await f.close();
  });
  await check('explicit cache clear blocks held GET repopulation and errors never become cached fallback',async()=>{
    const f=await fixture({exposeAdapter:true});
    const result=await f.page.evaluate(async()=>{
      const h=__HR,a=h.adapter,data={month:'2026-09',uid:'employee-actor-a'};
      h.detailVersion=1;h.holdNext='getHrEmployeeReport';const old=a.getEmployeeMonth(data);a.clearReportCache();
      h.detailVersion=2;await a.getEmployeeMonth(data);h.heldCalls.shift().resolve();await old;
      const cached=await a.getEmployeeMonth(data);
      h.rejectNext={name:'getHrEmployeeReport',code:'functions/unavailable'};let error;
      try{await a.getEmployeeMonth(data,{forceFresh:true});}catch(e){error=e.code;}
      const retry=await a.getEmployeeMonth(data);return {cached:cached.report.full_name,error,retry:retry.freshness.source,calls:h.calls.filter(c=>c.name==='getHrEmployeeReport').length};
    });
    assert.ok(result.cached.endsWith('v2'));assert.equal(result.error,'functions/unavailable');assert.equal(result.retry,'server');assert.equal(result.calls,4);await f.close();
  });
  await check('refresh month pagehide and same UID station changes invalidate actual memory entries',async()=>{
    const f=await fixture({exposeAdapter:true});await openDetail(f.page);
    await f.page.locator('.hr-person').click();await f.page.locator('[data-hr="detail-fresh"]').waitFor();
    await f.page.locator('[data-hr="refresh"]').click();await openDetail(f.page);
    assert.equal(await f.page.evaluate(()=>__HR.calls.filter(c=>c.name==='getHrEmployeeReport').length),2);
    await f.page.locator('[data-hr="month"]').fill('2026-08');await openDetail(f.page);
    await f.page.locator('[data-hr="month"]').fill('2026-09');await openDetail(f.page);
    assert.equal(await f.page.evaluate(()=>__HR.calls.filter(c=>c.name==='getHrEmployeeReport').length),4);
    await f.page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await privateEmpty(f.page);
    assert.equal(await f.page.evaluate(()=>__HR.calls.filter(c=>c.name==='getHrEmployeeReport').length),4);
    await f.page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));await openDetail(f.page);
    assert.equal(await f.page.evaluate(()=>__HR.calls.filter(c=>c.name==='getHrEmployeeReport').length),5);
    await f.page.evaluate(()=>{const h=__HR,u=h.auth.currentUser;u.claims={role:'hr_coordinator',stationId:'second_station'};h.dispatch(u);});await openDetail(f.page);
    assert.equal(await f.page.evaluate(()=>__HR.calls.filter(c=>c.name==='getHrEmployeeReport').length),6);
    assert.ok((await f.page.locator('[data-hr="detail"] h2').innerText()).includes('second_station'));
    assert.deepEqual(await f.page.evaluate(async()=>[localStorage.length,sessionStorage.length,(await caches.keys()).length,location.search]),[0,0,0,'']);await f.close();
  });
  await check('warm cache cannot bypass pre-observer SDK identity switch or logout/login reset',async()=>{
    const f=await fixture({exposeAdapter:true});await openDetail(f.page);
    await f.page.evaluate(()=>{__HR.auth.currentUser=__HR.makeUser('actor-a',{role:'hr_coordinator',stationId:'second_station'});});
    await f.page.locator('.hr-person').click();await privateEmpty(f.page);
    assert.equal(await f.page.evaluate(()=>__HR.calls.filter(c=>c.name==='getHrEmployeeReport').length),1);
    await f.page.evaluate(()=>__HR.dispatch(__HR.auth.currentUser));await openDetail(f.page);
    await f.page.evaluate(()=>__HR.dispatch(null));await privateEmpty(f.page);
    await f.page.evaluate(()=>__HR.dispatch(__HR.makeUser('actor-a',{role:'hr_coordinator',stationId:'second_station'})));await openDetail(f.page);
    assert.equal(await f.page.evaluate(()=>__HR.calls.filter(c=>c.name==='getHrEmployeeReport').length),3);await f.close();
  });
  await check('review transport preserves four-field payload and invalidates old report cache',async()=>{
    const f=await fixture({exposeAdapter:true});
    const result=await f.page.evaluate(async()=>{
      const a=__HR.adapter,data={month:'2026-09',uid:'employee-actor-a'};
      await a.getEmployeeMonth(data);const cached=await a.getEmployeeMonth(data);
      const payload={...data,expected_revision:'a'.repeat(64),request_id:'review_request_001'};
      const saved=await a.reviewEmployeeMonth(payload);const fresh=await a.getEmployeeMonth(data);
      return {saved,cached:cached.freshness.source,fresh:fresh.freshness.source,call:__HR.calls.find(c=>c.name==='saveHrEmployeeReview')};
    });
    assert.equal(result.cached,'memory');assert.equal(result.fresh,'server');assert.equal(result.saved.current,true);
    assert.deepEqual(Object.keys(result.call.data).sort(),['expected_revision','month','request_id','uid']);assert.equal(result.call.appCheckReady,true);
    await f.close();
  });
  await check('old review response cannot clear newer session cache or return success',async()=>{
    const f=await fixture({exposeAdapter:true});
    await f.page.evaluate(()=>{__HR.holdNext='saveHrEmployeeReview';__HR.oldReview=__HR.adapter.reviewEmployeeMonth({month:'2026-09',uid:'employee-actor-a',expected_revision:'a'.repeat(64),request_id:'review_request_002'}).then(()=>({success:true}),e=>({code:e.code}));});
    await f.page.evaluate(()=>__HR.dispatch(__HR.makeUser('actor-b',{role:'hr_coordinator',stationId:'new_station'})));
    await f.page.waitForFunction(()=>__HR.adapter.currentSession()?.uid==='actor-b');
    const result=await f.page.evaluate(async()=>{
      const data={month:'2026-09',uid:'employee-actor-b'};await __HR.adapter.getEmployeeMonth(data);
      __HR.heldCalls.shift().resolve();const old=await __HR.oldReview;
      return {old,source:(await __HR.adapter.getEmployeeMonth(data)).freshness.source};
    });
    assert.equal(result.old.code,'functions/unauthenticated');assert.equal(result.source,'memory');await f.close();
  });
  await check('actual HR page local export creates a verified month folder for its live station',async()=>{
    const f=await fixture({nativeDirectory:true});await person(f.page);
    await f.page.getByRole('button',{name:'ייצוא לתיקייה מקומית'}).click();
    await f.page.locator('[data-hr-local-export] [role="status"]').filter({hasText:'הייצוא הושלם'}).waitFor({timeout:15000});
    const paths=await f.page.evaluate(()=>__HR.directoryPaths());
    assert.ok(paths.some(p=>p.startsWith('משאבי אנוש - fixture_station/run-')&&p.endsWith('/manifest.json')));
    const month=await f.page.locator('[data-hr="month"]').inputValue();
    assert.ok(paths.some(p=>p.includes(`/Synthetic actor-a fixture_station v0 [1001]/דוחות שעות/${month}/`)),paths.join('\n'));
    await f.close();
  });
  await check('actual HR page held local export cannot complete after identity revocation',async()=>{
    const f=await fixture({nativeDirectory:true});await person(f.page);
    await f.page.evaluate(()=>{__HR.holdNext='getHrEmployeeReport';});
    await f.page.getByRole('button',{name:'ייצוא לתיקייה מקומית'}).click();
    await f.page.waitForFunction(()=>__HR.heldCalls.some(x=>x.name==='getHrEmployeeReport'));
    await f.page.evaluate(()=>{__HR.dispatch(__HR.makeUser('actor-a',{role:'firefighter',stationId:'fixture_station'}));__HR.heldCalls.find(x=>x.name==='getHrEmployeeReport').resolve();});
    await f.page.waitForTimeout(100);
    assert.equal((await f.page.evaluate(()=>__HR.directoryPaths())).some(p=>p.endsWith('/manifest.json')),false);
    await privateEmpty(f.page);await f.close();
  });
  /* ----------------------------------------------------------------------
   *  חריגת השעות — שלושה מצבים, ולא שניים
   *
   *  ⭐ התקלה שתוקנה: פאנל ריק נקרא „אין חורגים", בעוד
   *  בפועל לא היה לו מקור נתונים בכלל. שתי הבדיקות הבאות
   *  מראות שהמצבים נראים שונה — מקף מול אפס, ושתי אמירות שונות.
   * -------------------------------------------------------------------- */

  await check('with no monthly report the tile shows a dash and the text refuses to say nobody is over', async () => {
    const f = await fixture({ preset: { overHours: { state: 'not_built', month: null, hour_limit: null, coverage: null, over_employees: [] } } });
    await person(f.page);
    await f.page.waitForFunction(() => document.querySelector('[data-oh="count"]').textContent === '—');
    const text = await f.page.locator('[data-oh="alert"]').innerText();
    assert.ok(text.includes('טרם הופק'), text);
    assert.equal(/אין עובדים מעל הסף/.test(text), false, text);
    // וההפקה הידנית מוצגת במצב הזה בלבד.
    assert.equal(await f.page.locator('[data-oh="build"]').isHidden(), false);
    await f.close();
  });

  await check('with a report and nobody over, the tile shows zero and says so in words', async () => {
    const f = await fixture({ preset: { overHours: { state: 'clear', month: '2026-09', hour_limit: 265, coverage: 'complete', over_employees: [] } } });
    await person(f.page);
    await f.page.waitForFunction(() => document.querySelector('[data-oh="count"]').textContent === '0');
    const text = await f.page.locator('[data-oh="alert"]').innerText();
    assert.ok(text.includes('אין עובדים מעל הסף'), text);
    assert.ok(text.includes('אינו חוסם סידור'), text);
    assert.equal(await f.page.locator('[data-oh="build"]').isHidden(), true);
    await f.close();
  });

  await check('with somebody over the threshold the list names them and never shows a uid', async () => {
    const f = await fixture({ preset: { overHours: { state: 'over', month: '2026-09', hour_limit: 265, coverage: 'complete',
      over_employees: [{ employee_number: '4410', full_name: 'דנה לוי', crew: 'משמרת ב', total_hours: 301 }] } } });
    await person(f.page);
    await f.page.waitForFunction(() => document.querySelector('[data-oh="count"]').textContent === '1');
    const text = await f.page.locator('[data-oh="alert"]').innerText();
    assert.ok(text.includes('דנה לוי'), text);
    assert.ok(text.includes('4410'), text);
    assert.ok(text.includes('301'), text);
    await f.close();
  });

  await check('a partial classification is stated on the alert instead of being hidden', async () => {
    const f = await fixture({ preset: { overHours: { state: 'clear', month: '2026-09', hour_limit: 265, coverage: 'legacy_pending', over_employees: [] } } });
    await person(f.page);
    await f.page.waitForFunction(() => document.querySelector('[data-oh="alert"]').innerText.includes('אינו מוצג כשלם'));
    await f.close();
  });

  await check('a failed status call says the state is unavailable, not that nobody is over', async () => {
    const f = await fixture({ preset: { overHours: { state: 'nonsense' } } });
    await person(f.page);
    await f.page.waitForFunction(() => document.querySelector('[data-oh="meta"]').textContent.includes('אינו זמין'));
    assert.equal(await f.page.locator('[data-oh="count"]').innerText(), '—');
    const text = await f.page.locator('[data-oh="alert"]').innerText();
    assert.equal(/אין עובדים מעל הסף/.test(text), false, text);
    assert.equal(await f.page.locator('[data-oh="retry"]').isHidden(), false);
    await f.close();
  });

  await check('the manual build runs once, then the alert reloads from the new generation', async () => {
    const f = await fixture({ preset: {
      overHours: { state: 'not_built', month: null, hour_limit: null, coverage: null, over_employees: [] },
      afterBuild: { state: 'clear', month: '2026-09', hour_limit: 265, coverage: 'complete', over_employees: [] } } });
    await person(f.page);
    await f.page.waitForFunction(() => !document.querySelector('[data-oh="build"]').hidden);
    await f.page.locator('[data-oh="build"]').click();
    await f.page.waitForFunction(() => document.querySelector('[data-oh="count"]').textContent === '0');
    assert.equal(await f.page.evaluate(() => __HR.builds), 1);
    assert.equal(await f.page.evaluate(() => __HR.calls.filter(c => c.name === 'buildHrMonthlySummaryNow').length), 1);
    await f.close();
  });

  /* ----------------------------------------------------------------------
   *  הדוח החודשי המאוחד במסך
   * -------------------------------------------------------------------- */

  await check('the monthly report loads on demand, pages, and states that it is in-app only', async () => {
    const f = await fixture();
    await f.page.evaluate(() => {
      const row = (uid, over) => ({ uid, employee_number: 'E' + uid, full_name: 'עובד ' + uid,
        crew: 'משמרת א', total_hours: over ? 301 : 120, hours_state: 'approved',
        approved_sick_days: 3, approved_reserve_days: 0, approved_vacation_days: 1,
        approved_extended_absence_days: 0, pending_sick_days: 2, pending_reserve_days: 0,
        pending_vacation_days: 0, pending_extended_absence_days: 0, long_absence: null,
        over_hour_limit: !!over, hour_limit: 265 });
      __HR.monthly = { month: '2026-09', state: 'ready', generated_at_ms: 1789000000000,
        generation_id: 'a'.repeat(64), hour_limit: 265, coverage: 'complete',
        source_digest: 'b'.repeat(64), sources: { hr_requests: 4 }, total_rows: 2,
        delivery: 'in_app_only', rows: [row('u1', false), row('u2', true)], next_cursor: null };
    });
    await person(f.page);
    assert.equal(await f.page.locator('[data-mr="table"]').isHidden(), true, 'nothing is loaded until asked');
    await f.page.locator('[data-mr="load"]').click();
    await f.page.waitForFunction(() => !document.querySelector('[data-mr="table"]').hidden);
    const head = await f.page.locator('[data-mr="head"]').innerText();
    assert.ok(head.includes('2026-09'), head);
    assert.ok(head.includes('במערכת בלבד'), head);
    const table = await f.page.locator('[data-mr="table"]').innerText();
    assert.ok(table.includes('עובד u1'), table);
    assert.ok(table.includes('מעל הסף'), table);
    // השורה שחורגת מסומנת גם במבנה ולא רק בצבע.
    assert.equal(await f.page.locator('[data-mr="rows"] tr[data-over="true"]').count(), 1);
    assert.equal(await f.page.locator('[data-mr="more"]').isHidden(), true);
    assert.equal(await f.page.locator('[data-mr="coverage"]').isHidden(), true);
    await f.close();
  });

  await check('a report that was never built says so in the report section too', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __HR.monthly = { month: '2026-09', state: 'not_built', rows: [], next_cursor: null }; });
    await person(f.page);
    await f.page.locator('[data-mr="load"]').click();
    await f.page.waitForFunction(() => document.querySelector('[data-mr="message"]').textContent.includes('טרם הופק'));
    assert.equal(await f.page.locator('[data-mr="table"]').isHidden(), true);
    await f.close();
  });

  await check('a malformed report row is refused whole rather than rendered in part', async () => {
    const f = await fixture();
    await f.page.evaluate(() => {
      __HR.monthly = { month: '2026-09', state: 'ready', rows: [{ uid: 'u1', employee_number: 'E1',
        full_name: 'עובד', crew: 'א', total_hours: 'many', approved_sick_days: 1 }], next_cursor: null };
    });
    await person(f.page);
    await f.page.locator('[data-mr="load"]').click();
    await f.page.waitForFunction(() => document.querySelector('[data-mr="message"]').textContent.includes('אינו זמין'));
    assert.equal(await f.page.locator('[data-mr="rows"] tr').count(), 0);
    await f.close();
  });

  await check('the report section stays inside 320, 360 and 390 without scrolling the page sideways', async () => {
    const f = await fixture();
    await f.page.evaluate(() => {
      __HR.monthly = { month: '2026-09', state: 'ready', hour_limit: 265, coverage: 'complete',
        total_rows: 1, delivery: 'in_app_only', next_cursor: null,
        rows: [{ uid: 'u1', employee_number: 'E1', full_name: 'עובד ארוך מאוד לצורך הבדיקה',
          crew: 'משמרת א', total_hours: 301, hours_state: 'approved',
          approved_sick_days: 3, approved_reserve_days: 2, approved_vacation_days: 1,
          approved_extended_absence_days: 0, pending_sick_days: 0, pending_reserve_days: 0,
          pending_vacation_days: 0, pending_extended_absence_days: 0, long_absence: null,
          over_hour_limit: true, hour_limit: 265 }] };
    });
    await person(f.page);
    await f.page.locator('[data-mr="load"]').click();
    await f.page.waitForFunction(() => !document.querySelector('[data-mr="table"]').hidden);
    for (const width of [320, 360, 390]) {
      await f.page.setViewportSize({ width, height: 780 });
      await f.page.waitForTimeout(40);
      const overflow = await f.page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, 'page overflow ' + overflow + ' at ' + width);
      /* יעד המגע הוא הכפתור או הקישור עצמו, ולא ה-`strong`
       * שבתוכו — אצבע פוגעת באריח, לא במספר. */
      for (const selector of ['[data-mr="load"]', '[data-mr="more"], [data-mr="load"]', '[data-oh="tile"]']) {
        const box = await f.page.locator(selector).first().boundingBox();
        assert.ok(box && box.height >= 44, selector + ' ' + JSON.stringify(box) + ' at ' + width);
        assert.ok(box.width >= 44, selector + ' is narrower than 44 at ' + width);
      }
    }
    await f.close();
  });

  assert.deepEqual(sourceHashes(), before, 'actual product sources remain unchanged during suite');
  console.log('SOURCE_HASHES ' + JSON.stringify(before));
  console.log('HR client bootstrap: ' + passed + '/' + passed + ' passed');
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
