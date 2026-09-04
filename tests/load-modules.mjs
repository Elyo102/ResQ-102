/* ====================================================================
 *  load-modules · עומס ו-fuzz על המודולים הטהורים
 *
 *  מה נבדק כאן ולמה
 *  ----------------
 *  המודולים הטהורים (מנוע היומן, מחבר המדיניות, ימי עבודה אפקטיביים,
 *  יומן התקלות, חוות הדעת) הם הקוד שרץ בתוך פונקציית ענן חמה, פעם
 *  אחר פעם, על קלט שמגיע מלקוח. שני דברים חייבים להיות נכונים:
 *
 *   1. **גודל** — קלט בגבול העליון של החוזה נגמר בזמן סביר, וקלט
 *      מעבר לגבול נדחה בקוד שגיאה, לא ב-RangeError או בתלייה.
 *   2. **מפתחות** — כל מזהה שמגיע מבחוץ ומשמש כמפתח במפה אינו יכול
 *      לזהם את Object.prototype של התהליך. "__proto__" כמזהה אדם
 *      עשה בדיוק את זה (5aeb193). ה-fuzz כאן מזריק מפתחות שמורים
 *      ואקראיים לכל שדה-מפתח, ומוודא ששלושה דברים מתקיימים: או
 *      שהקריאה מצליחה, או שהיא נזרקת עם `code` של המודול; לעולם לא
 *      TypeError; ובסוף Object.prototype נקי.
 *
 *  אין כאן Firebase, אין רשת, אין קבצים. יציאה 0 עבר · 1 נכשל.
 * ==================================================================== */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const require = createRequire(resolve(ROOT, 'functions', 'package.json'));
const engineMod = require(resolve(ROOT, 'functions', 'schedule-calendar-engine.js'));
const authorMod = require(resolve(ROOT, 'functions', 'schedule-policy-author.js'));
/* schedule-effective-workdays.js (חבילת workdays-core) עדיין אינו ב-origin;
 * כשהוא נוכח — נבדק, וכשלא — מדווח כדילוג מפורש, לא כהצלחה. */
let workdays = null;
try { workdays = require(resolve(ROOT, 'functions', 'schedule-effective-workdays.js')); }
catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const incidentMod = require(resolve(ROOT, 'functions', 'incident-log.js'));
const catalog = require(resolve(ROOT, 'functions', 'ops-telemetry-contract.js'));
const feedbackMod = require(resolve(ROOT, 'functions', 'feedback.js'));
const { createFakeFirestore } = require(resolve(ROOT, 'functions', 'fixtures', 'fake-firestore.js'));

let passed = 0;
const fails = [];
function check(name, fn) {
  const t0 = Date.now();
  try { fn(); passed += 1; console.log('✓ ' + name + ' (' + (Date.now() - t0) + 'ms)'); }
  catch (e) { fails.push(name + ' → ' + (e && e.stack || e)); console.log('✗ ' + name); }
}
async function checkAsync(name, fn) {
  const t0 = Date.now();
  try { await fn(); passed += 1; console.log('✓ ' + name + ' (' + (Date.now() - t0) + 'ms)'); }
  catch (e) { fails.push(name + ' → ' + (e && e.stack || e)); console.log('✗ ' + name); }
}
function within(ms, label, fn) {
  const t0 = Date.now();
  const out = fn();
  const took = Date.now() - t0;
  assert.ok(took <= ms, label + ' לקח ' + took + 'ms, מעל התקציב ' + ms + 'ms');
  return out;
}
/* קריאה שמותר לה להצליח או להיכשל עם code של המודול — אבל לא להתפוצץ. */
function orModuleError(fn, ErrorType) {
  try { return { ok: true, value: fn() }; }
  catch (e) {
    assert.ok(e instanceof ErrorType, 'שגיאה שאינה של המודול: ' + (e && e.constructor && e.constructor.name) + ' ' + (e && e.message));
    assert.ok(typeof e.code === 'string' && e.code.length > 0, 'שגיאת מודול בלי code');
    return { ok: false, code: e.code };
  }
}

const RESERVED = ['__proto__', 'constructor', 'prototype'];
function snapshotOwn(target) {
  return Reflect.ownKeys(target).map(key => [key, Object.getOwnPropertyDescriptor(target, key)]);
}
const PROTO_BEFORE = snapshotOwn(Object.prototype);
// Snapshot descriptors, not property reads: accessors are never invoked, and
// properties added to an existing native function cannot hide behind its identity.
const PROTO_FUNCTIONS = PROTO_BEFORE
  .filter(([, descriptor]) => typeof descriptor.value === 'function')
  .map(([key, descriptor]) => ({ key, target: descriptor.value, before: snapshotOwn(descriptor.value) }));
function ownUnchanged(target, before, label) {
  assert.deepEqual(Reflect.ownKeys(target), before.map(([key]) => key), label + ': own keys changed');
  for (const [key, descriptor] of before) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(target, key), descriptor,
      label + ': descriptor changed for ' + String(key));
  }
}
function protoClean(label) {
  ownUnchanged(Object.prototype, PROTO_BEFORE, label + ': Object.prototype');
  for (const entry of PROTO_FUNCTIONS) {
    ownUnchanged(entry.target, entry.before, label + ': Object.prototype.' + String(entry.key));
  }
  assert.equal(Object.keys({}).length, 0, label + ': אובייקט ריק אינו ריק');
}

check('prototype guard: catches a field added to an existing native function, then restores it', () => {
  protoClean('before function mutation');
  const target = Object.prototype.toString;
  const original = Object.getOwnPropertyDescriptor(target, 'firefighter');
  assert.equal(original, undefined, 'the mutation must add a previously absent field');
  try {
    Object.defineProperty(target, 'firefighter', { value: 1, configurable: true });
    assert.throws(() => protoClean('function mutation'), { code: 'ERR_ASSERTION' });
  } finally {
    if (original) Object.defineProperty(target, 'firefighter', original);
    else Reflect.deleteProperty(target, 'firefighter');
  }
  protoClean('after function mutation restore');
});

check('prototype guard: catches a changed descriptor with unchanged keys, then restores it', () => {
  protoClean('before descriptor mutation');
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'toString');
  assert.equal(original.configurable, true, 'the fixture must be safely reversible');
  try {
    Object.defineProperty(Object.prototype, 'toString', { ...original, enumerable: !original.enumerable });
    assert.throws(() => protoClean('descriptor mutation'), { code: 'ERR_ASSERTION' });
  } finally {
    Object.defineProperty(Object.prototype, 'toString', original);
  }
  protoClean('after descriptor mutation restore');
});

/* PRNG דטרמיניסטי — כדי שכשל ישוחזר. */
let seed = 0x2f6e2b1;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(list) { return list[Math.floor(rnd() * list.length)]; }
function randomKey() {
  const r = rnd();
  if (r < 0.25) return pick(RESERVED);
  if (r < 0.35) return '';
  if (r < 0.45) return pick(['a.b', 'a/b', 'a b', 'שלום', '\u0000x', 'x'.repeat(129), 'x'.repeat(64), 'toString', 'valueOf', 'hasOwnProperty']);
  return 'k' + Math.floor(rnd() * 1e6).toString(36);
}

/* ============================ מנוע היומן ============================ */

const CLOCK = () => '2026-09-01T06:00:00.000Z';
const ST = '102';
function enginePolicy(subs) {
  return {
    station_id: ST, version: 'v1', digest: 'pd',
    sub_stations: subs,
    rest: { min_gap_days: 1 }, rotation: null, max_shifts_per_month: null
  };
}
function bigPolicy() {
  return enginePolicy({
    eilat: { label: 'אילת', minimum: 7, requirements: [
      { role: 'shift_lead', label: 'ראש', count: 1, required: true },
      { role: 'team_cmd', label: 'מפקד', count: 2, required: true },
      { role: 'driver', label: 'נהג', count: 2, required: true },
      { role: 'firefighter', label: 'לוחם', count: 4, required: false }
    ] },
    timna: { label: 'תמנע', minimum: 2, requirements: [
      { role: 'driver', label: 'נהג', count: 1, required: true },
      { role: 'firefighter', label: 'לוחם', count: 1, required: true }
    ] }
  });
}
function person(id, sub, roles) {
  return {
    id, station_id: ST, sub_station: sub, active: true, roles,
    source_snapshot: 's1', source_version: 'v1', contract_station_id: ST,
    source_revision: 'r1', source_digest: 'sd', source_complete: true
  };
}
function bigRoster(n) {
  const out = [];
  const roles = [['shift_lead', 'firefighter'], ['team_cmd', 'firefighter'], ['driver', 'firefighter'], ['firefighter']];
  for (let i = 0; i < n; i += 1) out.push(person('p' + i, i % 5 === 0 ? 'timna' : 'eilat', roles[i % 4]));
  return out;
}
function days(from, n) {
  const out = [];
  const t = Date.parse(from + 'T00:00:00Z');
  for (let i = 0; i < n; i += 1) out.push(new Date(t + i * 86400000).toISOString().slice(0, 10));
  return out;
}
const BASE = {
  station_id: ST, source_snapshot: 's1', source_version: 'v1', contract_station_id: ST,
  source_revision: 'r1', source_digest: 'sd', policy_digest: 'pd', source_complete: true,
  availability: {}, locked: {}, carry: {}
};
function engine(policy) { return engineMod.createCalendarEngine({ clock: CLOCK, policy: policy || bigPolicy() }); }

check('calendar: 1,000 אנשים × 91 יום מתוכננים בתקציב 6s, וכל יום מלא', () => {
  const out = within(6000, '1000×91', () => engine().planPeriod(Object.assign({}, BASE, { days: days('2026-09-01', 91), roster: bigRoster(1000) })));
  assert.equal(out.rows.length, 91 * 2);
  assert.ok(out.rows.every((r) => r.complete), 'יום לא מלא עם 1,000 אנשים');
  assert.equal(Object.getPrototypeOf(out.carry.load), Object.prototype);
});

check('calendar: המשך (carry) של 91 יום נכנס לחודש הבא ושומר הוגנות', () => {
  const e = engine();
  const first = e.planPeriod(Object.assign({}, BASE, { days: days('2026-09-01', 30), roster: bigRoster(200) }));
  const second = within(3000, 'carry', () => e.planPeriod(Object.assign({}, BASE, { days: days('2026-10-01', 31), roster: bigRoster(200), carry: first.carry })));
  assert.ok(second.rows.every((r) => r.complete));
  // לא הוכחת הוגנות — שומר רגרסיה: אף אחד לא עובד כל יום, והפער נשאר חד-ספרתי.
  assert.ok(second.summary.fairness.max <= 20, 'עומס מקסימלי ' + second.summary.fairness.max);
  assert.ok(second.summary.fairness.spread <= 8, 'פער עומס ' + second.summary.fairness.spread);
});

check('calendar: מעבר לגבולות נדחה בקוד, לא בקריסה — סגל 20,001, 1,001 ימים', () => {
  const r1 = orModuleError(() => engine().planPeriod(Object.assign({}, BASE, { days: ['2026-09-01'], roster: bigRoster(20001) })), engineMod.CalendarError);
  assert.equal(r1.code, 'roster-too-large');
  const r2 = orModuleError(() => engine().planPeriod(Object.assign({}, BASE, { days: days('2026-09-01', 1001), roster: bigRoster(50) })), engineMod.CalendarError);
  assert.equal(r2.code, 'days-too-many');
});

check('calendar fuzz: 3,000 קלטים עם מפתחות שמורים/אקראיים — רק CalendarError, ו-Object.prototype נקי', () => {
  const codes = new Map();
  for (let i = 0; i < 3000; i += 1) {
    const subKey = randomKey();
    const role = randomKey();
    const pid = randomKey();
    const subs = JSON.parse('{' + JSON.stringify(subKey) + ':' + JSON.stringify({ label: 'x', minimum: 1, requirements: [{ role, label: 'x', count: 1, required: true }] }) + '}');
    const r = orModuleError(() => {
      const e = engineMod.createCalendarEngine({ clock: CLOCK, policy: enginePolicy(subs) });
      const p = person(pid, rnd() < 0.5 ? subKey : randomKey(), [role]);
      const locked = rnd() < 0.5 ? {} : JSON.parse('{' + JSON.stringify(pick([subKey, randomKey()])) + ':{' + JSON.stringify(pick(['2026-09-01', randomKey()])) + ':[]}}');
      const availability = JSON.parse('{' + JSON.stringify(randomKey()) + ':{"2026-09-01":true}}');
      const carry = rnd() < 0.2 ? { load: JSON.parse('{' + JSON.stringify(pick([pid, randomKey()])) + ':1}'), lastDay: {}, byRole: {} } : {};
      return e.planPeriod(Object.assign({}, BASE, { days: ['2026-09-01'], roster: [p], locked, availability, carry }));
    }, engineMod.CalendarError);
    codes.set(r.ok ? 'ok' : r.code, (codes.get(r.ok ? 'ok' : r.code) || 0) + 1);
  }
  protoClean('calendar fuzz');
  assert.ok(codes.get('ok') > 0, 'אף קלט אקראי חוקי לא הצליח — ה-fuzz אינו מגיע למסלול המוצלח');
  assert.ok(codes.has('sub-station-key-reserved') && codes.has('requirement-role'), 'קודי המפתחות השמורים לא הופעלו');
  assert.ok(!codes.has('roster-id-reserved'), 'UID אינו נפסל (410)');
});

check('calendar: מזהי Firebase אמיתיים — 28 תווים, ועם נקודות — מתקבלים ומקבלים שיבוץ', () => {
  const ids = [];
  for (let i = 0; i < 40; i += 1) ids.push(crypto.randomBytes(21).toString('base64url').slice(0, 28));
  ids.push('user.with.dot', 'a:b:c', 'x'.repeat(128));
  const roster = ids.map((id, i) => person(id, 'eilat', [['shift_lead', 'firefighter'], ['team_cmd', 'firefighter'], ['driver', 'firefighter']][i % 3]));
  const out = engine(enginePolicy({ eilat: bigPolicy().sub_stations.eilat })).planPeriod(Object.assign({}, BASE, { days: days('2026-09-01', 7), roster }));
  assert.ok(out.rows.every((r) => r.complete));
  const assigned = new Set(out.rows.flatMap((r) => r.slots.map((s) => s.person)));
  assert.ok(assigned.size >= 9, 'שובצו רק ' + assigned.size);
});

/* ============================ מחבר המדיניות ============================ */

const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const author = authorMod.createPolicyAuthor({ clock: CLOCK, hash });
function draftWith(subKey, role, group) {
  const subs = JSON.parse('{' + JSON.stringify(subKey) + ':' + JSON.stringify({ label: 'x', minimum: 1, requirements: [{ role, label: 'x', count: 1, required: true }] }) + '}');
  return { sub_stations: subs, rest: { min_gap_days: 1 }, rotation: group === null ? null : { groups: ['a', group], anchor: '2026-01-01', days_per_group: 1, strict: true }, max_shifts_per_month: 10 };
}

check('policy-author fuzz: 3,000 טיוטות עם מפתחות אקראיים — רק שגיאות מודול, ו-Object.prototype נקי', () => {
  let ok = 0;
  for (let i = 0; i < 3000; i += 1) {
    const r = orModuleError(() => author.planPolicy({ station_id: pick(['station-102', randomKey()]), draft: draftWith(randomKey(), randomKey(), rnd() < 0.2 ? null : randomKey()), actor_uid: 'u' }), authorMod.PolicyAuthorError || Error);
    if (r.ok) ok += 1;
  }
  protoClean('policy-author fuzz');
  assert.ok(ok > 0, 'אף טיוטה אקראית לא התקבלה');
});

check('policy-author: 64 תחנות קצה × 32 תפקידים (הגבול) בתקציב 1s; 65 נדחות', () => {
  const subs = {};
  for (let s = 0; s < 64; s += 1) {
    const reqs = [];
    for (let r = 0; r < 32; r += 1) reqs.push({ role: 'role' + r, label: 'r' + r, count: 1, required: true });
    subs['sub' + s] = { label: 's' + s, minimum: 1, requirements: reqs };
  }
  const draft = { sub_stations: subs, rest: { min_gap_days: 1 }, rotation: null, max_shifts_per_month: 10 };
  const out = within(1000, '64×32', () => author.planPolicy({ station_id: 'station-102', draft, actor_uid: 'u' }));
  assert.equal(Object.keys(out.document.sub_stations).length, 64);
  subs.sub64 = subs.sub0;
  const r = orModuleError(() => author.planPolicy({ station_id: 'station-102', draft, actor_uid: 'u' }), Error);
  assert.equal(r.ok, false);
});

/* ============================ ימי עבודה אפקטיביים ============================ */

if (!workdays) console.log('· workdays: המודול אינו במקור — 2 בדיקות דולגו (לא נספרות)');
if (workdays) check('workdays: 397 יום × 500 מזהים מורכבים בתקציב 2s; 501 מזהים ו-398 ימים נדחים', () => {
  const range = workdays.normalizeRange('2026-01-01', '2027-02-01');
  const uids = [];
  for (let i = 0; i < 500; i += 1) uids.push('u' + i);
  const windows = workdays.windowsFor(range, null).map((w) => ({
    from: w.from, to: w.to,
    days: workdays.normalizeRange(w.from, w.to).dates.map((date) => ({ date, assignments: uids.slice(0, 50).map((uid) => ({ uid, display: 'x', source: 'v2' })) }))
  }));
  const out = within(2000, '397×500', () => workdays.assemble({ source: 'legacy', range: { from: range.from, to: range.to }, coverage: null, windows, uids, roster: null }));
  assert.equal(out.unknown_dates.length, 0);
  assert.equal(out.by_uid.u0.length, 397);
  assert.equal(out.by_uid.u499.length, 0);
  assert.equal(orModuleError(() => workdays.normalizeUids(new Array(501).fill('a')), workdays.EffectiveWorkdaysError).code, 'uids-too-many');
  assert.equal(orModuleError(() => workdays.normalizeRange('2026-01-01', '2027-02-02'), workdays.EffectiveWorkdaysError).code, 'range-too-long');
});

if (workdays) check('workdays fuzz: 2,000 מזהים אקראיים כולל שמורים — invalid או מוכר, לעולם לא ירושה', () => {
  for (let i = 0; i < 2000; i += 1) {
    const raw = randomKey();
    const { uids, invalid } = workdays.normalizeUids([raw]);
    if (RESERVED.includes(raw)) {
      // מזהה שמור הוא מחרוזת תקינה מבחינת התבנית; הוא מגיע ל-by_uid
      // כמפתח own ולא דרך ירושה. נוודא זאת דרך assemble.
      const out = workdays.assemble({ source: 'legacy', range: { from: '2026-09-01', to: '2026-09-01' }, coverage: null,
        windows: [{ from: '2026-09-01', to: '2026-09-01', days: [{ date: '2026-09-01', assignments: [] }] }], uids, roster: null });
      assert.ok(Object.prototype.hasOwnProperty.call(out.by_uid, raw) || invalid.length === 1);
    }
  }
  protoClean('workdays fuzz');
});

/* ============================ יומן תקלות · חוות דעת ============================ */

class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const member = { stationId: 'alpha_1', role: 'firefighter', is_active: true, employee_number: '9001' };

await checkAsync('incident-log: 600 צירופים קטלוגיים שונים ביום — 500 מסמכים נפרדים, השאר day-cap', async () => {
  const db = createFakeFirestore({ 'stations/alpha_1/users/u1': member });
  const service = incidentMod.createIncidentLog({ db, FieldValue: db.FieldValue, HttpsError, hash, clock: () => '2026-09-03T10:00:00.000Z' });
  // צירופים מתוך הקטלוג בלבד — ערך מחוץ לקטלוג מנורמל ל-'unknown' ואינו "שונה".
  const combos = [];
  for (const kind of catalog.KINDS) for (const screen of catalog.SCREENS) for (const code of catalog.CODES) for (const callable of catalog.CALLABLES) {
    combos.push({ kind, screen, version: '42G.0', code, callable });
  }
  assert.ok(combos.length >= 600, 'הקטלוג קטן מ-600 צירופים: ' + combos.length);
  let accepted = 0; let capped = 0;
  const fingerprints = new Set();
  const t0 = Date.now();
  for (let i = 0; i < 600; i += 1) {
    const out = await service.report({ auth: { uid: 'u1', token: member }, data: combos[i] });
    if (out.accepted === true) { accepted += 1; fingerprints.add(out.fingerprint); }
    else { assert.equal(out.reason, 'day-cap'); capped += 1; }
  }
  assert.equal(accepted, incidentMod.DAY_CAP);
  assert.equal(capped, 600 - incidentMod.DAY_CAP);
  assert.equal(fingerprints.size, incidentMod.DAY_CAP, 'טביעות אצבע לא נבדלות');
  assert.equal(db.keys().filter((k) => k.startsWith('stations/alpha_1/incidents/')).length, incidentMod.DAY_CAP);
  assert.ok(Date.now() - t0 < 8000, 'איטי מדי');
});

await checkAsync('incident-log: אותה תקלה 2,000 פעמים — מסמך אחד, מונה עד המכסה היומית, ואז day-cap', async () => {
  const db = createFakeFirestore({ 'stations/alpha_1/users/u1': member });
  const service = incidentMod.createIncidentLog({ db, FieldValue: db.FieldValue, HttpsError, hash, clock: () => '2026-09-03T10:00:00.000Z' });
  let fingerprint = null; let accepted = 0;
  for (let i = 0; i < 2000; i += 1) {
    const out = await service.report({ auth: { uid: 'u1', token: member },
      data: { kind: 'client-error', screen: 'swaps.html', version: '42G.0', code: 'TypeError', callable: 'unknown' } });
    if (out.accepted === true) accepted += 1; else assert.equal(out.reason, 'day-cap');
    fingerprint = out.fingerprint;
  }
  // המכסה היומית סופרת כל דיווח, גם חוזר — זה חוזה קיים (DAY_CAP), לא באג.
  assert.equal(accepted, incidentMod.DAY_CAP);
  const doc = db.read('stations/alpha_1/incidents/' + fingerprint);
  assert.equal(doc.count, incidentMod.DAY_CAP);
  const incidents = db.keys().filter((k) => k.startsWith('stations/alpha_1/incidents/'));
  assert.equal(incidents.length, 1);
});

await checkAsync('incident-log fuzz: שדות עם מפתחות שמורים ומחרוזות ארוכות — HttpsError בלבד, Object.prototype נקי', async () => {
  const db = createFakeFirestore({ 'stations/alpha_1/users/u1': member });
  const service = incidentMod.createIncidentLog({ db, FieldValue: db.FieldValue, HttpsError, hash, clock: () => '2026-09-03T10:00:00.000Z' });
  for (let i = 0; i < 500; i += 1) {
    const data = JSON.parse('{' + JSON.stringify(randomKey()) + ':1, "kind":' + JSON.stringify(pick(['client-error', randomKey()])) + ', "screen":' + JSON.stringify(pick(['swaps.html', randomKey(), 'x'.repeat(5000)])) + ', "version":"42G.0", "code":' + JSON.stringify(pick(['TypeError', randomKey(), 'x'.repeat(5000)])) + ', "callable":"unknown"}');
    try { await service.report({ auth: { uid: 'u1', token: member }, data }); }
    catch (e) { assert.ok(e instanceof HttpsError, 'לא HttpsError: ' + (e && e.stack)); }
  }
  protoClean('incident fuzz');
});

await checkAsync('feedback: מכסה יומית לאדם — 20 מתקבלות, ה-21 נדחית, וכפילות אינה נספרת', async () => {
  const db = createFakeFirestore({ 'stations/alpha_1/users/u1': member });
  const service = feedbackMod.createFeedback({ db, FieldValue: db.FieldValue, HttpsError, hash, clock: () => '2026-09-03T10:00:00.000Z' });
  const submit = (n) => service.submit({ auth: { uid: 'u1', token: member },
    data: { request_id: 'fb_req_' + String(n).padStart(4, '0'), screen: 'feedback.html', version: '42G.0', category: 'problem', rating: 2, text: 'הכפתור לא מגיב ' + n, allow_contact: true } });
  const quota = feedbackMod.LIMITS.perUserPerDay;
  assert.equal(typeof quota, 'number');
  const ids = [];
  for (let i = 0; i < quota; i += 1) {
    const out = await submit(i);
    assert.equal(out.duplicate, false); assert.equal(typeof out.id, 'string'); ids.push(out.id);
  }
  const docsBefore = db.keys().filter((k) => k.startsWith('stations/alpha_1/feedback/')).length;
  const quotaBefore = JSON.stringify(db.keys().filter((k) => k.includes('feedback_quota')).map((k) => db.read(k)));
  const dup = await submit(0);
  assert.equal(dup.duplicate, true, 'כפילות לא זוהתה');
  assert.equal(dup.id, ids[0]);
  assert.equal(db.keys().filter((k) => k.startsWith('stations/alpha_1/feedback/')).length, docsBefore, 'כפילות יצרה מסמך');
  assert.equal(JSON.stringify(db.keys().filter((k) => k.includes('feedback_quota')).map((k) => db.read(k))), quotaBefore, 'כפילות נספרה במכסה');
  await assert.rejects(submit(quota + 1), (e) => e instanceof HttpsError && e.code === 'resource-exhausted');
});

/* ============================ סיכום ============================ */

check('בסוף הכל: Object.prototype זהה לתחילת הריצה', () => protoClean('final'));

if (fails.length) {
  console.error('\nload-modules · נכשל');
  for (const f of fails) console.error('  ✗ ' + f);
  console.error('  ' + passed + ' עברו · ' + fails.length + ' נכשלו');
  process.exit(1);
}
console.log('\nload-modules · ' + passed + '/' + passed + ' עברו (עומס + fuzz על מודולים טהורים; אין Firebase)');
