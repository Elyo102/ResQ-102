/* ממשק הקבצים הפרטיים · בדיקות דפדפן.
 *
 * הכפיל כאן מחזיר את מבני התשובה של המודול השרתי כפי שהם, כולל `epoch`.
 * כפיל שמחזיר פחות שדות ממה שהשרת מחזיר מאפשר להצלחה שגויה לעבור, ולכן
 * ברירות המחדל כאן מלאות והתרחישים משנים בכוונה שדה אחד בכל פעם.
 *
 * מה שהבדיקות האלה **אינן** מוכיחות: אחסון אמיתי, App Check, חיווט
 * callables, או שהשרת מתנהג כמו הכפיל. הן בודקות את הרכיב מול החוזה.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:41996';
const owned = ['hr-attachments-ui.js', 'hr-attachments-ui.css'];
const hashes = () => Object.fromEntries(owned.map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')]));
const before = hashes();
const executablePath = process.env.RESQ_CHROMIUM || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const contexts = new Set();
let passed = 0;

const ID = a => a.repeat(64);
const PARENT = ID('c');
/* PNG אמיתי בן 68 בתים — חתימה, IHDR ו-IEND. הבדיקה משתמשת בבייטים
 * אמיתיים כי הרכיב קובע סוג מהבייטים ולא מהסיומת. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100'
  + '05fe02fea70000000049454e44ae426082', 'hex');
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(40, 0x20), Buffer.from('\n%%EOF\n')]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40, 0x21)]);

const HARNESS = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>hra</title>
<link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/hr-attachments-ui.css">
<style>body{margin:0;padding:16px;background:var(--bg);color:var(--txt);font-family:system-ui,sans-serif}</style>
</head><body><main id="host"></main>
<script type="module">
import { createHrAttachmentsUI } from '/hr-attachments-ui.js';
const t = window.__hra;
window.__ui = createHrAttachmentsUI(document.getElementById('host'), {
  currentSession: () => {
    if (t.flipIn != null && t.flipIn-- === 0) t.session = { ...t.session, uid: 'u2' };
    return t.session;
  },
  subscribeIdentity: fn => { t.observers.push(fn); return () => { t.unsubscribed = true; }; },
  reserve: d => t.call('reserve', d),
  upload: d => t.call('upload', d),
  resume: d => t.call('resume', d),
  list: d => t.call('list', d),
  download: d => t.call('download', d),
  onLockChange: v => { t.locks.push(v); },
  onPublished: p => {
    t.published.push(p);
    if (t.publishThrows) throw new Error('host refresh failed');
    if (t.publishRejects) return Promise.reject(new Error('host refresh failed'));
    return undefined;
  }
});
if (t.context) window.__ui.setContext(t.context);
window.__ready = true;
</script></body></html>`;

async function fixture({ session = { uid: 'u1', stationId: 's1', role: 'firefighter', super: false, epoch: 7 },
  context = { parent_kind: 'document', parent_id: PARENT, parent_revision: 4, canUpload: true },
  width = 1100, theme = 'light', png = PNG.toString('base64') } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 900 }, colorScheme: theme });
  contexts.add(ctx);
  await ctx.addInitScript(options => {
    const t = window.__hra = { calls: [], observers: [], held: [], locks: [], published: [], urls: { made: 0, freed: 0, live: 0 },
      readWaiters: [], session: options.session, context: options.context, next: { reserve: [], upload: [], resume: [], list: [], download: [] },
      rows: [], revision: options.context ? options.context.parent_revision : 1,
      base: options.context ? options.context.parent_revision : 1, readGate: false, readFails: false, hashFails: false,
      publishThrows: false, publishRejects: false, unsubscribed: false, png: options.png, errors: [], flipIn: null };
    addEventListener('unhandledrejection', e => { t.errors.push(String(e.reason && e.reason.message)); });
    /* המזהים נבנים כאן ולא בצד Node: הפונקציה הזאת עוברת סריאליזציה
     * לדפדפן ואינה סוגרת על שום דבר מחוץ לה. */
    const id = a => a.repeat(64);
    /* צורת ה-epoch כפי שהשרת בונה אותה: claims_digest הוא SHA-256 הקסה
     * בן 64 תווים, ו-auth_time הוא תביעת הטוקן בשניות. */
    t.epoch = () => ({ uid: t.session.uid, station_id: t.session.stationId, auth_time: 1756000000, claims_digest: 'd'.repeat(64) });
    t.attachment = a => ({ attachment_id: id(a), display_name: 'טופס ' + a + '.png', declared_type: 'image/png',
      byte_length: options.pngBytes, revision: ++t.revision, created_at_ms: 1756000000000 });
    /* ברירות המחדל הן צורות התשובה המלאות של השרת. */
    t.fallback = (name, data) => ({
      /* פרסום של מסמך יושב בדיוק גרסה אחת מעל הבסיס שהכוונה הוקפאה
       * עליו — ההזמנה דוחה בסיס ישן ב-`aborted`, ולכן ready שאינו
       * base+1 אינו תשובה על הכוונה הזאת. */
      reserve: () => ({ result: { attachment_id: id('a'), state: 'reserved', duplicate: false, reserve_expires_ms: 1756000900000, epoch: t.epoch() } }),
      upload: () => ({ result: { attachment_id: id('a'), state: 'ready', revision: data.parent_revision + 1, notification_status: 'policy_pending', duplicate: false, epoch: t.epoch() } }),
      resume: () => ({ result: { attachment_id: data.attachment_id, state: 'ready', revision: t.base + 1, notification_status: 'already', duplicate: true, epoch: t.epoch() } }),
      list: () => ({ result: { items: t.rows, next_cursor: null, revision: t.base, epoch: t.epoch() } }),
      download: () => ({ result: { attachment_id: data.attachment_id, display_name: 'טופס.png', declared_type: 'image/png',
        byte_length: options.pngBytes, content_base64: t.png, epoch: t.epoch() } })
    }[name]());
    t.call = async (name, data) => {
      t.calls.push({ name, data: structuredClone(data), uid: t.session && t.session.uid });
      const step = t.next[name].shift() || t.fallback(name, data);
      if (step.code) throw Object.assign(new Error('synthetic failure'), { code: 'functions/' + step.code });
      const value = 'result' in step ? step.result : t.fallback(name, data).result;
      if (step.hold) return new Promise((resolve, reject) => t.held.push({ name, resolve: () => resolve(structuredClone(value)), reject }));
      return structuredClone(value);
    };
    t.release = () => t.held.splice(0).forEach(h => h.resolve());
    t.emit = next => { t.session = next; t.observers.forEach(fn => fn(next)); };
    /* אותו אדם, אובייקט חדש — לפי החוזה זו סשן אחרת. */
    t.reissue = () => t.emit(t.session ? { ...t.session } : null);
    t.releaseRead = () => { t.readGate = false; t.readWaiters.splice(0).forEach(w => w.go()); };
    /* שער על קריאת הקובץ מהמכשיר — כדי שאפשר יהיה להחליף זהות **בזמן**
     * שהקריאה תלויה. זהו סטאב של API של הדפדפן בעמוד הבדיקה, לא של הרכיב. */
    const realArrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      if (t.readFails) { t.readFails = false; return Promise.reject(new Error('device read failed')); }
      if (!t.readGate) return realArrayBuffer.call(this);
      return new Promise((resolve, reject) => t.readWaiters.push({ go: () => realArrayBuffer.call(this).then(resolve, reject), reject }));
    };
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = (alg, data) => t.hashFails ? (t.hashFails = false, Promise.reject(new Error('hash failed'))) : realDigest(alg, data);
    /* מה שנלחץ בפועל נרשם — כדי לבדוק את מה שהרכיב קבע, ולא את מה
     * שהדפדפן החליט לעשות עם זה. */
    t.clicks = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      t.clicks.push({ download: this.download, blob: this.href.startsWith('blob:'), attached: this.isConnected, rel: this.rel });
      return realClick.call(this);
    };
    const make = URL.createObjectURL.bind(URL), free = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { t.urls.made += 1; t.urls.live += 1; return make(blob); };
    URL.revokeObjectURL = url => { t.urls.freed += 1; t.urls.live -= 1; return free(url); };
  }, { session, context, png, pngBytes: PNG.length });
  await ctx.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/harness.html') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HARNESS });
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
  });
  const page = await ctx.newPage(), errors = [];
  page.setDefaultTimeout(6000);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/harness.html');
  await page.waitForFunction(() => window.__ready === true);
  if (context) await page.waitForFunction(() => __hra.calls.some(c => c.name === 'list'));
  return { page, errors, close: async () => { assert.deepEqual(errors, []); await ctx.close(); contexts.delete(ctx); } };
}

const file = page => page.locator('#host input[type=file]');
const state = page => page.locator('.hra-item .hra-state');
const problem = page => page.locator('#host .hra-problem');
const calls = (page, name) => page.evaluate(n => __hra.calls.filter(c => c.name === n), name);
const pickFile = (page, name, buffer, mimeType = 'application/octet-stream') =>
  file(page).setInputFiles([{ name, mimeType, buffer }]);
async function upload(page, name = 'טופס.png', buffer = PNG) {
  await pickFile(page, name, buffer);
  await page.locator('.hra-item').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'העלו את הקובץ' }).click();
}
async function check(name, fn) { await fn(); passed += 1; console.log('PASS ' + name); }

try {
  await check('a null session mounts, calls nothing and shows no picker', async () => {
    const f = await fixture({ session: null, context: null });
    assert.deepEqual(await f.page.evaluate(() => __hra.calls), []);
    assert.equal(await f.page.locator('.hra-pick').isHidden(), true);
    assert.equal(await f.page.locator('.hra-item').isHidden(), true);
    await f.close();
  });

  await check('a document sends its displayed revision; a request omits the field entirely', async () => {
    const f = await fixture();
    assert.deepEqual((await calls(f.page, 'list'))[0].data, { parent_kind: 'document', parent_id: PARENT, revision: 4 });
    await f.page.evaluate(id => { __hra.base = 9; __ui.setContext({ parent_kind: 'request', parent_id: id, parent_revision: 9, canUpload: true }); }, PARENT);
    await f.page.waitForFunction(() => __hra.calls.filter(c => c.name === 'list').length === 2);
    const second = (await calls(f.page, 'list'))[1].data;
    assert.deepEqual(second, { parent_kind: 'request', parent_id: PARENT });
    assert.equal('revision' in second, false);
    await f.close();
  });

  await check('the type is decided by the bytes, and a refused file makes no call', async () => {
    const cases = [['חשבונית.pdf', GIF, 'PDF, JPEG או PNG', 'application/pdf'], ['ריק.png', Buffer.alloc(0), 'ריק'],
      ['גדול.png', Buffer.concat([PNG, Buffer.alloc(2097153 - PNG.length, 0)]), 'גדול מ-'],
      ['a'.repeat(121) + '.png', PNG, 'ארוך מ-'], ['../secret.png', PNG, 'תווי נתיב'], ['con.png', PNG, 'שמור']];
    for (const [name, buffer, expected, mime] of cases) {
      const f = await fixture();
      await pickFile(f.page, name, buffer, mime || 'image/png');
      await problem(f.page).first().waitFor({ state: 'visible' });
      assert.ok((await problem(f.page).first().innerText()).includes(expected), name + ' → ' + expected);
      assert.equal(await f.page.locator('.hra-item').isHidden(), true);
      assert.deepEqual(await calls(f.page, 'reserve'), []);
      assert.equal(await file(f.page).inputValue(), '');
      await f.close();
    }
  });

  await check('reserve then upload carry one frozen intent, and publication reports the new revision', async () => {
    const f = await fixture();
    await upload(f.page);
    await state(f.page).getByText('צורף').waitFor();
    const [reserve] = await calls(f.page, 'reserve'), [sent] = await calls(f.page, 'upload');
    assert.equal(reserve.data.parent_revision, 4);
    assert.equal(reserve.data.declared_type, 'image/png');
    assert.equal(reserve.data.byte_length, PNG.length);
    assert.match(reserve.data.content_sha256, /^[a-f0-9]{64}$/);
    assert.equal(reserve.data.content_sha256, createHash('sha256').update(PNG).digest('hex'));
    const { content_base64: body, ...intent } = sent.data;
    assert.deepEqual(intent, reserve.data);
    assert.equal(body, PNG.toString('base64'));
    assert.deepEqual(await f.page.evaluate(() => __hra.published), [{ attachment_id: ID('a'), revision: 5 }]);
    /* מסמך אינו נטען מחדש כאן: הקובץ חי בגרסה 5 וההקשר הוא 4. המארח
     * מרענן ומוסר הקשר חדש. */
    assert.equal((await calls(f.page, 'list')).length, 1);
    await f.close();
  });

  await check('a reserve that answers ready never uploads the bytes again', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __hra.next.reserve.push({ result: { attachment_id: 'a'.repeat(64), state: 'ready', duplicate: true,
      revision: 5, notification_status: 'already', reserve_expires_ms: 1756000900000, epoch: __hra.epoch() } }); });
    await upload(f.page);
    await state(f.page).getByText('צורף').waitFor();
    assert.deepEqual(await calls(f.page, 'upload'), []);
    assert.deepEqual(await f.page.evaluate(() => __hra.published), [{ attachment_id: 'a'.repeat(64), revision: 5 }]);
    await f.close();
  });

  await check('an upload result missing its revision is not a completed upload', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __hra.next.upload.push({ result: { attachment_id: 'a'.repeat(64), state: 'ready',
      notification_status: 'queued', duplicate: false, epoch: __hra.epoch() } }); });
    await upload(f.page);
    await state(f.page).getByText('מצב לא ידוע').waitFor();
    assert.deepEqual(await f.page.evaluate(() => __hra.published), []);
    await f.close();
  });

  await check('a lost response stays uncertain, never says the file was not sent, and resumes on the same id', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __hra.next.upload.push({ code: 'internal' }); });
    await upload(f.page);
    await state(f.page).getByText('מצב לא ידוע').waitFor();
    const said = await f.page.locator('.hra-item .hra-wait').innerText();
    assert.ok(said.includes('לא ידוע אם הקובץ נקלט'));
    assert.equal(/לא נשלח|לא נקלט\./.test(said), false);
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), true);
    assert.equal(await f.page.getByRole('button', { name: 'הסירו את הבחירה' }).isHidden(), true);
    await f.page.getByRole('button', { name: 'בדקו מה נקלט' }).click();
    await state(f.page).getByText('צורף').waitFor();
    const [resume] = await calls(f.page, 'resume');
    assert.deepEqual(resume.data, { attachment_id: 'a'.repeat(64) });
    assert.equal((await calls(f.page, 'upload')).length, 1);
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), false);
    await f.close();
  });

  await check('upload-required stays a held attempt on the same request id', async () => {
    const f = await fixture();
    await f.page.evaluate(() => {
      __hra.next.upload.push({ code: 'internal' });
      __hra.next.resume.push({ result: { attachment_id: 'a'.repeat(64), state: 'stored_pending', resume: 'upload-required', epoch: __hra.epoch() } });
    });
    await upload(f.page);
    await f.page.getByRole('button', { name: 'בדקו מה נקלט' }).click();
    await f.page.locator('.hra-item[data-state=attempted] .hra-wait').waitFor();
    /* „נדרשת העלאה חוזרת" אינה ראיה שהעלאה קודמת לא תגיע. לכן הכרטיס
     * נשאר ניסיון: נעול, לא ניתן להסרה, ולא חוזר ל„נבחר". */
    const said = await f.page.locator('.hra-item .hra-wait').innerText();
    assert.equal(/לא נקלט\.|לא נשלח/.test(said), false);
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), true);
    assert.equal(await f.page.getByRole('button', { name: 'הסירו את הבחירה' }).isHidden(), true);
    assert.equal(await f.page.getByRole('button', { name: 'העלו את הקובץ' }).isHidden(), true);
    /* הריפוי המפורש חוזר על אותה הזמנה בדיוק. */
    await f.page.getByRole('button', { name: 'בדקו מה נקלט' }).click();
    await state(f.page).getByText('צורף').waitFor();
    const reserves = await calls(f.page, 'reserve');
    assert.equal(reserves.length, 1);
    assert.deepEqual((await calls(f.page, 'resume')).map(c => c.data),
      [{ attachment_id: 'a'.repeat(64) }, { attachment_id: 'a'.repeat(64) }]);
    await f.close();
  });

  await check('the second file uses the revision the host supplied after the first publication', async () => {
    const f = await fixture();
    await upload(f.page);
    await state(f.page).getByText('צורף').waitFor();
    const revision = (await f.page.evaluate(() => __hra.published))[0].revision;
    await f.page.evaluate(([id, next]) => { __hra.base = next; __ui.setContext({ parent_kind: 'document', parent_id: id, parent_revision: next, canUpload: true }); }, [PARENT, revision]);
    await f.page.waitForFunction(() => document.querySelector('.hra-pick').hidden === false);
    await upload(f.page, 'שני.pdf', PDF);
    await state(f.page).getByText('צורף').waitFor();
    const reserves = await calls(f.page, 'reserve');
    assert.deepEqual(reserves.map(c => c.data.parent_revision), [4, 5]);
    assert.equal(reserves[1].data.declared_type, 'application/pdf');
    assert.notEqual(reserves[0].data.request_id, reserves[1].data.request_id);
    await f.close();
  });

  await check('a held upload locks the host, and the lock lifts only when the answer arrives', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __hra.next.upload.push({ hold: true }); });
    await upload(f.page);
    await f.page.waitForFunction(() => __hra.held.length === 1);
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), true);
    assert.deepEqual(await f.page.evaluate(() => __hra.locks), [true]);
    await f.page.evaluate(() => __hra.release());
    await state(f.page).getByText('צורף').waitFor();
    assert.deepEqual(await f.page.evaluate(() => __hra.locks), [true, false]);
    await f.close();
  });

  await check('a host refresh that throws does not undo a publication', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __hra.publishThrows = true; });
    await upload(f.page);
    await state(f.page).getByText('צורף').waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'העלו את הקובץ' }).isHidden(), true);
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), false);
    await f.close();
  });

  await check('an identity change during the device read discards the selection and calls nothing', async () => {
    const f = await fixture();
    /* הפקד עצמו אינו multiple, ולכן אצווה אינה יכולה להתחיל דרכו. כאן
     * נכפית אצווה בכל זאת — כדי להוכיח שגם קלט כזה נעצר על קובץ אחד. */
    assert.equal(await file(f.page).evaluate(e => e.multiple), false);
    await f.page.evaluate(() => { __hra.readGate = true; });
    await file(f.page).evaluate(input => {
      const dt = new DataTransfer();
      for (const name of ['ראשון.png', 'שני.png']) {
        dt.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], name, { type: 'image/png' }));
      }
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await f.page.waitForFunction(() => __hra.readWaiters.length === 1);
    await f.page.evaluate(() => __hra.emit({ uid: 'u2', stationId: 's1', role: 'firefighter', super: false, epoch: 8 }));
    await f.page.evaluate(() => __hra.releaseRead());
    await f.page.waitForTimeout(120);
    assert.equal(await f.page.locator('.hra-item').isHidden(), true);
    assert.deepEqual(await calls(f.page, 'reserve'), []);
    assert.equal(await file(f.page).inputValue(), '');
    await f.close();
  });

  await check('a late device-read failure and a late hash failure both refuse without calling', async () => {
    for (const flag of ['readFails', 'hashFails']) {
      const f = await fixture();
      await f.page.evaluate(k => { __hra[k] = true; }, flag);
      await pickFile(f.page, 'טופס.png', PNG);
      await problem(f.page).first().waitFor({ state: 'visible' });
      assert.ok((await problem(f.page).first().innerText()).includes('לא ניתן'));
      assert.deepEqual(await calls(f.page, 'reserve'), []);
      assert.equal(await f.page.locator('.hra-item').isHidden(), true);
      await f.close();
    }
  });

  await check('permission denial is definite, offers no retry and clears what was private', async () => {
    const f = await fixture();
    await f.page.evaluate(() => {
      __hra.rows = [__hra.attachment('b')];
      __hra.next.upload.push({ code: 'permission-denied' });
    });
    await f.page.getByRole('button', { name: 'רענון' }).click();
    await f.page.locator('.hra-row').first().waitFor();
    await upload(f.page);
    await f.page.locator('.hra-pick .hra-problem').waitFor();
    /* הבחירה עצמה נמחקה — זה מה ש„ניקוי מידע פרטי" אומר — אבל הסיבה
     * נאמרת, ואין הצעת „נסו שוב" על סירוב. */
    assert.ok((await f.page.locator('.hra-pick .hra-problem').innerText()).includes('אין הרשאה'));
    assert.equal(await f.page.locator('.hra-item').isHidden(), true);
    assert.equal(await f.page.getByRole('button', { name: 'בדקו מה נקלט' }).isHidden(), true);
    assert.equal(await f.page.locator('.hra-row').count(), 0);
    assert.equal(await file(f.page).inputValue(), '');
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), false);
    assert.deepEqual(await f.page.evaluate(() => __hra.locks.slice(-1)), [false]);
    await f.close();
  });

  await check('a body whose real length is not the declared length is refused before any blob', async () => {
    const f = await fixture();
    await f.page.evaluate(() => {
      __hra.rows = [__hra.attachment('b')];
      __hra.next.download.push({ result: { attachment_id: 'b'.repeat(64), display_name: 'טופס.png', declared_type: 'image/png',
        byte_length: 18, content_base64: __hra.png, epoch: __hra.epoch() } });
    });
    await f.page.getByRole('button', { name: 'רענון' }).click();
    await f.page.getByRole('button', { name: 'הורדה' }).click();
    await f.page.locator('.hra-row .hra-problem').waitFor();
    assert.deepEqual(await f.page.evaluate(() => __hra.urls), { made: 0, freed: 0, live: 0 });
    await f.close();
  });

  await check('an epoch whose digest is not a SHA-256 is not an epoch', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __hra.rows = [__hra.attachment('b')]; });
    await f.page.getByRole('button', { name: 'רענון' }).click();
    await f.page.locator('.hra-row').first().waitFor();
    /* ארבעים תווים נראים כמו digest אבל אינם מה שהשרת חותם: הוא חותם
     * SHA-256. `auth_time` לעומת זאת אינו נבדק כאן מעבר להיותו מספר
     * שלם — לשרת אין חסם על הערך, ולא נמציא חסם שאינו קיים. */
    await f.page.evaluate(() => {
      __hra.next.download.push({ result: { attachment_id: 'b'.repeat(64), display_name: 'טופס.png', declared_type: 'image/png',
        byte_length: 68, content_base64: __hra.png, epoch: { ...__hra.epoch(), claims_digest: 'd'.repeat(40) } } });
    });
    await f.page.getByRole('button', { name: 'הורדה' }).click();
    await f.page.locator('.hra-row .hra-problem').waitFor();
    assert.deepEqual(await f.page.evaluate(() => __hra.urls), { made: 0, freed: 0, live: 0 });
    assert.deepEqual(await f.page.evaluate(() => __hra.clicks), []);
    await f.close();
  });

  await check('a download for another identity or another attachment is refused', async () => {
    for (const patch of ['epoch', 'attachment']) {
      const f = await fixture();
      await f.page.evaluate(which => {
        __hra.rows = [__hra.attachment('b')];
        const base = { attachment_id: 'b'.repeat(64), display_name: 'טופס.png', declared_type: 'image/png',
          byte_length: 68, content_base64: __hra.png, epoch: __hra.epoch() };
        if (which === 'epoch') base.epoch = { ...base.epoch, uid: 'someone-else' };
        else base.attachment_id = 'c'.repeat(64);
        __hra.next.download.push({ result: base });
      }, patch);
      await f.page.getByRole('button', { name: 'רענון' }).click();
      await f.page.getByRole('button', { name: 'הורדה' }).click();
      await f.page.locator('.hra-row .hra-problem').waitFor();
      assert.deepEqual(await f.page.evaluate(() => __hra.urls), { made: 0, freed: 0, live: 0 });
      await f.close();
    }
  });

  await check('bytes that contradict the declared type, or a non-canonical body, are refused', async () => {
    const pdf = Buffer.from('%PDF-1.4 not a png at all, fifty-two bytes of it!!!!');
    const bodies = [[pdf.toString('base64'), pdf.length], ['****AAAA', 6], ['AAA', 2]];
    for (const [body, declared] of bodies) {
      const f = await fixture();
      await f.page.evaluate(([base64, length]) => {
        __hra.rows = [__hra.attachment('b')];
        __hra.next.download.push({ result: { attachment_id: 'b'.repeat(64), display_name: 'טופס.png', declared_type: 'image/png',
          byte_length: length, content_base64: base64, epoch: __hra.epoch() } });
      }, [body, declared]);
      await f.page.getByRole('button', { name: 'רענון' }).click();
      await f.page.getByRole('button', { name: 'הורדה' }).click();
      await f.page.locator('.hra-row .hra-problem').waitFor();
      assert.deepEqual(await f.page.evaluate(() => __hra.urls), { made: 0, freed: 0, live: 0 });
      assert.deepEqual(await f.page.evaluate(() => __hra.clicks), []);
      await f.close();
    }
  });

  await check('a valid download lives for one click and leaves no url and no anchor', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __hra.rows = [__hra.attachment('b')]; });
    await f.page.getByRole('button', { name: 'רענון' }).click();
    await f.page.getByRole('button', { name: 'הורדה' }).click();
    await f.page.waitForFunction(() => __hra.urls.made === 1 && __hra.urls.live === 0);
    assert.deepEqual(await f.page.evaluate(() => __hra.clicks),
      [{ download: 'טופס.png', blob: true, attached: true, rel: 'noopener' }]);
    assert.equal(await f.page.locator('#host a').count(), 0);
    assert.deepEqual(await f.page.evaluate(() => [location.search, location.hash, localStorage.length, sessionStorage.length]), ['', '', 0, 0]);
    await f.close();
  });

  await check('one malformed row fails the whole list instead of becoming a shorter one', async () => {
    const f = await fixture();
    await f.page.evaluate(() => {
      const good = __hra.attachment('b'), bad = __hra.attachment('c');
      delete bad.byte_length;
      __hra.next.list.push({ result: { items: [good, bad], next_cursor: null, revision: __hra.base, epoch: __hra.epoch() } });
    });
    await f.page.getByRole('button', { name: 'רענון' }).click();
    await f.page.locator('.hra > .hra-problem').waitFor();
    assert.equal(await f.page.locator('.hra-row').count(), 0);
    assert.ok((await f.page.locator('.hra > .hra-problem').innerText()).includes('לא ניתן לטעון'));
    await f.close();
  });

  await check('paging is a button, not a drain', async () => {
    const f = await fixture();
    /* עמוד מלא הוא 25 לפי החוזה; סמן על עמוד קצר הוא עמוד שאינו מתאר
     * את עצמו, ולכן הכפיל מייצר עמודים אמיתיים. */
    await f.page.evaluate(() => {
      const page = mark => Array.from({ length: 25 }, (_, i) => {
        const row = __hra.attachment(mark);
        row.attachment_id = (mark + i.toString(16).padStart(2, '0')).padEnd(64, '0');
        return row;
      });
      __hra.next.list.push({ result: { items: page('b'), next_cursor: '5|' + 'b'.repeat(64), revision: __hra.base, epoch: __hra.epoch() } });
      __hra.next.list.push({ result: { items: page('c'), next_cursor: null, revision: __hra.base, epoch: __hra.epoch() } });
    });
    await f.page.getByRole('button', { name: 'רענון' }).click();
    await f.page.locator('.hra-row').first().waitFor();
    await f.page.waitForTimeout(150);
    assert.equal((await calls(f.page, 'list')).length, 2);
    assert.equal(await f.page.locator('.hra-row').count(), 25);
    await f.page.getByRole('button', { name: 'טענו עוד' }).click();
    await f.page.waitForFunction(() => document.querySelectorAll('.hra-row').length === 50);
    const pages = await calls(f.page, 'list');
    assert.equal(pages.length, 3);
    assert.equal(pages[2].data.cursor, '5|' + 'b'.repeat(64));
    assert.equal(await f.page.getByRole('button', { name: 'טענו עוד' }).isHidden(), true);
    await f.close();
  });

  await check('a closed parent can still be read but never uploaded to', async () => {
    const f = await fixture({ context: { parent_kind: 'request', parent_id: PARENT, parent_revision: 3, canUpload: false } });
    await f.page.evaluate(() => { __hra.rows = [__hra.attachment('b')]; });
    await f.page.getByRole('button', { name: 'רענון' }).click();
    await f.page.locator('.hra-row').first().waitFor();
    assert.equal(await f.page.locator('.hra-pick').isHidden(), true);
    assert.equal(await f.page.getByRole('button', { name: 'הורדה' }).isVisible(), true);
    await f.close();
  });

  await check('destroy removes the component and a late answer touches nothing', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __hra.next.upload.push({ hold: true }); });
    await upload(f.page);
    await f.page.waitForFunction(() => __hra.held.length === 1);
    await f.page.evaluate(() => __ui.destroy());
    assert.equal(await f.page.locator('#host .hra').count(), 0);
    await f.page.evaluate(() => __hra.release());
    await f.page.waitForTimeout(120);
    assert.equal(await f.page.evaluate(() => __hra.unsubscribed), true);
    assert.deepEqual(await f.page.evaluate(() => __hra.published), []);
    await f.close();
  });

  await check('R1 · a held selection can never replace or unlock a file already in flight', async () => {
    const f = await fixture();
    /* A נבחר, קריאתו מהמכשיר מוחזקת. */
    await f.page.evaluate(() => { __hra.readGate = true; });
    await pickFile(f.page, 'A.pdf', PDF, 'application/pdf');
    await f.page.waitForFunction(() => __hra.readWaiters.length === 1);
    /* בזמן ש-A תלוי, בחירה שנייה נדחית מיד — סינכרונית, לפני כל await. */
    await pickFile(f.page, 'B.png', PNG, 'image/png');
    assert.ok((await f.page.locator('.hra-pick .hra-problem').innerText()).includes('כבר יש קובץ בטיפול'));
    assert.equal(await f.page.evaluate(() => __hra.readWaiters.length), 1);
    /* A משתחרר, מועלה, וההעלאה מוחזקת. */
    await f.page.evaluate(() => { __hra.next.upload.push({ hold: true }); __hra.releaseRead(); });
    await f.page.locator('.hra-item').waitFor();
    await f.page.getByRole('button', { name: 'העלו את הקובץ' }).click();
    await f.page.waitForFunction(() => __hra.held.length === 1);
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), true);
    /* וכעת ההוכחה: בחירה נוספת בזמן העלאה חיה אינה מחליפה ואינה משחררת. */
    await pickFile(f.page, 'C.png', PNG, 'image/png');
    await f.page.waitForTimeout(120);
    assert.equal(await f.page.locator('.hra-name').first().innerText(), 'A.pdf');
    assert.equal(await f.page.locator('.hra-item').getAttribute('data-state'), 'uploading');
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), true);
    assert.deepEqual(await f.page.evaluate(() => __hra.locks), [true]);
    /* וההעלאה האחת מתיישבת פעם אחת. */
    await f.page.evaluate(() => __hra.release());
    await state(f.page).getByText('צורף').waitFor();
    assert.equal((await calls(f.page, 'upload')).length, 1);
    assert.equal((await calls(f.page, 'reserve')).length, 1);
    assert.equal((await f.page.evaluate(() => __hra.published)).length, 1);
    await f.close();
  });

  await check('R2 · pagehide invalidates every pending completion and releases the lock', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __hra.rows = [__hra.attachment('b')]; });
    await f.page.getByRole('button', { name: 'רענון' }).click();
    await f.page.locator('.hra-row').first().waitFor();
    await f.page.evaluate(() => { __hra.readGate = true; });
    await pickFile(f.page, 'A.pdf', PDF, 'application/pdf');
    await f.page.waitForFunction(() => __hra.readWaiters.length === 1);
    await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    /* הכרטיס, הרשימה, הקלט וההודעות — הכול נמחק בנתיב אחד. */
    assert.equal(await f.page.locator('.hra-item').isHidden(), true);
    assert.equal(await f.page.locator('.hra-row').count(), 0);
    assert.equal(await file(f.page).inputValue(), '');
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), false);
    /* והקריאה שהתעכבה אינה מצייר את הקובץ בחזרה. */
    await f.page.evaluate(() => __hra.releaseRead());
    await f.page.waitForTimeout(150);
    assert.equal(await f.page.locator('.hra-item').isHidden(), true);
    assert.deepEqual(await calls(f.page, 'reserve'), []);
    /* וגם בחירה חדשה אפשרית — המנעול השתחרר, לא ננעל בשוגג. */
    await pickFile(f.page, 'C.png', PNG, 'image/png');
    await f.page.locator('.hra-item').waitFor();
    await f.close();
  });

  await check('R2 · a held upload cannot publish after pagehide, and destroy unlocks the host', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __hra.next.upload.push({ hold: true }); });
    await upload(f.page);
    await f.page.waitForFunction(() => __hra.held.length === 1);
    await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), false);
    await f.page.evaluate(() => __hra.release());
    await f.page.waitForTimeout(150);
    assert.deepEqual(await f.page.evaluate(() => __hra.published), []);
    assert.equal(await f.page.locator('.hra-item').isHidden(), true);
    await f.close();
    const g = await fixture();
    await g.page.evaluate(() => { __hra.next.upload.push({ hold: true }); });
    await upload(g.page);
    await g.page.waitForFunction(() => __hra.held.length === 1);
    await g.page.evaluate(() => __ui.destroy());
    /* destroy מודיע למארח שהנעילה שוחררה, ולא רק מסיר DOM. */
    assert.deepEqual(await g.page.evaluate(() => __hra.locks), [true, false]);
    assert.equal(await g.page.evaluate(() => __ui.isLocked()), false);
    await g.page.evaluate(() => __hra.release());
    await g.page.waitForTimeout(120);
    assert.deepEqual(await g.page.evaluate(() => __hra.published), []);
    await g.close();
  });

  await check('R2 · a new session object with identical fields is a new session', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __hra.rows = [__hra.attachment('b')]; });
    await f.page.getByRole('button', { name: 'רענון' }).click();
    await f.page.locator('.hra-row').first().waitFor();
    await f.page.evaluate(() => { __hra.readGate = true; });
    await pickFile(f.page, 'A.pdf', PDF, 'application/pdf');
    await f.page.waitForFunction(() => __hra.readWaiters.length === 1);
    await f.page.evaluate(() => __hra.reissue());
    await f.page.evaluate(() => __hra.releaseRead());
    await f.page.waitForTimeout(150);
    assert.equal(await f.page.locator('.hra-item').isHidden(), true);
    assert.deepEqual(await calls(f.page, 'reserve'), []);
    await f.close();
  });

  await check('R3 · a conflict is not a receipt: aborted, failed-precondition and cleaning stay held', async () => {
    const cases = [['aborted', 'upload'], ['failed-precondition', 'upload'], ['resource-exhausted', 'reserve']];
    for (const [code, where] of cases) {
      const f = await fixture();
      await f.page.evaluate(([c, w]) => { __hra.next[w].push({ code: c }); }, [code, where]);
      await upload(f.page);
      await f.page.locator('.hra-item[data-state=attempted]').waitFor();
      assert.equal(await f.page.getByRole('button', { name: 'הסירו את הבחירה' }).isHidden(), true, code);
      assert.equal(await f.page.evaluate(() => __ui.isLocked()), true, code);
      assert.ok((await f.page.locator('.hra-item .hra-wait').innerText()).includes('לא ידוע אם הקובץ נקלט'));
      await f.close();
    }
    /* cleaning מגיע כמצב שרת, לא כשגיאה — ואותו כלל חל עליו. */
    const f = await fixture();
    await f.page.evaluate(() => { __hra.next.reserve.push({ result: { attachment_id: 'a'.repeat(64),
      state: 'cleaning', duplicate: false, reserve_expires_ms: 1756000900000, epoch: __hra.epoch() } }); });
    await upload(f.page);
    await f.page.locator('.hra-item[data-state=attempted]').waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'הסירו את הבחירה' }).isHidden(), true);
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), true);
    await f.close();
  });

  await check('R3 · an attempt whose identifier never arrived repeats the same reserve', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __hra.next.reserve.push({ code: 'internal' }); });
    await upload(f.page);
    await f.page.locator('.hra-item[data-state=attempted]').waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'הסירו את הבחירה' }).isHidden(), true);
    await f.page.getByRole('button', { name: 'שלחו שוב את אותה בקשה' }).click();
    await state(f.page).getByText('צורף').waitFor();
    const reserves = await calls(f.page, 'reserve');
    assert.equal(reserves.length, 2);
    assert.deepEqual(reserves[0].data, reserves[1].data);
    await f.close();
  });

  await check('R3 · only the server closing the attempt makes it droppable', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __hra.next.reserve.push({ result: { attachment_id: 'a'.repeat(64),
      state: 'failed', duplicate: false, reserve_expires_ms: 1756000900000, epoch: __hra.epoch() } }); });
    await upload(f.page);
    await f.page.locator('.hra-item[data-state=failed]').waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'בחרו קובץ אחר' }).isVisible(), true);
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), false);
    await f.page.getByRole('button', { name: 'בחרו קובץ אחר' }).click();
    assert.equal(await f.page.locator('.hra-item').isHidden(), true);
    await f.close();
  });

  await check('R4 · a context switch renders only the new list and no stale busy state', async () => {
    const f = await fixture();
    await f.page.evaluate(() => {
      __hra.next.list.push({ hold: true, result: { items: [__hra.attachment('b')], next_cursor: null, revision: 4, epoch: __hra.epoch() } });
      __hra.next.list.push({ hold: true, result: { items: [__hra.attachment('e')], next_cursor: null, revision: 9, epoch: __hra.epoch() } });
    });
    await f.page.getByRole('button', { name: 'רענון' }).click();
    await f.page.waitForFunction(() => __hra.held.some(h => h.name === 'list'));
    /* הקשר חדש בזמן שהטעינה הישנה תלויה. */
    await f.page.evaluate(id => { __hra.base = 9; __ui.setContext({ parent_kind: 'document', parent_id: id, parent_revision: 9, canUpload: true }); }, PARENT);
    await f.page.waitForFunction(() => __hra.calls.filter(c => c.name === 'list').length === 3);
    /* גם הטעינה החדשה מוחזקת, כדי שלהשלמה הישנה יהיה מה לקלקל. */
    assert.equal(await f.page.getByRole('button', { name: 'רענון' }).isDisabled(), true);
    /* ההשלמה הישנה משתחררת ראשונה. */
    await f.page.evaluate(() => { const old = __hra.held.shift(); old.resolve(); });
    await f.page.waitForTimeout(150);
    /* היא אינה מציירת שורות. */
    assert.equal(await f.page.locator('.hra-row').count(), 0);
    /* וגם אינה מנקה את דגל העסוק של הריצה שהחליפה אותה — נבדק אחרי
     * ציור אמיתי, כי דגל שנוקה בשקט מתגלה רק בציור הבא. */
    await pickFile(f.page, 'טופס.png', PNG, 'image/png');
    await f.page.locator('.hra-item').waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'רענון' }).isDisabled(), true);
    assert.ok((await f.page.locator('.hra-empty').innerText()).includes('טוען'));
    await f.page.evaluate(() => __hra.release());
    await f.page.locator('.hra-row').first().waitFor();
    assert.deepEqual(await f.page.locator('.hra-row .hra-name').allInnerTexts(), ['טופס e.png']);
    assert.equal(await f.page.locator('.hra-item').getAttribute('data-state'), 'chosen');
    assert.equal(await f.page.getByRole('button', { name: 'רענון' }).isDisabled(), false);
    const asked = (await calls(f.page, 'list')).map(c => c.data.revision);
    assert.deepEqual(asked, [4, 4, 9]);
    await f.close();
  });

  await check('R5 · a rejected host refresh does not undo a publication', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __hra.publishRejects = true; });
    await upload(f.page);
    await state(f.page).getByText('צורף').waitFor();
    await f.page.waitForTimeout(150);
    assert.equal(await f.page.locator('.hra-item').getAttribute('data-state'), 'ready');
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), false);
    assert.deepEqual(await f.page.evaluate(() => __hra.errors || []), []);
    await f.close();
  });

  await check('resume is not believed merely because it says upload-required', async () => {
    const f = await fixture();
    await f.page.evaluate(() => {
      __hra.next.upload.push({ code: 'internal' });
      __hra.next.resume.push({ result: { attachment_id: 'a'.repeat(64), state: 'nonsense', resume: 'upload-required', epoch: __hra.epoch() } });
    });
    await upload(f.page);
    await f.page.getByRole('button', { name: 'בדקו מה נקלט' }).click();
    await f.page.waitForTimeout(150);
    assert.equal(await f.page.locator('.hra-item').getAttribute('data-state'), 'attempted');
    assert.equal((await f.page.locator('.hra-item .hra-wait').innerText()).includes('השרת מבקש את הקובץ שוב'), false);
    await f.close();
  });

  await check('G1 · upload-required leads to an actual second upload of the same bytes', async () => {
    const f = await fixture();
    await f.page.evaluate(() => {
      __hra.next.upload.push({ code: 'internal' });
      /* השרת מבקש את הבייטים שוב — וזה מה שהמסלול הזה חייב לאפשר. */
      __hra.next.resume.push({ result: { attachment_id: 'a'.repeat(64), state: 'stored_pending',
        resume: 'upload-required', epoch: __hra.epoch() } });
    });
    await upload(f.page);
    await f.page.getByRole('button', { name: 'בדקו מה נקלט' }).click();
    await f.page.getByRole('button', { name: 'שלחו שוב את אותו קובץ' }).waitFor({ state: 'visible' });
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), true);
    await f.page.getByRole('button', { name: 'שלחו שוב את אותו קובץ' }).click();
    await state(f.page).getByText('צורף').waitFor();
    const uploads = await calls(f.page, 'upload');
    assert.equal(uploads.length, 2);
    /* זהות בייט-בבייט: אותה כוונה, אותו גוף, אותו מזהה בקשה. */
    assert.deepEqual(uploads[0].data, uploads[1].data);
    assert.equal(uploads[1].data.content_base64, PNG.toString('base64'));
    assert.equal((await calls(f.page, 'reserve')).length, 1);
    assert.equal((await calls(f.page, 'resume')).length, 1);
    assert.deepEqual(await f.page.evaluate(() => __hra.published), [{ attachment_id: 'a'.repeat(64), revision: 5 }]);
    await f.close();
  });

  await check('G1 · a request for bytes is re-earned on every check', async () => {
    const f = await fixture();
    await f.page.evaluate(() => {
      __hra.next.upload.push({ code: 'internal' });
      __hra.next.resume.push({ result: { attachment_id: 'a'.repeat(64), state: 'stored_pending',
        resume: 'upload-required', epoch: __hra.epoch() } });
      /* בבדיקה השנייה השרת כבר אינו מבקש אותם. */
      __hra.next.resume.push({ result: { attachment_id: 'a'.repeat(64), state: 'stored', epoch: __hra.epoch() } });
    });
    await upload(f.page);
    await f.page.getByRole('button', { name: 'בדקו מה נקלט' }).click();
    await f.page.getByRole('button', { name: 'שלחו שוב את אותו קובץ' }).waitFor({ state: 'visible' });
    await f.page.getByRole('button', { name: 'בדקו מה נקלט' }).click();
    await f.page.waitForFunction(() => __hra.calls.filter(c => c.name === 'resume').length === 2);
    await f.page.waitForTimeout(150);
    assert.equal(await f.page.getByRole('button', { name: 'שלחו שוב את אותו קובץ' }).isHidden(), true);
    assert.equal(await f.page.locator('.hra-item').getAttribute('data-state'), 'attempted');
    assert.equal((await calls(f.page, 'upload')).length, 1);
    await f.close();
  });

  await check('G1 · a state that cannot ask for bytes does not get a resend', async () => {
    /* השרת האמיתי זורק `aborted` על cleaning ואינו מחזיר אותו עם
     * upload-required. אם בכל זאת יגיע כזה — אין להציע שליחה חוזרת
     * בזמן שהשרת מנקה את אותו ניסיון. */
    for (const state of ['cleaning', 'failed']) {
      const f = await fixture();
      await f.page.evaluate(bad => {
        __hra.next.upload.push({ code: 'internal' });
        __hra.next.resume.push({ result: { attachment_id: 'a'.repeat(64), state: bad,
          resume: 'upload-required', epoch: __hra.epoch() } });
      }, state);
      await upload(f.page);
      await f.page.getByRole('button', { name: 'בדקו מה נקלט' }).click();
      await f.page.waitForTimeout(150);
      assert.equal(await f.page.locator('.hra-item').getAttribute('data-state'), 'attempted', state);
      assert.equal(await f.page.getByRole('button', { name: 'שלחו שוב את אותו קובץ' }).isHidden(), true, state);
      assert.equal((await f.page.locator('.hra-item .hra-wait').innerText()).includes('השרת מבקש את הקובץ שוב'), false, state);
      assert.equal((await calls(f.page, 'upload')).length, 1, state);
      await f.close();
    }
  });

  await check('G4 · a closed attempt reaches its receipt through the reserve, and only through it', async () => {
    const f = await fixture();
    await f.page.evaluate(() => {
      __hra.next.upload.push({ code: 'internal' });
      /* השרת סגר את הניסיון; `resume` על כזה זורק failed-precondition. */
      __hra.next.resume.push({ code: 'failed-precondition' });
      __hra.next.resume.push({ code: 'failed-precondition' });
      __hra.next.reserve.push({});
      __hra.next.reserve.push({ result: { attachment_id: 'a'.repeat(64), state: 'failed', duplicate: true,
        reserve_expires_ms: 1756000900000, epoch: __hra.epoch() } });
    });
    await upload(f.page);
    await f.page.locator('.hra-item[data-state=attempted]').waitFor();
    /* המסלול הישן: „בדקו מה נקלט" חוזר על אותו כשל ואינו מתקדם. */
    await f.page.getByRole('button', { name: 'בדקו מה נקלט' }).click();
    await f.page.waitForFunction(() => __hra.calls.filter(c => c.name === 'resume').length === 1);
    assert.equal(await f.page.locator('.hra-item').getAttribute('data-state'), 'attempted');
    await f.page.getByRole('button', { name: 'בדקו מה נקלט' }).click();
    await f.page.waitForFunction(() => __hra.calls.filter(c => c.name === 'resume').length === 2);
    assert.equal(await f.page.locator('.hra-item').getAttribute('data-state'), 'attempted');
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), true);
    /* המסלול החדש: בירור מול ההזמנה — אותה כוונה בדיוק. */
    await f.page.getByRole('button', { name: 'בררו אם הבקשה נסגרה' }).click();
    await f.page.locator('.hra-item[data-state=failed]').waitFor();
    const reserves = await calls(f.page, 'reserve');
    assert.equal(reserves.length, 2);
    assert.deepEqual(reserves[0].data, reserves[1].data);
    assert.equal((await calls(f.page, 'upload')).length, 1);
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), false);
    assert.equal(await f.page.getByRole('button', { name: 'בחרו קובץ אחר' }).isVisible(), true);
    assert.equal(await f.page.getByRole('button', { name: 'שלחו שוב את אותו קובץ' }).isHidden(), true);
    /* והבייטים אכן ירדו: הקובץ הבא נושא מזהה חדש וגוף חדש. */
    await f.page.getByRole('button', { name: 'בחרו קובץ אחר' }).click();
    await upload(f.page, 'שני.pdf', PDF);
    await state(f.page).getByText('צורף').waitFor();
    const all = await calls(f.page, 'reserve');
    assert.equal(all.length, 3);
    assert.notEqual(all[2].data.request_id, reserves[0].data.request_id);
    assert.equal(all[2].data.declared_type, 'application/pdf');
    const uploads = await calls(f.page, 'upload');
    assert.equal(uploads.length, 2);
    assert.notEqual(uploads[1].data.content_base64, uploads[0].data.content_base64);
    await f.close();
  });

  await check('G4 · a reserve that does not answer failed leaves the attempt held', async () => {
    for (const answer of [{ code: 'aborted' }, { code: 'failed-precondition' },
      { result: { attachment_id: 'a'.repeat(64), state: 'stored', duplicate: true, reserve_expires_ms: 1756000900000 } },
      { result: { attachment_id: 'a'.repeat(64), state: 'reserved', duplicate: true, reserve_expires_ms: 1756000900000 } }]) {
      const f = await fixture();
      await f.page.evaluate(step => {
        __hra.next.upload.push({ code: 'internal' });
        __hra.next.resume.push({ code: 'failed-precondition' });
        if (step.result) step.result.epoch = __hra.epoch();
        __hra.next.reserve.push({});
        __hra.next.reserve.push(step);
      }, answer);
      await upload(f.page);
      await f.page.locator('.hra-item[data-state=attempted]').waitFor();
      await f.page.getByRole('button', { name: 'בדקו מה נקלט' }).click();
      await f.page.waitForFunction(() => __hra.calls.some(c => c.name === 'resume'));
      await f.page.getByRole('button', { name: 'בררו אם הבקשה נסגרה' }).click();
      await f.page.waitForFunction(() => __hra.calls.filter(c => c.name === 'reserve').length === 2);
      await f.page.waitForTimeout(120);
      /* אין קבלה — אין סגירה. הכרטיס נשאר נעול ולא ניתן להסרה. */
      assert.equal(await f.page.locator('.hra-item').getAttribute('data-state'), 'attempted', JSON.stringify(answer));
      assert.equal(await f.page.evaluate(() => __ui.isLocked()), true, JSON.stringify(answer));
      assert.equal(await f.page.getByRole('button', { name: 'הסירו את הבחירה' }).isHidden(), true);
      assert.equal(await f.page.getByRole('button', { name: 'בחרו קובץ אחר' }).isHidden(), true);
      /* והבירור אינו מעלה דבר מעצמו. */
      assert.equal((await calls(f.page, 'upload')).length, 1, JSON.stringify(answer));
      await f.close();
    }
  });

  await check('G5 · a receipt about another attachment is not a receipt about this one', async () => {
    for (const state of ['failed', 'ready']) {
      const f = await fixture();
      await f.page.evaluate(bad => {
        __hra.next.upload.push({ code: 'internal' });
        __hra.next.resume.push({ code: 'failed-precondition' });
        /* תקין בצורתו, אבל מדבר על קובץ אחר. */
        __hra.next.reserve.push({});
        __hra.next.reserve.push({ result: { attachment_id: 'f'.repeat(64), state: bad, duplicate: true,
          reserve_expires_ms: 1756000900000, revision: 5, notification_status: 'already', epoch: __hra.epoch() } });
        /* ואחריו — הקבלה האמיתית על A. */
        __hra.next.reserve.push({ result: { attachment_id: 'a'.repeat(64), state: 'failed', duplicate: true,
          reserve_expires_ms: 1756000900000, epoch: __hra.epoch() } });
      }, state);
      await upload(f.page);
      await f.page.locator('.hra-item[data-state=attempted]').waitFor();
      await f.page.getByRole('button', { name: 'בדקו מה נקלט' }).click();
      await f.page.waitForFunction(() => __hra.calls.some(c => c.name === 'resume'));
      await f.page.getByRole('button', { name: 'בררו אם הבקשה נסגרה' }).click();
      await f.page.waitForFunction(() => __hra.calls.filter(c => c.name === 'reserve').length === 2);
      await f.page.waitForTimeout(150);
      /* A נשאר נעול. לא פורסם, לא נסגר, לא הועלה. */
      assert.equal(await f.page.locator('.hra-item').getAttribute('data-state'), 'attempted', state);
      assert.equal(await f.page.evaluate(() => __ui.isLocked()), true, state);
      assert.deepEqual(await f.page.evaluate(() => __hra.published), [], state);
      assert.equal((await calls(f.page, 'upload')).length, 1, state);
      /* והמזהה לא הוחלף: הבירור הבא עדיין מדבר על A. */
      await f.page.getByRole('button', { name: 'בררו אם הבקשה נסגרה' }).click();
      await f.page.locator('.hra-item[data-state=failed]').waitFor();
      const reserves = await calls(f.page, 'reserve');
      assert.equal(reserves.length, 3, state);
      assert.deepEqual(reserves[0].data, reserves[2].data, state);
      assert.equal(await f.page.evaluate(() => __ui.isLocked()), false, state);
      await f.close();
    }
  });

  await check('G5 · a reset between the helper and its caller stops both callers', async () => {
    /* `send`: ההזמנה מוחזרת, והזהות מתחלפת בין הגדר של העוזר לבין
     * ההמשך של הקורא. אסור שההעלאה תצא. */
    const f = await fixture();
    await f.page.evaluate(() => { __hra.next.reserve.push({ hold: true }); });
    await pickFile(f.page, 'טופס.png', PNG, 'image/png');
    await f.page.locator('.hra-item').waitFor();
    await f.page.getByRole('button', { name: 'העלו את הקובץ' }).click();
    await f.page.waitForFunction(() => __hra.held.some(h => h.name === 'reserve'));
    await f.page.evaluate(() => { __hra.flipIn = 1; __hra.release(); });
    await f.page.waitForTimeout(200);
    assert.deepEqual(await calls(f.page, 'upload'), []);
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), false);
    assert.equal(await f.page.locator('.hra-item').isHidden(), true);
    assert.equal((await f.page.locator('.hra-live').innerText()).includes('טופס'), false);
    await f.close();

    /* `recheck`: אותו גבול, והפעם מה שאסור הוא הודעה על הקובץ הישן
     * והחזרת הנעילה אחרי האיפוס. */
    const g = await fixture();
    await g.page.evaluate(() => {
      __hra.next.upload.push({ code: 'internal' });
      __hra.next.reserve.push({});
      __hra.next.reserve.push({ hold: true, result: { attachment_id: 'a'.repeat(64), state: 'reserved',
        duplicate: true, reserve_expires_ms: 1756000900000, epoch: __hra.epoch() } });
    });
    await upload(g.page);
    await g.page.locator('.hra-item[data-state=attempted]').waitFor();
    await g.page.getByRole('button', { name: 'בררו אם הבקשה נסגרה' }).click();
    await g.page.waitForFunction(() => __hra.held.some(h => h.name === 'reserve'));
    await g.page.evaluate(() => { __hra.flipIn = 1; __hra.release(); });
    await g.page.waitForTimeout(200);
    assert.equal(await g.page.locator('.hra-item').isHidden(), true);
    assert.equal(await g.page.evaluate(() => __ui.isLocked()), false);
    assert.equal((await g.page.locator('.hra-live').innerText()).includes('טופס'), false);
    assert.equal(await file(g.page).inputValue(), '');
    await g.close();
  });

  await check('G1 · already-exists is not proof that nothing was published', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __hra.next.upload.push({ code: 'already-exists' }); });
    await upload(f.page);
    await f.page.locator('.hra-item[data-state=attempted]').waitFor();
    /* אותו קוד משמש גם לחברות שכבר פורסמה — ולכן הוא אינו סוגר ניסיון. */
    assert.equal(await f.page.getByRole('button', { name: 'הסירו את הבחירה' }).isHidden(), true);
    assert.equal(await f.page.getByRole('button', { name: 'בחרו קובץ אחר' }).isHidden(), true);
    assert.equal(await f.page.evaluate(() => __ui.isLocked()), true);
    assert.ok((await f.page.locator('.hra-item .hra-wait').innerText()).includes('לא ידוע'));
    await f.close();
  });

  await check('G2 · an identity reset erases the card text, not only its visibility', async () => {
    for (const how of ['identity', 'pagehide']) {
      const f = await fixture();
      await pickFile(f.page, 'אישור סודי 12.8.pdf', PDF, 'application/pdf');
      await f.page.locator('.hra-item').waitFor();
      assert.ok((await f.page.locator('.hra-item').innerText()).includes('אישור סודי'));
      if (how === 'identity') await f.page.evaluate(() => __hra.emit({ uid: 'u2', stationId: 's1', role: 'firefighter', super: false }));
      else await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
      await f.page.waitForTimeout(120);
      /* מוסתר אינו נעלם. הטקסט עצמו חייב לרדת מה-DOM. */
      const dom = await f.page.evaluate(() => ({
        body: document.body.textContent,
        html: document.querySelector('#host').innerHTML,
        /* תוויות הכפתורים הן markup קבוע. מה שחייב להיעלם הוא כל מה
         * שנגזר מהקובץ: שם, סוג, גודל, מצב והודעה. */
        derived: ['.hra-name', '.hra-meta', '.hra-state', '.hra-item .hra-problem',
          '.hra-item .hra-wait', '.hra-item .hra-ok', '.hra-live']
          .map(sel => [sel, [...document.querySelectorAll(sel)].map(n => n.textContent.trim()).join('')]),
        state: document.querySelector('.hra-item').dataset.state ?? null,
        input: document.querySelector('input[type=file]').value
      }));
      assert.equal(dom.body.includes('אישור סודי'), false, how + ' body');
      assert.equal(dom.html.includes('אישור סודי'), false, how + ' html');
      assert.deepEqual(dom.derived.filter(([, value]) => value !== ''), [], how + ' leftovers');
      assert.equal(dom.state, null, how + ' state');
      assert.equal(dom.input, '', how + ' input');
      await f.close();
    }
  });

  await check('G2 · a download belongs to its own run across a context change', async () => {
    const f = await fixture();
    await f.page.evaluate(() => {
      __hra.rows = [__hra.attachment('b')];
      __hra.next.download.push({ hold: true });
      __hra.next.download.push({ hold: true });
    });
    await f.page.getByRole('button', { name: 'רענון' }).click();
    await f.page.locator('.hra-row').first().waitFor();
    await f.page.getByRole('button', { name: 'הורדה' }).click();
    await f.page.waitForFunction(() => __hra.held.some(h => h.name === 'download'));
    /* הקשר חדש, ואותה שורה בדיוק נטענת שוב ומוחזקת. */
    await f.page.evaluate(id => { __hra.base = 9; __ui.setContext({ parent_kind: 'document', parent_id: id, parent_revision: 9, canUpload: true }); }, PARENT);
    await f.page.locator('.hra-row').first().waitFor();
    await f.page.getByRole('button', { name: 'הורדה' }).click();
    await f.page.waitForFunction(() => __hra.held.filter(h => h.name === 'download').length === 2);
    assert.equal(await f.page.getByRole('button', { name: 'מוריד…' }).isVisible(), true);
    /* ההורדה הישנה מסתיימת — ואינה משחררת את החדשה. הבדיקה מכריחה
     * ציור אמיתי לפני האימות, כי בעלות שנלקחה בשקט מתגלה רק בציור הבא. */
    await f.page.evaluate(() => { const old = __hra.held.shift(); old.resolve(); });
    await f.page.waitForTimeout(200);
    await pickFile(f.page, 'טופס.png', PNG, 'image/png');
    await f.page.locator('.hra-item').waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'מוריד…' }).isVisible(), true);
    assert.equal(await f.page.getByRole('button', { name: 'מוריד…' }).isDisabled(), true);
    assert.equal(await f.page.evaluate(() => __hra.urls.live), 0);
    await f.page.evaluate(() => __hra.release());
    await f.page.getByRole('button', { name: 'הורדה' }).waitFor({ state: 'visible' });
    assert.equal(await f.page.evaluate(() => __hra.urls.live), 0);
    await f.close();
  });

  await check('G3 · a publication that is not one revision past the base is not this publication', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __hra.next.upload.push({ result: { attachment_id: 'a'.repeat(64), state: 'ready',
      revision: 11, notification_status: 'policy_pending', duplicate: false, epoch: __hra.epoch() } }); });
    await upload(f.page);
    await f.page.locator('.hra-item[data-state=attempted]').waitFor();
    assert.deepEqual(await f.page.evaluate(() => __hra.published), []);
    await f.close();
    /* לפנייה אין גרסה מוצגת, ולכן הכלל הזה אינו חל עליה. */
    const g = await fixture({ context: { parent_kind: 'request', parent_id: PARENT, parent_revision: 4, canUpload: true } });
    await g.page.evaluate(() => { __hra.next.upload.push({ result: { attachment_id: 'a'.repeat(64), state: 'ready',
      revision: 11, notification_status: 'queued', duplicate: false, epoch: __hra.epoch() } }); });
    await upload(g.page);
    await state(g.page).getByText('צורף').waitFor();
    assert.deepEqual(await g.page.evaluate(() => __hra.published), [{ attachment_id: 'a'.repeat(64), revision: 11 }]);
    await g.close();
  });

  await check('G3 · reserve and ready receipts must carry the fields the service returns', async () => {
    const drops = [
      ['reserve', o => { delete o.duplicate; }],
      ['reserve', o => { delete o.reserve_expires_ms; }],
      ['upload', o => { delete o.duplicate; }],
      ['upload', o => { delete o.notification_status; }]
    ];
    for (const [method, damage] of drops) {
      const f = await fixture();
      await f.page.evaluate(([m, code]) => {
        const base = m === 'reserve'
          ? { attachment_id: 'a'.repeat(64), state: 'reserved', duplicate: false, reserve_expires_ms: 1756000900000, epoch: __hra.epoch() }
          : { attachment_id: 'a'.repeat(64), state: 'ready', revision: 5, notification_status: 'policy_pending', duplicate: false, epoch: __hra.epoch() };
        // eslint-disable-next-line no-new-func
        new Function('o', code)(base);
        __hra.next[m].push({ result: base });
      }, [method, '(' + damage.toString() + ')(o)']);
      await upload(f.page);
      await f.page.locator('.hra-item[data-state=attempted]').waitFor();
      assert.deepEqual(await f.page.evaluate(() => __hra.published), []);
      await f.close();
    }
  });

  await check('G3 · a list must describe itself: page size, cursor shape and the revision asked for', async () => {
    const bad = [
      ['a cursor on a short page', () => ({ items: [], next_cursor: '5|' + 'b'.repeat(64) })],
      ['a cursor that is not a cursor', () => ({ items: [], next_cursor: 'more-please' })],
      ['another revision than the one asked for', () => ({ items: [], next_cursor: null, revision: 9 })]
    ];
    for (const [why, shape] of bad) {
      const f = await fixture();
      await f.page.evaluate(code => {
        // eslint-disable-next-line no-new-func
        const patch = new Function('return (' + code + ')')()();
        __hra.next.list.push({ result: { items: [], next_cursor: null, revision: __hra.base, epoch: __hra.epoch(), ...patch } });
      }, shape.toString());
      await f.page.getByRole('button', { name: 'רענון' }).click();
      await f.page.locator('.hra > .hra-problem').waitFor();
      assert.ok((await f.page.locator('.hra > .hra-problem').innerText()).includes('לא ניתן לטעון'), why);
      assert.equal(await f.page.locator('.hra-row').count(), 0, why);
      await f.close();
    }
    /* ועמוד ארוך מהחוזה נדחה גם הוא. */
    const f = await fixture();
    await f.page.evaluate(() => {
      const rows = Array.from({ length: 26 }, (_, i) => {
        const row = __hra.attachment('b');
        row.attachment_id = ('b' + i.toString(16).padStart(2, '0')).padEnd(64, '0');
        return row;
      });
      __hra.next.list.push({ result: { items: rows, next_cursor: null, revision: __hra.base, epoch: __hra.epoch() } });
    });
    await f.page.getByRole('button', { name: 'רענון' }).click();
    await f.page.locator('.hra > .hra-problem').waitFor();
    assert.equal(await f.page.locator('.hra-row').count(), 0);
    await f.close();
  });

  await check('both palettes hold at 390px with visible focus and 44px targets', async () => {
    for (const theme of ['light', 'dark']) {
      const f = await fixture({ width: 390, theme });
      await f.page.evaluate(() => { __hra.rows = [__hra.attachment('b')]; });
      await f.page.getByRole('button', { name: 'רענון' }).click();
      await f.page.locator('.hra-row').first().waitFor();
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, theme + ' overflows');
      await file(f.page).focus();
      assert.equal(await f.page.locator('.hra-file').evaluate(e => getComputedStyle(e).outlineStyle !== 'none'), true);
      const heights = await f.page.locator('#host button:visible').evaluateAll(list => list.map(b => b.getBoundingClientRect().height));
      assert.ok(heights.length > 0 && heights.every(h => h >= 44), theme + ' targets ' + JSON.stringify(heights));
      const ink = await f.page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('.hra-name')).color]);
      assert.notEqual(ink[0], ink[1]);
      await f.close();
    }
  });

  await check('a latin run inside a Hebrew file name keeps the order it has on disk', async () => {
    const f = await fixture();
    await f.page.evaluate(() => {
      const row = __hra.attachment('b');
      row.display_name = 'אישור מחלה 12.8.pdf';
      __hra.rows = [row];
    });
    await f.page.getByRole('button', { name: 'רענון' }).click();
    await f.page.locator('.hra-row').first().waitFor();
    /* מדידה, לא ניחוש: היכן נמצא „12.8" ביחס ל„pdf" על המסך. בשורה
     * RTL בלי בידוד הנקודה שביניהם לוקחת את כיוון הפסקה ומפרידה את שני
     * הרצפים, ואז הסיומת מצוירת לפני המספר. */
    const where = await f.page.evaluate(() => {
      const x = node => { const r = document.createRange(); r.selectNodeContents(node); return r.getBoundingClientRect().left; };
      const control = document.createElement('span');
      control.dir = 'rtl';
      control.textContent = 'אישור מחלה 12.8.pdf';
      document.body.append(control);
      const range = (from, to) => { const r = document.createRange(); r.setStart(control.firstChild, from); r.setEnd(control.firstChild, to); return r.getBoundingClientRect().left; };
      const raw = { number: range(11, 15), extension: range(16, 19) };
      const parts = [...document.querySelectorAll('.hra-name bdi')];
      control.remove();
      return { raw, isolated: parts.map(p => [p.textContent, x(p)]) };
    });
    assert.ok(where.raw.extension < where.raw.number, 'the raw string must actually reorder, or this test proves nothing');
    assert.deepEqual(where.isolated.map(p => p[0]), ['12.8.pdf']);
    assert.equal(await f.page.locator('.hra-name bdi').evaluate(e => getComputedStyle(e).unicodeBidi), 'isolate');
    await f.close();
  });

  await check('a latin token beside Hebrew is isolated so the size cannot reorder', async () => {
    const f = await fixture();
    await f.page.evaluate(() => { __hra.rows = [__hra.attachment('b')]; });
    await f.page.getByRole('button', { name: 'רענון' }).click();
    await f.page.locator('.hra-row').first().waitFor();
    const tokens = f.page.locator('.hra-row .hra-tok');
    assert.equal(await tokens.count(), 2);
    assert.equal(await tokens.first().innerText(), 'PNG');
    assert.equal(await tokens.first().evaluate(e => getComputedStyle(e).unicodeBidi), 'isolate');
    assert.equal(await f.page.evaluate(() => document.dir), 'rtl');
    await f.close();
  });

  assert.deepEqual(hashes(), before);
  console.log('HR attachments UI browser: ' + passed + '/' + passed + ' passed.');
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser.close();
}
