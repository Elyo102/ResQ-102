'use strict';

/* ======================================================================
 *  hr-absence-report — דיווח מחלה ומילואים עם קובץ
 *
 *  ההכרעה שמאחורי הקובץ הזה: **לא נפתח אוסף חדש.** מחלה ומילואים הם
 *  פנייה של העובד למשאבי אנוש — אותה ישות בדיוק שכבר קיימת ב-
 *  `hr_requests`: בבעלות העובד, עם צרופות, עם היסטוריה, וסגורה
 *  לחלוטין לכתיבה מהדפדפן. אוסף שני היה מכפיל הרשאות, צרופות ויומן
 *  בלי להוסיף דבר. מה שנוסף הוא סוג, טווח תאריכים והכרעה.
 *
 *  מה נבדק כאן: הסמכות וההשפעה. מי יוצר, מי מכריע, מי רואה, ומה
 *  קורה לקובץ שהוסר.
 *
 *  מה **אינו** נבדק כאן: אכיפת כללי Firestore (אמולטור — NOT RUN),
 *  ומסלול ההעלאה עצמו, שיש לו בדיקות משלו.
 * ====================================================================== */

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { fakeDb, FakeHttpsError, people, AUTH_TIME } = require('./hr-pilot-test-harness');
const { createHrRequests } = require('./hr-requests');

const SID = 'station_102';
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fileId = (seed) => hash(['attachment', seed]);

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('✓ ' + name); }
  catch (error) { failures.push(name); console.log('✗ ' + name + ' — ' + error.message); }
}
async function rejects(promise, code) {
  try { await promise; }
  catch (error) {
    assert.equal(error.code, code, 'expected ' + code + ' but got ' + error.code + ': ' + error.message);
    return error;
  }
  assert.fail('expected a ' + code + ' rejection, but the call succeeded');
}

function world() {
  const db = fakeDb();
  const who = people(db, SID);
  let clock = Date.parse('2026-09-19T08:00:00Z');
  const requests = createHrRequests({ db, auth: who.auth, HttpsError: FakeHttpsError, clock: () => (clock += 1000) });
  db._put('config/runtime', { silent: false });
  return { db, who, requests };
}

const report = (over) => ({
  request_id: 'req-' + Math.random().toString(16).slice(2, 12),
  subject: 'דיווח היעדרות', text: 'מצורף אישור.', send_now: false,
  kind: 'sick', from_date: '2026-09-10', to_date: '2026-09-12', ...over
});

/** מצרף קובץ לדיווח, כפי שמסלול ההעלאה משאיר אותו. */
function attach(w, caseId, uploaderUid, id) {
  const path = 'stations/' + SID + '/hr_requests/' + caseId;
  const current = w.db._get(path);
  w.db._put(path, { ...current, attachment_ids: (current.attachment_ids || []).concat(id) });
  w.db._put('stations/' + SID + '/hr_attachments/' + id, {
    schema: 'hr-attachment-v1', attachment_id: id, state: 'ready', station_id: SID,
    actor_uid: uploaderUid, parent_kind: 'request', parent_id: caseId,
    display_name: 'אישור.pdf', byte_length: 2048,
    object_path: 'stations/' + SID + '/attachments/' + id, object_generation: '1'
  });
  return w.db._get(path).revision;
}

(async () => {
  /* ---------- 1 ---------- */
  await test('an employee files a sickness report with a file attached to it', async () => {
    const w = world();
    const worker = w.who.add('worker', 'firefighter');
    const created = await w.requests.create(w.who.req(worker, report()));
    const stored = w.db._get('stations/' + SID + '/hr_requests/' + created.case_id);
    assert.equal(stored.kind, 'sick');
    assert.equal(stored.from_date, '2026-09-10');
    assert.equal(stored.to_date, '2026-09-12');
    assert.equal(stored.decision, 'pending', 'a report is born pending, never approved');
    assert.equal(stored.owner_uid, worker);
    attach(w, created.case_id, worker, fileId('sick'));
    // ⭐ הקובץ קשור לדיווח הזה ולא „מרחף" בפני עצמו.
    const view = await w.requests.get(w.who.req(worker, { case_id: created.case_id }));
    assert.equal(view.kind, 'sick');
    assert.equal(view.decision, 'pending');
    const record = w.db._get('stations/' + SID + '/hr_attachments/' + fileId('sick'));
    assert.equal(record.parent_kind, 'request');
    assert.equal(record.parent_id, created.case_id, 'the file belongs to this report');
  });

  /* ---------- 2 ---------- */
  await test('and a reserve-duty report the same way', async () => {
    const w = world();
    const worker = w.who.add('worker', 'firefighter');
    const created = await w.requests.create(w.who.req(worker,
      report({ kind: 'reserve', from_date: '2026-08-01', to_date: '2026-08-20' })));
    const stored = w.db._get('stations/' + SID + '/hr_requests/' + created.case_id);
    assert.equal(stored.kind, 'reserve');
    assert.equal(stored.decision, 'pending');
    attach(w, created.case_id, worker, fileId('reserve'));
    const view = await w.requests.get(w.who.req(worker, { case_id: created.case_id }));
    assert.equal(view.from_date, '2026-08-01');
    assert.equal(view.to_date, '2026-08-20');
  });

  /* ---------- 3 ---------- */
  await test('an employee cannot read another employee’s report', async () => {
    const w = world();
    const worker = w.who.add('worker', 'firefighter');
    const other = w.who.add('other', 'firefighter');
    const created = await w.requests.create(w.who.req(worker, report()));
    await rejects(w.requests.get(w.who.req(other, { case_id: created.case_id })), 'permission-denied');
    const mine = await w.requests.list(w.who.req(other, {}));
    assert.deepEqual(mine.items, [], 'and it does not appear in their own list');
  });

  /* ---------- 4 ---------- */
  for (const [label, role, isSuper] of [['hr_coordinator', 'hr_coordinator', false], ['super', 'firefighter', true]]) {
    await test('a ' + label + ' sees the report and its file, and can approve or reject it', async () => {
      const w = world();
      const worker = w.who.add('worker', 'firefighter');
      const boss = w.who.add('boss_' + label, role, isSuper);
      const created = await w.requests.create(w.who.req(worker, report()));
      const revision = attach(w, created.case_id, worker, fileId('decide-' + label));

      const seen = await w.requests.get(w.who.req(boss, { case_id: created.case_id }));
      assert.equal(seen.kind, 'sick');
      assert.deepEqual(w.db._get('stations/' + SID + '/hr_requests/' + created.case_id).attachment_ids,
        [fileId('decide-' + label)], 'the file is there to look at before deciding');

      const out = await w.requests.setDecision(w.who.req(boss, {
        request_id: 'req-decide-' + label, case_id: created.case_id,
        expected_revision: revision, send_now: false, decision: 'approved'
      }));
      assert.equal(out.outcome, 'saved');
      const after = w.db._get('stations/' + SID + '/hr_requests/' + created.case_id);
      assert.equal(after.decision, 'approved');
      assert.equal(after.decided_by, boss, 'who decided is recorded');
      assert.equal(Number.isSafeInteger(after.decided_at_ms), true, 'and when');
      const event = w.db._get('stations/' + SID + '/hr_requests/' + created.case_id + '/events/' + out.event_id);
      assert.equal(event.kind, 'setDecision');
      assert.equal(event.decision, 'approved');
      assert.equal(event.from_decision, 'pending');
      assert.equal(event.actor_uid, boss);
    });
  }

  await test('a rejection is recorded exactly like an approval', async () => {
    const w = world();
    const worker = w.who.add('worker', 'firefighter');
    const hr = w.who.add('hr', 'hr_coordinator');
    const created = await w.requests.create(w.who.req(worker, report()));
    const out = await w.requests.setDecision(w.who.req(hr, {
      request_id: 'req-reject-1', case_id: created.case_id,
      expected_revision: 1, send_now: false, decision: 'rejected'
    }));
    assert.equal(out.outcome, 'saved');
    assert.equal(w.db._get('stations/' + SID + '/hr_requests/' + created.case_id).decision, 'rejected');
    // והעובד רואה את התשובה.
    const view = await w.requests.get(w.who.req(worker, { case_id: created.case_id }));
    assert.equal(view.decision, 'rejected');
  });

  /* ---------- 5 ---------- */
  await test('an employee cannot decide their own report, and neither can an HR person on theirs', async () => {
    const w = world();
    const worker = w.who.add('worker', 'firefighter');
    const hr = w.who.add('hr', 'hr_coordinator');
    const own = await w.requests.create(w.who.req(worker, report()));
    await rejects(w.requests.setDecision(w.who.req(worker, {
      request_id: 'req-self-1', case_id: own.case_id, expected_revision: 1,
      send_now: false, decision: 'approved'
    })), 'permission-denied');
    assert.equal(w.db._get('stations/' + SID + '/hr_requests/' + own.case_id).decision, 'pending',
      'nothing moved');

    /* ⭐ והשער שקל לפספס: מי שיש לו סמכות משאבי אנוש עדיין אינו
     * מכריע בדיווח שהוא עצמו הגיש. */
    const hrOwn = await w.requests.create(w.who.req(hr, report({ request_id: 'req-hr-own' })));
    await rejects(w.requests.setDecision(w.who.req(hr, {
      request_id: 'req-hr-self-1', case_id: hrOwn.case_id, expected_revision: 1,
      send_now: false, decision: 'approved'
    })), 'permission-denied');
  });

  await test('a colleague with no HR authority cannot decide someone else’s report either', async () => {
    const w = world();
    const worker = w.who.add('worker', 'firefighter');
    const colleague = w.who.add('colleague', 'firefighter');
    const boss = w.who.add('boss', 'commander');
    const created = await w.requests.create(w.who.req(worker, report({ request_id: 'req-colleague' })));
    /* ⭐ ממצא שראוי שיהיה כתוב: מי שאינו בעל הדיווח ואינו משאבי אנוש
     * נעצר **פעמיים** — קודם בקריאה (`caseData` מסרב „This request is
     * private") ורק אחר כך בשער הסמכות. לכן הסרת שער הסמכות לבדה
     * אינה מפילה את הבדיקה הזו: הוא הגנה בעומק ולא הבלם היחיד.
     *
     * הבדיקה נשארת, ומאמתת את שני השערים יחד: אם מישהו ירכך את
     * `caseData` בעתיד, שער הסמכות עדיין יעצור — וזו בדיוק הסיבה
     * שהוא נשאר. */
    await rejects(w.requests.setDecision(w.who.req(colleague, {
      request_id: 'req-colleague-decide', case_id: created.case_id, expected_revision: 1,
      send_now: false, decision: 'approved'
    })), 'permission-denied');
    // גם מפקד משמרת אינו סמכות משאבי אנוש כאן.
    await rejects(w.requests.setDecision(w.who.req(boss, {
      request_id: 'req-boss-decide', case_id: created.case_id, expected_revision: 1,
      send_now: false, decision: 'approved'
    })), 'permission-denied');
    assert.equal(w.db._get('stations/' + SID + '/hr_requests/' + created.case_id).decision, 'pending');
    // השער הראשון, במפורש: הם אינם יכולים אפילו לקרוא את הדיווח.
    await rejects(w.requests.get(w.who.req(colleague, { case_id: created.case_id })), 'permission-denied');
    await rejects(w.requests.get(w.who.req(boss, { case_id: created.case_id })), 'permission-denied');
  });

  /* ---------- 6 ---------- */
  await test('a file is not required to file a report — and that is reported, not assumed', async () => {
    const w = world();
    const worker = w.who.add('worker', 'firefighter');
    const created = await w.requests.create(w.who.req(worker, report({ request_id: 'req-nofile' })));
    /* מסלול ההעלאה הקיים מצרף קובץ **אחרי** שהפנייה קיימת — ההורה
     * חייב להיות שם כדי שאפשר יהיה לקשור אליו. לכן קובץ חובה בעת
     * היצירה אינו אפשרי במבנה הזה, והדיווח נוצר בלעדיו. */
    const stored = w.db._get('stations/' + SID + '/hr_requests/' + created.case_id);
    assert.equal(stored.decision, 'pending');
    assert.equal(stored.attachment_ids, undefined, 'no file yet, and the report still exists');
  });

  /* ---------- 7 ---------- */
  await test('a file removed under the removal rules no longer counts as attached', async () => {
    const w = world();
    const worker = w.who.add('worker', 'firefighter');
    const created = await w.requests.create(w.who.req(worker, report({ request_id: 'req-removed' })));
    const id = fileId('removed');
    const revision = attach(w, created.case_id, worker, id);
    await w.requests.removeAttachment(w.who.req(worker, {
      request_id: 'req-remove-report-1', case_id: created.case_id,
      expected_revision: revision, attachment_id: id
    }));
    const after = w.db._get('stations/' + SID + '/hr_requests/' + created.case_id);
    assert.deepEqual(after.attachment_ids, [], 'not an active attachment any more');
    assert.deepEqual(after.removed_attachment_ids, [id], 'and recorded as removed');
    const ctx = { uid: worker, sid: SID, role: 'firefighter', super: false };
    await rejects(w.db.runTransaction((tx) => w.requests.attachmentPorts.read(tx, {
      ctx, authTime: AUTH_TIME, parent_kind: 'request', parent_id: created.case_id, attachment_id: id
    })), 'permission-denied');
  });

  /* ---------- 8 ---------- */
  await test('no path lets a client set or forge a decision', async () => {
    const w = world();
    const worker = w.who.add('worker', 'firefighter');
    // יצירה שמנסה להכריז על עצמה מאושרת — השדה אינו בחוזה בכלל.
    await rejects(w.requests.create(w.who.req(worker,
      { ...report({ request_id: 'req-forge-1' }), decision: 'approved' })), 'invalid-argument');
    // ותשובה רגילה אינה נתיב עוקף להכרעה.
    const created = await w.requests.create(w.who.req(worker, report({ request_id: 'req-forge-2' })));
    await rejects(w.requests.reply(w.who.req(worker, {
      request_id: 'req-forge-3', case_id: created.case_id, expected_revision: 1,
      send_now: false, text: 'נא לאשר', decision: 'approved'
    })), 'invalid-argument');
    assert.equal(w.db._get('stations/' + SID + '/hr_requests/' + created.case_id).decision, 'pending');
  });

  await test('dates are required for an absence report and refused for an ordinary one', async () => {
    const w = world();
    const worker = w.who.add('worker', 'firefighter');
    await rejects(w.requests.create(w.who.req(worker,
      { request_id: 'req-nodates', subject: 'מחלה', text: 'ללא תאריכים', send_now: false, kind: 'sick' })),
      'invalid-argument');
    await rejects(w.requests.create(w.who.req(worker,
      report({ request_id: 'req-backwards', from_date: '2026-09-12', to_date: '2026-09-10' }))),
      'invalid-argument');
    await rejects(w.requests.create(w.who.req(worker,
      { request_id: 'req-general-dates', subject: 'שאלה', text: 'סתם שאלה', send_now: false,
        kind: 'general', from_date: '2026-09-10', to_date: '2026-09-12' })), 'invalid-argument');
    // ⭐ ופנייה חופשית ממשיכה לעבוד בדיוק כפי שעבדה, בלי סוג ובלי תאריכים.
    const plain = await w.requests.create(w.who.req(worker,
      { request_id: 'req-plain', subject: 'שאלה', text: 'סתם שאלה', send_now: false }));
    const stored = w.db._get('stations/' + SID + '/hr_requests/' + plain.case_id);
    assert.equal(stored.kind, 'general');
    assert.equal(stored.decision, undefined, 'an ordinary request carries no decision at all');
  });

  await test('a report about days that already passed is accepted, and the dates say so', async () => {
    const w = world();
    const worker = w.who.add('worker', 'firefighter');
    /* רטרואקטיביות נגזרת ואינה דגל: `from_date` מול `created_at_ms`.
     * אותה תפיסה כמו בדיווח הנוכחות — אין שדה שהלקוח יכול לשקר בו. */
    const created = await w.requests.create(w.who.req(worker,
      report({ request_id: 'req-retro', from_date: '2026-08-03', to_date: '2026-08-05' })));
    const stored = w.db._get('stations/' + SID + '/hr_requests/' + created.case_id);
    assert.equal(stored.from_date, '2026-08-03');
    assert.ok(stored.created_at_ms > Date.parse('2026-08-05T23:59:59+03:00'),
      'the report was created after the period ended — that is what makes it retroactive');
  });

  console.log('');
  console.log('NOT RUN here — Firestore rules (emulator) and the upload pipeline itself.');
  console.log('hr_requests is closed to the browser (allow read, write: if false), so a decision');
  console.log('cannot be written except through the callable this file exercises.');
  console.log('');
  if (failures.length) {
    console.error(failures.length + ' absence report checks failed.');
    process.exit(1);
  }
  console.log(passed + ' absence report checks passed.');
})();
