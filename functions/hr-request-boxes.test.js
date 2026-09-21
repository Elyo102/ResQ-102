'use strict';

/* ======================================================================
 *  hr-request-boxes — תיבות העבודה: מונים, שיוך לחודש, שם ומשמרת
 *
 *  ----------------------------------------------------------------
 *  שלוש הטענות שהקובץ הזה מוכיח
 *  ----------------------------------------------------------------
 *  **1 · `months` הוא עובדה של השרת.** הלקוח אינו שולח אותו ואינו
 *  יכול; הוא נגזר מטווח מאומת, והוא נבדק מחדש בכל קריאה. מסמך שבו
 *  `months` אינו מה שהטווח גוזר נדחה ואינו מוצג „בקירוב".
 *
 *  **2 · המונה זז עם המסמך.** הוא נכתב באותה עסקה, ולכן אינו יכול
 *  להיות לא-מסונכרן עם מה שהוא סופר. הדלתא נגזרת ממצב לפני ואחרי,
 *  ולא משם הפעולה — פעולה חדשה שתזיז סטטוס תיספר נכון בלי שמישהו
 *  יזכור לעדכן את הספירה.
 *
 *  **3 · שם ומשמרת אינם מגיעים לעובד.** הם נקראים לתיבת משאבי אנוש
 *  בלבד, בקריאה מקובצת אחת ולא אחת לשורה, והם „השם הרשום כרגע
 *  בתחנה" ולא עותק שנכתב על הפנייה.
 *
 *  ----------------------------------------------------------------
 *  מה אינו נבדק כאן
 *  ----------------------------------------------------------------
 *  אכיפת כללי Firestore (אמולטור — NOT RUN) ודרישות אינדקס. הכפיל
 *  מגיש כל צורת שאילתה; Firestore לא. לכן השאילתות עצמן מוגבלות
 *  לשוויון בודד או ל-`array-contains` בודד.
 * ====================================================================== */

const assert = require('node:assert/strict');
const { fakeDb, FakeHttpsError, people } = require('./hr-pilot-test-harness');
const service = require('./hr-requests');
const { createHrRequests, absenceMonths, MAX_ABSENCE_DAYS } = service;

const SID = 'station_102';
const OTHER = 'station_7';

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

function world(sid = SID) {
  const db = fakeDb();
  const who = people(db, sid);
  let clock = Date.parse('2026-09-19T08:00:00Z');
  const requests = createHrRequests({ db, auth: who.auth, HttpsError: FakeHttpsError, clock: () => (clock += 1000) });
  db._put('config/runtime', { silent: false });
  return { db, who, requests, sid };
}
const report = (over) => ({
  request_id: 'req-' + Math.random().toString(16).slice(2, 12),
  subject: 'דיווח היעדרות', send_now: false,
  kind: 'sick', from_date: '2026-09-10', to_date: '2026-09-12', ...over
});
const caseDoc = (w, id) => w.db._get('stations/' + w.sid + '/hr_requests/' + id);
const counters = (w) => w.db._get('stations/' + w.sid + '/hr_request_counters/hr-request-counters-v1');
const bucket = (w, key) => ((counters(w) || {}).buckets || {})[key];

async function main() {

  /* ---------- 1 · גזירת החודשים ---------- */

  await test('a single day inside one month yields that one month', () => {
    assert.deepEqual(absenceMonths('2026-09-05', '2026-09-05'), ['2026-09']);
  });

  await test('a range that crosses a month boundary yields both months, in order', () => {
    assert.deepEqual(absenceMonths('2026-08-28', '2026-09-03'), ['2026-08', '2026-09']);
  });

  await test('a range that crosses a year boundary keeps counting', () => {
    assert.deepEqual(absenceMonths('2026-12-20', '2027-02-04'), ['2026-12', '2027-01', '2027-02']);
  });

  await test('an inverted range is not a range', () => {
    assert.equal(absenceMonths('2026-09-12', '2026-09-10'), null);
  });

  await test('the declared cap is what refuses an open-ended absence, and it is the stated 400 days', () => {
    assert.equal(MAX_ABSENCE_DAYS, 400);
    assert.notEqual(absenceMonths('2026-01-01', '2027-02-04'), null); // 400 days exactly
    assert.equal(absenceMonths('2026-01-01', '2027-02-05'), null);    // 401
    assert.equal(absenceMonths('2020-01-01', '2030-01-01'), null);
  });

  /* ---------- 2 · months נכתב בשרת ולא מתקבל מהלקוח ---------- */

  await test('creating a dated report writes the months the range covers', async () => {
    const w = world(); const uid = w.who.add('u-owner', 'firefighter');
    const out = await w.requests.create(w.who.req(uid, report({ from_date: '2026-08-28', to_date: '2026-09-03' })));
    assert.deepEqual(caseDoc(w, out.case_id).months, ['2026-08', '2026-09']);
  });

  await test('a general request carries no months at all', async () => {
    const w = world(); const uid = w.who.add('u-owner', 'firefighter');
    const out = await w.requests.create(w.who.req(uid, {
      request_id: 'req-general', subject: 'שאלה', text: 'שאלה כללית', send_now: false, kind: 'general' }));
    assert.equal(Object.hasOwn(caseDoc(w, out.case_id), 'months'), false);
  });

  await test('the client cannot supply months; the field is simply not accepted', async () => {
    const w = world(); const uid = w.who.add('u-owner', 'firefighter');
    await rejects(w.requests.create(w.who.req(uid, report({ months: ['2026-01'] }))), 'invalid-argument');
  });

  await test('an absence beyond the cap is refused with a reason, not silently truncated', async () => {
    const w = world(); const uid = w.who.add('u-owner', 'firefighter');
    const error = await rejects(w.requests.create(w.who.req(uid,
      report({ kind: 'extended_absence', from_date: '2026-01-01', to_date: '2028-01-01' }))), 'invalid-argument');
    assert.match(error.message, /workforce case/);
  });

  /* ⭐ זו הטענה שהופכת את השדה לבלתי-ניתן לזיוף: לא „הוא נכתב נכון",
   * אלא „ערך שאינו תואם אינו נקרא". */
  await test('a stored months value that disagrees with the range makes the case unreadable', async () => {
    const w = world(); const uid = w.who.add('u-owner', 'firefighter');
    const out = await w.requests.create(w.who.req(uid, report()));
    const path = 'stations/' + SID + '/hr_requests/' + out.case_id;
    w.db._put(path, { ...w.db._get(path), months: ['2026-01'] });
    await rejects(w.requests.get(w.who.req(uid, { case_id: out.case_id })), 'failed-precondition');
  });

  await test('a legacy dated report with no months field is still readable', async () => {
    const w = world(); const uid = w.who.add('u-owner', 'firefighter');
    const out = await w.requests.create(w.who.req(uid, report()));
    const path = 'stations/' + SID + '/hr_requests/' + out.case_id;
    const value = { ...w.db._get(path) }; delete value.months;
    w.db._put(path, value);
    const read = await w.requests.get(w.who.req(uid, { case_id: out.case_id }));
    assert.equal(read.case_id, out.case_id);
    assert.equal(read.kind, 'sick');
  });

  await test('months on a kind that has no dates makes the case unreadable', async () => {
    const w = world(); const uid = w.who.add('u-owner', 'firefighter');
    const out = await w.requests.create(w.who.req(uid, {
      request_id: 'req-general2', subject: 'שאלה', text: 'שאלה', send_now: false, kind: 'general' }));
    const path = 'stations/' + SID + '/hr_requests/' + out.case_id;
    w.db._put(path, { ...w.db._get(path), months: ['2026-09'] });
    await rejects(w.requests.get(w.who.req(uid, { case_id: out.case_id })), 'failed-precondition');
  });

  /* ---------- 3 · has_attachment ---------- */

  await test('has_attachment is false — the boolean, not undefined — before any file', async () => {
    const w = world(); const uid = w.who.add('u-owner', 'firefighter');
    const out = await w.requests.create(w.who.req(uid, report()));
    const read = await w.requests.get(w.who.req(uid, { case_id: out.case_id }));
    assert.equal(read.has_attachment, false);
  });

  await test('has_attachment turns true once a file is linked and false again once removed', async () => {
    const w = world(); const uid = w.who.add('u-owner', 'firefighter');
    const out = await w.requests.create(w.who.req(uid, report()));
    const path = 'stations/' + SID + '/hr_requests/' + out.case_id;
    const id = 'a'.repeat(64);
    w.db._put(path, { ...w.db._get(path), attachment_ids: [id] });
    w.db._put('stations/' + SID + '/hr_attachments/' + id, {
      schema: 'hr-attachment-v1', attachment_id: id, state: 'ready', station_id: SID,
      actor_uid: uid, parent_kind: 'request', parent_id: out.case_id, display_name: 'אישור.pdf' });
    let read = await w.requests.get(w.who.req(uid, { case_id: out.case_id }));
    assert.equal(read.has_attachment, true);
    await w.requests.removeAttachment(w.who.req(uid, { request_id: 'req-remove',
      case_id: out.case_id, expected_revision: read.revision, attachment_id: id }));
    read = await w.requests.get(w.who.req(uid, { case_id: out.case_id }));
    assert.equal(read.has_attachment, false);
  });

  /* ---------- 4 · המונים ---------- */

  await test('creating a dated report moves both axes: one open status and one pending decision', async () => {
    const w = world(); const uid = w.who.add('u-owner', 'firefighter');
    await w.requests.create(w.who.req(uid, report()));
    assert.equal(bucket(w, 'sick|status|open'), 1);
    assert.equal(bucket(w, 'sick|decision|pending'), 1);
    assert.equal(bucket(w, 'reserve|status|open'), undefined);
  });

  await test('a status change moves the count off the old bucket and onto the new one', async () => {
    const w = world();
    const uid = w.who.add('u-owner', 'firefighter'), hr = w.who.add('u-hr', 'hr_coordinator');
    const out = await w.requests.create(w.who.req(uid, report()));
    await w.requests.setStatus(w.who.req(hr, { request_id: 'req-status-one', case_id: out.case_id,
      expected_revision: 1, status: 'in_progress', send_now: false }));
    assert.equal(bucket(w, 'sick|status|open'), 0);
    assert.equal(bucket(w, 'sick|status|in_progress'), 1);
    // ההכרעה לא נגעה: שינוי סטטוס אינו הכרעה.
    assert.equal(bucket(w, 'sick|decision|pending'), 1);
  });

  await test('a decision moves the decision axis and leaves the status axis alone', async () => {
    const w = world();
    const uid = w.who.add('u-owner', 'firefighter'), hr = w.who.add('u-hr', 'hr_coordinator');
    const out = await w.requests.create(w.who.req(uid, report()));
    await w.requests.setDecision(w.who.req(hr, { request_id: 'req-decision-one', case_id: out.case_id,
      expected_revision: 1, decision: 'approved', send_now: false }));
    assert.equal(bucket(w, 'sick|decision|pending'), 0);
    assert.equal(bucket(w, 'sick|decision|approved'), 1);
    assert.equal(bucket(w, 'sick|status|open'), 1);
  });

  /* ⭐ הדלתא נגזרת ממצב ולא משם הפעולה, ולכן מעבר עקיף נספר גם הוא:
   * תגובה של העובד על „ממתינה לעובד" מחזירה את הפנייה ל„פתוחה". */
  await test('an indirect transition counts too: an employee reply reopens a waiting case', async () => {
    const w = world();
    const uid = w.who.add('u-owner', 'firefighter'), hr = w.who.add('u-hr', 'hr_coordinator');
    const out = await w.requests.create(w.who.req(uid, report()));
    await w.requests.setStatus(w.who.req(hr, { request_id: 'req-status-two', case_id: out.case_id,
      expected_revision: 1, status: 'waiting_employee', send_now: false }));
    assert.equal(bucket(w, 'sick|status|waiting_employee'), 1);
    await w.requests.reply(w.who.req(uid, { request_id: 'req-reply-one', case_id: out.case_id,
      expected_revision: 2, text: 'מצורף', send_now: false }));
    assert.equal(bucket(w, 'sick|status|waiting_employee'), 0);
    assert.equal(bucket(w, 'sick|status|open'), 1);
  });

  await test('a replayed action does not double-count', async () => {
    const w = world(); const uid = w.who.add('u-owner', 'firefighter');
    const payload = report({ request_id: 'req-replay' });
    await w.requests.create(w.who.req(uid, payload));
    const again = await w.requests.create(w.who.req(uid, payload));
    assert.equal(again.duplicate, true);
    assert.equal(bucket(w, 'sick|status|open'), 1);
  });

  await test('a no-change status write does not move any count', async () => {
    const w = world();
    const uid = w.who.add('u-owner', 'firefighter'), hr = w.who.add('u-hr', 'hr_coordinator');
    const out = await w.requests.create(w.who.req(uid, report()));
    const out2 = await w.requests.setStatus(w.who.req(hr, { request_id: 'req-status-three', case_id: out.case_id,
      expected_revision: 1, status: 'open', send_now: false }));
    assert.equal(out2.outcome, 'no_change');
    assert.equal(bucket(w, 'sick|status|open'), 1);
  });

  await test('removing a file is not a box event', async () => {
    const w = world(); const uid = w.who.add('u-owner', 'firefighter');
    const out = await w.requests.create(w.who.req(uid, report()));
    const path = 'stations/' + SID + '/hr_requests/' + out.case_id;
    const id = 'b'.repeat(64);
    w.db._put(path, { ...w.db._get(path), attachment_ids: [id] });
    w.db._put('stations/' + SID + '/hr_attachments/' + id, {
      schema: 'hr-attachment-v1', attachment_id: id, state: 'ready', station_id: SID,
      actor_uid: uid, parent_kind: 'request', parent_id: out.case_id, display_name: 'x.pdf' });
    const before = JSON.stringify(counters(w).buckets);
    await w.requests.removeAttachment(w.who.req(uid, { request_id: 'req-remove-two',
      case_id: out.case_id, expected_revision: 1, attachment_id: id }));
    assert.equal(JSON.stringify(counters(w).buckets), before);
  });

  /* ---------- 5 · קריאת המונים ---------- */

  await test('an employee cannot read the box counts', async () => {
    const w = world(); const uid = w.who.add('u-owner', 'firefighter');
    await rejects(w.requests.counts(w.who.req(uid, {})), 'permission-denied');
  });

  await test('a station commander who is not HR cannot read them either', async () => {
    const w = world(); const cmd = w.who.add('u-cmd', 'station_commander');
    await rejects(w.requests.counts(w.who.req(cmd, {})), 'permission-denied');
  });

  await test('HR reads every box and both axes, zero-filled, with no scan', async () => {
    const w = world();
    const uid = w.who.add('u-owner', 'firefighter'), hr = w.who.add('u-hr', 'hr_coordinator');
    await w.requests.create(w.who.req(uid, report()));
    await w.requests.create(w.who.req(uid, report({ kind: 'vacation', request_id: 'req-vacation-one' })));
    const out = await w.requests.counts(w.who.req(hr, {}));
    assert.deepEqual(Object.keys(out.boxes).sort(), ['extended_absence', 'reserve', 'sick', 'vacation']);
    assert.deepEqual(out.boxes.sick.status, { open: 1, in_progress: 0, waiting_employee: 0, closed: 0 });
    assert.deepEqual(out.boxes.sick.decision, { pending: 1, approved: 0, rejected: 0 });
    assert.deepEqual(out.boxes.reserve.status, { open: 0, in_progress: 0, waiting_employee: 0, closed: 0 });
    assert.equal(out.boxes.vacation.status.open, 1);
    assert.equal(out.drift, false);
  });

  await test('counts on a station with nothing yet are zeros, not a missing answer', async () => {
    const w = world(); const hr = w.who.add('u-hr', 'hr_coordinator');
    const out = await w.requests.counts(w.who.req(hr, {}));
    assert.equal(out.boxes.sick.status.open, 0);
    assert.equal(out.updated_at_ms, null);
    assert.equal(out.drift, false);
  });

  /* ⭐ מונה שהתקלקל מודה בכך. הוא אינו מפיל את המסך ואינו מציג מספר
   * שלילי — הוא נחתך באפס ומדווח שהוא משוער. */
  await test('a corrupted bucket is reported as drift rather than served as a number', async () => {
    const w = world(); const hr = w.who.add('u-hr', 'hr_coordinator');
    w.db._put('stations/' + SID + '/hr_request_counters/hr-request-counters-v1', {
      schema: 'hr-request-counters-v1', station_id: SID, updated_at_ms: 1,
      buckets: { 'sick|status|open': -4 } });
    const out = await w.requests.counts(w.who.req(hr, {}));
    assert.equal(out.boxes.sick.status.open, 0);
    assert.equal(out.drift, true);
  });

  await test('a count that would go below zero clamps and records the drift', async () => {
    const w = world();
    const uid = w.who.add('u-owner', 'firefighter'), hr = w.who.add('u-hr', 'hr_coordinator');
    const out = await w.requests.create(w.who.req(uid, report()));
    w.db._put('stations/' + SID + '/hr_request_counters/hr-request-counters-v1', {
      schema: 'hr-request-counters-v1', station_id: SID, updated_at_ms: 1, buckets: {} });
    await w.requests.setStatus(w.who.req(hr, { request_id: 'req-status-four', case_id: out.case_id,
      expected_revision: 1, status: 'closed', send_now: false }));
    assert.equal(bucket(w, 'sick|status|open'), 0);
    assert.equal(bucket(w, 'sick|status|closed'), 1);
    assert.equal((await w.requests.counts(w.who.req(hr, {}))).drift, true);
  });

  /* ---------- 6 · שם ומשמרת ---------- */

  await test('the HR inbox carries the reporting employee name and crew', async () => {
    const w = world();
    const uid = w.who.add('u-owner', 'firefighter', { full_name: 'דנה לוי', crew: 'משמרת ב' });
    const hr = w.who.add('u-hr', 'hr_coordinator');
    await w.requests.create(w.who.req(uid, report()));
    const page = await w.requests.listInbox(w.who.req(hr, { kind: 'sick' }));
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].owner_name, 'דנה לוי');
    assert.equal(page.items[0].owner_crew, 'משמרת ב');
  });

  /* ⭐ זו הבדיקה שמונעת הדלפה: מסלול העובד אינו נוגע ברשומות של אף
   * אחד, ולכן אינו יכול להחזיר שם של אף אחד — גם לא את שלו. */
  await test('the employee list carries no name field at all', async () => {
    const w = world();
    const uid = w.who.add('u-owner', 'firefighter', { full_name: 'דנה לוי', crew: 'משמרת ב' });
    await w.requests.create(w.who.req(uid, report()));
    const page = await w.requests.list(w.who.req(uid, {}));
    assert.equal(page.items.length, 1);
    assert.equal(Object.hasOwn(page.items[0], 'owner_name'), false);
    assert.equal(Object.hasOwn(page.items[0], 'owner_crew'), false);
  });

  await test('a name is read live and is never written onto the request document', async () => {
    const w = world();
    const uid = w.who.add('u-owner', 'firefighter', { full_name: 'דנה לוי', crew: 'משמרת ב' });
    const hr = w.who.add('u-hr', 'hr_coordinator');
    const out = await w.requests.create(w.who.req(uid, report()));
    const stored = caseDoc(w, out.case_id);
    assert.equal(Object.hasOwn(stored, 'owner_name'), false);
    const path = 'stations/' + SID + '/users/' + uid;
    w.db._put(path, { ...w.db._get(path), full_name: 'דנה כהן', crew: 'משמרת ג' });
    const page = await w.requests.listInbox(w.who.req(hr, { kind: 'sick' }));
    assert.equal(page.items[0].owner_name, 'דנה כהן');
    assert.equal(page.items[0].owner_crew, 'משמרת ג');
  });

  await test('a reporter whose station record is gone leaves an empty name, not a broken page', async () => {
    const w = world();
    const uid = w.who.add('u-owner', 'firefighter', { full_name: 'דנה לוי', crew: 'משמרת ב' });
    const hr = w.who.add('u-hr', 'hr_coordinator');
    await w.requests.create(w.who.req(uid, report()));
    w.db._store.delete('stations/' + SID + '/users/' + uid);
    const page = await w.requests.listInbox(w.who.req(hr, { kind: 'sick' }));
    assert.equal(page.items[0].owner_name, '');
    assert.equal(page.items[0].owner_crew, '');
  });

  await test('control characters in a stored name never reach the inbox row', async () => {
    const w = world();
    const uid = w.who.add('u-owner', 'firefighter');
    const hr = w.who.add('u-hr', 'hr_coordinator');
    await w.requests.create(w.who.req(uid, report()));
    const path = 'stations/' + SID + '/users/' + uid;
    w.db._put(path, { ...w.db._get(path), full_name: 'דנה\u0007\u001bלוי', crew: 'ב' });
    const page = await w.requests.listInbox(w.who.req(hr, { kind: 'sick' }));
    assert.equal(page.items[0].owner_name, 'דנהלוי');
  });

  /* ---------- 7 · בידוד תחנות ---------- */

  await test('counters are per station: one station never sees the other station tally', async () => {
    const a = world(SID), b = world(OTHER);
    const ua = a.who.add('u-a', 'firefighter'); a.who.add('hr-a', 'hr_coordinator');
    const ub = b.who.add('u-b', 'firefighter'); const hrB = b.who.add('hr-b', 'hr_coordinator');
    await a.requests.create(a.who.req(ua, report()));
    await b.requests.create(b.who.req(ub, report({ request_id: 'req-station-b' })));
    assert.equal(bucket(a, 'sick|status|open'), 1);
    assert.equal(bucket(b, 'sick|status|open'), 1);
    const out = await b.requests.counts(b.who.req(hrB, {}));
    assert.equal(out.boxes.sick.status.open, 1);
    assert.equal(a.db._get('stations/' + OTHER + '/hr_request_counters/hr-request-counters-v1'), undefined);
    assert.equal(b.db._get('stations/' + SID + '/hr_request_counters/hr-request-counters-v1'), undefined);
  });

  await test('an HR coordinator of another station cannot read this station counts', async () => {
    const w = world(SID);
    const foreign = people(w.db, OTHER);
    const hrOther = foreign.add('hr-other', 'hr_coordinator');
    const requestsOther = createHrRequests({ db: w.db, auth: foreign.auth, HttpsError: FakeHttpsError });
    const out = await requestsOther.counts(foreign.req(hrOther, {}));
    // התשובה נגזרת מ-`ctx.sid` של ה-claims, ולכן היא על התחנה שלו — ריקה.
    assert.equal(out.boxes.sick.status.open, 0);
    const uid = w.who.add('u-owner', 'firefighter');
    await w.requests.create(w.who.req(uid, report()));
    assert.equal((await requestsOther.counts(foreign.req(hrOther, {}))).boxes.sick.status.open, 0);
  });

  /* ---------- 8 · שערי סמכות שנושאים משקל ---------- */

  await test('counts rejects any request field, so a station cannot be asked for from the client', async () => {
    const w = world(); const hr = w.who.add('u-hr', 'hr_coordinator');
    await rejects(w.requests.counts(w.who.req(hr, { station_id: OTHER })), 'invalid-argument');
    await rejects(w.requests.counts(w.who.req(hr, { sid: OTHER })), 'invalid-argument');
  });

  await test('a super admin reads the counts of the station in the signed token', async () => {
    const w = world();
    const uid = w.who.add('u-owner', 'firefighter');
    const su = w.who.add('u-su', 'hr_coordinator', { super: true });
    await w.requests.create(w.who.req(uid, report()));
    assert.equal((await w.requests.counts(w.who.req(su, {}))).boxes.sick.status.open, 1);
  });

  console.log('');
  console.log('NOT RUN here — Firestore rules enforcement (emulator) and composite-index');
  console.log('requirements. hr_request_counters is allow read, write: if false, so the only');
  console.log('read path is the callable this file exercises; that is asserted in the rules,');
  console.log('not here.');
  console.log('');
  if (failures.length) {
    console.error(failures.length + ' box checks failed.');
    process.exit(1);
  }
  console.log(passed + ' box checks passed.');
}

main();
