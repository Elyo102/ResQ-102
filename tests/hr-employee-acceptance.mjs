/* קבלה · העברה בין עובד למשאבי אנוש, על מצב משותף.
 *
 * ההבדל מ-`hr-requests-browser.mjs`: שם רכיב אחד בהקשר אחד, כפיל לכל
 * הקשר. כאן **שני דפדפנים חיים בו-זמנית** מול **מודל אחד** בצד Node.
 *
 * ══ מה הקובץ הזה הוא, ומה איננו ══
 *
 * המודל **משקף את החוזה** של `functions/hr-requests.js` — קבלת פעולה
 * לפי `request_id` עם fingerprint, קידום גרסה גם בנדנוד, מדיניות
 * שקט שמחזירה `confirmation_required`, ו-`notification_status` לפי
 * אותם כללים. **הוא אינו השירות.** אין כאן Firestore, אין אמולטור,
 * ואין הרשאות אמיתיות.
 *
 * לכן, במפורש: **כל טענה על ACL, על תור ההתראות ועל אידמפוטנטיות היא
 * טענה על התנהגות המסך מול חוזה משוקף — לא ראיה שהשרת מתנהג כך.**
 * ראיה לשרת מגיעה מ-`functions/hr-requests.integration.test.js` מול
 * אמולטור, שלא רץ כאן. מה שהקובץ הזה כן מוכיח הוא מה שהמסך שולח, מה
 * הוא מציג, ומה הוא מסתיר — וזה מה שבדיקת רכיב בהקשר אחד אינה יכולה.
 *
 * **פוש:** לעבודה יש `delivery_status: 'intent_only'`. הבדיקות טוענות
 * על **כוונה שנרשמה** בלבד. `queued` · `suppressed` · `policy_pending`
 * — אף אחד מהם אינו מסירה למכשיר, וזה אינו נבדק כאן ואינו ניתן
 * לבדיקה כאן.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:41998';
const owned = ['hr-requests.html', 'hr-requests-client.js', 'hr-requests-ui.js'];
const hashes = () => Object.fromEntries(owned.map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')]));
const before = hashes();
const browser = await chromium.launch(process.env.RESQ_CHROMIUM ? { executablePath: process.env.RESQ_CHROMIUM } : {});
const contexts = new Set();
let passed = 0;

const PEOPLE = {
  employee: { uid: 'employee-a', stationId: 'station-1', role: 'firefighter', super: false },
  other: { uid: 'employee-b', stationId: 'station-1', role: 'firefighter', super: false },
  hr: { uid: 'coordinator-1', stationId: 'station-1', role: 'hr_coordinator', super: false },
  farHr: { uid: 'coordinator-2', stationId: 'station-2', role: 'hr_coordinator', super: false },
  commander: { uid: 'commander-1', stationId: 'station-1', role: 'station_commander', super: false }
};
const id = seed => createHash('sha256').update(seed).digest('hex');
const fingerprintOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/* ---------- מודל אחד, משקף את החוזה ---------- */

function createModel() {
  const cases = new Map();
  const receipts = new Map();     // request_id -> { actor, fingerprint, result }
  const jobs = [];                // כוונות התראה. `intent_only`.
  const calls = [];
  const held = new Set();
  const lost = new Set();
  const waiting = [];
  let clock = 1756000000000;
  let down = false;
  let silent = false;             // „שעות שקט" — מה שמחזיר confirmation_required

  const fail = (code) => Object.assign(new Error(code), { code: 'functions/' + code });
  const manager = who => who.role === 'hr_coordinator' || who.super === true;
  const visible = (who, item) => item.station_id === who.stationId
    && (item.owner_uid === who.uid || manager(who));
  const strip = item => ({ case_id: item.case_id, subject: item.subject, status: item.status,
    revision: item.revision, owner_uid: item.owner_uid, updated_at_ms: item.updated_at_ms });

  return {
    calls, jobs,
    get quiet() { return silent; },
    setQuiet(value) { silent = value; },
    breakLink(value) { down = value; },
    holdNext(method) { held.add(method); },
    release() { held.clear(); waiting.splice(0).forEach(go => go()); },
    gate(method) { return held.has(method) ? new Promise(go => waiting.push(go)) : null; },
    /** הכתיבה **מתחייבת**, והתשובה עליה אובדת. זה המצב שבו „ניסיון
     *  חוזר" חייב להיות שידור של אותה בקשה ולא פעולה שנייה. */
    loseNextResponse(method) { lost.add(method); },
    responseLost(method) { return lost.delete(method); },
    caseOf(caseId) { return cases.get(caseId); },
    eventsOf(caseId) { return cases.get(caseId).events; },
    seed(subject, owner = PEOPLE.employee) {
      const item = { case_id: id(subject), station_id: owner.stationId, owner_uid: owner.uid,
        subject, status: 'open', revision: 1, created_at_ms: clock, updated_at_ms: clock,
        events: [{ event_id: id(subject + ':0'), revision: 1, actor_uid: owner.uid, kind: 'create', text: 'גוף הפנייה' }] };
      cases.set(item.case_id, item);
      return item;
    },

    handle(who, method, data) {
      calls.push({ who: who && who.uid, method, data });
      if (down) throw fail('unavailable');
      if (!who) throw fail('unauthenticated');
      clock += 1000;

      if (method === 'listInbox' && !manager(who)) throw fail('permission-denied');
      if (method === 'list' || method === 'listInbox') {
        const rows = [...cases.values()].filter(item => method === 'list'
          ? item.owner_uid === who.uid && item.station_id === who.stationId
          : visible(who, item));
        return { items: rows.map(strip), next_cursor: null };
      }

      const item = data.case_id ? cases.get(data.case_id) : null;
      /* „לא קיים" ו„אינו שלך" — אותו קוד בדיוק, ולא רק באותה מילה. */
      if (method !== 'create' && (!item || !visible(who, item))) throw fail('not-found');
      if (method === 'get') return { ...strip(item), events: item.events, next_cursor: null };

      /* קבלת פעולה לפי `request_id`, כמו בשירות: אותה בקשה בדיוק חוזרת
       * כשכפולה; אותו מזהה עם מטען אחר הוא `already-exists`. */
      const fingerprint = fingerprintOf([who.uid, method, data.case_id ?? null,
        data.text ?? null, data.status ?? null, data.subject ?? null, data.expected_revision ?? null]);
      const prior = receipts.get(data.request_id);
      if (prior) {
        if (prior.actor !== who.uid || prior.fingerprint !== fingerprint) throw fail('already-exists');
        return { ...prior.result, duplicate: true };
      }

      if (method !== 'create' && item.revision !== data.expected_revision) throw fail('aborted');
      const ownerSide = method === 'create' || item.owner_uid === who.uid;
      if (method === 'reply' && item.status === 'closed') throw fail('failed-precondition');
      if (method === 'nudge' && !(ownerSide
        ? ['open', 'in_progress'].includes(item.status) : item.status === 'waiting_employee')) {
        throw fail('failed-precondition');
      }

      /* שקט + בלי אישור מפורש ⇒ נדרש אישור. זו מדיניות, לא היעדר שדה. */
      const confirmation = method === 'nudge' && silent && data.send_now !== true;
      const noChange = method === 'setStatus' && item.status === data.status;
      let result;
      if (noChange || confirmation) {
        result = { case_id: item.case_id, revision: item.revision, status: item.status,
          outcome: noChange ? 'no_change' : 'confirmation_required', notification_status: 'not_queued' };
      } else {
        const target = method === 'create' ? this.seed(data.subject, who) : item;
        const fromStatus = method === 'create' ? 'open' : item.status;
        if (method !== 'create') {
          target.revision += 1;                     // גם נדנוד מקדם גרסה
          target.updated_at_ms = clock;
          if (method === 'setStatus') target.status = data.status;
          else if (method === 'reply' && ownerSide && target.status === 'waiting_employee') target.status = 'open';
        } else if (data.text) target.events[0].text = data.text;
        const eventId = id(target.case_id + ':' + target.revision + ':' + method);
        if (method !== 'create') {
          target.events.push({ event_id: eventId, revision: target.revision, actor_uid: who.uid,
            kind: method, ...(data.text ? { text: data.text } : {}),
            // כמו בשירות: שינוי מצב נושא את שני הקצוות, והמסך מאמת אותם.
            ...(method === 'setStatus' ? { from_status: fromStatus, to_status: target.status } : {}) });
        }
        const ownerNotification = method === 'setStatus' || !ownerSide;
        const notifySelf = ownerNotification && target.owner_uid === who.uid;
        const notificationStatus = notifySelf ? 'no_other_recipient'
          : (silent && data.send_now !== true && method === 'nudge') ? 'suppressed' : 'policy_pending';
        if (notificationStatus !== 'no_other_recipient') {
          jobs.push({ event_id: eventId, case_id: target.case_id, station_id: target.station_id,
            actor_uid: who.uid, audience: ownerNotification ? 'person' : 'station_hr',
            ...(ownerNotification ? { recipient_uid: target.owner_uid } : {}),
            type: method === 'nudge' ? 'hr_nudge' : ownerNotification ? 'hr_reply' : 'hr_request',
            status: notificationStatus, delivery_status: 'intent_only', exclude_actor: true });
        }
        result = { case_id: target.case_id, revision: target.revision, status: target.status,
          outcome: 'saved', event_id: eventId, notification_status: notificationStatus };
      }
      receipts.set(data.request_id, { actor: who.uid, fingerprint, result });
      return { ...result, duplicate: false };
    }
  };
}

/* ---------- דפדפן לכל אדם ---------- */

const CLIENT_STUBS = who => ({
  '/appcheck.js': 'export async function initAppCheck(){window.__appCheck=true;}',
  '/monitored-functions.js': `export function getFunctions(a,r){window.__region=r;return {};}
export function httpsCallable(f,name){return async data => {
  if(!window.__appCheck) throw new Error('App Check ordering violated');
  const out = await window.__server(name, JSON.parse(JSON.stringify(data)));
  if (out.error) throw Object.assign(new Error('server'), { code: 'functions/' + out.error });
  return { data: out.value };
};}`,
  '/firebase-app.js': 'export function initializeApp(){return {};}',
  '/firebase-auth.js': `const who = ${JSON.stringify(who)};
export function getAuth(){ return window.__auth ||= { currentUser: makeUser(who) }; }
function makeUser(p){ return p && { uid: p.uid, getIdTokenResult: async () => {
  if (window.__holdClaims) await new Promise(go => { window.__releaseClaims = go; });
  return { claims: { stationId: p.stationId, role: p.role, super: p.super } };
} }; }
window.__become = p => { window.__auth.currentUser = makeUser(p); return Promise.all(window.__watchers.map(fn => fn(window.__auth.currentUser))); };
export function onIdTokenChanged(auth, cb){ (window.__watchers ||= []).push(cb); queueMicrotask(() => cb(auth.currentUser)); return () => {}; }`
});

const NAMES = { createHrRequest: 'create', listMyHrRequests: 'list', listHrRequestsInbox: 'listInbox',
  getHrRequest: 'get', replyHrRequest: 'reply', setHrRequestStatus: 'setStatus', nudgeHrRequest: 'nudge' };

async function openAs(model, who) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1100, height: 900 } });
  contexts.add(ctx);
  const stubs = CLIENT_STUBS(who);
  await ctx.route('**/*', async route => {
    const url = new URL(route.request().url());
    const key = url.hostname === 'www.gstatic.com' ? '/' + url.pathname.split('/').pop() : url.pathname;
    if (stubs[key]) return route.fulfill({ status: 200, contentType: 'text/javascript', body: stubs[key] });
    if (url.origin !== origin) return route.abort();
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: file.endsWith('.html') ? 'text/html; charset=utf-8'
      : file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
  });
  const page = await ctx.newPage(), errors = [];
  page.setDefaultTimeout(6000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  let acting = who;
  await page.exposeFunction('__server', async (name, data) => {
    /* השחקן נלכד **כשהקריאה יוצאת**, לא אחרי ההמתנה. קריאה מוחזקת
     * שמתבצעת בשם מי שהתחבר אחריה היא בדיוק הבאג שאנחנו בודקים. */
    const actor = acting;
    const wait = model.gate(NAMES[name]);
    if (wait) await wait;
    let value;
    try { value = model.handle(actor, NAMES[name], data); }
    catch (error) { return { error: String(error.code || '').replace(/^functions\//, '') || 'internal' }; }
    // התשובה אובדת **אחרי** שהכתיבה נרשמה.
    if (model.responseLost(NAMES[name])) return { error: 'unavailable' };
    return { value };
  });
  await page.goto(origin + '/hr-requests.html');
  await page.waitForFunction(() => window.__appCheck === true);
  return {
    page, errors, who,
    become: async next => { acting = next; await page.evaluate(p => window.__become(p), next); },
    close: async () => { assert.deepEqual(errors, []); await ctx.close(); contexts.delete(ctx); }
  };
}

const q = (page, key) => page.locator('[data-r="' + key + '"]');
const openCase = async (page, caseId) => {
  await page.locator('[data-case="' + caseId + '"]').click();
  await q(page, 'reply-form').waitFor({ state: 'visible' });
};
const sent = (model, method) => model.calls.filter(c => c.method === method);
async function check(name, fn) { await fn(); passed += 1; console.log('PASS ' + name); }

try {
  await check('UI · a reply written by HR is the text the employee reads', async () => {
    const model = createModel();
    const item = model.seed('בקשת ימי מחלה');
    const hr = await openAs(model, PEOPLE.hr);
    await q(hr.page, 'inbox').click();
    await openCase(hr.page, item.case_id);
    await q(hr.page, 'reply').fill('התקבל. נדרש אישור רופא עד סוף השבוע.');
    await q(hr.page, 'reply-save').click();
    await hr.page.waitForFunction(() => !document.querySelector('[data-r="reply-save"]').disabled);

    const worker = await openAs(model, PEOPLE.employee);
    await openCase(worker.page, item.case_id);
    assert.ok((await q(worker.page, 'detail').innerText()).includes('נדרש אישור רופא עד סוף השבוע.'));
    /* כוונת התראה אחת, לבעל הפנייה, שאינה השולח — ו„כוונה" בלבד. */
    assert.equal(model.jobs.length, 1);
    assert.deepEqual({ to: model.jobs[0].recipient_uid, type: model.jobs[0].type,
      delivery: model.jobs[0].delivery_status, excludes: model.jobs[0].exclude_actor },
    { to: PEOPLE.employee.uid, type: 'hr_reply', delivery: 'intent_only', excludes: true });
    await hr.close();
    await worker.close();
  });

  await check('contract · "not yours" and "does not exist" answer with the same code', async () => {
    const model = createModel();
    const mine = model.seed('פנייה של עובד א');
    const missing = id('never-created');
    /* לא בפרוזה: שתי קריאות `get` אמיתיות דרך גבול המודל, והשוואת הקוד. */
    const ask = (who, caseId) => {
      try { model.handle(who, 'get', { case_id: caseId, request_id: 'probe-' + caseId.slice(0, 8) }); return 'ok'; }
      catch (error) { return String(error.code); }
    };
    assert.equal(ask(PEOPLE.other, mine.case_id), 'functions/not-found', 'a case that is not his');
    assert.equal(ask(PEOPLE.other, missing), 'functions/not-found', 'a case that does not exist');
    assert.equal(ask(PEOPLE.farHr, mine.case_id), 'functions/not-found', 'another station');
    assert.equal(ask(PEOPLE.farHr, missing), 'functions/not-found');
    assert.equal(ask(PEOPLE.hr, mine.case_id), 'ok', 'and the coordinator of this station does see it');
  });

  await check('UI · the screens show only what belongs to the person looking', async () => {
    const model = createModel();
    const item = model.seed('פנייה של עובד א');
    const far = await openAs(model, PEOPLE.farHr);
    await q(far.page, 'inbox').click();
    await far.page.waitForTimeout(250);
    assert.equal(await far.page.locator('[data-case="' + item.case_id + '"]').count(), 0);
    assert.equal((await far.page.locator('body').innerText()).includes('פנייה של עובד א'), false);
    await far.close();
    const peer = await openAs(model, PEOPLE.other);
    await peer.page.waitForTimeout(250);
    assert.equal(await peer.page.locator('[data-case="' + item.case_id + '"]').count(), 0);
    assert.equal(await q(peer.page, 'inbox').isHidden(), true);
    await peer.close();
    const boss = await openAs(model, PEOPLE.commander);
    assert.equal(await q(boss.page, 'inbox').isHidden(), true, 'a commander does not read the HR inbox');
    await boss.close();
  });

  await check('contract · a nudge advances the revision and records one intent, never for the actor', async () => {
    const model = createModel();
    const item = model.seed('פנייה שממתינה');
    const hr = await openAs(model, PEOPLE.hr);
    await q(hr.page, 'inbox').click();
    await openCase(hr.page, item.case_id);
    assert.equal(await q(hr.page, 'nudge').isHidden(), true, 'not while it does not wait on the employee');
    await q(hr.page, 'status').selectOption('waiting_employee');
    await q(hr.page, 'status-save').click();
    await hr.page.waitForFunction(() => !document.querySelector('[data-r="status-save"]').disabled);
    await q(hr.page, 'nudge').waitFor({ state: 'visible' });
    const beforeRevision = model.caseOf(item.case_id).revision;
    await q(hr.page, 'nudge').click();
    await hr.page.waitForTimeout(300);
    /* כמו בשירות: נדנוד הוא מוטציה, ולכן הגרסה מתקדמת. */
    assert.equal(model.caseOf(item.case_id).revision, beforeRevision + 1);
    const nudges = model.jobs.filter(j => j.type === 'hr_nudge');
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0].recipient_uid, PEOPLE.employee.uid);
    assert.equal(nudges[0].actor_uid, PEOPLE.hr.uid);
    assert.equal(nudges[0].exclude_actor, true);
    assert.equal(nudges[0].delivery_status, 'intent_only');
    /* לחיצה אחת = קריאה אחת. זה נאמר על המסך, לא על המודל. */
    assert.equal(sent(model, 'nudge').length, 1);
    /* והמסך אינו אומר „נמסר". */
    assert.equal(/נמסר|הגיע למכשיר/.test(await q(hr.page, 'detail').innerText()), false);
    await hr.close();
  });

  await check('contract · quiet hours ask for confirmation instead of queuing', async () => {
    const model = createModel();
    const item = model.seed('פנייה בשעת שקט');
    item.status = 'waiting_employee';
    model.setQuiet(true);
    const hr = await openAs(model, PEOPLE.hr);
    await q(hr.page, 'inbox').click();
    await openCase(hr.page, item.case_id);
    await q(hr.page, 'nudge').click();
    await hr.page.waitForTimeout(300);
    assert.deepEqual(model.jobs.filter(j => j.type === 'hr_nudge'), [], 'nothing queued without consent');
    assert.equal(model.caseOf(item.case_id).revision, 1, 'and no revision was spent');
    const call = sent(model, 'nudge')[0];
    assert.equal(call.data.send_now, false, 'the screen asked without consent first');
    /* ואחרי אישור מפורש — נשלח, ועם consent. */
    await q(hr.page, 'send-now').check();
    await q(hr.page, 'nudge').click();
    await hr.page.waitForTimeout(300);
    const second = sent(model, 'nudge')[1];
    assert.equal(second.data.send_now, true);
    assert.notEqual(second.data.request_id, call.data.request_id, 'a new consent is a new action');
    assert.equal(model.jobs.filter(j => j.type === 'hr_nudge').length, 1);
    await hr.close();
  });

  await check('UI · an identity change is honoured the moment the token turns, not when the answer lands', async () => {
    const model = createModel();
    const item = model.seed('פנייה פרטית');
    const hr = await openAs(model, PEOPLE.hr);
    await q(hr.page, 'inbox').click();
    await openCase(hr.page, item.case_id);
    await q(hr.page, 'reply').fill('טיוטה שלא נשמרה');
    model.holdNext('list');
    await hr.page.evaluate(() => { window.__holdClaims = true; });
    void hr.become(PEOPLE.other);
    await hr.page.waitForFunction(() => typeof window.__releaseClaims === 'function');
    await hr.page.waitForTimeout(150);
    const during = await hr.page.locator('body').innerText();
    assert.equal(during.includes('פנייה פרטית'), false, 'nothing of the previous person survives');
    assert.equal(during.includes('טיוטה שלא נשמרה'), false);
    assert.equal(await hr.page.locator('[data-case]').count(), 0);
    await hr.page.evaluate(() => { window.__holdClaims = false; window.__releaseClaims(); });
    model.release();
    await hr.page.waitForTimeout(200);
    assert.equal(await q(hr.page, 'inbox').isHidden(), true, 'and the inbox is not his to read');
    /* ואף פעולה לא נרשמה בשמו על הפנייה ההיא. */
    assert.equal(model.calls.some(c => c.who === PEOPLE.other.uid
      && ['reply', 'setStatus', 'nudge'].includes(c.method)), false);
    await hr.close();
  });

  await check('recovery · a link that drops BEFORE the write keeps the draft and lands exactly one write', async () => {
    const model = createModel();
    const item = model.seed('ניתוק לפני הכתיבה');
    const hr = await openAs(model, PEOPLE.hr);
    await q(hr.page, 'inbox').click();
    await openCase(hr.page, item.case_id);
    model.breakLink(true);
    await q(hr.page, 'reply').fill('תשובה שנשלחת בזמן ניתוק');
    await q(hr.page, 'reply-save').click();
    await hr.page.waitForTimeout(300);
    assert.equal(model.caseOf(item.case_id).revision, 1, 'nothing was written while the link was down');
    assert.equal(await q(hr.page, 'reply').inputValue(), 'תשובה שנשלחת בזמן ניתוק', 'the draft survives');
    const first = sent(model, 'reply')[0];
    assert.equal(await q(hr.page, 'retry').isVisible(), true, 'a retry is offered');
    model.breakLink(false);
    await q(hr.page, 'retry').click();
    await hr.page.waitForTimeout(400);
    const attempts = sent(model, 'reply');
    assert.equal(attempts.length, 2);
    /* אותה בקשה בדיוק — לא בקשה חדשה על אותו טקסט. */
    assert.deepEqual(attempts[1].data, first.data);
    assert.equal(model.caseOf(item.case_id).revision, 2, 'exactly one write landed');
    assert.equal(model.eventsOf(item.case_id).filter(e => e.kind === 'reply').length, 1);
    await hr.close();
  });

  await check('recovery · a response lost AFTER the write replays the same id and writes nothing more', async () => {
    const model = createModel();
    const item = model.seed('תשובה שאבדה אחרי הכתיבה');
    const hr = await openAs(model, PEOPLE.hr);
    await q(hr.page, 'inbox').click();
    await openCase(hr.page, item.case_id);
    await q(hr.page, 'reply').fill('תשובה שנכתבה והתשובה עליה אבדה');
    /* הכתיבה מתחייבת — ורק אז התשובה אובדת. */
    model.loseNextResponse('reply');
    await q(hr.page, 'reply-save').click();
    await hr.page.waitForTimeout(400);
    const first = sent(model, 'reply')[0];
    /* ראיה שהכתיבה **כן** נחתה, למרות שהמסך לא קיבל תשובה. */
    assert.equal(model.caseOf(item.case_id).revision, 2, 'the write committed');
    assert.equal(model.eventsOf(item.case_id).filter(e => e.kind === 'reply').length, 1);
    assert.equal(await q(hr.page, 'retry').isVisible(), true, 'and the screen offers a retry, not a new send');
    await q(hr.page, 'retry').click();
    await hr.page.waitForTimeout(400);
    const attempts = sent(model, 'reply');
    assert.equal(attempts.length, 2, 'the retry is one more attempt, not a new action');
    assert.deepEqual(attempts[1].data, first.data, 'byte for byte the same request');
    assert.equal(attempts[1].data.request_id, first.data.request_id);
    /* ההשמעה החוזרת מוכרת ככפולה, ולא נכתב דבר נוסף. */
    assert.equal(model.caseOf(item.case_id).revision, 2, 'no second write');
    assert.equal(model.eventsOf(item.case_id).filter(e => e.kind === 'reply').length, 1);
    assert.equal(model.jobs.filter(j => j.type === 'hr_reply').length, 1);
    await hr.close();
  });

  await check('contract · the same request id with a different payload is refused, not merged', async () => {
    const model = createModel();
    const item = model.seed('אותו מזהה מטען אחר');
    const shared = 'shared-request-identifier-01';
    const one = model.handle(PEOPLE.hr, 'reply',
      { request_id: shared, case_id: item.case_id, expected_revision: 1, send_now: false, text: 'ראשונה' });
    assert.equal(one.duplicate, false);
    const again = model.handle(PEOPLE.hr, 'reply',
      { request_id: shared, case_id: item.case_id, expected_revision: 1, send_now: false, text: 'ראשונה' });
    assert.equal(again.duplicate, true, 'the identical request replays');
    assert.equal(model.eventsOf(item.case_id).filter(e => e.kind === 'reply').length, 1);
    assert.throws(() => model.handle(PEOPLE.hr, 'reply',
      { request_id: shared, case_id: item.case_id, expected_revision: 2, send_now: false, text: 'אחרת' }),
    /already-exists/, 'a different payload on the same id is refused');
  });

  await check('UI · two people on one revision: the second is told it moved, not merged', async () => {
    const model = createModel();
    const item = model.seed('פנייה במרוץ');
    const hr = await openAs(model, PEOPLE.hr);
    const worker = await openAs(model, PEOPLE.employee);
    await q(hr.page, 'inbox').click();
    await openCase(hr.page, item.case_id);
    await openCase(worker.page, item.case_id);
    await q(hr.page, 'reply').fill('תשובת רכזת');
    await q(hr.page, 'reply-save').click();
    await hr.page.waitForFunction(() => !document.querySelector('[data-r="reply-save"]').disabled);
    assert.equal(model.caseOf(item.case_id).revision, 2);
    await q(worker.page, 'reply').fill('הודעה של העובד');
    await q(worker.page, 'reply-save').click();
    await worker.page.waitForTimeout(300);
    assert.equal(model.caseOf(item.case_id).revision, 2, 'the stale write did not land');
    const stale = sent(model, 'reply').filter(c => c.who === PEOPLE.employee.uid);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].data.expected_revision, 1);
    assert.equal(await q(worker.page, 'reply').inputValue(), 'הודעה של העובד', 'the text is not thrown away');
    await hr.close();
    await worker.close();
  });

  assert.deepEqual(hashes(), before, 'product sources unchanged');
  console.log('HR employee acceptance: ' + passed + '/' + passed + ' passed.');
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser.close();
}
