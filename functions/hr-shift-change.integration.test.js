'use strict';
/* ======================================================================
 *  בקשת שינוי ציוות / תחנה (shift_change) · 42H.48 · Claude, 1.10.2026
 *
 *  מפיקים אמיתיים (hr-requests + hr-domain-dispatch) על Firestore אמיתי
 *  באמולטור. Auth ו-FCM סינתטיים בלבד. לא ייצור, לא דפדפן.
 *
 *  מה מוכח כאן:
 *  · ולידציה: נימוק ≤250, בלי תווי בקרה, תאריך לא בעבר ועד 92 יום,
 *    תחנת קצה קיימת ופעילה **בתחנה של המבקש**.
 *  · הרשאות: אחראי/ת סידור חי/ה רואה ומכריע/ה **רק** בבקשות מהסוג הזה;
 *    מינוי שבוטל / של תחנה אחרת / מפקד בלי מינוי — נחסמים מיד.
 *  · התראות: הבקשה מגיעה למשאבי אנוש ולאחראי/ת הסידור בלבד; ההכרעה
 *    מגיעה לבעלים — וגם הכרעה על דיווח מחלה מגיעה (באג שתוקן).
 * ====================================================================== */
const assert = require('node:assert/strict');
const localEndpoint = /^(127\.0\.0\.1|localhost):(\d{1,5})$/.exec(process.env.FIRESTORE_EMULATOR_HOST || '');
if (!localEndpoint || process.env.GCLOUD_PROJECT !== 'demo-resq') {
  console.error('NOT RUN: loopback Firestore emulator and GCLOUD_PROJECT=demo-resq required.');
  process.exit(2);
}
process.env.METADATA_SERVER_DETECTION = 'none';
const { randomBytes, createHash } = require('node:crypto');
const admin = require('firebase-admin');
const { createHrRequests, SHIFT_TEXT_MAX } = require('./hr-requests');
const { createHrDomainDispatch } = require('./hr-domain-dispatch');

const app = admin.initializeApp({ projectId: 'demo-resq' }, 'hr-shift-change-' + process.pid), db = app.firestore();
const runId = randomBytes(6).toString('hex'), runtime = db.doc('config/runtime');
const authTime = Date.parse('2026-09-01T00:00:00Z') / 1000;
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const records = new Map(), roots = [], extraRefs = new Map(), tests = [];
const auth = { async getUser(uid) {
  const r = records.get(uid);
  if (!r) throw Object.assign(new Error('synthetic missing Auth'), { code: 'auth/user-not-found' });
  return structuredClone(r);
} };
const accepted = p => ({ responses: p.tokens.map((_, i) => ({ success: true, messageId: 'synthetic/' + i })) });
const ACTIVE = ['policy_pending', 'discovering', 'queued', 'processing', 'deferred', 'blocked'];
let seq = 0, passed = 0, priorRuntime;

async function fixture() {
  const sid = 'shift_change_it_' + runId + '_' + (++seq), root = db.doc('stations/' + sid); roots.push(root);
  await root.set({ station_id: sid, active: true, status: 'ready', silent: false });
  for (const [id, v] of [['rashit', { name: 'ראשית' }], ['timna', { name: 'תמנע' }],
    ['old_site', { name: 'ישנה', status: 'inactive' }]]) await root.collection('sub_stations').doc(id).set(v);
  /* 8.9.2026 12:00 שעון ישראל */
  const f = { sid, root, people: {}, at: Date.parse('2026-09-08T09:00:00Z'), calls: [] };
  f.add = async (name, role = 'firefighter') => {
    const uid = name + '_' + sid, claims = { stationId: sid, role };
    records.set(uid, { uid, disabled: false, customClaims: claims, tokensValidAfterTime: new Date(authTime * 1000).toUTCString() });
    await root.collection('users').doc(uid).set({ stationId: sid, role, active: true, full_name: 'PRIVATE_NAME_' + name });
    const q = db.doc('hr_request_actor_quotas/' + hash(['hr-request-quota-v1', uid])); extraRefs.set(q.path, q);
    await root.collection('push_tokens').doc(uid).set({ tokens: [{ token: 'tok-' + uid }], prefs: { hr_request: false } });
    return f.people[name] = { uid, claims, token: 'tok-' + uid };
  };
  f.appoint = (name, extra = {}) => root.collection('schedule_access').doc(f.people[name].uid).set({
    schema_version: 1, active: true, station_id: sid, uid: f.people[name].uid, revision: 1, roles: ['schedule_manager'], ...extra });
  await f.add('owner'); await f.add('other'); await f.add('hr', 'hr_coordinator');
  await f.add('command', 'station_commander'); await f.add('sched'); await f.appoint('sched');
  f.req = (name, data) => ({ auth: { uid: f.people[name].uid, token: { ...f.people[name].claims, auth_time: authTime } }, data });
  f.requests = createHrRequests({ db, auth, HttpsError, clock: () => f.at });
  f.shift = (who = 'owner', extra = {}) => f.requests.create(f.req(who, { request_id: 'shift-' + who + '-' + (++seq),
    kind: 'shift_change', target_date: '2026-09-10', target_sub_station: 'timna',
    text: 'PRIVATE_REASON בקשה לעבור לתמנע', send_now: false, ...extra }));
  f.decide = (who, c, decision = 'approved', extra = {}) => f.requests.setDecision(f.req(who, {
    request_id: 'decide-' + who + '-' + (++seq), case_id: c.case_id, expected_revision: c.revision,
    decision, send_now: false, ...extra }));
  f.worker = () => createHrDomainDispatch({ db, auth, HttpsError, clock: () => f.at,
    messaging: { async sendEachForMulticast(p) { f.calls.push(p); return accepted(p); } } });
  f.deliver = async () => {
    const w = f.worker(), jobs = await root.collection('hr_request_notification_jobs').get();
    for (const d of jobs.docs) {
      for (let i = 0; i < 50; ++i) {
        if (!ACTIVE.includes((await d.ref.get()).data().status)) break;
        let r;
        /* תקלה סופית (למשל מינוי שבוטל) מסמנת את המשימה כמבוטלת ונזרקת — זה המצב שנבדק. */
        try { r = await w.processJob({ stationId: sid, family: 'request', job_id: d.id }); }
        catch (e) { if (e.terminal === true) break; throw e; }
        if (['deferred', 'blocked'].includes(r.status)) break;
      }
    }
    await w.run();
  };
  f.tokensSent = () => f.calls.flatMap(c => c.tokens);
  f.jobs = async () => (await root.collection('hr_request_notification_jobs').get()).docs.map(d => d.data());
  return f;
}
async function cleanup() {
  for (const root of roots.splice(0)) { assert.ok(root.id.startsWith('shift_change_it_' + runId)); await db.recursiveDelete(root); }
  for (const ref of extraRefs.values()) await ref.delete();
  extraRefs.clear(); records.clear();
}
const check = (name, fn) => tests.push({ name, fn });
const code = c => e => { assert.equal(e.code, c, 'expected ' + c + ', got ' + e.code + ': ' + e.message); return true; };

/* ---------------- יצירה וולידציה ---------------- */

check('firefighter creates a shift change request: fixed subject, pending, no months, station_shift job', async () => {
  const f = await fixture(), out = await f.shift();
  assert.equal(out.outcome, 'saved');
  const doc = (await f.root.collection('hr_requests').doc(out.case_id).get()).data();
  assert.equal(doc.kind, 'shift_change'); assert.equal(doc.decision, 'pending');
  assert.equal(doc.subject, 'בקשת שינוי ציוות / תחנה');
  assert.equal(doc.target_date, '2026-09-10'); assert.equal(doc.target_sub_station, 'timna');
  for (const k of ['months', 'from_date', 'to_date']) assert.equal(Object.hasOwn(doc, k), false, k);
  const [job] = await f.jobs(); assert.equal(job.audience, 'station_shift'); assert.equal(job.type, 'hr_request');
});

check('a client-supplied subject is refused: the subject is fixed by the server', async () => {
  const f = await fixture();
  await assert.rejects(f.shift('owner', { subject: 'PRIVATE_CUSTOM' }), code('invalid-argument'));
});

check('reason is limited to 250 characters and rejects control characters', async () => {
  const f = await fixture();
  await f.shift('owner', { text: 'א'.repeat(SHIFT_TEXT_MAX) });
  await assert.rejects(f.shift('owner', { text: 'א'.repeat(SHIFT_TEXT_MAX + 1) }), code('invalid-argument'));
  await assert.rejects(f.shift('owner', { text: 'בקשה\u0007' }), code('invalid-argument'));
  await assert.rejects(f.shift('owner', { text: '   ' }), code('invalid-argument'));
});

check('date must be today..+92 days by Israel time, sub-station must be active in this station', async () => {
  const f = await fixture();
  await f.shift('owner', { target_date: '2026-09-08' });               // היום
  await assert.rejects(f.shift('owner', { target_date: '2026-09-07' }), code('invalid-argument'));
  await assert.rejects(f.shift('owner', { target_date: '2026-12-10' }), code('invalid-argument'));
  await assert.rejects(f.shift('owner', { target_date: '2026-02-30' }), code('invalid-argument'));
  await assert.rejects(f.shift('owner', { target_sub_station: 'eilat_102/../x' }), code('invalid-argument'));
  await assert.rejects(f.shift('owner', { target_sub_station: 'nowhere' }), code('failed-precondition'));
  await assert.rejects(f.shift('owner', { target_sub_station: 'old_site' }), code('failed-precondition'));
  /* תחנת קצה שקיימת רק בתחנה אזורית אחרת — נקראת לפי התחנה מה-token, ולכן אינה נמצאת */
  const g = await fixture(); await g.root.collection('sub_stations').doc('beersheva_only').set({ name: 'אחרת' });
  await assert.rejects(f.shift('owner', { target_sub_station: 'beersheva_only' }), code('failed-precondition'));
  await assert.rejects(f.shift('owner', { target_sub_station: '__reserved__' }), code('invalid-argument'));
});

check('target fields are refused on any other request kind', async () => {
  const f = await fixture();
  await assert.rejects(f.requests.create(f.req('owner', { request_id: 'general-with-target-1', subject: 'x', text: 'y',
    send_now: false, target_date: '2026-09-10', target_sub_station: 'timna' })), code('invalid-argument'));
});

check('shift change requests cannot carry attachments', async () => {
  const f = await fixture(), c = await f.shift();
  const ports = f.requests.attachmentPorts;
  const input = { ctx: { uid: f.people.owner.uid, sid: f.sid, role: 'firefighter', super: false }, authTime,
    parent_kind: 'request', parent_id: c.case_id, expected_revision: c.revision,
    attachment_id: hash(['a', f.sid]), event_id: hash(['e', f.sid]) };
  await assert.rejects(db.runTransaction(tx => ports.prepare(tx, input)), code('failed-precondition'));
});

/* ---------------- הרשאות ---------------- */

check('live schedule manager lists only shift change requests and reads them, never other kinds', async () => {
  const f = await fixture(), c = await f.shift();
  const general = await f.requests.create(f.req('owner', { request_id: 'general-private-1', subject: 'PRIVATE_S', text: 'PRIVATE_T', send_now: false }));
  const box = await f.requests.listInbox(f.req('sched', { kind: 'shift_change' }));
  assert.deepEqual(box.items.map(i => i.case_id), [c.case_id]);
  assert.equal(box.items[0].target_sub_station, 'timna');
  await assert.rejects(f.requests.listInbox(f.req('sched', {})), code('permission-denied'));
  await assert.rejects(f.requests.listInbox(f.req('sched', { kind: 'sick' })), code('permission-denied'));
  await assert.rejects(f.requests.listInbox(f.req('sched', { kind: 'general' })), code('permission-denied'));
  assert.equal((await f.requests.get(f.req('sched', { case_id: c.case_id }))).kind, 'shift_change');
  await assert.rejects(f.requests.get(f.req('sched', { case_id: general.case_id })), code('permission-denied'));
  await assert.rejects(f.requests.counts(f.req('sched', {})), code('permission-denied'));
});

check('"my requests" tells the screen who handles shift requests — live, and false once revoked', async () => {
  const f = await fixture();
  const flag = async who => (await f.requests.list(f.req(who, {}))).can_handle_shift;
  assert.deepEqual([await flag('sched'), await flag('hr'), await flag('owner'), await flag('command')], [true, true, false, false]);
  await f.appoint('sched', { active: false, roles: [], revision: 2 });
  assert.equal(await flag('sched'), false);
});

check('commander and colleague without appointment cannot list, read or decide', async () => {
  const f = await fixture(), c = await f.shift();
  for (const who of ['command', 'other']) {
    await assert.rejects(f.requests.listInbox(f.req(who, { kind: 'shift_change' })), code('permission-denied'));
    await assert.rejects(f.requests.get(f.req(who, { case_id: c.case_id })), code('permission-denied'));
    await assert.rejects(f.decide(who, c), code('permission-denied'));
  }
});

check('revoking the appointment blocks the very next call; a foreign-station appointment never counts', async () => {
  const f = await fixture(), c = await f.shift();
  await f.requests.get(f.req('sched', { case_id: c.case_id }));
  await f.appoint('sched', { active: false, roles: [], revision: 2 });
  await assert.rejects(f.requests.get(f.req('sched', { case_id: c.case_id })), code('permission-denied'));
  await assert.rejects(f.requests.listInbox(f.req('sched', { kind: 'shift_change' })), code('permission-denied'));
  await assert.rejects(f.decide('sched', c), code('permission-denied'));
  await f.appoint('sched', { station_id: 'some_other_station', revision: 3 });
  await assert.rejects(f.decide('sched', c), code('permission-denied'));
});

check('schedule manager decides shift change only; not own request, not a sickness report', async () => {
  const f = await fixture(), c = await f.shift();
  const own = await f.shift('sched');
  await assert.rejects(f.decide('sched', own), code('permission-denied'));
  const sick = await f.requests.create(f.req('owner', { request_id: 'sick-report-001', subject: 'PRIVATE_S', kind: 'sick',
    from_date: '2026-09-07', to_date: '2026-09-08', send_now: false }));
  await assert.rejects(f.decide('sched', sick), code('permission-denied'));
  await assert.rejects(f.decide('hr', sick, 'approved', { text: 'note' }), code('invalid-argument'));
  await assert.rejects(f.decide('sched', c, 'rejected', { text: 'ב'.repeat(SHIFT_TEXT_MAX + 1) }), code('invalid-argument'));
  const out = await f.decide('sched', c, 'rejected', { text: 'אין כוח אדם בתמנע באותו יום' });
  assert.equal(out.status, 'closed');
  const doc = (await f.root.collection('hr_requests').doc(c.case_id).get()).data();
  assert.equal(doc.decision, 'rejected'); assert.equal(doc.decided_by, f.people.sched.uid);
  const events = (await f.root.collection('hr_requests').doc(c.case_id).collection('events').get()).docs.map(d => d.data());
  assert.ok(events.some(e => e.kind === 'setDecision' && e.text === 'אין כוח אדם בתמנע באותו יום'));
});

check('HR coordinator can also decide a shift change request', async () => {
  const f = await fixture(), c = await f.shift(), out = await f.decide('hr', c);
  assert.equal(out.outcome, 'saved'); assert.equal(out.status, 'closed');
});

check('counters: the shift box counts pending then approved/closed, without drift', async () => {
  const f = await fixture(), c = await f.shift();
  let box = (await f.requests.counts(f.req('hr', {}))).boxes.shift_change;
  assert.deepEqual([box.decision.pending, box.status.open], [1, 1]);
  await f.decide('sched', c);
  const out = await f.requests.counts(f.req('hr', {})); box = out.boxes.shift_change;
  assert.deepEqual([box.decision.pending, box.decision.approved, box.status.open, box.status.closed, out.drift], [0, 1, 0, 1, false]);
  assert.deepEqual(out.boxes.sick.decision, { pending: 0, approved: 0, rejected: 0 }, 'other boxes untouched');
});

check('re-deciding: same decision (even with a note) is no_change; a flip is allowed until the day passes, then final', async () => {
  const f = await fixture(), c = await f.shift();
  const first = await f.decide('sched', c);
  const same = await f.decide('sched', { case_id: c.case_id, revision: first.revision }, 'approved', { text: 'שוב' });
  assert.equal(same.outcome, 'no_change');
  const flip = await f.decide('hr', { case_id: c.case_id, revision: first.revision }, 'rejected');
  assert.equal(flip.outcome, 'saved');
  f.at = Date.parse('2026-09-11T09:00:00Z');   // היום המבוקש (10.9) עבר
  await assert.rejects(f.decide('hr', { case_id: c.case_id, revision: flip.revision }, 'approved'), code('failed-precondition'));
});

check('a schedule manager may reply on a shift request; the owner is notified', async () => {
  const f = await fixture(), c = await f.shift(); await f.deliver(); f.calls.length = 0;
  await f.requests.reply(f.req('sched', { request_id: 'sched-reply-001', case_id: c.case_id, expected_revision: c.revision,
    text: 'PRIVATE_REPLY נדבר מחר', send_now: false }));
  await f.deliver();
  assert.deepEqual(f.tokensSent(), [f.people.owner.token]);
});

/* ---------------- התראות ---------------- */

check('a new request notifies HR and the live schedule manager only — not the commander, colleague or owner', async () => {
  const f = await fixture(); await f.shift(); await f.deliver();
  const sent = f.tokensSent().sort();
  assert.deepEqual(sent, [f.people.hr.token, f.people.sched.token].sort());
  for (const c of f.calls) assert.equal(JSON.stringify(c.data).includes('PRIVATE_'), false, 'no private text in push');
});

check('a revoked schedule manager is not notified of a new request', async () => {
  const f = await fixture(); await f.appoint('sched', { active: false, roles: [], revision: 2 });
  await f.shift(); await f.deliver();
  assert.deepEqual(f.tokensSent(), [f.people.hr.token]);
});

check('an appointment revoked after the decision but before delivery: the push is cancelled at send time', async () => {
  const f = await fixture(), c = await f.shift(); await f.deliver(); f.calls.length = 0;
  await f.decide('sched', c);
  await f.appoint('sched', { active: false, roles: [], revision: 2 });
  await f.deliver();
  assert.deepEqual(f.tokensSent(), []);
  assert.ok((await f.jobs()).some(j => j.type === 'hr_reply' && j.status === 'cancelled' && j.dispatch_reason === 'actor-role-changed'));
});

check('a general HR request is never pushed to a schedule manager', async () => {
  const f = await fixture();
  await f.requests.create(f.req('owner', { request_id: 'general-001', subject: 'PRIVATE_S', text: 'PRIVATE_T', send_now: false }));
  await f.deliver();
  assert.deepEqual(f.tokensSent(), [f.people.hr.token]);
});

check('the decision reaches the owner exactly once', async () => {
  const f = await fixture(), c = await f.shift(); await f.deliver(); f.calls.length = 0;
  await f.decide('sched', c); await f.deliver(); await f.deliver();
  assert.deepEqual(f.tokensSent(), [f.people.owner.token]);
});

check('regression: an HR decision on a sickness report now reaches the employee (was cancelled as source-invalid)', async () => {
  const f = await fixture();
  const sick = await f.requests.create(f.req('owner', { request_id: 'sick-report-002', subject: 'PRIVATE_S', kind: 'sick',
    from_date: '2026-09-07', to_date: '2026-09-08', send_now: false }));
  await f.deliver(); f.calls.length = 0;
  await f.decide('hr', sick); await f.deliver();
  assert.deepEqual(f.tokensSent(), [f.people.owner.token]);
  assert.ok((await f.jobs()).every(j => j.dispatch_reason !== 'source-invalid'));
});

check('durable create replay survives Israel midnight and rejects changed intent', async () => {
  const f = await fixture();
  f.at = Date.parse('2026-09-08T20:59:00Z');
  const data = { request_id: 'midnight-receipt', kind: 'shift_change', target_date: '2026-09-08',
    target_sub_station: 'timna', text: 'Synthetic reason', send_now: false };
  const first = await f.requests.create(f.req('owner', data));
  f.at = Date.parse('2026-09-08T21:01:00Z');
  const replay = await f.requests.create(f.req('owner', data));
  assert.deepEqual(replay, { ...first, duplicate: true });
  await assert.rejects(f.requests.create(f.req('owner', { ...data, text: 'Changed intent' })), { code: 'already-exists' });
  await assert.rejects(f.requests.create(f.req('owner', { ...data, request_id: 'new-expired-request' })), { code: 'invalid-argument' });
});

check('new request crossing Israel midnight during final checks creates no record', async () => {
  const f = await fixture();
  f.at = Date.parse('2026-09-08T20:59:00Z');
  const requests = createHrRequests({ db, auth, HttpsError, clock: () => f.at,
    hooks: { beforeWrites: async ({ stage }) => { if (stage === 'create') f.at = Date.parse('2026-09-08T21:01:00Z'); } } });
  await assert.rejects(requests.create(f.req('owner', { request_id: 'midnight-new', kind: 'shift_change',
    target_date: '2026-09-08', target_sub_station: 'timna', text: 'Synthetic reason', send_now: false })), { code: 'invalid-argument' });
  assert.equal((await f.root.collection('hr_requests').get()).size, 0);
  assert.equal((await f.root.collection('hr_request_operations').get()).size, 0);
});

(async () => {
  const filter = process.env.SHIFT_CHANGE_TEST_FILTER || '', selected = tests.filter(t => !filter || t.name.includes(filter));
  assert.ok(selected.length, 'filter must select a test');
  try {
    priorRuntime = await runtime.get();
    for (let n = 0; n < selected.length; ++n) {
      const { name, fn } = selected[n]; await runtime.set({ silent: false, silent_allow: [] });
      try { await fn(); ++passed; console.log('PASS ' + name); }
      catch (e) { console.error('FAIL ' + name); for (const t of selected.slice(n + 1)) console.log('NOT RUN ' + t.name); throw e; }
      finally { await cleanup(); }
    }
    console.log('HR shift change integration: ' + passed + '/' + selected.length + ' PASS; actual producers/Firestore, synthetic Auth/FCM only.');
  } finally {
    await cleanup();
    if (priorRuntime) { if (priorRuntime.exists) await runtime.set(priorRuntime.data()); else await runtime.delete(); }
    await app.delete();
  }
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
