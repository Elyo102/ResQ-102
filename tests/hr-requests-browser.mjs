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
      cases: [], receipts: {}, committed: 0, region: null, appCheck: false, attachments: {}, attachmentCounter: 0, badAttachmentEpoch: null, failGet: false };
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
    t.addCase = (letter, subject, uid = 'owner') => {
      const c = { case_id: letter.repeat(64), owner_uid: uid, subject, status: 'open', revision: 1, created_at_ms: 1, updated_at_ms: 1,
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
        const cases = name === 'listMyHrRequests' ? t.cases.filter(c => c.owner_uid === t.auth.currentUser.uid) : t.cases;
        result = { items: cases.map(({ events, ...c }) => c), next_cursor: null };
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
          byte_length: a.input.byte_length, revision: a.revision, created_at_ms: 1788220800000 });
        const ready = a => ({ attachment_id: a.id, state: 'ready', revision: a.revision, notification_status: 'policy_pending', duplicate: false, epoch });
        let a = Object.values(t.attachments).find(a => data.attachment_id ? a.id === data.attachment_id : a.input.request_id === data.request_id);
        if (name === 'listHrAttachments') {
          const c = t.cases.find(c => c.case_id === data.parent_id);
          result = { items: Object.values(t.attachments).filter(a => a.revision && a.input.parent_id === data.parent_id).map(row), next_cursor: null, revision: c.revision, epoch };
        } else if (name === 'reserveHrAttachment') {
          if (a) assertSame(a.input, data);
          else { a = { id: (++t.attachmentCounter).toString(16).padStart(64, '0'), input: structuredClone(data) }; t.attachments[a.id] = a; }
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
          if (name === 'createHrRequest') { c = t.addCase(String(++t.committed + 2), data.subject, t.auth.currentUser.uid); c.events[0].text = data.text; }
          else {
            if (c.revision !== data.expected_revision) throw Object.assign(new Error('Stale'), { code: 'functions/aborted' });
            if (name === 'nudgeHrRequest' && t.warnNudge && !data.send_now) {
              result = { case_id: c.case_id, revision: c.revision, status: c.status, outcome: 'confirmation_required', notification_status: 'not_queued', duplicate: false };
            } else {
              ++c.revision;
              if (name === 'setHrRequestStatus') c.status = data.status;
              if (name === 'replyHrRequest' && c.owner_uid === t.auth.currentUser.uid && c.status === 'waiting_employee') c.status = 'open';
              c.events.push({ event_id: c.revision.toString(16).padStart(64, '0'), revision: c.revision, actor_uid: t.auth.currentUser.uid,
                kind: name === 'replyHrRequest' ? 'reply' : name === 'setHrRequestStatus' ? 'setStatus' : 'nudge',
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
  assert.deepEqual(hashes(), before); console.log('HR requests browser: ' + passed + '/' + passed + ' passed.');
} finally { for (const context of contexts) await context.close(); await browser.close(); }
