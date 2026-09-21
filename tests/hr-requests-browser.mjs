import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:41995';
const files = ['hr-requests.html', 'hr-requests-client.js', 'hr-requests-ui.js', 'hr-requests-ui.css', 'hr-attachments-ui.js', 'hr-attachments-ui.css'];
const hashes = () => Object.fromEntries(files.map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')]));
const before = hashes(), browser = await chromium.launch(), contexts = new Set();
let passed = 0;
async function fixture({ role = 'firefighter', superUser = false, connected = true, width = 1100, theme = 'light' } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 900 }, colorScheme: theme }); contexts.add(context);
  await context.addInitScript(options => {
    const t = window.__requests = { calls: [], held: [], claimsHeld: [], observers: [], hold: null, reject: null, nextFailure: null,
      cases: [], receipts: {}, committed: 0, region: null, appCheck: false, attachments: {}, attachmentCounter: 0, badAttachmentEpoch: null, failGet: false,
      /* שם ומשמרת חיים ברשומת התחנה, לא על הפנייה — והכפיל
       * שולח אותם רק לתיבת משאבי אנוש, כמו השרת. */
      people: { p1: { owner_name: '\u05d3\u05e0\u05d4 \u05dc\u05d5\u05d9', owner_crew: '\u05de\u05e9\u05de\u05e8\u05ea \u05d1' },
        p2: { owner_name: '\u05d0\u05d1\u05d9 \u05db\u05d4\u05df', owner_crew: '\u05de\u05e9\u05de\u05e8\u05ea \u05d0' } },
      countsFailure: null, countsOverride: null };
    t.makeUser = (uid, role = 'firefighter', superUser = false) => {
      const claims = { stationId: 'synthetic_station', role, super: superUser, auth_time: 1788220800 };
      return { uid, claims, getIdTokenResult: async () => ({ claims }) };
    };
    // Synthetic SDK response identity, matching epochOf; never call the SDK claim getter again.
    t.attachmentEpoch = async () => {
      const u = t.auth.currentUser, c = u.claims;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([u.uid, c.stationId, c.super === true ? 'super_admin' : c.role, c.super === true])));
      return { uid: u.uid, station_id: c.stationId, auth_time: c.auth_time, claims_digest: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('') };
    };
    t.auth = { currentUser: options.connected ? t.makeUser('owner', options.role, options.superUser) : null };
    t.emit = async (uid, role = 'firefighter', superUser = false) => {
      t.auth.currentUser = uid ? t.makeUser(uid, role, superUser) : null;
      await Promise.all(t.observers.map(fn => fn(t.auth.currentUser)));
    };
    t.addCase = (letter, subject, uid = 'owner', extra = {}) => {
      const c = { case_id: letter.repeat(64), owner_uid: uid, subject, status: 'open', revision: 1, created_at_ms: 1, updated_at_ms: 1,
        kind: 'general', ...extra,
        events: [{ event_id: letter.repeat(64), actor_uid: uid, kind: 'create', revision: 1, text: 'Private text <img src=x onerror=alert(1)> https://example.invalid/private' }] };
      t.cases.push(c); return c;
    };
    t.addCase('a', 'פנייה ראשונה'); t.addCase('b', 'פנייה שנייה');
    t.transport = async (name, data) => {
      if (!t.appCheck) throw new Error('App Check ordering violated');
      t.calls.push({ name, data: structuredClone(data), uid: t.auth.currentUser?.uid });
      const reject = t.reject; t.reject = null;
      if (reject) throw Object.assign(new Error('Synthetic private failure text'), { code: 'functions/' + reject });
      let result;
      if (name === 'listMyHrRequests' || name === 'listHrRequestsInbox') {
        let cases = name === 'listMyHrRequests' ? t.cases.filter(c => c.owner_uid === t.auth.currentUser.uid) : t.cases;
        // הכפיל מסנן במקום שהשרת מסנן — בשאילתה, לא בדפדפן.
        if (name === 'listHrRequestsInbox' && data.kind && !t.mixBoxes) cases = cases.filter(c => (c.kind || 'general') === data.kind);
        result = { items: cases.map(({ events, ...c }) => ({
          ...c,
          has_attachment: c.has_attachment === true,
          ...(name === 'listHrRequestsInbox' && t.people[c.owner_uid] ? t.people[c.owner_uid] : {})
        })), next_cursor: null };
      } else if (name === 'countHrRequestBoxes') {
        if (t.countsFailure) throw Object.assign(new Error('Synthetic counts failure'), { code: 'functions/' + t.countsFailure });
        if (t.countsOverride) { result = structuredClone(t.countsOverride); }
        else {
          const kinds = ['sick', 'reserve', 'vacation', 'extended_absence'];
          const states = ['open', 'in_progress', 'waiting_employee', 'closed'];
          const decisions = ['pending', 'approved', 'rejected'];
          const boxes = {};
          for (const kind of kinds) {
            const rows = t.cases.filter(c => (c.kind || 'general') === kind);
            const row = { status: {}, decision: {} };
            for (const state of states) row.status[state] = rows.filter(c => c.status === state).length;
            for (const value of decisions) row.decision[value] = rows.filter(c => c.decision === value).length;
            boxes[kind] = row;
          }
          result = { boxes, drift: false, updated_at_ms: 1788220800000 };
        }
      } else if (name === 'removeMyRequestFile') {
        const c = t.cases.find(c => c.case_id === data.case_id);
        const a = t.attachments[data.attachment_id];
        if (!c || !a) throw Object.assign(new Error('Missing'), { code: 'functions/not-found' });
        // הכפיל אוכף את אותו כלל שהשרת אוכף: רק המעלה.
        if (a.uploader !== t.auth.currentUser.uid) throw Object.assign(new Error('Not yours'), { code: 'functions/permission-denied' });
        a.removed = true;
        c.removed_attachment_ids = (c.removed_attachment_ids || []).concat(a.id);
        ++c.revision;
        c.events.push({ event_id: ('e' + c.revision.toString(16)).padStart(64, '0'), revision: c.revision,
          actor_uid: t.auth.currentUser.uid, kind: 'removeAttachment', attachment_id: a.id,
          attachment_display_name: a.input.display_name, created_at_ms: 1788220800000 });
        result = { case_id: c.case_id, revision: c.revision, status: c.status, outcome: 'saved',
          event_id: c.events[c.events.length - 1].event_id, notification_status: 'no_other_recipient',
          removed_attachment_id: a.id };
        t.receipts[data.request_id] = { data: structuredClone(data), result: structuredClone(result) };
      } else if (name === 'getHrRequest') {
        if (t.failGet) { t.failGet = false; throw Object.assign(new Error('Synthetic refresh failure'), { code: 'functions/unavailable' }); }
        const c = t.cases.find(c => c.case_id === data.case_id);
        if (!c) throw Object.assign(new Error('Missing'), { code: 'functions/not-found' });
        result = { ...c, events: c.events, next_cursor: null };
      } else if (['reserveHrAttachment', 'uploadHrAttachment', 'resumeHrAttachment', 'listHrAttachments', 'downloadHrAttachment'].includes(name)) {
        // Only bounded transport DTOs are doubled. Actual clients, host and attachment controller run unchanged.
        const epoch = await t.attachmentEpoch();
        if (t.badAttachmentEpoch) { Object.assign(epoch, t.badAttachmentEpoch); t.badAttachmentEpoch = null; }
        const row = a => ({ attachment_id: a.id, display_name: a.input.display_name, declared_type: a.input.declared_type,
          byte_length: a.input.byte_length, revision: a.revision, created_at_ms: 1788220800000,
          // המעלה נרשם בכפיל בדיוק כמו `actor_uid` ברשומה האמיתית.
          uploaded_by_me: a.uploader === t.auth.currentUser.uid });
        const ready = a => ({ attachment_id: a.id, state: 'ready', revision: a.revision, notification_status: 'policy_pending', duplicate: false, epoch });
        let a = Object.values(t.attachments).find(a => data.attachment_id ? a.id === data.attachment_id : a.input.request_id === data.request_id);
        if (name === 'listHrAttachments') {
          const c = t.cases.find(c => c.case_id === data.parent_id);
          result = { items: Object.values(t.attachments).filter(a => a.revision && !a.removed && a.input.parent_id === data.parent_id).map(row), next_cursor: null, revision: c.revision, epoch };
        } else if (name === 'reserveHrAttachment') {
          if (a) assertSame(a.input, data);
          else { a = { id: (++t.attachmentCounter).toString(16).padStart(64, '0'), input: structuredClone(data), uploader: t.auth.currentUser.uid }; t.attachments[a.id] = a; }
          result = a.revision ? { ...ready(a), duplicate: true, reserve_expires_ms: 1788221700000 }
            : { attachment_id: a.id, state: 'reserved', duplicate: false, reserve_expires_ms: 1788221700000, epoch };
        } else if (name === 'uploadHrAttachment') {
          const { content_base64, ...intent } = data; assertSame(a.input, intent);
          if (!a.revision) {
            const c = t.cases.find(c => c.case_id === a.input.parent_id);
            a.revision = ++c.revision; a.content_base64 = content_base64;
            c.events.push({ event_id: a.id, actor_uid: t.auth.currentUser.uid, kind: 'attachment', attachment_id: a.id, revision: c.revision, created_at_ms: 1788220800000 });
          }
          result = ready(a);
        } else if (name === 'resumeHrAttachment') {
          result = a.revision ? ready(a) : { attachment_id: a.id, state: 'reserved', resume: 'upload-required', epoch };
        } else {
          const { revision, created_at_ms, ...metadata } = row(a);
          result = { ...metadata, content_base64: a.content_base64, epoch };
        }
      } else {
        const old = t.receipts[data.request_id];
        if (old) { assertSame(old.data, data); result = { ...old.result, duplicate: true }; }
        else {
          let c = t.cases.find(c => c.case_id === data.case_id);
          if (name === 'createHrRequest') {
            const dated = ['sick', 'reserve', 'vacation', 'extended_absence'].includes(data.kind);
            c = t.addCase(String(++t.committed + 2), data.subject, t.auth.currentUser.uid,
              dated ? { kind: data.kind, from_date: data.from_date, to_date: data.to_date,
                decision: 'pending', created_at_ms: Date.parse('2026-09-19T08:00:00+03:00') }
                : { kind: data.kind || 'general' });
            // הערה ריקה אינה שורת טקסט ביומן, בדיוק כמו בשרת.
            if (data.text) c.events[0].text = data.text; else delete c.events[0].text;
          }
          else {
            if (c.revision !== data.expected_revision) throw Object.assign(new Error('Stale'), { code: 'functions/aborted' });
            if (name === 'decideMyStationReport' && c.owner_uid === t.auth.currentUser.uid) {
              throw Object.assign(new Error('Own report'), { code: 'functions/permission-denied' });
            }
            if (name === 'nudgeHrRequest' && t.warnNudge && !data.send_now) {
              result = { case_id: c.case_id, revision: c.revision, status: c.status, outcome: 'confirmation_required', notification_status: 'not_queued', duplicate: false };
            } else {
              ++c.revision;
              if (name === 'setHrRequestStatus') c.status = data.status;
              if (name === 'decideMyStationReport') {
                c.decision = data.decision; c.decided_by = t.auth.currentUser.uid;
                c.decided_at_ms = Date.parse('2026-09-19T12:00:00+03:00');
              }
              if (name === 'replyHrRequest' && c.owner_uid === t.auth.currentUser.uid && c.status === 'waiting_employee') c.status = 'open';
              c.events.push({ event_id: c.revision.toString(16).padStart(64, '0'), revision: c.revision, actor_uid: t.auth.currentUser.uid,
                kind: name === 'replyHrRequest' ? 'reply' : name === 'setHrRequestStatus' ? 'setStatus'
                  : name === 'decideMyStationReport' ? 'setDecision' : 'nudge',
                ...(name === 'replyHrRequest' ? { text: data.text } : name === 'setHrRequestStatus' ? { from_status: 'open', to_status: data.status } : {}) });
            }
          }
          result ||= { case_id: c.case_id, revision: c.revision, status: c.status, outcome: 'saved', notification_status: 'policy_pending', duplicate: false };
          t.receipts[data.request_id] = { data: structuredClone(data), result: structuredClone(result) };
        }
      }
      result = structuredClone(result);
      const nextFailure = t.nextFailure; t.nextFailure = null;
      if (nextFailure) throw Object.assign(new Error('Response lost after synthetic server commit'), { code: 'functions/' + nextFailure });
      if (t.hold === name) { t.hold = null; return new Promise((resolve, reject) => t.held.push({ resolve: () => resolve({ data: result }), reject })); }
      return { data: result };
    };
    function assertSame(a, b) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Retry changed request payload'); }
    t.release = () => t.held.splice(0).forEach(h => h.resolve());
  }, { role, superUser, connected });
  const stubs = {
    '/appcheck.js': 'export async function initAppCheck(){window.__requests.appCheck=true;}',
    '/monitored-functions.js': 'export function getFunctions(a,r){window.__requests.region=r;return {};};export function httpsCallable(f,n){return data=>window.__requests.transport(n,data);}',
    '/firebase-app.js': 'export function initializeApp(){return {};}',
    '/firebase-auth.js': 'export function getAuth(){return window.__requests.auth;} export function onIdTokenChanged(auth,cb){window.__requests.observers.push(cb);queueMicrotask(()=>cb(auth.currentUser));return ()=>{};}'
  };
  await context.route('**/*', async route => {
    const url = new URL(route.request().url()), key = url.hostname === 'www.gstatic.com' ? '/' + url.pathname.split('/').pop() : url.pathname;
    if (stubs[key]) return route.fulfill({ status: 200, contentType: 'text/javascript', body: stubs[key] });
    if (url.origin !== origin) return route.abort();
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
  });
  const page = await context.newPage(), errors = []; page.setDefaultTimeout(6000); page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(origin + '/hr-requests.html');
  if (connected && role !== 'district_commander') await page.waitForFunction(() => __requests.calls.some(c => c.name === 'listMyHrRequests'));
  return { page, errors, close: async () => { assert.deepEqual(errors, []); await context.close(); contexts.delete(context); } };
}
const q = (page, key) => page.locator('[data-r="' + key + '"]');
async function open(page, letter = 'a') { await page.locator('[data-case="' + letter.repeat(64) + '"]').click(); await q(page, 'reply-form').waitFor({ state: 'visible' }); }
const attachmentBytes = Buffer.from('%PDF-1.4\nsynthetic composed request fixture\n%%EOF');
async function chooseAttachment(page) {
  await q(page, 'attachments').locator('input[type=file]').setInputFiles({ name: 'request-private.pdf', mimeType: 'application/pdf', buffer: attachmentBytes });
  await q(page, 'attachments').locator('.hra-item[data-state="chosen"]').waitFor();
}
async function check(name, fn) { await fn(); ++passed; console.log('PASS ' + name); }
try {
  await check('disconnected and unsupported role shells make no calls and contain no private data', async () => {
    for (const options of [{ connected: false }, { role: 'district_commander' }]) {
      const f = await fixture(options); assert.equal(await q(f.page, 'workspace').isHidden(), true);
      assert.equal(await f.page.evaluate(() => __requests.calls.length), 0); assert.equal((await f.page.locator('body').innerText()).includes('Private text'), false); await f.close();
    }
  });
  await check('actual client waits for App Check, uses region, own default and plain private text', async () => {
    const f = await fixture(); await open(f.page);
    assert.equal(await f.page.evaluate(() => __requests.region), 'europe-west1'); assert.equal(await q(f.page, 'inbox').isHidden(), true);
    assert.equal(await q(f.page, 'detail').locator('img,a').count(), 0); assert.ok((await q(f.page, 'detail').innerText()).includes('<img src=x'));
    assert.deepEqual(await f.page.evaluate(() => [location.search, location.hash, localStorage.length, sessionStorage.length]), ['', '', 0, 0]); await f.close();
  });
  await check('attachment history renders its label without reopening waiting_employee or inventing download links', async () => {
    const f = await fixture();
    await f.page.evaluate(() => {
      const c = __requests.cases[0]; c.status = 'waiting_employee'; c.revision = 2;
      c.events.push({ event_id: 'c'.repeat(64), actor_uid: 'owner', kind: 'attachment', attachment_id: 'd'.repeat(64), revision: 2, created_at_ms: 2 });
    });
    await open(f.page);
    assert.equal(await q(f.page, 'detail').locator('.requests-tag').innerText(), 'ממתינה לעובד');
    const entry = q(f.page, 'detail').locator('.requests-event').last();
    assert.equal(await entry.innerText(), 'אני · נוסף קובץ לפנייה'); assert.equal(await entry.locator('a,button,img').count(), 0);
    assert.equal((await q(f.page, 'detail').innerText()).includes('d'.repeat(64)), false);
    assert.equal(await q(f.page, 'nudge').isHidden(), true);
    assert.deepEqual(await f.page.evaluate(() => [__requests.cases[0].status, __requests.cases[0].revision]), ['waiting_employee', 2]);
    assert.ok((await f.page.evaluate(() => __requests.calls.map(c => c.name))).every(name => ['listMyHrRequests', 'getHrRequest', 'listHrAttachments'].includes(name)));
    await f.close();
  });
  await check('attachment malformed or missing identity rejects detail and exposes no attachment controls', async () => {
    for (const attachmentId of ['g'.repeat(64), ['d'.repeat(64)], null, undefined]) {
      const f = await fixture();
      await f.page.evaluate(value => {
        const c = __requests.cases[0]; c.revision = 2;
        c.events.push({ event_id: 'c'.repeat(64), actor_uid: 'owner', kind: 'attachment', revision: 2,
          ...(value === undefined ? {} : { attachment_id: value }) });
      }, attachmentId);
      await f.page.locator('[data-case="' + 'a'.repeat(64) + '"]').click();
      await f.page.waitForFunction(() => document.querySelector('[data-r="message"]').textContent.includes('הפנייה אינה זמינה'));
      assert.equal(await q(f.page, 'detail').locator('.requests-event').count(), 0);
      assert.equal(await q(f.page, 'reply-form').isHidden(), true); assert.equal(await q(f.page, 'actions').isHidden(), true);
      assert.equal((await q(f.page, 'detail').innerText()).includes('נוסף קובץ לפנייה'), false);
      assert.ok((await f.page.evaluate(() => __requests.calls.map(c => c.name))).every(name => ['listMyHrRequests', 'getHrRequest'].includes(name)));
      await f.close();
    }
  });
  await check('composed attachment first empty list uses full epoch and omits request revision', async () => {
    const f = await fixture(); await open(f.page);
    await q(f.page, 'attachments').locator('.hra-empty').filter({ hasText: 'אין קבצים' }).waitFor();
    const calls = await f.page.evaluate(() => __requests.calls.filter(c => c.name === 'listHrAttachments'));
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].data, { parent_kind: 'request', parent_id: 'a'.repeat(64) });
    assert.equal(await q(f.page, 'workspace').isVisible(), true); assert.equal(await q(f.page, 'attachments').locator('.hra-row').count(), 0);
    assert.equal(await f.page.evaluate(() => __requests.calls.some(c => ['reserveHrAttachment', 'uploadHrAttachment'].includes(c.name))), false); await f.close();
  });
  await check('composed wrong auth time or well-shaped wrong digest clears the entire request host', async () => {
    for (const patch of [{ auth_time: 1788220801 }, { claims_digest: 'f'.repeat(64) }]) {
      const f = await fixture(); await f.page.evaluate(patch => { __requests.badAttachmentEpoch = patch; }, patch);
      await f.page.locator('[data-case="' + 'a'.repeat(64) + '"]').click();
      await f.page.waitForFunction(() => __requests.calls.some(c => c.name === 'listHrAttachments'));
      await q(f.page, 'workspace').waitFor({ state: 'hidden' });
      assert.equal((await f.page.locator('body').innerText()).includes('Private text'), false);
      assert.equal(await q(f.page, 'attachments').locator('.hra-row:visible,.hra-item:visible').count(), 0); await f.close();
    }
  });
  await check('composed held upload locks host handlers then refreshes the same waiting case without changing its draft', async () => {
    const f = await fixture(); await f.page.evaluate(() => { __requests.cases[0].status = 'waiting_employee'; }); await open(f.page);
    await q(f.page, 'reply').fill('טיוטה נשמרת בזמן צירוף'); await chooseAttachment(f.page);
    await f.page.evaluate(() => { __requests.hold = 'uploadHrAttachment'; });
    await q(f.page, 'attachments').getByRole('button', { name: 'העלו את הקובץ', exact: true }).click();
    await f.page.waitForFunction(() => __requests.held.length === 1);
    for (const key of ['mine', 'refresh', 'new', 'reply', 'reply-save']) assert.equal(await q(f.page, key).isDisabled(), true);
    assert.equal(await f.page.locator('[data-case="' + 'b'.repeat(64) + '"]').isDisabled(), true);
    const beforeNav = await f.page.evaluate(() => __requests.calls.length);
    await q(f.page, 'refresh').dispatchEvent('click'); await q(f.page, 'new').dispatchEvent('click');
    await f.page.locator('[data-case="' + 'b'.repeat(64) + '"]').dispatchEvent('click');
    assert.equal(await f.page.evaluate(() => __requests.calls.length), beforeNav);
    await f.page.evaluate(() => __requests.release());
    await f.page.waitForFunction(() => document.querySelector('[data-r="message"]').textContent.includes('הפנייה רועננה') && !document.querySelector('[data-r="refresh"]').disabled);
    assert.equal(await q(f.page, 'detail').getByRole('heading').innerText(), 'פנייה ראשונה');
    assert.equal(await q(f.page, 'reply').inputValue(), 'טיוטה נשמרת בזמן צירוף');
    assert.equal(await q(f.page, 'detail').locator('.requests-tag').innerText(), 'ממתינה לעובד');
    assert.ok((await q(f.page, 'detail').innerText()).includes('נוסף קובץ לפנייה'));
    const calls = await f.page.evaluate(() => __requests.calls.filter(c => ['reserveHrAttachment', 'uploadHrAttachment'].includes(c.name)));
    assert.equal(calls.length, 2); const { content_base64, ...intent } = calls[1].data; assert.deepEqual(intent, calls[0].data);
    assert.deepEqual(Object.keys(intent).sort(), ['request_id', 'parent_kind', 'parent_id', 'parent_revision', 'display_name', 'declared_type', 'byte_length', 'content_sha256'].sort());
    assert.equal(intent.parent_revision, 1); assert.equal(intent.content_sha256, createHash('sha256').update(attachmentBytes).digest('hex'));
    assert.equal(content_base64, attachmentBytes.toString('base64')); await f.close();
  });
  await check('composed ready result survives parent refresh failure without another upload', async () => {
    const f = await fixture(); await open(f.page); await chooseAttachment(f.page);
    await f.page.evaluate(() => { __requests.failGet = true; });
    await q(f.page, 'attachments').getByRole('button', { name: 'העלו את הקובץ', exact: true }).click();
    await f.page.waitForFunction(() => document.querySelector('[data-r="message"]').textContent.includes('אין להעלות שוב'));
    assert.equal(await f.page.evaluate(() => __requests.calls.filter(c => c.name === 'uploadHrAttachment').length), 1);
    await q(f.page, 'refresh').click();
    assert.equal(await f.page.evaluate(() => __requests.calls.filter(c => c.name === 'uploadHrAttachment').length), 1); await f.close();
  });
  await check('composed identity clear fences a held ready upload response and removes its private card', async () => {
    const f = await fixture(); await open(f.page); await chooseAttachment(f.page);
    await f.page.evaluate(() => { __requests.hold = 'uploadHrAttachment'; });
    await q(f.page, 'attachments').getByRole('button', { name: 'העלו את הקובץ', exact: true }).click();
    await f.page.waitForFunction(() => __requests.held.length === 1); await f.page.evaluate(() => __requests.emit(null));
    const count = await f.page.evaluate(() => __requests.calls.length); await f.page.evaluate(() => __requests.release());
    await q(f.page, 'workspace').waitFor({ state: 'hidden' });
    assert.equal(await f.page.evaluate(() => __requests.calls.length), count);
    assert.equal((await f.page.locator('body').innerText()).includes('request-private.pdf'), false);
    assert.equal(await q(f.page, 'attachments').locator('.hra-item:visible').count(), 0); await f.close();
  });
  await check('HR and signed super can choose inbox; ordinary command sees own view only', async () => {
    for (const options of [{ role: 'hr_coordinator' }, { superUser: true }]) {
      const f = await fixture(options); await q(f.page, 'inbox').click();
      await f.page.waitForFunction(() => __requests.calls.some(c => c.name === 'listHrRequestsInbox')); await open(f.page);
      assert.equal(await q(f.page, 'status-save').isVisible(), true); await f.close();
    }
    const f = await fixture({ role: 'station_commander' }); assert.equal(await q(f.page, 'inbox').isHidden(), true); await f.close();
  });
  await check('lost response after create commit locks edits; Retry preserves exact request and commits once', async () => {
    const f = await fixture(); await q(f.page, 'new').click(); await q(f.page, 'subject').fill('פנייה שנשמרה'); await q(f.page, 'body').fill('תוכן פרטי');
    await f.page.evaluate(() => { __requests.nextFailure = 'unavailable'; }); await q(f.page, 'save').click();
    await q(f.page, 'retry').waitFor({ state: 'visible' }); assert.equal(await q(f.page, 'body').isDisabled(), true); assert.equal(await q(f.page, 'new').isDisabled(), true);
    await q(f.page, 'retry').click(); await q(f.page, 'detail').getByRole('heading', { name: 'פנייה שנשמרה' }).waitFor();
    const calls = await f.page.evaluate(() => __requests.calls.filter(c => c.name === 'createHrRequest'));
    assert.equal(calls.length, 2); assert.deepEqual(calls[0].data, calls[1].data); assert.equal(await f.page.evaluate(() => __requests.committed), 1);
    assert.ok((await q(f.page, 'message').innerText()).includes('אין אישור')); assert.equal(await q(f.page, 'pending').isHidden(), true); await f.close();
  });
  await check('reply CAS keeps draft and waits for explicit refresh and a new user action', async () => {
    const f = await fixture(); await open(f.page); await q(f.page, 'reply').fill('טיוטה שלי');
    await f.page.evaluate(() => { __requests.cases[0].revision = 2; }); await q(f.page, 'reply-save').click();
    await f.page.waitForFunction(() => document.querySelector('[data-r="message"]').textContent.includes('הפנייה השתנתה'));
    assert.equal(await q(f.page, 'reply').inputValue(), 'טיוטה שלי'); assert.equal(await f.page.evaluate(() => __requests.calls.filter(c => c.name === 'replyHrRequest').length), 1);
    await q(f.page, 'refresh').click(); await q(f.page, 'reply-save').waitFor({ state: 'visible' }); await q(f.page, 'reply-save').click();
    await f.page.waitForFunction(() => document.querySelector('[data-r="reply"]').value === '');
    const calls = await f.page.evaluate(() => __requests.calls.filter(c => c.name === 'replyHrRequest'));
    assert.equal(calls[1].data.expected_revision, 2); assert.notEqual(calls[0].data.request_id, calls[1].data.request_id); await f.close();
  });
  await check('night nudge warning creates fresh explicitly consented action and resets checkbox', async () => {
    const f = await fixture(); await open(f.page); await f.page.evaluate(() => { __requests.warnNudge = true; }); await q(f.page, 'nudge').click();
    await f.page.waitForFunction(() => document.querySelector('[data-r="message"]').textContent.includes('לא נוצרה תזכורת'));
    await q(f.page, 'send-now').check(); await q(f.page, 'nudge').click();
    await f.page.waitForFunction(() => __requests.calls.filter(c => c.name === 'nudgeHrRequest').length === 2 && !document.querySelector('[data-r="nudge"]').disabled);
    const calls = await f.page.evaluate(() => __requests.calls.filter(c => c.name === 'nudgeHrRequest'));
    assert.equal(calls[0].data.send_now, false); assert.equal(calls[1].data.send_now, true); assert.notEqual(calls[0].data.request_id, calls[1].data.request_id);
    assert.equal(await q(f.page, 'send-now').isChecked(), false); await f.close();
  });
  await check('older detail response cannot replace a newly selected case', async () => {
    const f = await fixture(); await f.page.evaluate(() => { __requests.hold = 'getHrRequest'; });
    await f.page.locator('[data-case="' + 'a'.repeat(64) + '"]').click(); await f.page.waitForFunction(() => __requests.held.length === 1);
    await open(f.page, 'b'); await f.page.evaluate(() => __requests.release());
    assert.equal(await q(f.page, 'detail').getByRole('heading').innerText(), 'פנייה שנייה'); await f.close();
  });
  await check('identity reset erases private drafts and late committed response cannot touch next identity', async () => {
    const f = await fixture(); await q(f.page, 'new').click(); await q(f.page, 'subject').fill('Old private subject'); await q(f.page, 'body').fill('Old private draft');
    await f.page.evaluate(() => { __requests.hold = 'createHrRequest'; }); await q(f.page, 'save').click(); await f.page.waitForFunction(() => __requests.held.length === 1);
    await f.page.evaluate(() => __requests.emit('next-user')); await q(f.page, 'new').click(); await q(f.page, 'subject').fill('New user draft');
    await f.page.evaluate(() => __requests.release());
    assert.equal(await q(f.page, 'subject').inputValue(), 'New user draft'); assert.equal(await q(f.page, 'body').inputValue(), '');
    assert.equal((await f.page.locator('body').innerText()).includes('Old private'), false); assert.equal(await q(f.page, 'pending').isHidden(), true); await f.close();
  });
  await check('same UID token change and permission denial clear private DOM immediately', async () => {
    const f = await fixture(); await open(f.page); await q(f.page, 'reply').fill('Private unsaved');
    await f.page.evaluate(() => __requests.emit('owner', 'district_commander'));
    assert.equal(await q(f.page, 'workspace').isHidden(), true); assert.equal(await q(f.page, 'reply').inputValue(), '');
    await f.page.evaluate(() => __requests.emit('owner')); await open(f.page);
    await f.page.evaluate(() => { __requests.reject = 'permission-denied'; }); await q(f.page, 'refresh').click();
    await q(f.page, 'workspace').waitFor({ state: 'hidden' }); assert.equal((await f.page.locator('body').innerText()).includes('Private text'), false); await f.close();
  });
  await check('status update preserves an unrelated reply draft and uses explicit revision', async () => {
    const f = await fixture({ role: 'hr_coordinator' }); await open(f.page); await q(f.page, 'reply').fill('טיוטה שטרם נשמרה');
    await q(f.page, 'status').selectOption('waiting_employee'); await q(f.page, 'status-save').click();
    await f.page.waitForFunction(() => __requests.calls.some(c => c.name === 'setHrRequestStatus') && !document.querySelector('[data-r="status-save"]').disabled);
    assert.equal(await q(f.page, 'reply').inputValue(), 'טיוטה שטרם נשמרה');
    const call = await f.page.evaluate(() => __requests.calls.find(c => c.name === 'setHrRequestStatus'));
    assert.equal(call.data.expected_revision, 1); assert.equal(call.data.status, 'waiting_employee'); await f.close();
  });
  await check('mobile light/dark layout stays within viewport and leaves keyboard focus visible', async () => {
    for (const theme of ['light', 'dark']) {
      const f = await fixture({ width: 390, theme }); await open(f.page);
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await q(f.page, 'reply').focus(); assert.equal(await q(f.page, 'reply').evaluate(e => getComputedStyle(e).outlineStyle !== 'none'), true); await f.close();
    }
  });
  /* ======================================================================
   *  הסרת קובץ אישי — מה שרואים, ומה שנשלח
   * ====================================================================== */

  /** מעלה קובץ דרך המסלול האמיתי, ומחזיר את מזהה הקובץ. */
  async function uploadOne(page) {
    await chooseAttachment(page);
    await q(page, 'attachments').locator('button:has-text("העלו את הקובץ")').click();
    await q(page, 'attachments').locator('.hra-row').first().waitFor();
    return page.evaluate(() => document.querySelector('[data-r="attachments"] .hra-row').dataset.id);
  }

  await check('the remove button appears only beside a file this person uploaded', async () => {
    const f = await fixture(); await open(f.page);
    const mine = await uploadOne(f.page);
    assert.equal(await f.page.locator('[data-drop="' + mine + '"]').count(), 1,
      'my own upload offers removal');
    // אותו קובץ בדיוק, רק עם מעלה אחר — הכפתור נעלם.
    await f.page.evaluate((id) => { window.__requests.attachments[id].uploader = 'hr-person'; }, mine);
    await q(f.page, 'attachments').locator('button:has-text("רענון")').click();
    await f.page.waitForFunction((id) => !document.querySelector('[data-drop="' + id + '"]'), mine);
    assert.equal(await f.page.locator('[data-drop="' + mine + '"]').count(), 0,
      'a file uploaded by HR offers no removal to the employee');
    assert.equal(await f.page.locator('[data-pull="' + mine + '"]').count(), 1,
      'but it is still there to download — nothing was hidden by mistake');
    await f.close();
  });

  await check('removing a file calls the request callable, never Storage, and hides the file', async () => {
    const f = await fixture(); await open(f.page);
    const mine = await uploadOne(f.page);
    await f.page.locator('[data-drop="' + mine + '"]').click();
    await f.page.waitForFunction((id) => !document.querySelector('[data-pull="' + id + '"]'), mine);
    const sent = await f.page.evaluate(() => window.__requests.calls.filter(c => c.name === 'removeMyRequestFile'));
    assert.equal(sent.length, 1, 'exactly one removal call');
    assert.equal(sent[0].data.attachment_id, mine);
    assert.equal(typeof sent[0].data.case_id, 'string');
    assert.equal(Number.isSafeInteger(sent[0].data.expected_revision), true,
      'the removal is bound to the revision the screen was showing');
    // ⭐ הלקוח אינו נוגע ב-Storage. לא בקריאה הזו ולא בשום קריאה אחרת.
    const names = await f.page.evaluate(() => window.__requests.calls.map(c => c.name));
    assert.equal(names.some(n => /storage|delete/i.test(n)), false,
      'no client-side storage or delete call exists at all');
    assert.equal(await f.page.locator('[data-pull="' + mine + '"]').count(), 0, 'the file can no longer be downloaded');
    assert.equal(await f.page.locator('[data-drop="' + mine + '"]').count(), 0, 'and it can no longer be removed again');
    await f.close();
  });

  await check('the removed file is reported as removed in the request history', async () => {
    const f = await fixture(); await open(f.page);
    const mine = await uploadOne(f.page);
    await f.page.locator('[data-drop="' + mine + '"]').click();
    await f.page.waitForFunction((id) => !document.querySelector('[data-pull="' + id + '"]'), mine);
    // המסך נטען מחדש מהשרת אחרי ההסרה — לא רענון של כל הדף.
    await f.page.waitForFunction(() => window.__requests.calls.filter(c => c.name === 'getHrRequest').length >= 2);
    const state = await f.page.evaluate(() => {
      const c = window.__requests.cases.find(x => x.case_id === 'a'.repeat(64));
      return { removed: c.removed_attachment_ids || [], kinds: c.events.map(e => e.kind) };
    });
    assert.equal(state.removed.length, 1, 'the case records what was removed');
    assert.equal(state.kinds.includes('removeAttachment'), true, 'and the history carries the removal');
    assert.equal(state.kinds.includes('attachment'), true, 'the original attachment row survives it');
    await f.close();
  });

  await check('a viewer who does not own the request is offered no removal, even for a file they uploaded', async () => {
    const f = await fixture({ role: 'hr_coordinator' });
    /* ⭐ הבדיקה מכוונת אל כלל הבעלות ואל שום דבר אחר: הקובץ מוצג,
     * הוא ניתן להורדה, ו-`uploaded_by_me` שלו **אמת** — המעלה הוא
     * הצופה עצמו. הדבר היחיד שחסר הוא הבעלות על הפנייה. */
    await f.page.evaluate(() => {
      const t = window.__requests;
      t.addCase('c', 'פנייה של עובד אחר', 'someone-else');
      const id = 'f'.repeat(64);
      t.attachments[id] = { id, uploader: t.auth.currentUser.uid, revision: 1,
        input: { display_name: 'x.pdf', declared_type: 'application/pdf', byte_length: 10,
          parent_id: 'c'.repeat(64) } };
    });
    await q(f.page, 'inbox').click();
    await f.page.locator('[data-case="' + 'c'.repeat(64) + '"]').click();
    await q(f.page, 'attachments').locator('.hra-row').first().waitFor();
    const row = await f.page.evaluate(() => {
      const el = document.querySelector('[data-r="attachments"] .hra-row');
      return { id: el.dataset.id, pull: !!el.querySelector('[data-pull]'), drop: !!el.querySelector('[data-drop]') };
    });
    assert.equal(row.id, 'f'.repeat(64), 'the file really is on screen');
    assert.equal(row.pull, true, 'and it really is downloadable — the row is not empty');
    assert.equal(row.drop, false, 'but ownership of the request is missing, so there is no removal');
    await f.close();
  });

  await check('the confirmation says what removal actually does, and says nothing about deleting', async () => {
    const f = await fixture(); await open(f.page);
    const mine = await uploadOne(f.page);
    const asked = [];
    f.page.on('dialog', d => { asked.push(d.message()); });
    await f.page.locator('[data-drop="' + mine + '"]').click();
    await f.page.waitForFunction((id) => !document.querySelector('[data-pull="' + id + '"]'), mine);
    assert.equal(asked.length >= 1, true, 'the person is asked first');
    assert.equal(asked[0], 'להסיר את הקובץ מהפנייה? הקובץ יוסתר ולא יהיה ניתן להורדה דרך המערכת.');
    assert.equal(/נמחק|מחיקה לצמיתות/.test(asked[0]), false,
      'the wording never promises a deletion that does not happen');
    await f.close();
  });

  /* ======================================================================
   *  דיווח מחלה / מילואים / חופשה / היעדרות ממושכת
   *
   *  שני צדדים: מה העובד פותח, ומה משאבי אנוש רואה ומכריעה.
   * ====================================================================== */

  const REPORT = { kind: 'sick', from: '2026-09-10', to: '2026-09-12' };
  const dated = (over = {}) => ({ kind: 'sick', from_date: '2026-09-10', to_date: '2026-09-12',
    decision: 'pending', created_at_ms: Date.parse('2026-09-19T08:00:00+03:00'), ...over });

  /** ממלא את טופס הדיווח ופותח אותו. */
  async function openReport(page, { kind, from, to } = REPORT, note = '') {
    await q(page, 'new').click();
    await q(page, 'kind').selectOption(kind);
    await q(page, 'from-date').fill(from); await q(page, 'to-date').fill(to);
    if (note) await q(page, 'body').fill(note);
    await q(page, 'save').click();
    await page.waitForFunction(() => __requests.calls.some(c => c.name === 'createHrRequest'));
  }

  await check('the employee form sends the kind and the range, and nothing it was not given', async () => {
    const f = await fixture(); await openReport(f.page, REPORT, 'מצורף אישור.');
    const call = await f.page.evaluate(() => __requests.calls.find(c => c.name === 'createHrRequest'));
    assert.equal(call.data.kind, 'sick');
    assert.equal(call.data.from_date, '2026-09-10');
    assert.equal(call.data.to_date, '2026-09-12');
    assert.equal(call.data.text, 'מצורף אישור.');
    // ⭐ הנושא נגזר משלושת השדות שהעובד מילא, ואינו שדה נפרד.
    assert.equal(call.data.subject, 'מחלה · 2026-09-10 — 2026-09-12');
    assert.equal(Object.hasOwn(call.data, 'decision'), false, 'the browser never proposes a decision');
    assert.equal(Object.hasOwn(call.data, 'retroactive'), false, 'and never a retroactive flag');
    await f.close();
  });

  await check('an ordinary request still carries no dates at all', async () => {
    const f = await fixture(); await q(f.page, 'new').click();
    assert.equal(await q(f.page, 'dates').isHidden(), true, 'the date fields are not even shown');
    await q(f.page, 'subject').fill('שאלה'); await q(f.page, 'body').fill('תוכן');
    await q(f.page, 'save').click();
    await f.page.waitForFunction(() => __requests.calls.some(c => c.name === 'createHrRequest'));
    const call = await f.page.evaluate(() => __requests.calls.find(c => c.name === 'createHrRequest'));
    assert.equal(call.data.kind, 'general');
    assert.equal(Object.hasOwn(call.data, 'from_date'), false);
    assert.equal(Object.hasOwn(call.data, 'to_date'), false);
    await f.close();
  });

  await check('the note is optional on a report and required on an ordinary request', async () => {
    const f = await fixture();
    // דיווח בלי הערה נשלח בפועל.
    await openReport(f.page);
    assert.equal(await f.page.evaluate(() => __requests.calls.filter(c => c.name === 'createHrRequest').length), 1);
    // ופנייה כללית ריקה אינה נשלחת כלל — הדפדפן עוצר אותה.
    await q(f.page, 'new').click(); await q(f.page, 'subject').fill('שאלה');
    await q(f.page, 'save').click();
    await f.page.waitForTimeout(150);
    assert.equal(await f.page.evaluate(() => __requests.calls.filter(c => c.name === 'createHrRequest').length), 1,
      'an empty ordinary request never reaches the server');
    await f.close();
  });

  /* הניסוח עודכן למשפט שהוכרע: „הדיווח התקבל במשאבי
   * אנוש וממתין לטיפול." מה שהבדיקה באמת שומרת עליו אינו
   * הניסוח אלא הגבול: אף משפט במסך אינו אומר שהסידור
   * עודכן, כי אין שום כתיבה לסידור במסלול הזה. */
  await check('the receipt says HR has it and never says the schedule moved', async () => {
    const f = await fixture(); await openReport(f.page);
    await f.page.waitForFunction(() => document.querySelector('[data-r="message"]').textContent
      .includes('הדיווח התקבל במשאבי אנוש וממתין לטיפול'));
    // ואזור הקבצים באמת פתוח עכשיו, ולא רק מובטח.
    await q(f.page, 'attachments').locator('input[type=file]').waitFor();
    const detail = await q(f.page, 'detail').innerText();
    assert.ok(detail.includes('הדיווח התקבל במשאבי אנוש וממתין לטיפול'),
      'and the detail itself says it, not only the passing status line');
    const body = await f.page.locator('body').innerText();
    assert.equal(/הסידור עודכן|עודכן בסידור|הוסר מהסידור|שובצת|שיבוץ עודכן/.test(body), false, body.slice(0, 400));
    await f.close();
  });

  await check('a report reads as kind, range, pending, and says plainly that it is retroactive', async () => {
    const f = await fixture(); await openReport(f.page);
    const detail = await q(f.page, 'detail').innerText();
    assert.ok(detail.includes('מחלה · 2026-09-10 — 2026-09-12'), detail);
    assert.ok(detail.includes('מצב הדיווח: ממתין להכרעה'), detail);
    /* ⭐ 9 ימים בין 10.9 ל-19.9, נגזר מהתאריך ומזמן הפתיחה שהשרת
     * חתם עליו — אין שדה שהלקוח יכול לשקר בו. */
    assert.ok(detail.includes('דיווח רטרואקטיבי · 9 ימים אחרי'), detail);
    await f.close();
  });

  await check('HR approves a report and the screen then says who decided and when', async () => {
    const f = await fixture({ role: 'hr_coordinator' });
    await f.page.evaluate(() => __requests.addCase('c', 'מחלה של עובד', 'someone-else',
      { kind: 'sick', from_date: '2026-09-10', to_date: '2026-09-12', decision: 'pending',
        created_at_ms: Date.parse('2026-09-19T08:00:00+03:00') }));
    await q(f.page, 'inbox').click();
    await open(f.page, 'c');
    assert.equal(await q(f.page, 'approve').isVisible(), true);
    assert.equal(await q(f.page, 'reject').isVisible(), true);
    await q(f.page, 'approve').click();
    await f.page.waitForFunction(() => __requests.calls.some(c => c.name === 'decideMyStationReport'));
    const call = await f.page.evaluate(() => __requests.calls.find(c => c.name === 'decideMyStationReport'));
    assert.equal(call.data.decision, 'approved');
    assert.equal(call.data.expected_revision, 1, 'bound to the revision the screen was showing');
    await f.page.waitForFunction(() => document.querySelector('[data-r="detail"]').innerText.includes('מצב הדיווח: אושר'));
    const detail = await q(f.page, 'detail').innerText();
    assert.ok(detail.includes('הכריע: אני'), detail);
    assert.ok(/הכריע: אני · .*19/.test(detail), detail);
    assert.ok(detail.includes('הכרעה בדיווח'), 'and the history carries the decision line');
    // ואחרי שאושר, אין לאשר שוב.
    assert.equal(await q(f.page, 'approve').isDisabled(), true);
    assert.equal(await q(f.page, 'reject').isDisabled(), false, 'but a decision can still be reversed to rejected');
    await f.close();
  });

  await check('HR is offered no decision on a report of their own', async () => {
    const f = await fixture({ role: 'hr_coordinator' });
    /* ⭐ הבדיקה מכוונת אל הבעלות ולשום דבר אחר: אותה רשומה
     * בדיוק, אותה סמכות ואותו סוג — רק הבעלים שונים. */
    await f.page.evaluate(() => {
      __requests.addCase('c', 'המחלה שלי', __requests.auth.currentUser.uid,
        { kind: 'sick', from_date: '2026-09-10', to_date: '2026-09-12', decision: 'pending',
          created_at_ms: Date.parse('2026-09-19T08:00:00+03:00') });
      __requests.addCase('d', 'מחלה של אחר', 'someone-else',
        { kind: 'sick', from_date: '2026-09-10', to_date: '2026-09-12', decision: 'pending',
          created_at_ms: Date.parse('2026-09-19T08:00:00+03:00') });
    });
    await q(f.page, 'inbox').click();
    await open(f.page, 'c');
    assert.equal(await q(f.page, 'approve').isHidden(), true, 'no approval of my own absence');
    assert.equal(await q(f.page, 'reject').isHidden(), true);
    await open(f.page, 'd');
    assert.equal(await q(f.page, 'approve').isVisible(), true,
      'but the very same screen offers it on someone else\u2019s report');
    await f.close();
  });

  await check('an ordinary firefighter is offered no decision, and no boxes at all', async () => {
    const f = await fixture();
    await f.page.evaluate(() => __requests.addCase('c', 'מחלה שלי', 'owner',
      { kind: 'sick', from_date: '2026-09-10', to_date: '2026-09-12', decision: 'pending',
        created_at_ms: Date.parse('2026-09-19T08:00:00+03:00') }));
    await q(f.page, 'refresh').click();
    await open(f.page, 'c');
    assert.equal(await q(f.page, 'approve').isHidden(), true);
    assert.equal(await q(f.page, 'reject').isHidden(), true);
    for (const key of ['inbox', 'box-sick', 'box-reserve', 'box-vacation', 'box-extended', 'box-hours']) {
      assert.equal(await q(f.page, key).isHidden(), true, key + ' is not for a firefighter');
    }
    assert.equal(await f.page.evaluate(() => __requests.calls.some(c => c.name === 'countHrRequestBoxes')), false,
      'and the counters are never asked for on behalf of someone who has no boxes');
    await f.close();
  });

  /* ----------------------------------------------------------------------
   *  תיבות העבודה
   * -------------------------------------------------------------------- */

  await check('each box asks the server for its own kind and shows nothing else', async () => {
    const f = await fixture({ role: 'hr_coordinator' });
    await f.page.evaluate(() => {
      const t = __requests;
      const at = Date.parse('2026-09-19T08:00:00+03:00');
      const base = { from_date: '2026-09-10', to_date: '2026-09-12', decision: 'pending', created_at_ms: at };
      t.addCase('c', 'דיווח מחלה', 'p1', { ...base, kind: 'sick' });
      t.addCase('d', 'דיווח מילואים', 'p2', { ...base, kind: 'reserve' });
      t.addCase('e', 'בקשת חופשה', 'p3', { ...base, kind: 'vacation' });
      t.addCase('f', 'היעדרות ממושכת', 'p4', { ...base, kind: 'extended_absence' });
    });
    const boxes = [['box-sick', 'sick', 'c', 'תיבת מחלה'],
      ['box-reserve', 'reserve', 'd', 'תיבת מילואים'],
      ['box-vacation', 'vacation', 'e', 'תיבת חופשה'],
      ['box-extended', 'extended_absence', 'f', 'תיבת היעדרות ממושכת']];
    for (const [key, kind, letter, title] of boxes) {
      await q(f.page, key).click();
      await f.page.waitForFunction(k => __requests.calls.some(c => c.name === 'listHrRequestsInbox' && c.data.kind === k), kind);
      await f.page.waitForFunction(l => document.querySelector('[data-case="' + l.repeat(64) + '"]'), letter);
      assert.equal(await q(f.page, 'list-title').innerText(), title);
      const shown = await f.page.evaluate(() =>
        [...document.querySelectorAll('[data-r="list"] button')].map(b => b.dataset.case));
      assert.deepEqual(shown, [letter.repeat(64)],
        'the ' + kind + ' box holds exactly its own report and nothing else');
      // ⭐ ובמפורש: שלושת הסוגים האחרים אינם שם.
      for (const [, other, otherLetter] of boxes) {
        if (other === kind) continue;
        assert.equal(shown.includes(otherLetter.repeat(64)), false,
          'a ' + other + ' report must never appear in the ' + kind + ' box');
      }
    }
    // „כל הפניות" מבקשת בלי סינון, ומחזירה את הכל.
    await q(f.page, 'inbox').click();
    await f.page.waitForFunction(() => document.querySelectorAll('[data-r="list"] button').length >= 6);
    const all = await f.page.evaluate(() => __requests.calls.filter(c => c.name === 'listHrRequestsInbox'));
    assert.equal(Object.hasOwn(all[all.length - 1].data, 'kind'), false, 'the all box sends no filter');
    await f.close();
  });

  await check('a box refuses a page that carries the wrong kind instead of showing it under its title', async () => {
    const f = await fixture({ role: 'hr_coordinator' });
    await f.page.evaluate(() => {
      __requests.mixBoxes = true;
      __requests.addCase('d', 'דיווח מילואים', 'p2',
        { kind: 'reserve', from_date: '2026-09-10', to_date: '2026-09-12', decision: 'pending',
          created_at_ms: Date.parse('2026-09-19T08:00:00+03:00') });
    });
    await q(f.page, 'box-sick').click();
    await f.page.waitForFunction(() => document.querySelector('[data-r="message"]').textContent.includes('רשימת הפניות אינה זמינה'));
    assert.equal(await f.page.locator('[data-case="' + 'd'.repeat(64) + '"]').count(), 0,
      'a reserve report is never rendered under the sickness title');
    await f.close();
  });

  await check('hours reports are not in this screen at all', async () => {
    const f = await fixture({ role: 'hr_coordinator' });
    const body = await f.page.locator('body').innerText();
    assert.equal(/דוח שעות|מאזן שעות/.test(body), false, body.slice(0, 400));
    // והמסך אומר במפורש איפה הם כן, כדי שלא יחפשו אותם כאן.
    assert.ok(body.includes('דוחות השעות אינם נמצאים במסך הזה'), body.slice(0, 400));
    await q(f.page, 'inbox').click();
    await f.page.waitForFunction(() => __requests.calls.some(c => c.name === 'listHrRequestsInbox'));
    const names = await f.page.evaluate(() => __requests.calls.map(c => c.name));
    assert.equal(names.some(n => /monthly|hours|attendance/i.test(n)), false,
      'this screen never calls the hours side at all');
    await f.close();
  });

  /* ----------------------------------------------------------------------
   *  מוני התיבות, שם ומשמרת, והסיכום בטופס
   * -------------------------------------------------------------------- */

  await check('each box carries its open count, and both axes in the accessible name', async () => {
    const f = await fixture({ role: 'hr_coordinator' });
    await f.page.evaluate(() => {
      const t = __requests, at = Date.parse('2026-09-19T08:00:00+03:00');
      const base = { from_date: '2026-09-10', to_date: '2026-09-12', created_at_ms: at };
      t.addCase('c', 'דיווח מחלה', 'p1', { ...base, kind: 'sick', decision: 'pending' });
      t.addCase('d', 'דיווח שני', 'p2', { ...base, kind: 'sick', decision: 'pending', status: 'in_progress' });
      t.addCase('e', 'דיווח סגור', 'p1', { ...base, kind: 'sick', decision: 'approved', status: 'closed',
        decided_by: 'hr', decided_at_ms: at });
      t.addCase('f', 'מילואים', 'p2', { ...base, kind: 'reserve', decision: 'pending' });
    });
    await q(f.page, 'refresh').click();
    await f.page.waitForFunction(() => document.querySelector('[data-r="count-sick"]').textContent === '2');
    // שתיים פתוחות, לא שלוש: סגורה אינה על שולחן אף אחד.
    assert.equal(await q(f.page, 'count-sick').innerText(), '2');
    assert.equal(await q(f.page, 'count-reserve').innerText(), '1');
    assert.equal(await q(f.page, 'count-vacation').innerText(), '0');
    const label = await q(f.page, 'box-sick').getAttribute('aria-label');
    // שני הצירים נפרדים בשם הנגיש, ולא מאוחדים למספר אחד.
    assert.ok(label.includes('ממתינים להכרעה 2'), label);
    assert.ok(label.includes('פתוחות 1'), label);
    assert.ok(label.includes('בטיפול 1'), label);
    assert.ok(label.includes('אושרו 1'), label);
    assert.ok(label.includes('נסגרו 1'), label);
    await f.close();
  });

  await check('a drifting tally says so instead of presenting the number as a fact', async () => {
    const f = await fixture({ role: 'hr_coordinator' });
    await f.page.evaluate(() => {
      __requests.countsOverride = { drift: true, updated_at_ms: 1, boxes: Object.fromEntries(
        ['sick', 'reserve', 'vacation', 'extended_absence'].map(k => [k, {
          status: { open: 4, in_progress: 0, waiting_employee: 0, closed: 0 },
          decision: { pending: 4, approved: 0, rejected: 0 } }])) };
    });
    await q(f.page, 'refresh').click();
    await f.page.waitForFunction(() => !document.querySelector('[data-r="counts-note"]').hidden);
    assert.ok((await q(f.page, 'counts-note').innerText()).includes('משוערים'));
    assert.ok((await q(f.page, 'box-sick').getAttribute('aria-label')).includes('המונים משוערים'));
    await f.close();
  });

  await check('a malformed or failed tally leaves no number at all, never a wrong one', async () => {
    for (const patch of [{ countsFailure: 'unavailable' },
      { countsOverride: { boxes: { sick: { status: {}, decision: {} } }, drift: false } },
      { countsOverride: { boxes: null, drift: false } }]) {
      const f = await fixture({ role: 'hr_coordinator' });
      await f.page.evaluate(value => Object.assign(__requests, value), patch);
      await q(f.page, 'refresh').click();
      await f.page.waitForFunction(() => __requests.calls.filter(c => c.name === 'countHrRequestBoxes').length >= 2);
      await f.page.waitForTimeout(80);
      assert.equal(await q(f.page, 'count-sick').innerText(), '');
      assert.equal(await q(f.page, 'counts-note').isHidden(), true);
      // והמסך עצמו עוד עובד: מונה שנכשל אינו מפיל רשימה.
      assert.equal(await q(f.page, 'inbox').isHidden(), false);
      await f.close();
    }
  });

  await check('an HR row carries who, which crew, which range and whether an approval is attached', async () => {
    const f = await fixture({ role: 'hr_coordinator' });
    await f.page.evaluate(() => {
      __requests.addCase('c', 'דיווח מחלה', 'p1', { kind: 'sick', from_date: '2026-09-10',
        to_date: '2026-09-12', decision: 'pending', has_attachment: true,
        created_at_ms: Date.parse('2026-09-19T08:00:00+03:00') });
    });
    await q(f.page, 'box-sick').click();
    await f.page.waitForFunction(() => document.querySelector('[data-case="' + 'c'.repeat(64) + '"]'));
    const row = await f.page.locator('[data-case="' + 'c'.repeat(64) + '"]').innerText();
    assert.ok(row.includes('דנה לוי'), row);
    assert.ok(row.includes('משמרת ב'), row);
    assert.ok(row.includes('2026-09-10 — 2026-09-12'), row);
    assert.ok(row.includes('3 ימים'), row);
    assert.ok(row.includes('אישור מצורף'), row);
    assert.ok(row.includes('ממתין להכרעה'), row);
    // ו-uid של אף אדם אינו על המסך.
    assert.equal((await f.page.locator('body').innerText()).includes('p1'), false);
    await f.close();
  });

  await check('the employee sees no name or crew on their own rows, because the server sends none', async () => {
    const f = await fixture();
    await q(f.page, 'refresh').click();
    await f.page.waitForFunction(() => document.querySelector('[data-case="' + 'a'.repeat(64) + '"]'));
    const row = await f.page.locator('[data-case="' + 'a'.repeat(64) + '"]').innerText();
    assert.equal(/דנה לוי|אבי כהן/.test(row), false, row);
    const inbox = await f.page.evaluate(() => __requests.calls.filter(c => c.name === 'listHrRequestsInbox').length);
    assert.equal(inbox, 0, 'an employee never reaches the inbox path that carries names');
    await f.close();
  });

  await check('status is colour AND text: the label is the exact stored word, the tone is an attribute', async () => {
    const f = await fixture({ role: 'hr_coordinator' });
    await f.page.evaluate(() => {
      const at = Date.parse('2026-09-19T08:00:00+03:00');
      const base = { kind: 'sick', from_date: '2026-09-10', to_date: '2026-09-12', decision: 'pending', created_at_ms: at };
      __requests.addCase('c', 'א', 'p1', { ...base, status: 'open' });
      __requests.addCase('d', 'ב', 'p1', { ...base, status: 'in_progress' });
      __requests.addCase('e', 'ג', 'p1', { ...base, status: 'waiting_employee' });
      __requests.addCase('f', 'ד', 'p1', { ...base, status: 'closed', decision: 'rejected',
        decided_by: 'hr', decided_at_ms: at });
    });
    await q(f.page, 'box-sick').click();
    await f.page.waitForFunction(() => document.querySelectorAll('[data-r="list"] .requests-tag').length === 4);
    const seen = await f.page.evaluate(() => [...document.querySelectorAll('[data-r="list"] .requests-tag')]
      .map(e => [e.dataset.state, e.textContent, getComputedStyle(e).color]));
    assert.deepEqual(seen.map(([state, text]) => [state, text]), [
      ['open', 'פתוחה'], ['in_progress', 'בטיפול'],
      ['waiting_employee', 'ממתינה לעובד'], ['closed', 'סגורה']]);
    // ארבעה גוונים שונים — וגם ארבע מילים שונות.
    assert.equal(new Set(seen.map(([, , color]) => color)).size, 4, JSON.stringify(seen));
    const decisions = await f.page.evaluate(() => [...document.querySelectorAll('[data-r="list"] .requests-decision')]
      .map(e => [e.dataset.decision, e.textContent]));
    assert.deepEqual(decisions, [['pending', 'ממתין להכרעה'], ['pending', 'ממתין להכרעה'],
      ['pending', 'ממתין להכרעה'], ['rejected', 'נדחה']]);
    await f.close();
  });

  await check('the summary sits inside the form, follows the dates, and one press sends', async () => {
    const f = await fixture();
    await q(f.page, 'new').click();
    assert.equal(await q(f.page, 'summary').isHidden(), true, 'an ordinary request gets no absence summary');
    await q(f.page, 'kind').selectOption('sick');
    await f.page.waitForFunction(() => !document.querySelector('[data-r="summary"]').hidden);
    assert.ok((await q(f.page, 'summary').innerText()).includes('טרם הוזן'));
    await q(f.page, 'from-date').fill('2026-09-10');
    await q(f.page, 'to-date').fill('2026-09-12');
    await f.page.waitForFunction(() => document.querySelector('[data-r="summary"]').innerText.includes('3 ימים'));
    let summary = await q(f.page, 'summary').innerText();
    assert.ok(summary.includes('מחלה'), summary);
    assert.ok(summary.includes('2026-09-10 — 2026-09-12'), summary);
    assert.ok(summary.includes('ללא הערה'), summary);
    await q(f.page, 'body').fill('מצורף אישור.');
    await f.page.waitForFunction(() => document.querySelector('[data-r="summary"]').innerText.includes('צורפה הערה'));
    // טווח הפוך נאמר במפורש לפני השליחה, ולא מתגלה בתשובת השרת.
    await q(f.page, 'to-date').fill('2026-09-01');
    await f.page.waitForFunction(() => document.querySelector('[data-r="summary"]').innerText.includes('הטווח אינו תקין'));
    await q(f.page, 'to-date').fill('2026-09-12');
    await f.page.waitForFunction(() => document.querySelector('[data-r="summary"]').innerText.includes('3 ימים'));
    const before = await f.page.evaluate(() => __requests.calls.length);
    await q(f.page, 'save').click();
    await f.page.waitForFunction(() => __requests.calls.some(c => c.name === 'createHrRequest'));
    // לחיצה אחת: אין דיאלוג בינה לבין השליחה.
    assert.equal(await f.page.evaluate(() => __requests.calls.filter(c => c.name === 'createHrRequest').length), 1);
    assert.ok(await f.page.evaluate(n => __requests.calls.length > n, before));
    await f.close();
  });

  await check('while sending, the button says so, reports aria-busy, and a second press writes nothing', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __requests.hold = 'createHrRequest'; });
    await q(f.page, 'new').click();
    await q(f.page, 'kind').selectOption('sick');
    await q(f.page, 'from-date').fill('2026-09-10');
    await q(f.page, 'to-date').fill('2026-09-12');
    await q(f.page, 'save').click();
    await f.page.waitForFunction(() => __requests.held.length === 1);
    assert.equal(await q(f.page, 'save').innerText(), 'שולח…');
    assert.equal(await q(f.page, 'save').getAttribute('aria-busy'), 'true');
    assert.equal(await q(f.page, 'save').isDisabled(), true);
    await q(f.page, 'save').dispatchEvent('click');
    await q(f.page, 'save').dispatchEvent('click');
    assert.equal(await f.page.evaluate(() => __requests.calls.filter(c => c.name === 'createHrRequest').length), 1);
    await f.page.evaluate(() => __requests.release());
    await f.page.waitForFunction(() => document.querySelector('[data-r="save"]').getAttribute('aria-busy') === 'false');
    assert.notEqual(await q(f.page, 'save').innerText(), 'שולח…');
    await f.close();
  });

  await check('the box row survives 320, 360 and 390 with 44 pixel targets and no sideways scroll', async () => {
    const f = await fixture({ role: 'hr_coordinator' });
    await q(f.page, 'refresh').click();
    await f.page.waitForFunction(() => document.querySelector('[data-r="count-sick"]').textContent !== '');
    for (const width of [320, 360, 390]) {
      await f.page.setViewportSize({ width, height: 780 });
      await f.page.waitForTimeout(40);
      const overflow = await f.page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, 'horizontal overflow ' + overflow + ' at ' + width);
      for (const key of ['box-sick', 'box-reserve', 'box-vacation', 'box-extended', 'box-hours']) {
        const box = await q(f.page, key).boundingBox();
        assert.ok(box && box.height >= 44, key + ' is ' + JSON.stringify(box) + ' at ' + width);
        assert.ok(box.width >= 44, key + ' is narrower than 44 at ' + width);
      }
    }
    await f.close();
  });

  await check('removing a file leaves the request readable, decision and all', async () => {
    /* רגרסיה: שורת היומן של הסרה היא סוג חדש. מסך שאינו
     * מכיר אותו פוסל את כל הפנייה ומציג „הפנייה אינה זמינה" —
     * אחרי פעולה שהצליחה. */
    const f = await fixture(); await open(f.page);
    const mine = await uploadOne(f.page);
    await f.page.locator('[data-drop="' + mine + '"]').click();
    await f.page.waitForFunction((id) => !document.querySelector('[data-pull="' + id + '"]'), mine);
    await f.page.waitForFunction(() => __requests.calls.filter(c => c.name === 'getHrRequest').length >= 2);
    /* המתנה עד שהפנייה אכן נטענה מחדש — או עד שנכשלה.
     * שתי התוצאות נקלטות כאן, ואז נבדק איזו מהן התקבלה. */
    await f.page.waitForFunction(() => {
      const text = document.querySelector('[data-r="detail"]').innerText;
      return text.includes('הוסר קובץ מהפנייה')
        || document.querySelector('[data-r="message"]').textContent.includes('אינה זמינה');
    });
    const detail = await q(f.page, 'detail').innerText();
    assert.ok(detail.includes('הוסר קובץ מהפנייה'), detail);
    assert.ok(detail.includes('request-private.pdf'), 'the removed file is named in the audit line');
    assert.equal(await q(f.page, 'message').innerText().then(t => t.includes('אינה זמינה')), false);
    await f.close();
  });

  assert.deepEqual(hashes(), before); console.log('HR requests browser: ' + passed + '/' + passed + ' passed.');
} finally { for (const context of contexts) await context.close(); await browser.close(); }
