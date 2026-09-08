import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), origin = 'http://127.0.0.1:41996';
const files = ['hr-documents.html', 'hr-documents-client.js', 'hr-documents-ui.js', 'hr-documents-ui.css'];
const hashes = () => Object.fromEntries(files.map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')]));
const before = hashes(), browser = await chromium.launch(), contexts = new Set();
let passed = 0;
async function fixture({ connected = true, role = 'firefighter', superUser = false, localMember = true, width = 1100, theme = 'light' } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 900 }, colorScheme: theme }); contexts.add(context);
  await context.addInitScript(options => {
    const t = window.__docs = { calls: [], held: [], claimsHeld: [], dirHeld: [], hold: null, holdClaims: false, holdDirectory: false, reject: null,
      lost: null, observers: [], publications: [], receipts: {}, operations: {}, created: 0, directory: [], queries: [], nameReads: [], appCheck: false, localMember: options.localMember };
    t.makeUser = (uid, role = 'firefighter', superUser = false) => ({ uid, getIdTokenResult() {
      const result = { claims: { stationId: 'fixture_station', role, super: superUser } };
      if (t.holdClaims) { t.holdClaims = false; return new Promise(resolve => t.claimsHeld.push(() => resolve(result))); }
      return Promise.resolve(result);
    } });
    t.auth = { currentUser: options.connected ? t.makeUser('owner', options.role, options.superUser) : null };
    t.emit = (uid, role = 'firefighter', superUser = false) => { t.auth.currentUser = uid ? t.makeUser(uid, role, superUser) : null; return Promise.all(t.observers.map(fn => fn(t.auth.currentUser))); };
    t.add = (id, kind = 'document', target = 'owner', title = 'מסמך לבדיקה') => {
      const d = { document_id: id, kind, ...(kind === 'document' ? { target_uid: target } : {}), title, current_revision: 1,
        versions: { 1: { title, text: 'טקסט פרטי <img src=x onerror=alert(1)> https://example.invalid/private', requires_ack: true } } };
      t.publications.push(d); return d;
    };
    t.add('a'.repeat(64), 'document', 'owner', 'המסמך האישי'); t.add('b'.repeat(64), 'procedure', null, 'נוהל התחנה');
    t.directory.push({ uid: 'target.valid', full_name: 'אור עובד', station: 'fixture_station', role: 'firefighter', active: true, crew: 'A' });
    const rkey = (id, n, uid) => [id, n, uid].join(':');
    t.putReceipt = (id, n, uid, opened = 100, ack = null) => { t.receipts[rkey(id, n, uid)] = { recipient_uid: uid, revision: n, opened_at_ms: opened, acknowledged_at_ms: ack }; };
    const summary = ({ versions, ...d }) => d;
    t.transport = async (name, data) => {
      if (!t.appCheck) throw new Error('App Check ordering');
      t.calls.push({ name, data: structuredClone(data), uid: t.auth.currentUser?.uid, rendered: !!document.querySelector('.doc-body') });
      if (t.reject) { const c = t.reject; t.reject = null; throw Object.assign(new Error('Private synthetic failure'), { code: 'functions/' + c }); }
      let result, d = t.publications.find(d => d.document_id === data.document_id), user = t.auth.currentUser.uid;
      if (['listMyHrDocuments', 'listHrProcedures', 'listManagedHrDocuments'].includes(name)) {
        const rows = t.publications.filter(d => name === 'listMyHrDocuments' ? d.kind === 'document' && d.target_uid === user : d.kind === (name === 'listHrProcedures' ? 'procedure' : data.kind))
          .sort((a, b) => a.document_id.localeCompare(b.document_id)).filter(d => !data.cursor || d.document_id > data.cursor);
        const page = rows.slice(0, 25); result = { items: page.map(summary), next_cursor: rows.length > 25 ? page.at(-1).document_id : null };
      } else if (name === 'getHrDocument') {
        if (!d) throw Object.assign(new Error('missing'), { code: 'functions/not-found' });
        const n = data.revision || d.current_revision;
        result = { ...summary(d), ...d.versions[n], revision: n, is_current: n === d.current_revision,
          recipient_eligible: t.localMember && (d.kind === 'procedure' || d.target_uid === user), receipt: t.receipts[rkey(d.document_id, n, user)] || null };
      } else if (name === 'listHrDocumentReceipts') {
        const rows = Object.entries(t.receipts).filter(([k]) => k.startsWith(data.document_id + ':' + data.revision + ':')).map(([, r]) => r)
          .sort((a, b) => a.recipient_uid.localeCompare(b.recipient_uid)).filter(r => !data.cursor || r.recipient_uid > data.cursor);
        const page = rows.slice(0, 25); result = { document_id: d.document_id, revision: data.revision, current_revision: d.current_revision, items: page, next_cursor: rows.length > 25 ? page.at(-1).recipient_uid : null };
      } else {
        const old = t.operations[data.request_id];
        if (old) { if (JSON.stringify(old.data) !== JSON.stringify(data)) throw new Error('Retry changed immutable payload'); result = { ...old.result, duplicate: true }; }
        else {
          if (name === 'publishHrDocument') {
            d = t.add((++t.created + 2).toString(16).padStart(64, '0'), data.kind, data.target_uid, data.title);
            d.versions[1] = { title: data.title, text: data.text, requires_ack: data.requires_ack };
          }
          if (name === 'reviseHrDocument') {
            if (data.expected_revision !== d.current_revision) throw Object.assign(new Error('stale'), { code: 'functions/aborted' });
            ++d.current_revision; d.title = data.title; d.versions[d.current_revision] = { title: data.title, text: data.text, requires_ack: data.requires_ack };
          }
          const n = data.revision || d.current_revision;
          if (['acknowledgeHrDocument', 'nudgeHrDocument'].includes(name) && n !== d.current_revision) throw Object.assign(new Error('stale'), { code: 'functions/aborted' });
          result = { document_id: d.document_id, revision: n, current_revision: d.current_revision, outcome: 'saved', notification_status: 'policy_pending', duplicate: false };
          if (name === 'markHrDocumentOpened' || name === 'acknowledgeHrDocument') {
            const key = rkey(d.document_id, n, user), r = t.receipts[key] || { recipient_uid: user, revision: n, opened_at_ms: null, acknowledged_at_ms: null };
            if (name === 'markHrDocumentOpened') r.opened_at_ms ??= 100;
            else { if (r.opened_at_ms === null) throw new Error('ack before open'); r.acknowledged_at_ms ??= 200; }
            t.receipts[key] = r; result.receipt = r; result.notification_status = 'not_queued';
          }
          if (name === 'nudgeHrDocument' && t.warnNudge && !data.send_now) { result.outcome = 'confirmation_required'; result.notification_status = 'not_queued'; }
          t.operations[data.request_id] = { data: structuredClone(data), result: structuredClone(result) };
        }
      }
      result = structuredClone(result);
      if (t.lost === name) { t.lost = null; throw Object.assign(new Error('lost response after commit'), { code: 'functions/unavailable' }); }
      if (t.hold === name) { t.hold = null; return new Promise(resolve => t.held.push(() => resolve({ data: result }))); }
      return { data: result };
    };
    t.directoryQuery = async q => {
      t.queries.push(q); const rows = t.directory.slice(0, 25).map(p => ({ id: p.uid, data: () => structuredClone(p) }));
      if (t.holdDirectory) { t.holdDirectory = false; return new Promise(resolve => t.dirHeld.push(() => resolve({ docs: rows }))); }
      return { docs: rows };
    };
    t.directoryGet = async ref => { t.nameReads.push(ref.uid); if (t.failNames) throw new Error('name read failed');
      const p = t.directory.find(p => p.uid === ref.uid); return { exists: () => !!p, data: () => structuredClone(p) }; };
  }, { connected, role, superUser, localMember });
  const stubs = {
    '/appcheck.js': 'export async function initAppCheck(){window.__docs.appCheck=true;}',
    '/monitored-functions.js': 'export function getFunctions(a,r){window.__docs.region=r;return {};}; export function httpsCallable(f,n){return data=>window.__docs.transport(n,data);}',
    '/firebase-app.js': 'export function initializeApp(){return {};}',
    '/firebase-auth.js': 'export function getAuth(){return window.__docs.auth;} export function onIdTokenChanged(a,cb){window.__docs.observers.push(cb);queueMicrotask(()=>cb(a.currentUser));return ()=>{};}',
    '/firebase-firestore.js': 'export function getFirestore(){return {};}; export function collection(db,path){return {path};}; export function doc(db,path,uid){return {path,uid};}; export function where(field,op,value){return {field,op,value};}; export function limit(n){return {limit:n};}; export function query(...parts){return parts;}; export function getDocsFromServer(q){return window.__docs.directoryQuery(q);}; export function getDocFromServer(ref){return window.__docs.directoryGet(ref);}'
  };
  await context.route('**/*', async route => {
    const url = new URL(route.request().url()), key = url.hostname === 'www.gstatic.com' ? '/' + url.pathname.split('/').pop() : url.pathname;
    if (stubs[key]) return route.fulfill({ status: 200, contentType: 'text/javascript', body: stubs[key] });
    if (url.origin !== origin) return route.abort();
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
  });
  const page = await context.newPage(), errors = []; page.setDefaultTimeout(7000); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.goto(origin + '/hr-documents.html');
  if (connected && role !== 'district_commander') await page.waitForFunction(() => __docs.calls.some(c => c.name === 'listMyHrDocuments'));
  return { page, close: async () => { assert.deepEqual(errors, []); await context.close(); contexts.delete(context); } };
}
const q = (p, k) => p.locator('[data-d="' + k + '"]');
async function open(p, letter = 'a') {
  await p.locator('[data-document="' + letter.repeat(64) + '"]').click(); await p.locator('.doc-body').waitFor();
  await p.waitForFunction(() => !document.querySelector('[data-d="refresh"]').disabled);
}
async function check(name, fn) { await fn(); ++passed; console.log('PASS ' + name); }
async function newForm(p) { await q(p, 'new').click(); await q(p, 'title').fill('כותרת פרטית'); await q(p, 'text').fill('טיוטת פרסום'); }
try {
  await check('public and unsupported-role shell has no private reads or fake file control', async () => {
    for (const opts of [{ connected: false }, { role: 'district_commander' }]) { const f = await fixture(opts);
      assert.equal(await q(f.page, 'workspace').isHidden(), true); assert.equal(await f.page.evaluate(() => __docs.calls.length), 0);
      assert.equal(await f.page.locator('input[type=file]').count(), 0); assert.ok((await f.page.locator('body').innerText()).includes('שליחת קבצים עדיין אינה זמינה')); await f.close(); }
  });
  await check('actual client opens only rendered body once and requires separate acknowledgment', async () => {
    const f = await fixture(); assert.equal(await f.page.evaluate(() => __docs.calls.filter(c => c.name === 'markHrDocumentOpened').length), 0);
    await open(f.page); const calls = await f.page.evaluate(() => __docs.calls.filter(c => c.name === 'markHrDocumentOpened'));
    assert.equal(calls.length, 1); assert.equal(calls[0].rendered, true); assert.equal(await f.page.evaluate(() => __docs.region), 'europe-west1');
    assert.equal(await f.page.evaluate(() => __docs.calls.some(c => c.name === 'acknowledgeHrDocument')), false);
    await q(f.page, 'ack').click(); await q(f.page, 'ack').waitFor({ state: 'hidden' });
    assert.ok((await q(f.page, 'receipt-state').innerText()).includes('אישור עיון')); await q(f.page, 'refresh').click();
    await f.page.waitForFunction(() => !document.querySelector('[data-d="refresh"]').disabled);
    assert.equal(await f.page.evaluate(() => __docs.calls.filter(c => c.name === 'markHrDocumentOpened').length), 1);
    assert.equal(await q(f.page, 'detail').locator('img,a').count(), 0); assert.ok((await q(f.page, 'detail').innerText()).includes('<img'));
    assert.deepEqual(await f.page.evaluate(() => [location.search, location.hash, localStorage.length, sessionStorage.length]), ['', '', 0, 0]); await f.close();
  });
  await check('profile-free super management view never manufactures an opened or acknowledgment receipt', async () => {
    const f = await fixture({ superUser: true, localMember: false }); await q(f.page, 'procedures').click(); await open(f.page, 'b');
    assert.equal(await f.page.evaluate(() => __docs.calls.some(c => ['markHrDocumentOpened', 'acknowledgeHrDocument'].includes(c.name))), false);
    assert.equal(await q(f.page, 'ack').isHidden(), true); assert.equal(await q(f.page, 'show-receipts').isVisible(), true); await f.close();
  });
  await check('directory picker filters aliases/inactive/wrong station and never silently selects a UID', async () => {
    const f = await fixture({ role: 'hr_coordinator' }); await newForm(f.page);
    await f.page.evaluate(() => __docs.directory.push(
      { uid: 'wrong', full_name: 'אור רחוק', station: 'other_station', role: 'firefighter' },
      { uid: 'conflict', full_name: 'אור סותר', station: 'fixture_station', stationId: 'other_station', role: 'firefighter' },
      { uid: 'inactive', full_name: 'אור לא פעיל', station_id: 'fixture_station', active: false, role: 'firefighter' }));
    await q(f.page, 'search').fill('או'); await q(f.page, 'search-button').click(); await q(f.page, 'candidates').getByRole('button').waitFor();
    assert.equal(await q(f.page, 'candidates').getByRole('button').count(), 1);
    await q(f.page, 'publish').click(); assert.equal(await f.page.evaluate(() => __docs.calls.some(c => c.name === 'publishHrDocument')), false);
    await q(f.page, 'candidates').getByRole('button').click(); await q(f.page, 'search').fill('אור עובד');
    await q(f.page, 'publish').click(); assert.equal(await f.page.evaluate(() => __docs.calls.some(c => c.name === 'publishHrDocument')), false);
    const query = await f.page.evaluate(() => __docs.queries[0]); assert.equal(query[0].path, 'directory'); assert.deepEqual(query[1], { field: 'name_prefixes', op: 'array-contains', value: 'או' }); assert.deepEqual(query[2], { limit: 25 }); await f.close();
  });
  await check('late directory result after edited search cannot select or expose old candidates', async () => {
    const f = await fixture({ role: 'hr_coordinator' }); await newForm(f.page);
    await f.page.evaluate(() => { __docs.holdDirectory = true; }); await q(f.page, 'search').fill('או'); await q(f.page, 'search-button').click();
    await f.page.waitForFunction(() => __docs.dirHeld.length === 1); await q(f.page, 'search').fill('שם אחר');
    await f.page.evaluate(() => __docs.dirHeld.splice(0).forEach(fn => fn())); assert.equal(await q(f.page, 'candidates').getByRole('button').count(), 0); await f.close();
  });
  await check('publication lost response retries exact immutable selected recipient and body', async () => {
    const f = await fixture({ role: 'hr_coordinator' }); await newForm(f.page); await q(f.page, 'search').fill('או'); await q(f.page, 'search-button').click(); await q(f.page, 'candidates').getByRole('button').click();
    await f.page.evaluate(() => { __docs.lost = 'publishHrDocument'; }); await q(f.page, 'publish').click(); await q(f.page, 'retry').waitFor({ state: 'visible' });
    assert.equal(await q(f.page, 'search').isDisabled(), true); assert.equal(await q(f.page, 'text').isDisabled(), true);
    await q(f.page, 'retry').click(); await q(f.page, 'detail').getByRole('heading', { name: 'כותרת פרטית' }).waitFor();
    const calls = await f.page.evaluate(() => __docs.calls.filter(c => c.name === 'publishHrDocument'));
    assert.equal(calls.length, 2); assert.deepEqual(calls[0].data, calls[1].data); assert.equal(calls[0].data.target_uid, 'target.valid');
    assert.equal(await f.page.evaluate(() => __docs.created), 1); assert.equal((await f.page.locator('body').innerText()).includes('target.valid'), false); await f.close();
  });
  await check('uncertain opened response retains exact retry and never auto-acknowledges', async () => {
    const f = await fixture(); await f.page.evaluate(() => { __docs.lost = 'markHrDocumentOpened'; });
    await f.page.locator('[data-document="' + 'a'.repeat(64) + '"]').click(); await q(f.page, 'retry').waitFor({ state: 'visible' });
    assert.equal(await q(f.page, 'ack').isDisabled(), true); await q(f.page, 'retry').click();
    await f.page.waitForFunction(() => !document.querySelector('[data-d="ack"]').disabled);
    const calls = await f.page.evaluate(() => __docs.calls.filter(c => c.name === 'markHrDocumentOpened'));
    assert.equal(calls.length, 2); assert.deepEqual(calls[0].data, calls[1].data);
    assert.equal(await f.page.evaluate(() => __docs.calls.some(c => c.name === 'acknowledgeHrDocument')), false); await f.close();
  });
  await check('new revision CAS never carries acknowledgment to unseen content or auto-resubmits', async () => {
    const f = await fixture(); await open(f.page);
    await f.page.evaluate(() => { const d = __docs.publications[0]; d.current_revision = 2; d.versions[2] = { title: d.title, text: 'גרסה חדשה לעיון', requires_ack: true }; });
    await q(f.page, 'ack').click(); await f.page.waitForFunction(() => document.querySelector('[data-d="message"]').textContent.includes('פורסמה גרסה חדשה'));
    assert.equal(await f.page.evaluate(() => __docs.calls.filter(c => c.name === 'acknowledgeHrDocument').length), 1);
    await q(f.page, 'latest').click(); await f.page.waitForFunction(() => document.querySelector('.doc-body')?.textContent.includes('גרסה חדשה'));
    await f.page.waitForFunction(() => !document.querySelector('[data-d="ack"]').disabled);
    assert.equal(await f.page.evaluate(() => __docs.calls.filter(c => c.name === 'acknowledgeHrDocument').length), 1);
    await q(f.page, 'ack').click(); await q(f.page, 'ack').waitFor({ state: 'hidden' });
    const calls = await f.page.evaluate(() => __docs.calls.filter(c => c.name === 'acknowledgeHrDocument'));
    assert.equal(calls[1].data.revision, 2); assert.notEqual(calls[0].data.request_id, calls[1].data.request_id); await f.close();
  });
  await check('held older document never renders or produces an opened receipt after selection changes', async () => {
    const f = await fixture(); await f.page.evaluate(() => { __docs.add('c'.repeat(64)); __docs.hold = 'getHrDocument'; }); await q(f.page, 'refresh').click();
    await f.page.locator('[data-document="' + 'c'.repeat(64) + '"]').waitFor(); await f.page.locator('[data-document="' + 'a'.repeat(64) + '"]').click();
    await f.page.waitForFunction(() => __docs.held.length === 1); await open(f.page, 'c'); await f.page.evaluate(() => __docs.held.splice(0).forEach(fn => fn()));
    assert.equal(await f.page.evaluate(() => __docs.calls.some(c => c.name === 'markHrDocumentOpened' && c.data.document_id === 'a'.repeat(64))), false); await f.close();
  });
  await check('held claims and late old receipt cannot restore previous identity data', async () => {
    const f = await fixture(); await f.page.evaluate(() => { __docs.holdClaims = true; void __docs.emit('old-hr', 'hr_coordinator'); });
    await f.page.waitForFunction(() => __docs.claimsHeld.length === 1); assert.equal(await q(f.page, 'workspace').isHidden(), true);
    await f.page.evaluate(() => __docs.emit('next')); await f.page.evaluate(() => __docs.claimsHeld.splice(0).forEach(fn => fn()));
    assert.equal(await q(f.page, 'new').isHidden(), true);
    await f.page.evaluate(() => __docs.emit('owner')); await f.page.evaluate(() => { __docs.hold = 'markHrDocumentOpened'; });
    await f.page.locator('[data-document="' + 'a'.repeat(64) + '"]').click(); await f.page.waitForFunction(() => __docs.held.length === 1);
    await f.page.evaluate(() => __docs.emit('next', 'hr_coordinator')); await newForm(f.page);
    await f.page.evaluate(() => __docs.held.splice(0).forEach(fn => fn())); assert.equal(await q(f.page, 'title').inputValue(), 'כותרת פרטית'); assert.equal(await q(f.page, 'pending').isHidden(), true); await f.close();
  });
  await check('actual non-null list cursors load 27 unique documents', async () => {
    const f = await fixture(); await f.page.evaluate(() => { __docs.publications = []; for (let i = 1; i <= 27; ++i) __docs.add(i.toString(16).padStart(64, '0')); });
    await q(f.page, 'refresh').click(); await q(f.page, 'more').waitFor({ state: 'visible' }); assert.equal(await q(f.page, 'list').getByRole('button').count(), 25);
    await q(f.page, 'more').click(); await q(f.page, 'more').waitFor({ state: 'hidden' }); assert.equal(await q(f.page, 'list').getByRole('button').count(), 27);
    assert.ok(await f.page.evaluate(() => __docs.calls.some(c => c.name === 'listMyHrDocuments' && c.data.cursor))); await f.close();
  });
  await check('receipt paging retains all rows; moved or failed names stay unavailable without UID display', async () => {
    const f = await fixture({ superUser: true, localMember: false }); await f.page.evaluate(() => {
      for (let i = 0; i < 27; ++i) { const id = 'person.' + String(i).padStart(2, '0'); __docs.putReceipt('b'.repeat(64), 1, id);
        __docs.directory.push({ uid: id, full_name: i === 0 ? 'שם מתחנה אחרת' : 'שם ' + i, station: i === 0 ? 'other_station' : 'fixture_station', role: 'firefighter' }); }
    });
    await q(f.page, 'procedures').click(); await open(f.page, 'b'); await q(f.page, 'show-receipts').click(); await q(f.page, 'receipts-more').waitFor({ state: 'visible' });
    await f.page.waitForFunction(() => __docs.nameReads.length === 25); assert.equal(await f.page.locator('.doc-receipt').count(), 25);
    assert.equal((await q(f.page, 'receipts').innerText()).includes('שם מתחנה אחרת'), false); assert.ok((await q(f.page, 'receipts').innerText()).includes('שם לא זמין'));
    await f.page.evaluate(() => { __docs.failNames = true; }); await q(f.page, 'receipts-more').click(); await q(f.page, 'receipts-more').waitFor({ state: 'hidden' });
    assert.equal(await f.page.locator('.doc-receipt').count(), 27); assert.equal((await q(f.page, 'receipts').innerText()).includes('person.'), false);
    assert.ok(await f.page.evaluate(() => __docs.calls.some(c => c.name === 'listHrDocumentReceipts' && c.data.cursor))); await f.close();
  });
  await check('revision editor retains draft on CAS and publishes only after explicit refresh and action', async () => {
    const f = await fixture({ role: 'hr_coordinator' }); await open(f.page); await q(f.page, 'revise').click(); await q(f.page, 'text').fill('טיוטת גרסה שלי');
    await f.page.evaluate(() => { const d = __docs.publications[0]; d.current_revision = 2; d.versions[2] = { title: d.title, text: 'עדכון אחר', requires_ack: true }; });
    await q(f.page, 'publish').click(); await f.page.waitForFunction(() => document.querySelector('[data-d="message"]').textContent.includes('פורסמה גרסה חדשה'));
    assert.equal(await q(f.page, 'text').inputValue(), 'טיוטת גרסה שלי'); await q(f.page, 'refresh').click();
    await f.page.waitForFunction(() => document.querySelector('.doc-body')?.textContent.includes('עדכון אחר')); await q(f.page, 'publish').click();
    await q(f.page, 'editor').waitFor({ state: 'hidden' }); const calls = await f.page.evaluate(() => __docs.calls.filter(c => c.name === 'reviseHrDocument'));
    assert.equal(calls.length, 2); assert.equal(calls[1].data.expected_revision, 2); assert.notEqual(calls[0].data.request_id, calls[1].data.request_id); await f.close();
  });
  await check('individual nudge night warning needs new explicit consent and never acknowledges', async () => {
    const f = await fixture({ superUser: true, localMember: false }); await q(f.page, 'procedures').click(); await open(f.page, 'b');
    await q(f.page, 'search').fill('או'); await q(f.page, 'search-button').click(); await q(f.page, 'candidates').getByRole('button').click(); await f.page.evaluate(() => { __docs.warnNudge = true; });
    await q(f.page, 'nudge').click(); await f.page.waitForFunction(() => document.querySelector('[data-d="message"]').textContent.includes('לא נוצרה תזכורת'));
    await q(f.page, 'send-now').check(); await q(f.page, 'nudge').click(); await f.page.waitForFunction(() => __docs.calls.filter(c => c.name === 'nudgeHrDocument').length === 2 && !document.querySelector('[data-d="nudge"]').disabled);
    const calls = await f.page.evaluate(() => __docs.calls.filter(c => c.name === 'nudgeHrDocument'));
    assert.notEqual(calls[0].data.request_id, calls[1].data.request_id); assert.equal(calls[1].data.send_now, true); assert.equal(await q(f.page, 'send-now').isChecked(), false);
    assert.equal(await f.page.evaluate(() => __docs.calls.some(c => c.name === 'acknowledgeHrDocument')), false); await f.close();
  });
  await check('mobile light/dark text publication stays in viewport with visible input focus', async () => {
    for (const theme of ['light', 'dark']) { const f = await fixture({ role: 'hr_coordinator', width: 390, theme }); await newForm(f.page);
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true); await q(f.page, 'text').focus();
      assert.equal(await q(f.page, 'text').evaluate(e => getComputedStyle(e).outlineStyle !== 'none'), true); await f.close(); }
  });
  assert.deepEqual(hashes(), before); console.log('HR documents browser: ' + passed + '/' + passed + ' passed.');
} finally { for (const c of contexts) await c.close(); await browser.close(); }
