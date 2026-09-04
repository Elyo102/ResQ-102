/* ====================================================================
 *  workdays-runtime-probe · ימי העבודה האפקטיביים על ה-runtime האמיתי,
 *  מול Firestore בזיכרון (לא אמולטור).
 *
 *  מה הבדיקה הזאת מוכיחה — ומה לא
 *  ----------------------------------------------------------------
 *  זה ה-runtime האמיתי (`functions/schedule-runtime.js`) עם מסד מזויף
 *  שמדמה את פעולות הקריאה שהמסלול הזה משתמש בהן: `limit().get()`,
 *  `where(field,'in',list)`, `db.getAll`, `doc.get/set/update/delete`.
 *  היא אינה תחליף לאמולטור (כללי אבטחה, אינדקסים, מרוצים אמיתיים) —
 *  היא מוכיחה את **הלוגיקה**: אילו קלטים נעוצים, מתי הקריאה מסרבת,
 *  ומה חוזה תחנה ריקה. השחזורים כאן הם של 419.
 *
 *   1. תחנה בלי אף רשומת מחזור: כל הטווח „לא ידוע" — לא סבב מומצא,
 *      לא חופש, לא שגיאה. מחזורים שקיימים אך כבויים — סירוב גלוי.
 *   2. חריגים שנכתבים בין שני חלונות (94 ימים): סירוב, לא תשובה
 *      מעורבבת; אותם חריגים יציבים — שני החלונות רואים אותם.
 *   3. החלפה מאושרת שנכנסת בין החלונות: סירוב; יציבה — מוחלת.
 *   4. שינוי בסיס (עוגן / חריג) **אחרי** שעות המשמרת — בשתי הכניסות.
 *   5. שעות המשמרת מגיעות מאותו בסיס נעוץ (אין קריאה נוספת ב-legacy).
 *   6. (421) שני טווחים אמיתיים מאותו מקור מתחברים במודול הלקוח; מקור
 *      אחר או פרסום — סירוב.
 *   7. (421) השבתה/העברה מתוך קריאות האימות הסופי עצמן — הזהות אחרונה.
 *
 *  יציאה: 0 עבר · 1 נכשל · 2 לא רץ.
 * ==================================================================== */

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import * as CLIENT from '../effective-workdays.js?v=42h0';

const HERE = dirname(fileURLToPath(import.meta.url));
const FN = resolve(HERE, '..', 'functions');
const require_ = createRequire(import.meta.url);

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  ok(name, a === b, 'קיבלתי ' + a + ' במקום ' + b);
}
async function rejectsCode(name, fn, code) {
  try { await fn(); } catch (e) {
    ok(name, e && e.code === code, 'קוד ' + (e && e.code) + ' במקום ' + code + (e && e.code !== code ? ' · ' + e.message : ''));
    return;
  }
  ok(name, false, 'לא נזרקה שגיאה כלל');
}

let runtimeMod, calendarMod, publicationMod, serviceMod, ScheduleRuntimeError;
try {
  runtimeMod = require_(resolve(FN, 'schedule-runtime.js'));
  calendarMod = require_(resolve(FN, 'schedule-calendar-engine.js'));
  publicationMod = require_(resolve(FN, 'schedule-publication.js'));
  serviceMod = require_(resolve(FN, 'schedule-service.js'));
  ScheduleRuntimeError = runtimeMod.ScheduleRuntimeError;
} catch (e) {
  console.error('NOT RUN — לא ניתן לטעון את המודולים: ' + e.message);
  process.exit(2);
}

/* ------------------------------------------------------------------
 * Firestore בזיכרון — רק מה שמסלול ימי העבודה קורא.
 * ------------------------------------------------------------------ */
function createFakeDb() {
  const docs = new Map();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  function snapshot(path) {
    const has = docs.has(path);
    return {
      exists: has, id: path.slice(path.lastIndexOf('/') + 1), ref: docRef(path),
      data: () => (has ? clone(docs.get(path)) : undefined)
    };
  }
  function query(path, filters, max) {
    return {
      path,
      where(field, op, value) { return query(path, filters.concat([{ field, op, value: clone(value) }]), max); },
      limit(n) { return query(path, filters, Number(n)); },
      orderBy() { throw new Error('orderBy אינו נתמך במסד המזויף — המסלול הזה לא אמור להשתמש בו'); },
      doc: (id) => docRef(path + '/' + String(id)),
      async get() {
        const prefix = path + '/';
        const out = [];
        for (const key of Array.from(docs.keys()).sort()) {
          if (key.indexOf(prefix) !== 0 || key.slice(prefix.length).indexOf('/') !== -1) continue;
          const value = docs.get(key);
          const hit = filters.every((f) => {
            const actual = value ? value[f.field] : undefined;
            if (f.op === '==') return actual === f.value;
            if (f.op === 'in') return Array.isArray(f.value) && f.value.indexOf(actual) !== -1;
            throw new Error('אופרטור לא נתמך במסד המזויף: ' + f.op);
          });
          if (hit) out.push(snapshot(key));
        }
        const limited = max === null ? out : out.slice(0, max);
        return { docs: limited, size: limited.length, empty: limited.length === 0 };
      }
    };
  }
  function docRef(path) {
    return {
      path, id: path.slice(path.lastIndexOf('/') + 1),
      collection: (name) => query(path + '/' + name, [], null),
      async get() { return snapshot(path); },
      async set(value) { docs.set(path, clone(value)); },
      async update(value) {
        if (!docs.has(path)) throw new Error('not-found: ' + path);
        docs.set(path, Object.assign({}, docs.get(path), clone(value)));
      },
      async delete() { docs.delete(path); }
    };
  }
  return {
    collection: (name) => query(name, [], null),
    doc: (path) => docRef(path),
    async getAll(...refs) {
      this._getAllCalls = (this._getAllCalls || 0) + 1;
      if (typeof this._onGetAll === 'function') await this._onGetAll(this._getAllCalls);
      return Promise.all(refs.map((r) => r.get()));
    },
    async runTransaction() { throw new Error('אין עסקאות במסלול הזה'); },
    _put(path, value) { docs.set(path, clone(value)); },
    _del(path) { docs.delete(path); },
    _has(path) { return docs.has(path); }
  };
}

const SID = 'station_102';
const ST = 'stations/' + SID;
function buildRuntime(db, hooks) {
  const h = hooks || {};
  return runtimeMod.createScheduleRuntime({
    db,
    FieldValue: { serverTimestamp: () => '__ts__' },
    FieldPath: Object.assign(function FieldPath() {}, { documentId: () => '__name__' }),
    clock: () => new Date(Date.UTC(2026, 8, 2, 6, 0, 0)).toISOString(),
    hash: (v) => createHash('sha256').update(String(v), 'utf8').digest('hex'),
    randomId: () => 'rnd',
    createEngine: calendarMod.createCalendarEngine,
    createPublication: publicationMod.createPublication,
    createService: serviceMod.createScheduleService,
    isSuper: () => false,
    sendPush: async () => ({ sent: 1 }),
    beforeEffectiveViewRecheck: h.beforeEffectiveViewRecheck
  });
}
function seed(db, options) {
  const opts = options || {};
  db._put(ST + '/schedule_state/runtime', { mode: opts.mode || 'shadow' });
  [['viewer', 'A'], ['driver2', 'B'], ['fighter2', 'C']].forEach(([uid, crew]) => {
    db._put(ST + '/roster/' + uid, { full_name: 'x', crew, is_active: true });
    db._put(ST + '/users/' + uid, { station_id: SID, station: SID, is_active: true, active: true, role: 'firefighter', full_name: 'x' });
  });
  ['A', 'B', 'C'].forEach((crew, position) => db._put(ST + '/rotations/' + crew, Object.assign({
    anchor_date: '2026-09-01', cycle_days: 3, position_in_cycle: position, crew, is_active: true
  }, opts.hours ? { shift_start: '07:00', shift_end: '07:00', shift_hours: 24 } : {})));
}
function req(uid, data) {
  return { auth: { uid, token: { stationId: SID, role: 'firefighter', name: uid } }, data };
}

/* ==================================================================
 * 1 · תחנה ריקה
 * ================================================================== */
{
  const db = createFakeDb();
  const api = buildRuntime(db);
  const out = await api.effectiveWorkDaysForStation('other_station', { from: '2026-09-01', to: '2026-09-03', uids: ['viewer'] });
  eq('1.1 מצב: תחנה בלי ריצה היא off', out.mode, 'off');
  eq('1.2 מקור legacy, בלי fallback', [out.source, out.fallback], ['legacy', null]);
  eq('1.3 אין כיסוי', out.coverage, null);
  eq('1.4 כל הטווח לא ידוע', out.unknown_dates, ['2026-09-01', '2026-09-02', '2026-09-03']);
  eq('1.5 מי שנשאל עליו — לא בסגל', out.unknown_uids, { viewer: 'not-in-roster' });
  eq('1.6 by_uid ריק', out.by_uid, {});
  eq('1.7 provenance מסמן אפס מחזורים', out.provenance.legacy_rotations, 0);
  ok('1.8 חתימה קיימת', typeof out.provenance.legacy_digest === 'string');
  eq('1.9 אין שעות', out.shift_hours, null);
  // סגל בלי מחזור: רשימה ריקה, אבל כל הימים לא ידועים — לא „חופש".
  db._put('stations/other_station/roster/ghost', { crew: 'A', is_active: true });
  const rostered = await api.effectiveWorkDaysForStation('other_station', { from: '2026-09-01', to: '2026-09-02', uids: ['ghost'] });
  eq('1.10 בסגל בלי מחזור — רשימה ריקה + כל הימים לא ידועים', [rostered.by_uid, rostered.unknown_dates], [{ ghost: [] }, ['2026-09-01', '2026-09-02']]);
  // מחזור קיים אך כבוי — סירוב גלוי של המתאם, לא „לא ידוע".
  db._put('stations/other_station/rotations/A', { anchor_date: '2026-09-01', cycle_days: 3, position_in_cycle: 0, crew: 'A', is_active: false });
  await rejectsCode('1.11 מחזורים כבויים — תצורה שבורה נשארת סירוב',
    () => api.effectiveWorkDaysForStation('other_station', { from: '2026-09-01', to: '2026-09-02', uids: ['ghost'] }), 'effective-schedule-invalid');
  // new בלי פרסום ובלי מחזור: fallback מסומן, ועדיין לא ידוע.
  db._del('stations/other_station/rotations/A');
  db._put('stations/other_station/schedule_state/runtime', { mode: 'new' });
  const fb = await api.effectiveWorkDaysForStation('other_station', { from: '2026-09-01', to: '2026-09-02', uids: ['ghost'] });
  eq('1.12 new בלי פרסום ובלי מחזור — fallback legacy, לא ידוע', [fb.mode, fb.fallback, fb.provenance.fallback, fb.unknown_dates.length], ['new', 'legacy', 'legacy', 2]);
  // וכשנכנס פרסום באמצע — לא legacy.
  const racing = buildRuntime(db, { beforeEffectiveViewRecheck: async (info) => {
    if (info && info.kind === 'workdays') db._put('stations/other_station/schedule_state/active', { publication_id: 'p1', revision: 1, content_digest: 'd' });
  } });
  await rejectsCode('1.13 פרסום שנכנס אחרי הקריאה → schedule-mode-changed',
    () => racing.effectiveWorkDaysForStation('other_station', { from: '2026-09-01', to: '2026-09-02', uids: ['ghost'] }), 'schedule-mode-changed');
}

/* ==================================================================
 * 2 · חריגים בין חלונות (השחזור של 419)
 * ================================================================== */
{
  const db = createFakeDb();
  seed(db);
  const api = buildRuntime(db);
  const range = { from: '2026-09-01', to: '2026-12-03', uids: ['viewer', 'driver2'] };
  const before = await api.effectiveWorkDaysForStation(SID, range);
  eq('2.1 94 ימים: viewer (A) עובד ב-1.9 וב-3.12', [before.by_uid.viewer.includes('2026-09-01'), before.by_uid.viewer.includes('2026-12-03')], [true, true]);
  eq('2.2 אין ימים לא ידועים', before.unknown_dates, []);
  let windows = 0;
  const shifting = buildRuntime(db, { beforeEffectiveViewRecheck: async (info) => {
    if (info && info.kind === 'legacy') {
      windows += 1;
      if (windows === 1) {
        db._put(ST + '/shift_overrides/2026-09-01', { kind: 'swap', crew: 'B', extra_crews: [] });
        db._put(ST + '/shift_overrides/2026-12-03', { kind: 'swap', crew: 'B', extra_crews: [] });
      }
    }
  } });
  await rejectsCode('2.3 חריגים שנכתבו אחרי החלון הראשון → legacy-schedule-changed', () => shifting.effectiveWorkDaysForStation(SID, range), 'legacy-schedule-changed');
  ok('2.4 ההוק אכן רץ פעמיים (שני חלונות)', windows === 2, String(windows));
  const steady = await api.effectiveWorkDaysForStation(SID, range);
  eq('2.5 יציב: viewer לא עובד באף אחד משני הימים', [steady.by_uid.viewer.includes('2026-09-01'), steady.by_uid.viewer.includes('2026-12-03')], [false, false]);
  eq('2.6 יציב: driver2 (B) עובד בשניהם', [steady.by_uid.driver2.includes('2026-09-01'), steady.by_uid.driver2.includes('2026-12-03')], [true, true]);
  ok('2.7 החתימה כוללת את החריגים', steady.provenance.legacy_digest !== before.provenance.legacy_digest);
  db._del(ST + '/shift_overrides/2026-09-01');
  db._del(ST + '/shift_overrides/2026-12-03');
  const after = await api.effectiveWorkDaysForStation(SID, range);
  eq('2.8 אחרי המחיקה — חזרה לחתימה המקורית', after.provenance.legacy_digest, before.provenance.legacy_digest);
  // חריג מחוץ לטווח אינו משנה את החתימה — התחימה לפי הטווח.
  db._put(ST + '/shift_overrides/2027-01-01', { kind: 'swap', crew: 'B', extra_crews: [] });
  const outside = await api.effectiveWorkDaysForStation(SID, range);
  eq('2.9 חריג מחוץ לטווח — אותה חתימה', outside.provenance.legacy_digest, before.provenance.legacy_digest);
  db._del(ST + '/shift_overrides/2027-01-01');
}

/* ==================================================================
 * 3 · החלפה מאושרת בין חלונות
 * ================================================================== */
{
  const db = createFakeDb();
  seed(db);
  const api = buildRuntime(db);
  const range = { from: '2026-09-01', to: '2026-12-03', uids: ['viewer', 'fighter2'] };
  const swap = { status: 'approved', from_uid: 'viewer', from_crew: 'A', from_date: '2026-12-03', to_uid: 'fighter2', to_crew: 'C', to_date: '2026-12-02' };
  const before = await api.effectiveWorkDaysForStation(SID, range);
  let windows = 0;
  const swapping = buildRuntime(db, { beforeEffectiveViewRecheck: async (info) => {
    if (info && info.kind === 'legacy') { windows += 1; if (windows === 1) db._put(ST + '/swaps/swap_419', swap); }
  } });
  await rejectsCode('3.1 החלפה שנכנסה בין החלונות → legacy-schedule-changed', () => swapping.effectiveWorkDaysForStation(SID, range), 'legacy-schedule-changed');
  const steady = await api.effectiveWorkDaysForStation(SID, range);
  eq('3.2 יציב: viewer יצא מ-3.12 ונכנס ל-2.12', [steady.by_uid.viewer.includes('2026-12-03'), steady.by_uid.viewer.includes('2026-12-02')], [false, true]);
  eq('3.3 יציב: fighter2 להפך', [steady.by_uid.fighter2.includes('2026-12-03'), steady.by_uid.fighter2.includes('2026-12-02')], [true, false]);
  ok('3.4 החתימה כוללת את ההחלפה', steady.provenance.legacy_digest !== before.provenance.legacy_digest);
  // החלפה שאינה מאושרת — נקראת (נעוצה) אך אינה מוחלת; החתימה שונה כי הבסיס שונה.
  db._put(ST + '/swaps/swap_419', Object.assign({}, swap, { status: 'pending' }));
  const pending = await api.effectiveWorkDaysForStation(SID, range);
  eq('3.5 החלפה ממתינה אינה מוחלת', pending.by_uid.viewer.includes('2026-12-03'), true);
}

/* ==================================================================
 * 4 · שינוי אחרי שעות המשמרת — בשתי הכניסות
 * ================================================================== */
{
  const db = createFakeDb();
  seed(db, { hours: true });
  const api = buildRuntime(db);
  const input = { from: '2026-09-01', to: '2026-09-06', uids: ['viewer'] };
  const fine = await api.getEffectiveWorkdays(req('viewer', input));
  eq('4.1 שעות מהבסיס הנעוץ', fine.shift_hours, { shift_start: '07:00', shift_end: '07:00', shift_hours: 24, hours_source: 'legacy-rotation-config' });
  eq('4.2 viewer עובד 1.9 ו-4.9', fine.by_uid.viewer, ['2026-09-01', '2026-09-04']);
  const anchorLate = buildRuntime(db, { beforeEffectiveViewRecheck: async (info) => {
    if (info && info.kind === 'workdays') db._put(ST + '/rotations/A', Object.assign({}, db._has(ST + '/rotations/A') ? {} : {}, { anchor_date: '2026-09-02', cycle_days: 3, position_in_cycle: 0, crew: 'A', is_active: true }));
  } });
  await rejectsCode('4.3 callable: עוגן שזז אחרי השעות → legacy-schedule-changed', () => anchorLate.getEffectiveWorkdays(req('viewer', input)), 'legacy-schedule-changed');
  seed(db, { hours: true });
  await rejectsCode('4.4 כניסה שרתית: אותו דין', () => anchorLate.effectiveWorkDaysForStation(SID, input), 'legacy-schedule-changed');
  seed(db, { hours: true });
  const overrideLate = buildRuntime(db, { beforeEffectiveViewRecheck: async (info) => {
    if (info && info.kind === 'workdays') db._put(ST + '/shift_overrides/2026-09-04', { kind: 'swap', crew: 'B', extra_crews: [] });
  } });
  await rejectsCode('4.5 חריג שנכתב אחרי השעות → legacy-schedule-changed', () => overrideLate.effectiveWorkDaysForStation(SID, input), 'legacy-schedule-changed');
  db._del(ST + '/shift_overrides/2026-09-04');
  const swapLate = buildRuntime(db, { beforeEffectiveViewRecheck: async (info) => {
    if (info && info.kind === 'workdays') db._put(ST + '/swaps/late', { status: 'approved', from_uid: 'viewer', from_crew: 'A', from_date: '2026-09-04', to_uid: 'driver2', to_crew: 'B', to_date: '2026-09-05' });
  } });
  await rejectsCode('4.6 החלפה שנכנסה אחרי השעות → legacy-schedule-changed', () => swapLate.getEffectiveWorkdays(req('viewer', input)), 'legacy-schedule-changed');
  db._del(ST + '/swaps/late');
  const modeLate = buildRuntime(db, { beforeEffectiveViewRecheck: async (info) => {
    if (info && info.kind === 'workdays') db._put(ST + '/schedule_state/runtime', { mode: 'off' });
  } });
  await rejectsCode('4.7 כניסה שרתית: מצב שהשתנה אחרי השעות → schedule-mode-changed', () => modeLate.effectiveWorkDaysForStation(SID, input), 'schedule-mode-changed');
  db._put(ST + '/schedule_state/runtime', { mode: 'shadow' });
  const viewerLate = buildRuntime(db, { beforeEffectiveViewRecheck: async (info) => {
    if (info && info.kind === 'workdays') db._put(ST + '/users/viewer', { station_id: SID, station: SID, is_active: false, active: false, role: 'firefighter' });
  } });
  await rejectsCode('4.8 callable: השבתה אחרי השעות → workdays-viewer-changed', () => viewerLate.getEffectiveWorkdays(req('viewer', input)), 'workdays-viewer-changed');
  seed(db, { hours: true });
  const again = await api.getEffectiveWorkdays(req('viewer', input));
  eq('4.9 בלי הפרעה — אותה תשובה', [again.by_uid.viewer, again.provenance.legacy_digest], [fine.by_uid.viewer, fine.provenance.legacy_digest]);
}

/* ==================================================================
 * 5 · שני חלקים של 500 מזהים — אותה חתימה
 * ================================================================== */
{
  const db = createFakeDb();
  seed(db);
  const api = buildRuntime(db);
  const a = await api.effectiveWorkDaysForStation(SID, { from: '2026-09-01', to: '2026-09-30', uids: ['viewer'] });
  const b = await api.effectiveWorkDaysForStation(SID, { from: '2026-09-01', to: '2026-09-30', uids: ['driver2'] });
  eq('5.1 אותו טווח, אותו בסיס — אותה חתימה', a.provenance.legacy_digest, b.provenance.legacy_digest);
  const c = await api.effectiveWorkDaysForStation(SID, { from: '2026-09-01', to: '2026-10-01', uids: ['viewer'] });
  ok('5.2 טווח אחר — חתימה אחרת (החתימה תחומה לטווח)', c.provenance.legacy_digest !== a.provenance.legacy_digest);
}

/* ==================================================================
 * 6 · 421#1 · שני טווחים אמיתיים מה-runtime מתחברים במודול הלקוח
 *      (מסך האבטחות: היסטוריה + עתיד); שינוי מקור/פרסום — סירוב.
 * ================================================================== */
{
  const db = createFakeDb();
  seed(db);
  const api = buildRuntime(db);
  const ask = (from, to) => api.getEffectiveWorkdays(req('viewer', { from, to, uids: ['viewer', 'driver2'] }));
  const history = await ask('2025-09-02', '2026-09-01');
  const upcoming = await ask('2026-09-02', '2027-09-02');
  ok('6.1 שני הטווחים נושאים חתימות תוכן שונות (הטווח בתוך החתימה)', history.provenance.legacy_digest !== upcoming.provenance.legacy_digest);
  eq('6.2 ואותה זהות מקור', history.provenance.legacy_basis_digest, upcoming.provenance.legacy_basis_digest);
  const merged = CLIENT.mergeEffectiveWorkdays([CLIENT.parseEffectiveWorkdays({ data: history }), CLIENT.parseEffectiveWorkdays({ data: upcoming })]);
  eq('6.3 המסך מחבר: 1.9 (היסטוריה) ו-4.9 (עתיד) — שניהם ידועים', [CLIENT.worksOn(merged, 'viewer', '2026-09-01'), CLIENT.worksOn(merged, 'viewer', '2026-09-04'), CLIENT.worksOn(merged, 'viewer', '2026-09-02')], [true, true, false]);
  eq('6.4 אין ימים לא ידועים בתפר', CLIENT.unknownDaysBetween(merged, '2026-08-30', '2026-09-05'), []);
  // המקור השתנה בין שתי הקריאות (העוגן זז) — הלקוח מסרב לחבר.
  db._put(ST + '/rotations/A', { anchor_date: '2026-09-02', cycle_days: 3, position_in_cycle: 0, crew: 'A', is_active: true });
  db._put(ST + '/rotations/B', { anchor_date: '2026-09-02', cycle_days: 3, position_in_cycle: 1, crew: 'B', is_active: true });
  db._put(ST + '/rotations/C', { anchor_date: '2026-09-02', cycle_days: 3, position_in_cycle: 2, crew: 'C', is_active: true });
  const moved = await ask('2026-09-02', '2027-09-02');
  ok('6.5 בסיס אחר — זהות אחרת', moved.provenance.legacy_basis_digest !== history.provenance.legacy_basis_digest);
  try { CLIENT.mergeEffectiveWorkdays([CLIENT.parseEffectiveWorkdays({ data: history }), CLIENT.parseEffectiveWorkdays({ data: moved })]); ok('6.6 חיבור טווחים ממקורות שונים — סירוב', false, 'לא נזרקה שגיאה'); }
  catch (e) { eq('6.6 חיבור טווחים ממקורות שונים — סירוב', e.code, 'workdays-merge-source'); }
  // חריג בטווח אחד בלבד: אותה זהות מקור (החריג הוא תוכן טווח) — מתחבר, והחריג מוחל.
  seed(db);
  db._put(ST + '/shift_overrides/2026-09-04', { kind: 'swap', crew: 'B', extra_crews: [] });
  const withOverride = await ask('2026-09-02', '2027-09-02');
  const merged2 = CLIENT.mergeEffectiveWorkdays([CLIENT.parseEffectiveWorkdays({ data: history }), CLIENT.parseEffectiveWorkdays({ data: withOverride })]);
  eq('6.7 חריג בטווח העתיד — מתחבר ומוחל (viewer לא ב-4.9, driver2 כן)', [CLIENT.worksOn(merged2, 'viewer', '2026-09-04'), CLIENT.worksOn(merged2, 'driver2', '2026-09-04')], [false, true]);
  // new עם פרסום מול legacy — סירוב (מצב/מקור שונים).
  const fake = { data: Object.assign({}, upcoming, { mode: 'new', source: 'publication', provenance: { mode: 'new', source: 'v2', publication_id: 'p1', revision: 1, content_digest: 'c' } }) };
  try { CLIENT.mergeEffectiveWorkdays([CLIENT.parseEffectiveWorkdays({ data: history }), CLIENT.parseEffectiveWorkdays(fake)]); ok('6.8 legacy + פרסום — סירוב', false, 'לא נזרקה שגיאה'); }
  catch (e) { eq('6.8 legacy + פרסום — סירוב', e.code, 'workdays-merge-source'); }
}

/* ==================================================================
 * 7 · 421#2 · השבתה/העברה **מתוך קריאות האימות הסופי** — בלי תפר
 *      (המסד עצמו משבית את המשתמש ב-getAll השני), והזהות נבדקת אחרונה.
 * ================================================================== */
{
  const db = createFakeDb();
  seed(db);
  const api = buildRuntime(db);
  const input = { from: '2026-09-01', to: '2026-09-06', uids: ['viewer'] };
  let seen = 0;
  db._onGetAll = async (n) => {
    seen = n;
    // getAll #1 — הבסיס הנעוץ; getAll #2 — האימות הסופי (verify). בדיוק אז — השבתה.
    if (n === 2) db._put(ST + '/users/viewer', { station_id: SID, station: SID, is_active: false, active: false, role: 'firefighter' });
  };
  await rejectsCode('7.1 השבתה במהלך ה-getAll של האימות → workdays-viewer-changed', () => api.getEffectiveWorkdays(req('viewer', input)), 'workdays-viewer-changed');
  eq('7.2 האימות אכן קרא (getAll שני)', seen >= 2, true);
  seed(db);
  db._getAllCalls = 0;
  db._onGetAll = async (n) => {
    if (n === 2) db._put(ST + '/users/viewer', { station_id: 'elsewhere_1', station: 'elsewhere_1', is_active: true, active: true, role: 'firefighter' });
  };
  await rejectsCode('7.3 העברת תחנה במהלך האימות → workdays-viewer-changed', () => api.getEffectiveWorkdays(req('viewer', input)), 'workdays-viewer-changed');
  seed(db);
  db._getAllCalls = 0;
  db._onGetAll = async (n) => {
    if (n === 2) db._put(ST + '/schedule_state/runtime', { mode: 'off' });
  };
  await rejectsCode('7.4 מצב שהשתנה במהלך האימות → schedule-mode-changed', () => api.getEffectiveWorkdays(req('viewer', input)), 'schedule-mode-changed');
  seed(db);
  db._onGetAll = null;
  const ok7 = await api.getEffectiveWorkdays(req('viewer', input));
  eq('7.5 בלי הפרעה — תשובה', ok7.by_uid.viewer, ['2026-09-01', '2026-09-04']);
}

if (fails.length) {
  console.error('✗ ' + fails.length + ' כשלים:');
  fails.forEach((f) => console.error('  ' + f));
  console.log(pass + ' עברו');
  process.exit(1);
}
console.log(pass + ' workdays runtime probe checks passed (real runtime, in-memory Firestore — not the emulator).');
