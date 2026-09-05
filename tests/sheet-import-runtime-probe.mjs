/* ====================================================================
 *  sheet-import-runtime-probe · ייבוא הגיליון כטיוטה, על ה-runtime
 *  האמיתי מול Firestore בזיכרון (לא אמולטור).
 *
 *  המסלול המלא: מדיניות אמיתית (savePolicy) → מקור חתום → הדבקת גיליון
 *  סינתטי → previewScheduleImport (דוח, בלי כתיבה) → importScheduleSheet
 *  (טיוטה דרך stageSnapshot/finalizeDraft) → getScheduleDraftPreview
 *  (תחנות, קו, היעדרויות, צוות) → publishSchedule → getStationScheduleRange
 *  ב-new (אותו עיטור) → getEffectiveWorkdays (מי עובד — מהפרסום המיובא).
 *
 *  מה לא כאן: כללי אבטחה, אינדקסים, מרוצים אמיתיים — אמולטור.
 *  יציאה: 0 עבר · 1 נכשל · 2 לא רץ.
 * ==================================================================== */

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const FN = resolve(HERE, '..', 'functions');
const require_ = createRequire(import.meta.url);

let pass = 0;
const fails = [];
function ok(name, cond, detail) { if (cond) { pass++; return; } fails.push(name + (detail ? ' — ' + detail : '')); }
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  ok(name, a === b, 'קיבלתי ' + a + ' במקום ' + b);
}
async function rejectsCode(name, fn, code) {
  try { await fn(); } catch (e) { ok(name, e && e.code === code, 'קוד ' + (e && e.code) + ' במקום ' + code + (e && e.code !== code ? ' · ' + e.message : '')); return; }
  ok(name, false, 'לא נזרקה שגיאה כלל');
}

let runtimeMod, calendarMod, publicationMod, serviceMod;
try {
  runtimeMod = require_(resolve(FN, 'schedule-runtime.js'));
  calendarMod = require_(resolve(FN, 'schedule-calendar-engine.js'));
  publicationMod = require_(resolve(FN, 'schedule-publication.js'));
  serviceMod = require_(resolve(FN, 'schedule-service.js'));
} catch (e) {
  console.error('NOT RUN — לא ניתן לטעון את המודולים: ' + e.message);
  process.exit(2);
}

/* ---------------- Firestore בזיכרון (קריאה, כתיבה, עסקה, batch) ---------------- */
function createFakeDb() {
  const docs = new Map();
  let beforeRead = null;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v, (k, val) => (val && val.__ts ? 'ts' : val))));
  function snapshot(path) {
    const has = docs.has(path);
    return { exists: has, id: path.slice(path.lastIndexOf('/') + 1), ref: docRef(path), data: () => (has ? clone(docs.get(path)) : undefined) };
  }
  function query(path, filters, max) {
    return {
      path,
      where(field, op, value) { return query(path, filters.concat([{ field, op, value: clone(value) }]), max); },
      limit(n) { return query(path, filters, Number(n)); },
      orderBy() { return this; },
      doc: (id) => docRef(path + '/' + String(id)),
      async get() {
        if (beforeRead) await beforeRead(path, 'query');
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
      async get() {
        if (beforeRead) await beforeRead(path, 'document');
        return snapshot(path);
      },
      async set(value, options) {
        if (options && options.merge && docs.has(path)) docs.set(path, Object.assign({}, docs.get(path), clone(value)));
        else docs.set(path, clone(value));
      },
      async update(value) { if (!docs.has(path)) throw new Error('not-found: ' + path); docs.set(path, Object.assign({}, docs.get(path), clone(value))); },
      async create(value) { if (docs.has(path)) { const e = new Error('exists'); e.code = 6; throw e; } docs.set(path, clone(value)); },
      async delete() { docs.delete(path); }
    };
  }
  function writer() {
    const ops = [];
    return {
      set(ref, value, options) { ops.push(() => ref.set(value, options)); return this; },
      update(ref, value) { ops.push(() => ref.update(value)); return this; },
      create(ref, value) { ops.push(() => { if (docs.has(ref.path)) { const e = new Error('exists'); e.code = 6; throw e; } return ref.set(value); }); return this; },
      delete(ref) { ops.push(() => ref.delete()); return this; },
      async commit() { for (const op of ops) await op(); }
    };
  }
  return {
    collection: (name) => query(name, [], null),
    doc: (path) => docRef(path),
    async getAll(...refs) { return Promise.all(refs.map((r) => r.get())); },
    batch() { return writer(); },
    async runTransaction(fn) {
      const w = writer();
      const tx = { get: (ref) => ref.get(), set: (r, v, o) => w.set(r, v, o), update: (r, v) => w.update(r, v), create: (r, v) => w.create(r, v), delete: (r) => w.delete(r) };
      const out = await fn(tx);
      await w.commit();
      return out;
    },
    _put(path, value) { docs.set(path, clone(value)); },
    _del(path) { docs.delete(path); },
    _get(path) { return docs.has(path) ? clone(docs.get(path)) : null; },
    _paths(prefix) { return Array.from(docs.keys()).filter((k) => k.indexOf(prefix) === 0).sort(); },
    _setBeforeRead(fn) { beforeRead = typeof fn === 'function' ? fn : null; }
  };
}

const SID = 'station_102';
const ST = 'stations/' + SID;
const hash = (v) => createHash('sha256').update(String(v), 'utf8').digest('hex');
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}
const digest = (v) => hash(stable(v));

function buildRuntime(db, hooks) {
  return runtimeMod.createScheduleRuntime({
    db,
    FieldValue: { serverTimestamp: () => ({ __ts: true }) },
    FieldPath: Object.assign(function FieldPath() {}, { documentId: () => '__name__' }),
    clock: () => '2026-08-25T06:00:00.000Z',
    hash, randomId: () => 'rnd',
    createEngine: calendarMod.createCalendarEngine,
    createPublication: publicationMod.createPublication,
    createService: serviceMod.createScheduleService,
    isSuper: () => false,
    sendPush: async () => ({ sent: 1 }),
    beforeLiveGuardViewRecheck: hooks && hooks.beforeLiveGuardViewRecheck,
    beforeEffectiveViewRecheck: hooks && hooks.beforeEffectiveViewRecheck
  });
}
const MGR = 'uid-mgr';
function req(data, uid) {
  return { auth: { uid: uid || MGR, token: { stationId: SID, role: 'firefighter', name: uid || MGR } }, data: data || {} };
}
const PEOPLE = [
  ['u1', 'רועי כהן', 'eilat', 'A'], ['u2', 'דניאל לוי', 'eilat', 'A'], ['u3', 'יוסי מזרחי', 'shahmon', 'B'],
  ['u4', 'עמית פרץ', 'timna', 'C'], ['u5', 'גיא ברק', 'yotvata', 'A'], ['u6', 'רועי אברהם', 'eilat', 'B'],
  ['u7', 'נועם דהן', 'eilat', 'B'], ['u8', 'אורי שלום', 'eilat', 'C'], ['u9', 'ליאור נחום', 'eilat', 'A'],
  ['ux', 'רועי ישראלי', 'eilat', 'C']
];

async function seed(db) {
  // משתמשים חיים, מינוי אחראי סידור, סגל ישן (צוותים) ומחזור ישן (צבע עמודה).
  db._put(ST + '/users/' + MGR, { station_id: SID, station: SID, is_active: true, active: true, role: 'firefighter', full_name: 'מ' });
  db._put(ST + '/schedule_access/' + MGR, { schema_version: 1, station_id: SID, uid: MGR, roles: ['schedule_manager'], active: true, revision: 1 });
  PEOPLE.forEach(([uid, name, , crew]) => {
    db._put(ST + '/users/' + uid, { station_id: SID, station: SID, is_active: true, active: true, role: 'firefighter', full_name: name });
    db._put(ST + '/roster/' + uid, { full_name: name, crew, is_active: true });
  });
  ['A', 'B', 'C'].forEach((crew, position) => db._put(ST + '/rotations/' + crew, { anchor_date: '2026-09-01', cycle_days: 3, position_in_cycle: position, crew, is_active: true }));
  db._put(ST + '/schedule_state/runtime', { mode: 'shadow' });
  const rt = buildRuntime(db);
  const saved = await rt.savePolicy(req({
    request_id: 'p1', activate: true,
    draft: {
      sub_stations: {
        eilat: { label: 'אילת', minimum: 7, requirements: [{ role: 'ff', count: 7, required: true }] },
        shahmon: { label: 'שחמון', minimum: 0, requirements: [{ role: 'ff', count: 1, required: false }] },
        timna: { label: 'תמנע', minimum: 0, requirements: [{ role: 'ff', count: 1, required: false }] },
        yotvata: { label: 'יטבתה', minimum: 0, requirements: [{ role: 'ff', count: 1, required: false }] }
      },
      rest: { min_gap_days: 1 }, rotation: null, max_shifts_per_month: null
    }
  }));
  // מקור חתום (כמו שהשרת כותב), בלי לעבור דרך הדבקת כוח האדם.
  const sourceId = 'src_1';
  const base = ST + '/schedule_sources/' + sourceId;
  const peopleRaw = PEOPLE.map(([uid, name, sub]) => ({ id: uid, full_name: name, active: true, sub_station: sub, roles: ['ff'] }));
  peopleRaw.forEach((p) => db._put(base + '/people/' + p.id, Object.assign({}, p, { id: undefined })));
  const basis = { station_id: SID, version: '1', revision: '1', carry: {}, counts: { people: peopleRaw.length, availability: 0, locked: 0, events: 0 }, people: peopleRaw, availability: {}, locked: {}, events: [] };
  db._put(base, { station_id: SID, complete: true, version: '1', revision: '1', person_count: peopleRaw.length, availability_count: 0, locked_count: 0, event_count: 0,
    content_digest: digest(basis), content_key: hash(stable({ station_id: SID, people: peopleRaw })) });
  db._put(ST + '/schedule_state/runtime', { mode: 'shadow', active_policy_id: saved.policy_id, active_source_id: sourceId });
  return { rt, policyId: saved.policy_id, sourceId };
}

function row(cells) { return cells.join('\t'); }
const SHEET = [
  row(['', '1/9', '2/9', '3/9/26']),
  row(['', 'ג', 'ד', 'ה']),
  row(['אילת', 'רועי כהן', 'יוסי מזרחי', 'עמית פרץ']),
  row(['', 'דניאל לוי', 'נועם דהן', 'אורי שלום']),
  row(['', 'ליאור נחום', 'רועי אברהם', 'גיא']),
  row(['', 'גיא', '', '']),
  row(['', 'אורי שלום', '', '']),
  row(['', 'נועם דהן', '', '']),
  row(['', 'עמית פרץ', '', '']),
  row(['שחמון', 'יוסי מזרחי', '', 'יוסי מזרחי']),
  row(['תמנע', '', 'עמית פרץ', '']),
  row(['יטבתה', '', 'גיא', '']),
  row(['', 'אבטחה', '', '']),
  row(['', '17:45-08:00', '', '']),
  row(['מחלה', 'רועי אברהם', 'אורי שלום', '']),
  row(['קורסים', '', 'ליאור נחום', '']),
  row(['באילת', '', '', 'רועי כהן']),
  row(['בצפון', 'רועי', '', ''])
].join('\n');

// The ordinary fixture deliberately covers three days so the old import and
// publication assertions stay small. Display selection requires a complete
// calendar month, therefore its fixture extends the exact same sheet with
// empty, explicit date columns through 30 September.
const FULL_MONTH_SHEET = (() => {
  const lines = SHEET.split('\n').map((line) => line.split('\t'));
  for (let day = 4; day <= 30; day += 1) {
    lines[0].push(day + '/9/26');
    lines[1].push('');
    for (let rowIndex = 2; rowIndex < lines.length; rowIndex += 1) lines[rowIndex].push('');
  }
  return lines.map((line) => line.join('\t')).join('\n');
})();
const CONFLICT_SHEET = [
  row(['', '1/9', '2/9', '3/9']),
  row(['', 'ג', 'ד', 'ה']),
  row(['אילת', 'רועי כהן', '', '']),
  row(['שחמון', '', 'יוסי מזרחי', '']),
  row(['תמנע', '', '', 'עמית פרץ']),
  row(['יטבתה', '', '', '']),
  row(['מחלה', 'רועי כהן', '', ''])
].join('\n');

/* ==================================================================
 * 0 · ביצועים בטוחים: קריאות זהות בלתי תלויות מתחילות יחד
 * ================================================================== */
{
  const db = createFakeDb();
  db._put(ST + '/users/' + MGR, {
    station_id: SID, station: SID, is_active: true, active: true,
    role: 'firefighter', full_name: 'מ'
  });
  db._put(ST + '/schedule_access/' + MGR, {
    schema_version: 1, station_id: SID, uid: MGR,
    roles: ['schedule_manager'], active: true, revision: 1
  });
  db._put(ST + '/schedule_state/runtime', { mode: 'off' });
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const identityPaths = new Set([
    ST + '/users/' + MGR,
    ST + '/schedule_access/' + MGR
  ]);
  db._setBeforeRead(async (path, kind) => {
    if (kind === 'document' && identityPaths.has(path)) {
      started.push(path);
      await gate;
    }
  });
  const pending = buildRuntime(db).getStatus(req({}));
  await new Promise((resolve) => setImmediate(resolve));
  eq('0.1 משתמש חי ומינוי מתחילים באותו גל',
    started.slice().sort(), Array.from(identityPaths).sort());
  release();
  eq('0.2 התשובה נשארת זהה אחרי הקריאה המקבילה',
    (await pending).mode, 'off');

  // גם כשהקריאה למינוי נכשלת, משתמש שאינו קיים מקבל את אותה
  // תשובת user-first — בלי חשיפת עצם קיומו של מסמך המינוי.
  db._setBeforeRead(async (path, kind) => {
    if (kind === 'document' && path === ST + '/schedule_access/' + MGR) {
      const error = new Error('access read failed');
      error.code = 'access-read-failed';
      throw error;
    }
  });
  db._del(ST + '/users/' + MGR);
  await rejectsCode('0.3 משתמש חסר אינו לומד שכשל מסמך המינוי',
    () => buildRuntime(db).getStatus(req({})), 'live-user-required');
}

/* ================================================================== */
{
  const db = createFakeDb();
  const { rt } = await seed(db);

  // 1 · שער: לא-מנהל נדחה; חודש/הדבקה פגומים נדחים.
  db._put(ST + '/users/u1', { station_id: SID, station: SID, is_active: true, active: true, role: 'firefighter', full_name: 'x' });
  await rejectsCode('1.1 previewScheduleImport דורש אחראי סידור', () => rt.previewScheduleImport(req({ month: '2026-09', paste: SHEET }, 'u1')), 'manager-required');
  await rejectsCode('1.2 importScheduleSheet דורש אחראי סידור', () => rt.importScheduleSheet(req({ request_id: 'i1', month: '2026-09', paste: SHEET }, 'u1')), 'manager-required');
  await rejectsCode('1.3 חודש פגום', () => rt.previewScheduleImport(req({ month: '9/2026', paste: SHEET })), 'import-month-invalid');
  await rejectsCode('1.4 הדבקה ריקה', () => rt.previewScheduleImport(req({ month: '2026-09', paste: '   ' })), 'import-paste-required');
  await rejectsCode('1.5 חודש שאינו בהדבקה', () => rt.previewScheduleImport(req({ month: '2026-10', paste: SHEET })), 'import-dates-not-found');
  const matrix = SHEET.split('\n').map((line) => line.split('\t'));
  const matrixReport = await rt.previewScheduleImport(req({ month: '2026-09', matrix }));
  eq('1.6 טבלת קובץ עוברת באותו מסלול מפענח', matrixReport.dates, ['2026-09-01', '2026-09-02', '2026-09-03']);
  eq('1.6b ה-fixture התקין אינו מכיל סתירת שיבוץ/היעדרות מקרית',
    matrixReport.counts.assignment_absence_conflicts, 0);
  await rejectsCode('1.7 אי אפשר למסור גם קובץ וגם הדבקה',
    () => rt.previewScheduleImport(req({ month: '2026-09', paste: SHEET, matrix })), 'import-input-required');

  // 2 · דוח לפני ייבוא — בלי כתיבה.
  const before = db._paths(ST + '/schedule_drafts').length;
  const report = await rt.previewScheduleImport(req({ month: '2026-09', paste: SHEET }));
  eq('2.1 תאריכים', report.dates, ['2026-09-01', '2026-09-02', '2026-09-03']);
  eq('2.2 שיבוצים לפני התאמות (בלי „רועי", „גיא" ו„אבטחה")', report.counts.assignments, 14);
  eq('2.3 לפני אישור השמות הקצרים אילת מתחת לקו בכל שלושת הימים', report.counts.below_minimum, 3);
  eq('2.4 היעדרויות: מחלה×2, קורס, באילת', report.counts.absences, 4);
  eq('2.5 שמות קצרים אינם משויכים בשקט', report.unresolved.map((u) => u.name).sort(), ['אבטחה', 'גיא', 'רועי']);
  eq('2.6 מועמדים ל„רועי" עם שמות', report.unresolved.find((u) => u.name === 'רועי').candidates.map((c) => c.uid), ['u1', 'u6', 'ux']);
  eq('2.6b גם שם קצר יחיד דורש אישור', report.unresolved.find((u) => u.name === 'גיא').candidates.map((c) => c.uid), ['u5']);
  eq('2.7 חסום עד התאמה', report.blocked, true);
  ok('2.8 האזור החופשי (משורת השעה) מסומן כמדולג', report.blocks.some((b) => b.kind === 'ignored' && b.rows[0] === 14));
  eq('2.9 preview אינו כותב טיוטה', db._paths(ST + '/schedule_drafts').length, before);
  eq('2.7b בשם: מה חוסם', report.blocked_by, ['unresolved']);
  ok('2.7c חתימת דוח', typeof report.report_digest === 'string' && report.report_digest.length === 64);
  await rejectsCode('2.10 ייבוא כשיש שמות לא מזוהים — נחסם', () => rt.importScheduleSheet(req({ request_id: 'i1', month: '2026-09', paste: SHEET, expected_report_digest: report.report_digest })), 'import-blocked');
  await rejectsCode('2.11 ייבוא בלי חתימת הדוח שהוצג — נדחה', () => rt.importScheduleSheet(req({ request_id: 'i1', month: '2026-09', paste: SHEET })), 'import-report-stale');

  // 3 · התאמת כינויים → ייבוא → טיוטה.
  const aliases = { 'רועי': 'ux', 'גיא': 'u5', 'אבטחה': null };   // null = „זה לא שם" — אחראי הסידור מסמן תא שאינו אדם
  const ready = await rt.previewScheduleImport(req({ month: '2026-09', paste: SHEET, aliases }));
  eq('3.1 אחרי התאמה — אין לא מזוהים', ready.counts.unresolved, 0);
  eq('3.1b אחרי התאמה אין סתירת שיבוץ/היעדרות', ready.counts.assignment_absence_conflicts, 0);
  eq('3.2 ולא חסום', ready.blocked, false);
  // 421-review §5/§7: הדוח שאושר קשור לקלט המדויק — כינוי שהשתנה אחרי „בדוק" נדחה.
  await rejectsCode('3.2b שינוי כינוי אחרי הדוח → import-report-stale', () => rt.importScheduleSheet(req({ request_id: 'i2', month: '2026-09', paste: SHEET, aliases: { 'רועי': 'u6', 'גיא': 'u5', 'אבטחה': null }, expected_report_digest: ready.report_digest })), 'import-report-stale');
  await rejectsCode('3.2c הדבקה שהשתנתה עם אותו דוח → import-report-stale', () => rt.importScheduleSheet(req({ request_id: 'i2', month: '2026-09', paste: SHEET + '\n', aliases, expected_report_digest: ready.report_digest })), 'import-report-stale');
  eq('3.2d לא נוצרה טיוטה מהניסיונות שנדחו', db._paths(ST + '/schedule_drafts').length, before);
  const imported = await rt.importScheduleSheet(req({ request_id: 'i2', month: '2026-09', paste: SHEET, aliases, expected_report_digest: ready.report_digest }));
  eq('3.3 טיוטה נוצרה', [imported.duplicate, typeof imported.draft_id, imported.from, imported.to], [false, 'string', '2026-09-01', '2026-09-03']);
  eq('3.4 סיכום: קו לא חוסם, ימים מתחת לקו נספרים בנפרד', [imported.summary.days_below_minimum, imported.summary.imported_below_minimum, imported.summary.imported_absences], [0, 2, 5]);
  const draft = db._get(ST + '/schedule_drafts/' + imported.draft_id);
  eq('3.5 הטיוטה מסומנת כמיובאת ושלמה', [draft.status, draft.imported, draft.import_month, draft.absence_count], ['complete', true, '2026-09', 5]);
  eq('3.6 הכינויים נשמרו — כולל „לא שם"', db._get(ST + '/schedule_state/sheet_aliases').aliases, { 'רועי': 'ux', 'גיא': 'u5', 'אבטחה': null });
  eq('3.6b תא שסומן „לא שם" נספר כמדולג', ready.counts.skipped, 1);
  // ניסיון חוזר (תשובה שאבדה): אותו request_id ואותו דוח → הדוח **המקורי** מהטיוטה, לא פענוח חדש.
  const again = await rt.importScheduleSheet(req({ request_id: 'i2', month: '2026-09', paste: SHEET, aliases, expected_report_digest: ready.report_digest }));
  eq('3.7 אותו request_id — כפילות, לא טיוטה שנייה', [again.duplicate, again.report.report_digest === ready.report_digest, again.report.counts.assignments], [true, true, ready.counts.assignments]);
  // v2-review §2: כינוי **שאינו בשימוש בגיליון** נוסף למיפוי השמור אחרי הייבוא —
  // ניסיון חוזר של אותה בקשה שהושלמה עדיין מחזיר את הקבלה והדוח המקוריים.
  db._put(ST + '/schedule_state/sheet_aliases', { station_id: SID, aliases: Object.assign({}, db._get(ST + '/schedule_state/sheet_aliases').aliases, { 'unused-alias': 'u2' }) });
  const replay = await rt.importScheduleSheet(req({ request_id: 'i2', month: '2026-09', paste: SHEET, aliases, expected_report_digest: ready.report_digest }));
  eq('3.7b ניסיון חוזר אחרי שינוי כינוי לא קשור — אותה קבלה, אותו דוח', [replay.duplicate, replay.draft_id, replay.report.report_digest], [true, imported.draft_id, ready.report_digest]);
  eq('3.7c ולא נוצרה טיוטה שנייה', db._paths(ST + '/schedule_drafts').filter((k) => k.split('/').length === 4).length, 1);
  // שינוי אמיתי בקלט עם אותו מזהה נשאר סירוב (נבדק גם ב-3.8), ושינוי בכינוי שנשלח — גם.
  await rejectsCode('3.7d אותו מזהה, כינוי שנשלח שונה → request-conflict', () => rt.importScheduleSheet(req({ request_id: 'i2', month: '2026-09', paste: SHEET, aliases: { 'רועי': 'u6', 'גיא': 'u5', 'אבטחה': null }, expected_report_digest: ready.report_digest })), 'request-conflict');
  const memo = await rt.previewScheduleImport(req({ month: '2026-09', paste: SHEET }));
  eq('3.9 כינוי שנשמר משמש בהדבקה הבאה בלי למסור שוב', memo.counts.unresolved, 0);
  // אותו request_id עם קלט אחר (הדוח של הקלט האחר) → סירוב.
  const other = await rt.previewScheduleImport(req({ month: '2026-09', paste: SHEET + '\n' }));
  await rejectsCode('3.8 אותו request_id עם הדבקה אחרת — סירוב', () => rt.importScheduleSheet(req({ request_id: 'i2', month: '2026-09', paste: SHEET + '\n', expected_report_digest: other.report_digest })), 'request-conflict');

  // 421-review §6: המינוי בוטל בין הבדיקות המקדימות לעסקה — הייבוא נדחה
  // **והכינויים לא השתנו** (נשמרים באותה עסקה שמאמתת את המינוי).
  {
    const aliasesBefore = db._get(ST + '/schedule_state/sheet_aliases').aliases;
    const fresh = await rt.previewScheduleImport(req({ month: '2026-09', paste: SHEET, aliases: { 'סיור': null } }));
    const originalTx = db.runTransaction;
    db.runTransaction = async (fn) => {
      db._del(ST + '/schedule_access/' + MGR);   // ביטול מינוי רגע לפני העסקה
      return originalTx.call(db, fn);
    };
    await rejectsCode('3.11 מינוי שבוטל לפני העסקה → manager-revoked', () => rt.importScheduleSheet(req({ request_id: 'i3', month: '2026-09', paste: SHEET, aliases: { 'סיור': null }, expected_report_digest: fresh.report_digest })), 'manager-revoked');
    db.runTransaction = originalTx;
    eq('3.12 הכינויים לא השתנו', db._get(ST + '/schedule_state/sheet_aliases').aliases, aliasesBefore);
    eq('3.13 לא נוצרה טיוטה', db._paths(ST + '/schedule_drafts').filter((k) => k.split('/').length === 4).length, 1);
    db._put(ST + '/schedule_access/' + MGR, { schema_version: 1, station_id: SID, uid: MGR, roles: ['schedule_manager'], active: true, revision: 1 });
    // עדכון מקביל של הכינויים בין הקריאה לעסקה — מתמזג, לא נדרס.
    db.runTransaction = async (fn) => {
      db._put(ST + '/schedule_state/sheet_aliases', { station_id: SID, aliases: Object.assign({}, db._get(ST + '/schedule_state/sheet_aliases').aliases, { 'מקביל': 'u2' }) });
      return originalTx.call(db, fn);
    };
    const merged = await rt.importScheduleSheet(req({ request_id: 'i3', month: '2026-09', paste: SHEET, aliases: { 'סיור': null }, expected_report_digest: fresh.report_digest }));
    db.runTransaction = originalTx;
    eq('3.14 כינוי שנכתב במקביל נשמר לצד החדש', [merged.duplicate, db._get(ST + '/schedule_state/sheet_aliases').aliases['מקביל'], db._get(ST + '/schedule_state/sheet_aliases').aliases['סיור']], [false, 'u2', null]);
  }

  // 4 · תצוגה מקדימה של הטיוטה — השבלונה.
  // תמונה מלאה: rows/events/absences/people אינם תלויים זה בזה ולכן
  // ארבע הקריאות חייבות להתחיל יחד. כך נחסך round trip בלי לשנות
  // את מספר הקריאות, הספירות או חתימת התוכן.
  const snapshotBase = ST + '/schedule_drafts/' + imported.draft_id;
  const snapshotPaths = new Set(['rows', 'events', 'absences', 'people']
    .map((name) => snapshotBase + '/' + name));
  const snapshotStarted = [];
  let releaseSnapshot;
  const snapshotGate = new Promise((resolve) => { releaseSnapshot = resolve; });
  db._setBeforeRead(async (path, kind) => {
    if (kind === 'query' && snapshotPaths.has(path)) {
      snapshotStarted.push(path);
      await snapshotGate;
    }
  });
  const previewPending = rt.getDraftPreview(req({ draft_id: imported.draft_id, start: '2026-09-01' }));
  await new Promise((resolve) => setImmediate(resolve));
  eq('4.0 ארבעת חלקי התמונה המלאה מתחילים באותו גל',
    snapshotStarted.slice().sort(), Array.from(snapshotPaths).sort());
  releaseSnapshot();
  const preview = await previewPending;
  db._setBeforeRead(null);
  eq('4.1 מיובא', preview.imported, true);
  const d1 = preview.days[0];
  eq('4.2 שורות = ארבע התחנות מהמדיניות, בסדר', d1.sub_stations.map((s) => s.sub_station), ['eilat', 'shahmon', 'timna', 'yotvata']);
  eq('4.3 אילת 1.9: 7 אנשים, קו 7, לא מתחת', [d1.sub_stations[0].people.length, d1.sub_stations[0].minimum, d1.sub_stations[0].below_minimum], [7, 7, false]);
  const d2 = preview.days[1];
  eq('4.4 אילת 2.9: 3 אנשים מתחת לקו', [d2.sub_stations[0].people.length, d2.sub_stations[0].below_minimum], [3, true]);
  eq('4.5 צוות לאדם מהסגל הישן, בסדר הגיליון (רועי, דניאל, ליאור, גיא, אורי, נועם, עמית)', d1.sub_stations[0].people.map((p) => p.uid + ':' + p.crew), ['u1:A', 'u2:A', 'u9:A', 'u5:A', 'u8:C', 'u7:B', 'u4:C']);
  eq('4.6 צוות היום מהמחזור (1.9=A, 2.9=B, 3.9=C)', preview.days.map((d) => d.crew), ['A', 'B', 'C']);
  eq('4.7 היעדרויות 1.9: מחלה + „רועי"→ux בצפון', d1.absences.map((a) => [a.uid, a.kind, a.location || null]), [['u6', 'sick', null], ['ux', 'leave', 'north']]);
  eq('4.8 היעדרויות 3.9: באילת', preview.days[2].absences.map((a) => [a.uid, a.kind, a.location, a.display]), [['u1', 'leave', 'eilat', 'רועי כהן']]);
  eq('4.9 סטטוס', d1.absences_status, 'ready');
  eq('4.10 שיבוץ מיובא אינו „אוטומטי” — אין role', d1.sub_stations[0].people[0].role_label, null);

  // 4.11 · הצגת הייבוא בלוח כשהמנוע כבוי. זוהי בחירת תצוגה בלבד:
  // אין פרסום, אין outbox, והקוראים התפעוליים נשארים על legacy.
  const fullReady = await rt.previewScheduleImport(req({
    month: '2026-09', paste: FULL_MONTH_SHEET, aliases
  }));
  const displayImported = await rt.importScheduleSheet(req({
    request_id: 'i_display_full_month', month: '2026-09', paste: FULL_MONTH_SHEET,
    aliases, expected_report_digest: fullReady.report_digest
  }));
  const cfgBeforeDisplay = db._get(ST + '/schedule_state/runtime');
  db._put(ST + '/schedule_state/runtime', Object.assign({}, cfgBeforeDisplay, { mode: 'off' }));
  const emptyDisplay = await rt.getScheduleDisplayStatus(req({ month: '2026-09' }));
  eq('4.11 לפני בחירה אין תצוגת ייבוא', [emptyDisplay.enabled, emptyDisplay.generation], [false, 0]);
  await rejectsCode('4.12 חבר שאינו אחראי אינו יכול לבחור תצוגה', () => rt.setScheduleDisplay(req({
    action: 'show', month: '2026-09', request_id: 'disp_denied', expected_generation: 0,
    draft_id: displayImported.draft_id, expected_content_digest: displayImported.content_digest
  }, 'u1')), 'manager-required');
  const showInput = {
    action: 'show', month: '2026-09', request_id: 'disp_show', expected_generation: 0,
    draft_id: displayImported.draft_id, expected_content_digest: displayImported.content_digest
  };
  const shown = await rt.setScheduleDisplay(req(showInput));
  eq('4.13 הטיוטה נבחרה לתצוגה בלי שינוי מצב',
    [shown.enabled, shown.generation, db._get(ST + '/schedule_state/runtime').mode],
    [true, 1, 'off']);
  eq('4.14 אין פרסום ואין הודעות', [
    db._paths(ST + '/schedule_publications').length,
    db._paths(ST + '/schedule_outbox').length
  ], [0, 0]);
  // כוננות מוסיפה צוות עובדים, אך אינה מחליפה את משמרת היממה בכותרת.
  db._put(ST + '/shift_overrides/2026-09-01', {
    date: '2026-09-01', kind: 'standby', extra_crews: ['B']
  });
  const offBoard = await rt.getStationRange(req({
    from: '2026-09-01', to: '2026-09-03', display_imported: true
  }, 'u2'));
  eq('4.15 במצב off הלוח מציג את ארבע התחנות מהקובץ',
    [offBoard.mode, offBoard.source, offBoard.display_only,
      offBoard.days[0].sub_stations.map((s) => s.sub_station)],
    ['off', 'imported-display', true, ['eilat', 'shahmon', 'timna', 'yotvata']]);
  eq('4.16 סדר השמות באילת נשמר בדיוק מסדר הגיליון',
    offBoard.days[0].sub_stations[0].people.map((p) => p.uid),
    ['u1', 'u2', 'u9', 'u5', 'u8', 'u7', 'u4']);
  eq('4.17 קו 7 והיעדרויות נשמרו בתצוגת off', [
    offBoard.days[0].sub_stations[0].minimum,
    offBoard.days[0].absences.map((a) => a.uid + ':' + a.kind)
  ], [7, ['u6:sick', 'ux:leave']]);
  eq('4.17b standby אינו מוחק את משמרת היממה מהכותרת',
    offBoard.days.map((day) => day.crew), ['A', 'B', 'C']);
  db._del(ST + '/shift_overrides/2026-09-01');

  // הטיוטה ננעלת לחוקי התחנה ולמקור כוח האדם שהיו פעילים בעת הייבוא.
  // שינוי לפני הקריאה נעצר מיד, ושינוי בזמן הקריאה נעצר באימות הסופי.
  const liveDisplayConfig = db._get(ST + '/schedule_state/runtime');
  db._put(ST + '/schedule_state/runtime', Object.assign({}, liveDisplayConfig, {
    active_policy_id: 'policy_replaced'
  }));
  await rejectsCode('4.18 מקור/מדיניות שהוחלפו לפני הקריאה עוצרים תצוגה ישנה', () =>
    rt.getStationRange(req({
      from: '2026-09-01', to: '2026-09-03', display_imported: true
    }, 'u2')), 'display-draft-stale');
  db._put(ST + '/schedule_state/runtime', liveDisplayConfig);

  let configRaceFired = false;
  const racingDisplayRuntime = buildRuntime(db, {
    beforeLiveGuardViewRecheck: async ({ kind }) => {
      if (configRaceFired || kind !== 'imported-display') return;
      configRaceFired = true;
      db._put(ST + '/schedule_state/runtime', Object.assign({}, liveDisplayConfig, {
        active_source_id: 'source_replaced'
      }));
    }
  });
  await rejectsCode('4.19 מקור/מדיניות שהוחלפו בזמן הקריאה עוצרים את התשובה', () =>
    racingDisplayRuntime.getStationRange(req({
      from: '2026-09-01', to: '2026-09-03', display_imported: true
    }, 'u2')), 'display-config-changed');
  eq('4.20 מחסום מרוץ התצוגה הופעל', configRaceFired, true);
  db._put(ST + '/schedule_state/runtime', liveDisplayConfig);

  const rotationPath = ST + '/rotations/A';
  const stableRotation = db._get(rotationPath);
  let rotationRaceFired = false;
  const rotationRaceRuntime = buildRuntime(db, {
    beforeLiveGuardViewRecheck: async ({ kind }) => {
      if (rotationRaceFired || kind !== 'imported-display') return;
      rotationRaceFired = true;
      db._put(rotationPath, Object.assign({}, stableRotation, { anchor_date: '2026-09-02' }));
    }
  });
  await rejectsCode('4.20b שינוי מחזור בזמן עיטור הלוח עוצר תשובה מעורבבת', () =>
    rotationRaceRuntime.getStationRange(req({
      from: '2026-09-01', to: '2026-09-03', display_imported: true
    }, 'u2')), 'legacy-schedule-changed');
  eq('4.20c מחסום מרוץ המחזור הופעל', rotationRaceFired, true);
  db._put(rotationPath, stableRotation);

  const overridePath = ST + '/shift_overrides/2026-09-02';
  let overrideRaceFired = false;
  const overrideRaceRuntime = buildRuntime(db, {
    beforeLiveGuardViewRecheck: async ({ kind }) => {
      if (overrideRaceFired || kind !== 'imported-display') return;
      overrideRaceFired = true;
      db._put(overridePath, { date: '2026-09-02', kind: 'swap', crew: 'C' });
    }
  });
  await rejectsCode('4.20d שינוי חריג בזמן עיטור הלוח עוצר תשובה מעורבבת', () =>
    overrideRaceRuntime.getStationRange(req({
      from: '2026-09-01', to: '2026-09-03', display_imported: true
    }, 'u2')), 'legacy-schedule-changed');
  eq('4.20e מחסום מרוץ החריג הופעל', overrideRaceFired, true);
  db._del(overridePath);

  // החלפת עובדים מאושרת שייכת לסידור האישי, אך אינה מחליפה
  // את צוות היממה. לכן היא לא נכנסת לחתימת עיטור הלוח.
  const swapPath = ST + '/swaps/approved_display_irrelevant';
  let swapRaceFired = false;
  const swapRaceRuntime = buildRuntime(db, {
    beforeLiveGuardViewRecheck: async ({ kind }) => {
      if (swapRaceFired || kind !== 'imported-display') return;
      swapRaceFired = true;
      db._put(swapPath, {
        status: 'approved', from_uid: 'u1', to_uid: 'u3',
        from_date: '2026-09-01', to_date: '2026-09-02'
      });
    }
  });
  const swapIndependentBoard = await swapRaceRuntime.getStationRange(req({
    from: '2026-09-01', to: '2026-09-03', display_imported: true
  }, 'u2'));
  eq('4.20f החלפה מאושרת אינה חוסמת/משנה את צוות היממה', [
    swapRaceFired, swapIndependentBoard.days.map((day) => day.crew)
  ], [true, ['A', 'B', 'C']]);
  db._del(swapPath);

  const duplicateShow = await rt.setScheduleDisplay(req(showInput));
  eq('4.21 ניסיון חוזר אינו מעלה דור ואינו יוצר פעולה שנייה',
    [duplicateShow.duplicate, duplicateShow.generation,
      db._paths(ST + '/schedule_audit/display_').length], [true, 1, 1]);

  // קבלה חתומה של פעולה שהושלמה קודמת לכל מצב מאוחר של הטיוטה/המנוע.
  // כך תשובה שאבדה ברשת ניתנת לשחזור גם אחרי ניקוי הטיוטה, בלי לבצע שוב.
  const displayDraftPath = ST + '/schedule_drafts/' + displayImported.draft_id;
  const displayDraftMeta = db._get(displayDraftPath);
  db._del(displayDraftPath);
  db._put(ST + '/schedule_state/runtime', Object.assign({}, liveDisplayConfig, { mode: 'new' }));
  const cleanupReplay = await rt.setScheduleDisplay(req(showInput));
  eq('4.22 retry זהה אחרי ניקוי טיוטה ושינוי מצב מחזיר את הקבלה',
    [cleanupReplay.duplicate, cleanupReplay.generation, cleanupReplay.enabled],
    [true, 1, true]);
  await rejectsCode('4.23 אותו request_id עם payload אחר נדחה לפני מצב/טיוטה', () =>
    rt.setScheduleDisplay(req(Object.assign({}, showInput, {
      expected_content_digest: '0'.repeat(64)
    }))), 'request-conflict');
  db._put(displayDraftPath, displayDraftMeta);
  db._put(ST + '/schedule_state/runtime', liveDisplayConfig);

  await rejectsCode('4.24 CAS ישן נדחה', () => rt.setScheduleDisplay(req(Object.assign({}, showInput, {
    request_id: 'disp_stale', expected_generation: 0
  }))), 'display-generation-conflict');
  const cleared = await rt.setScheduleDisplay(req({
    action: 'clear', month: '2026-09', request_id: 'disp_clear', expected_generation: 1
  }));
  eq('4.25 הסרה מחזירה את לוח legacy ואינה מוחקת את הטיוטה',
    [cleared.enabled, cleared.generation,
      (await rt.getStationRange(req({
        from: '2026-09-01', to: '2026-09-03', display_imported: true
      }, 'u2'))).source,
      !!db._get(ST + '/schedule_drafts/' + displayImported.draft_id)],
    [false, 2, 'legacy', true]);

  // ארבעת מסלולי ה-legacy הישירים: טווח+יום ב-off ואותם
  // שניים כ-fallback ב-new ללא פרסום. כוננות B על יום A היא
  // הרגרסיה: הקוד הישן ראה שני צוותים ברשימה והחזיר null.
  db._put(ST + '/shift_overrides/2026-09-01', {
    date: '2026-09-01', kind: 'standby', extra_crews: ['B']
  });
  const directLegacyRange = await rt.getStationRange(req({
    from: '2026-09-01', to: '2026-09-03'
  }, 'u2'));
  eq('4.26 off · טווח: כוננות אינה מוחקת את צוות היממה',
    [directLegacyRange.source, directLegacyRange.days.map((day) => day.crew)],
    ['legacy', ['A', 'B', 'C']]);
  const directLegacyDay = await rt.getStation(req({ date: '2026-09-02' }, 'u2'));
  eq('4.27 off · יום: שכני היום נשארים A/B/C מהמחזור', [
    directLegacyDay.previous_day.crew, directLegacyDay.day.crew,
    directLegacyDay.next_day.crew
  ], ['A', 'B', 'C']);

  const offRuntime = db._get(ST + '/schedule_state/runtime');
  db._put(ST + '/schedule_state/runtime', Object.assign({}, offRuntime, { mode: 'new' }));
  const fallbackRange = await rt.getStationRange(req({
    from: '2026-09-01', to: '2026-09-03'
  }, 'u2'));
  eq('4.28 new fallback · טווח: אותה משמרת יממתית', [
    fallbackRange.source, fallbackRange.fallback,
    fallbackRange.days.map((day) => day.crew)
  ], ['legacy', 'legacy', ['A', 'B', 'C']]);
  const fallbackDay = await rt.getStation(req({ date: '2026-09-02' }, 'u2'));
  eq('4.29 new fallback · יום: אותו A/B/C', [
    fallbackDay.fallback, fallbackDay.previous_day.crew, fallbackDay.day.crew,
    fallbackDay.next_day.crew
  ], ['legacy', 'A', 'B', 'C']);
  db._put(ST + '/schedule_state/runtime', offRuntime);
  db._del(ST + '/shift_overrides/2026-09-01');

  // המפענח התאימותי מדווח על שורות legacy פגומות כ-warning.
  // בתצוגה אסור לדלג עליהן ולהציג בשקט את צוות הבסיס.
  db._put(ST + '/shift_overrides/2026-09-02', {
    date: '2026-09-02', kind: 'swap', crew: 'D'
  });
  await rejectsCode('4.30 swap עם צוות פגום נכשל סגור', () => rt.getStationRange(req({
    from: '2026-09-01', to: '2026-09-03'
  }, 'u2')), 'effective-schedule-invalid');
  db._put(ST + '/shift_overrides/2026-09-02', {
    date: '2026-09-03', kind: 'swap', crew: 'C'
  });
  await rejectsCode('4.31 תאריך חריג סותר נכשל סגור', () => rt.getStationRange(req({
    from: '2026-09-01', to: '2026-09-03'
  }, 'u2')), 'legacy-override-date');
  db._del(ST + '/shift_overrides/2026-09-02');

  // החתימה הייעודית נבדקת אחרונה: שינוי מחזור/חריג בזמן
  // הקריאה נעצר, אך החלפה מאושרת שאינה קובעת צוות יממה לא נכנסת לה.
  const directRotationPath = ST + '/rotations/A';
  const directRotation = db._get(directRotationPath);
  let directRotationRace = false;
  const directRotationRuntime = buildRuntime(db, {
    beforeEffectiveViewRecheck: async ({ kind }) => {
      if (directRotationRace || kind !== 'legacy') return;
      directRotationRace = true;
      db._put(directRotationPath, Object.assign({}, directRotation, { anchor_date: '2026-09-02' }));
    }
  });
  await rejectsCode('4.32 שינוי מחזור במסלול legacy הישיר נעצר בסוף', () =>
    directRotationRuntime.getStationRange(req({
      from: '2026-09-01', to: '2026-09-03'
    }, 'u2')), 'legacy-schedule-changed');
  db._put(directRotationPath, directRotation);

  let modeRace = false;
  const modeRaceRuntime = buildRuntime(db, {
    beforeLiveGuardViewRecheck: async ({ kind }) => {
      if (modeRace || kind !== 'legacy-display') return;
      modeRace = true;
      db._put(ST + '/schedule_state/runtime', Object.assign({}, offRuntime, { mode: 'shadow' }));
    }
  });
  await rejectsCode('4.33 מצב שהשתנה אחרי אימות בסיס התצוגה אינו מוחזר', () =>
    modeRaceRuntime.getStation(req({ date: '2026-09-02' }, 'u2')), 'schedule-mode-changed');
  db._put(ST + '/schedule_state/runtime', offRuntime);

  db._put(ST + '/schedule_state/runtime', Object.assign({}, offRuntime, { mode: 'new' }));
  let pointerRace = false;
  const pointerRaceRuntime = buildRuntime(db, {
    beforeLiveGuardViewRecheck: async ({ kind }) => {
      if (pointerRace || kind !== 'legacy-display') return;
      pointerRace = true;
      db._put(ST + '/schedule_state/active', { publication_id: 'entered_during_read' });
    }
  });
  await rejectsCode('4.34 פרסום שנכנס אחרי אימות בסיס ה-fallback אינו מוסתר', () =>
    pointerRaceRuntime.getStationRange(req({
      from: '2026-09-01', to: '2026-09-03'
    }, 'u2')), 'schedule-mode-changed');
  db._del(ST + '/schedule_state/active');
  db._put(ST + '/schedule_state/runtime', offRuntime);

  // 5 · פרסום — אותו מסלול. כאן עוברים ל-new לפני הפרסום כדי לבדוק את
  // הלוח החי; מצביע תצוגת off אינו חלק מהמעבר ואינו משפיע עליו.
  const cfg = db._get(ST + '/schedule_state/runtime');
  db._put(ST + '/schedule_state/runtime', { mode: 'new', active_policy_id: cfg.active_policy_id, active_source_id: cfg.active_source_id });
  const published = await rt.publish(req({ request_id: 'pub1', draft_id: imported.draft_id, expected_content_digest: preview.expected_content_digest }));
  ok('5.1 פורסם', published && published.publication_id, JSON.stringify(published));
  const pub = db._get(ST + '/schedule_publications/' + published.publication_id);
  eq('5.2 הפרסום נושא imported + absence_count', [pub.imported, pub.absence_count], [true, 5]);
  const range = await rt.getStationRange(req({ from: '2026-09-01', to: '2026-09-03' }, 'u2'));
  eq('5.3 מקור v2, מיובא', [range.source, range.imported], ['v2', true]);
  eq('5.4 שורות תחנה + היעדרויות + צוות יום', [range.days[0].sub_stations.length, range.days[0].absences.length, range.days.map((d) => d.crew)], [4, 2, ['A', 'B', 'C']]);
  eq('5.5 היעדרויות לכל יום מהפרסום', range.days.map((d) => d.absences.map((a) => a.uid + ':' + a.kind)), [['u6:sick', 'ux:leave'], ['u8:sick', 'u9:course'], ['u1:leave']]);
  const mine = await rt.getStationRange(req({ from: '2026-09-03', to: '2026-09-03' }, 'u1'));
  eq('5.6 is_me — הצופה בחופש באילת', (mine.days[0].absences[0] || {}).is_me, true);
  const single = await rt.getStation(req({ date: '2026-09-02' }, 'u2'));
  eq('5.7 getStation — אותו עיטור ליום ולשכניו', [single.day.crew, single.previous_day.crew, single.day.absences.length, single.day.absences_status], ['B', 'A', 2, 'ready']);
  const work = await rt.getEffectiveWorkdays(req({ from: '2026-09-01', to: '2026-09-03', uids: ['u1', 'u3', 'u5'] }, 'u2'));
  eq('5.8 מי עובד — מהפרסום המיובא', [work.source, work.by_uid.u1, work.by_uid.u3, work.by_uid.u5], ['publication', ['2026-09-01'], ['2026-09-01', '2026-09-02', '2026-09-03'], ['2026-09-01', '2026-09-02', '2026-09-03']]);
  // הפרסום נקרא שוב עם החתימה — היעדרויות בתוכה.
  db._put(ST + '/schedule_publications/' + published.publication_id + '/absences/' + db._paths(ST + '/schedule_publications/' + published.publication_id + '/absences/')[0].split('/').pop(), { date: '2026-09-01', entries: [] });
  await rejectsCode('5.9 היעדרות שנמחקה מהתמונה החתומה — הפרסום נעצר (digest)', () => rt.getStationRange(req({ from: '2026-09-01', to: '2026-09-03' }, 'u2')), 'snapshot-count-mismatch');
}

/* 6a · מעטפת XLSX: גבולות התאים הממוזגים עוברים דרך ה-runtime,
 * נכללים בחתימת הכוונה ומשנים בפועל את גבול בלוק התחנה. */
{
  const db = createFakeDb();
  const { rt } = await seed(db);
  const matrix = SHEET.split('\n').map((line) => line.split('\t'));
  const aliases = { 'רועי': 'ux', 'גיא': 'u5', 'אבטחה': null };
  const accept = { ignored_blocks: true };
  const spans = [{ column: 0, start_row: 11, end_row: 11 }];
  const report = await rt.previewScheduleImport(req({
    month: '2026-09', matrix, label_spans: spans, aliases, accept
  }));
  const yotvata = report.blocks.find((block) => block.sub_station === 'yotvata');
  const ignored = report.blocks.find((block) => block.kind === 'ignored' && block.rows[0] === 13);
  eq('6a.1 label_spans מהקובץ קובע את הגבול המדויק של יטבתה',
    [yotvata.rows, ignored && ignored.rows], [[12, 12], [13, 14]]);
  eq('6a.2 ה-envelope התקין נקי מסתירות ומוכן אחרי אישור האזור החופשי',
    [report.counts.assignment_absence_conflicts, report.blocked], [0, false]);
  const imported = await rt.importScheduleSheet(req({
    request_id: 'matrix_spans_1', month: '2026-09', matrix, label_spans: spans,
    aliases, accept, expected_report_digest: report.report_digest
  }));
  eq('6a.3 ייבוא matrix עם label_spans יוצר טיוטה חתומה',
    [imported.duplicate, imported.from, imported.to], [false, '2026-09-01', '2026-09-03']);
  const changedSpans = [{ column: 0, start_row: 11, end_row: 12 }];
  const changed = await rt.previewScheduleImport(req({
    month: '2026-09', matrix, label_spans: changedSpans, aliases, accept
  }));
  await rejectsCode('6a.4 שינוי label_spans עם אותו request_id הוא payload אחר', () =>
    rt.importScheduleSheet(req({
      request_id: 'matrix_spans_1', month: '2026-09', matrix,
      label_spans: changedSpans, aliases, accept,
      expected_report_digest: changed.report_digest
    })), 'request-conflict');
  await rejectsCode('6a.5 label_spans אינו מתקבל לצד paste', () =>
    rt.previewScheduleImport(req({
      month: '2026-09', paste: SHEET, label_spans: spans
    })), 'import-label-spans-invalid');
}

/* 6b · אדם שמופיע גם בתחנה וגם בהיעדרות באותו יום: הדוח מחזיר
 * את האדם/היום/התחנה/סוג ההיעדרות, והייבוא נחסם בלי לכתוב טיוטה. */
{
  const db = createFakeDb();
  const { rt } = await seed(db);
  const report = await rt.previewScheduleImport(req({
    month: '2026-09', paste: CONFLICT_SHEET
  }));
  eq('6b.1 הסתירה מפורטת בדוח ולא מוכרעת בשקט',
    report.assignment_absence_conflicts, [{
      uid: 'u1', name: 'רועי כהן', date: '2026-09-01',
      stations: ['eilat'], absences: [{ kind: 'sick', location: null }]
    }]);
  eq('6b.2 הסתירה היא החסם היחיד',
    [report.counts.assignment_absence_conflicts, report.blocked, report.blocked_by],
    [1, true, ['assignment-absence-conflicts']]);
  const before = db._paths(ST + '/schedule_drafts').length;
  await rejectsCode('6b.3 גם עם חתימת הדוח הייבוא הסותר נחסם', () =>
    rt.importScheduleSheet(req({
      request_id: 'conflict_1', month: '2026-09', paste: CONFLICT_SHEET,
      expected_report_digest: report.report_digest
    })), 'import-blocked');
  eq('6b.4 חסימת הסתירה אינה כותבת טיוטה',
    db._paths(ST + '/schedule_drafts').length, before);
}

/* 7 · v2-review §1: המינוי בוטל והמשתמש הושבת **בזמן** קריאת ההיעדרויות של
 * הטיוטה — התשובה חייבת להיות סירוב, בלי שמות ובלי היעדרויות. אותו דבר
 * לניסיון חוזר של ייבוא ולדוח ההדבקה (שניהם מחזירים שמות). */
{
  const db = createFakeDb();
  const { rt } = await seed(db);
  const aliases = { 'רועי': 'ux', 'גיא': 'u5', 'אבטחה': null };
  const ready = await rt.previewScheduleImport(req({ month: '2026-09', paste: SHEET, aliases }));
  const imported = await rt.importScheduleSheet(req({ request_id: 'i7', month: '2026-09', paste: SHEET, aliases, expected_report_digest: ready.report_digest }));
  let fired = 0;
  const revoke = () => {
    fired += 1;
    db._del(ST + '/schedule_access/' + MGR);
    db._put(ST + '/users/' + MGR, { station_id: SID, station: SID, is_active: false, active: false, role: 'firefighter' });
  };
  const restore = () => {
    db._put(ST + '/schedule_access/' + MGR, { schema_version: 1, station_id: SID, uid: MGR, roles: ['schedule_manager'], active: true, revision: 1 });
    db._put(ST + '/users/' + MGR, { station_id: SID, station: SID, is_active: true, active: true, role: 'firefighter', full_name: 'מ' });
  };
  // הביטול נורה בסיום הקריאה הראשונה של הנתיב הנתון (אחרי שהקריאה כבר החזירה נתונים).
  function armOnRead(pathSuffix) {
    const original = db.collection;
    let armed = true;
    const wrap = (obj) => new Proxy(obj, { get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      if (key === 'get') return async (...args) => {
        const result = await value.apply(target, args);
        if (armed && String(target.path || '').endsWith(pathSuffix)) { armed = false; revoke(); }
        return result;
      };
      if (['collection', 'doc', 'where', 'limit', 'orderBy'].includes(key)) return (...args) => wrap(value.apply(target, args));
      return value.bind(target);
    } });
    db.collection = (...args) => wrap(original.apply(db, args));
    return () => { db.collection = original; };
  }
  let disarm = armOnRead('/schedule_drafts/' + imported.draft_id + '/absences');
  await rejectsCode('7.1 ביטול מינוי בזמן קריאת ההיעדרויות → סירוב, לא טיוטה עם שמות', () => rt.getDraftPreview(req({ draft_id: imported.draft_id, start: '2026-09-01' })), 'manager-revoked');
  disarm();
  eq('7.1b ההוק אכן נורה באמצע הקריאה', fired, 1);
  restore();
  const okPreview = await rt.getDraftPreview(req({ draft_id: imported.draft_id, start: '2026-09-01' }));
  eq('7.1c אחרי שחזור המינוי — הטיוטה נקראת', okPreview.days.reduce((n, d) => n + d.absences.length, 0), 5);
  // ניסיון חוזר של ייבוא שהושלם: המינוי בוטל בזמן קריאת הטיוטה הקיימת → סירוב, לא הדוח.
  disarm = armOnRead('/schedule_drafts/' + imported.draft_id);
  await rejectsCode('7.2 ניסיון חוזר בזמן ביטול מינוי → סירוב', () => rt.importScheduleSheet(req({ request_id: 'i7', month: '2026-09', paste: SHEET, aliases, expected_report_digest: ready.report_digest })), 'manager-revoked');
  disarm();
  eq('7.2b ההוק נורה', fired, 2);
  restore();
  // דוח ההדבקה: המינוי בוטל בזמן קריאת המיפוי השמור → סירוב, בלי רשימת אנשים.
  disarm = armOnRead('/schedule_state/sheet_aliases');
  await rejectsCode('7.3 דוח הדבקה בזמן ביטול מינוי → סירוב', () => rt.previewScheduleImport(req({ month: '2026-09', paste: SHEET })), 'manager-revoked');
  disarm();
  eq('7.3b ההוק נורה', fired, 3);
  restore();
  eq('7.4 אחרי שחזור — הדוח חוזר', (await rt.previewScheduleImport(req({ month: '2026-09', paste: SHEET }))).counts.unresolved, 0);
}

/* 8 · final-review §1: הקורא (חבר תחנה רגיל, לא אחראי סידור) הושבת **בזמן**
 * קריאת ההיעדרויות של הפרסום — getStationRange/getStation מסרבים בלי שמות;
 * חבר פעיל ממשיך לקרוא. */
{
  const db = createFakeDb();
  const { rt } = await seed(db);
  const aliases = { 'רועי': 'ux', 'גיא': 'u5', 'אבטחה': null };
  const ready = await rt.previewScheduleImport(req({ month: '2026-09', paste: SHEET, aliases }));
  const imported = await rt.importScheduleSheet(req({ request_id: 'i8', month: '2026-09', paste: SHEET, aliases, expected_report_digest: ready.report_digest }));
  const preview = await rt.getDraftPreview(req({ draft_id: imported.draft_id, start: '2026-09-01' }));
  const cfg = db._get(ST + '/schedule_state/runtime');
  db._put(ST + '/schedule_state/runtime', { mode: 'new', active_policy_id: cfg.active_policy_id, active_source_id: cfg.active_source_id });
  const published = await rt.publish(req({ request_id: 'pub8', draft_id: imported.draft_id, expected_content_digest: preview.expected_content_digest }));
  const absPath = ST + '/schedule_publications/' + published.publication_id + '/absences';
  let fired = 0;
  const disableViewer = () => { fired += 1; db._put(ST + '/users/u2', { station_id: SID, station: SID, is_active: false, active: false, role: 'firefighter', full_name: 'דניאל לוי' }); };
  const restoreViewer = () => db._put(ST + '/users/u2', { station_id: SID, station: SID, is_active: true, active: true, role: 'firefighter', full_name: 'דניאל לוי' });
  function armOnRead(pathSuffix, action) {
    const original = db.collection;
    let armed = true;
    const wrap = (obj) => new Proxy(obj, { get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      if (key === 'get') return async (...args) => {
        const result = await value.apply(target, args);
        if (armed && String(target.path || '').endsWith(pathSuffix)) { armed = false; action(); }
        return result;
      };
      if (['collection', 'doc', 'where', 'limit', 'orderBy'].includes(key)) return (...args) => wrap(value.apply(target, args));
      return value.bind(target);
    } });
    db.collection = (...args) => wrap(original.apply(db, args));
    return () => { db.collection = original; };
  }
  let disarm = armOnRead(absPath, disableViewer);
  await rejectsCode('8.1 getStationRange: הקורא הושבת בזמן קריאת ההיעדרויות → סירוב', () => rt.getStationRange(req({ from: '2026-09-01', to: '2026-09-03' }, 'u2')), 'board-viewer-changed');
  disarm();
  eq('8.1b ההוק נורה', fired, 1);
  restoreViewer();
  disarm = armOnRead(absPath, disableViewer);
  await rejectsCode('8.2 getStation: אותו מרוץ → סירוב', () => rt.getStation(req({ date: '2026-09-02' }, 'u2')), 'board-viewer-changed');
  disarm();
  eq('8.2b ההוק נורה', fired, 2);
  restoreViewer();
  // העברה לתחנה אחרת בזמן העיטור (קריאת הסגל) — גם סירוב.
  disarm = armOnRead(ST + '/roster', () => { fired += 1; db._put(ST + '/users/u2', { station_id: 'other', station: 'other', is_active: true, active: true, role: 'firefighter' }); });
  await rejectsCode('8.3 getStationRange: הקורא הועבר תחנה בזמן קריאת הסגל → סירוב', () => rt.getStationRange(req({ from: '2026-09-01', to: '2026-09-03' }, 'u2')), 'board-viewer-changed');
  disarm();
  restoreViewer();
  const fine = await rt.getStationRange(req({ from: '2026-09-01', to: '2026-09-03' }, 'u2'));
  eq('8.4 חבר פעיל — הלוח נקרא, עם היעדרויות', [fine.source, fine.days.reduce((n, d) => n + d.absences.length, 0)], ['v2', 5]);
  const one = await rt.getStation(req({ date: '2026-09-02' }, 'u2'));
  eq('8.5 getStation לחבר פעיל', [one.day.crew, one.day.absences.length], ['B', 2]);
  // המצביע זז בזמן העיטור — עדיין נתפס אחרי הקריאה האחרונה.
  disarm = armOnRead(ST + '/roster', () => db._put(ST + '/schedule_state/active', Object.assign({}, db._get(ST + '/schedule_state/active'), { revision: 99 })));
  await rejectsCode('8.6 המצביע השתנה בזמן קריאת הסגל → schedule-active-changed', () => rt.getStationRange(req({ from: '2026-09-01', to: '2026-09-03' }, 'u2')), 'schedule-active-changed');
  disarm();
}

/* 6 · פרסום קודם (בלי היעדרויות) נשאר תקף — החתימה אינה משתנה לו. */
{
  const db = createFakeDb();
  const { rt } = await seed(db);
  const sheet = [row(['', '1/9', '2/9', '3/9']), row(['', 'ג', 'ד', 'ה']),
    row(['אילת', 'רועי כהן', 'רועי כהן', 'רועי כהן']), row(['שחמון', '', '', ''])].join('\n');
  const first = await rt.previewScheduleImport(req({ month: '2026-09', paste: sheet }));
  eq('6.0 תחנות חסרות בהדבקה — חוסמות עד אישור מפורש (חסר ≠ ריק)', [first.blocked, first.blocked_by, first.missing_stations.map((m) => m.sub_station)], [true, ['missing-stations'], ['timna', 'yotvata']]);
  await rejectsCode('6.0b ייבוא בלי אישור — נחסם', () => rt.importScheduleSheet(req({ request_id: 'i9', month: '2026-09', paste: sheet, expected_report_digest: first.report_digest })), 'import-blocked');
  const accepted = await rt.previewScheduleImport(req({ month: '2026-09', paste: sheet, accept: { missing_stations: true } }));
  eq('6.0c אחרי אישור — לא חסום, וחתימה אחרת', [accepted.blocked, accepted.report_digest !== first.report_digest], [false, true]);
  const imported = await rt.importScheduleSheet(req({ request_id: 'i9', month: '2026-09', paste: sheet, accept: { missing_stations: true }, expected_report_digest: accepted.report_digest }));
  const draft = db._get(ST + '/schedule_drafts/' + imported.draft_id);
  eq('6.1 בלי היעדרויות — absence_count 0 אך הכיסוי החסר נשמר',
    [draft.absence_count, draft.absence_coverage],
    [0, { sick: 'missing', reserve: 'missing', course: 'missing', leave: 'missing' }]);
  const preview = await rt.getDraftPreview(req({ draft_id: imported.draft_id, start: '2026-09-01' }));
  eq('6.2 ארבע התחנות תמיד קיימות; חסרות מסומנות ולא נראות כריקות מאומתות',
    preview.days[0].sub_stations.map((s) => s.sub_station + ':' + s.people.length + ':' + s.coverage),
    ['eilat:1:ready', 'shahmon:0:ready', 'timna:0:missing', 'yotvata:0:missing']);
  eq('6.3 absences ריק אינו מתחזה למידע מאומת כאשר הבלוק חסר',
    [preview.days[0].absences, preview.days[0].absences_status, preview.days[0].absence_coverage],
    [[], 'ready', { sick: 'missing', reserve: 'missing', course: 'missing', leave: 'missing' }]);
  db._put(ST + '/schedule_drafts/' + imported.draft_id, Object.assign({}, draft, {
    absence_coverage: { sick: 'ready', reserve: 'missing', course: 'missing', leave: 'missing' }
  }));
  await rejectsCode('6.4 שינוי בכיסוי ההיעדרויות ללא שינוי חתימה → סירוב',
    () => rt.getDraftPreview(req({ draft_id: imported.draft_id, start: '2026-09-01' })), 'snapshot-digest-mismatch');
  db._put(ST + '/schedule_drafts/' + imported.draft_id, draft);
  const restored = await rt.getDraftPreview(req({ draft_id: imported.draft_id, start: '2026-09-01' }));
  eq('6.5 שחזור הביטים המקוריים מחזיר את התמונה', restored.days[0].absence_coverage.sick, 'missing');
  // תאימות לתמונה מהגרסה הקודמת: ללא שדה coverage וללא השדה בחתימה.
  const base = ST + '/schedule_drafts/' + imported.draft_id;
  const rows = db._paths(base + '/rows').map((path) => db._get(path).row)
    .sort((a, b) => (a.date + '|' + a.sub_station < b.date + '|' + b.sub_station ? -1 : 1));
  const events = db._paths(base + '/events').map((path) => db._get(path))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const people = db._paths(base + '/people').map((path) => db._get(path))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const oldBasis = { contract: {
    station_id: draft.station_id, source_snapshot: draft.source_snapshot,
    source_version: draft.source_version, source_revision: draft.source_revision,
    source_digest: draft.source_digest, policy_version: draft.policy_version,
    policy_digest: draft.policy_digest, source_complete: draft.source_complete
  }, rows, events, people };
  const oldMeta = Object.assign({}, draft, { content_digest: digest(oldBasis) });
  delete oldMeta.absence_coverage;
  db._put(base, oldMeta);
  const oldPreview = await rt.getDraftPreview(req({ draft_id: imported.draft_id, start: '2026-09-01' }));
  eq('6.6 תמונה ישנה שלא הכירה coverage נשארת תקפה, אך אינה מוצגת כמידע מלא',
    oldPreview.days[0].absence_coverage, null);
}

/* 9 · מדיניות ישנה אינה נחסמת לנצח: המנהל ממפה במפורש, והחתימה קושרת את המיפוי. */
{
  const db = createFakeDb();
  const { rt, policyId } = await seed(db);
  const legacy = await rt.savePolicy(req({
    request_id: 'p_legacy', expected_policy_id: policyId, activate: true, confirm_weakening: true,
    draft: {
      sub_stations: {
        main: { label: 'ראשית', minimum: 8, requirements: [{ role: 'ff', count: 7, required: true }] },
        north: { label: 'צפון', minimum: 2, requirements: [{ role: 'ff', count: 1, required: false }] }
      },
      rest: { min_gap_days: 1 }, rotation: null, max_shifts_per_month: null
    }
  }));
  ok('9.0 מדיניות ישנה הופעלה', legacy.activated === true);
  await rejectsCode('9.1 בלי מיפוי מפורש — אין ניחוש',
    () => rt.previewScheduleImport(req({ month: '2026-09', paste: SHEET })), 'import-station-mapping-required');
  const map = { eilat: 'main', shahmon: 'north', timna: null, yotvata: null };
  const report = await rt.previewScheduleImport(req({ month: '2026-09', paste: SHEET, station_map: map }));
  eq('9.2 הדוח מחזיר בדיוק את המיפוי שנבדק', report.station_map, map);
  await rejectsCode('9.3 תחנה ישנה אחת לשתי תחנות — נדחה', () => rt.previewScheduleImport(req({
    month: '2026-09', paste: SHEET, station_map: { eilat: 'main', shahmon: 'main', timna: null, yotvata: null }
  })), 'import-station-mapping-duplicate');
}

if (fails.length) {
  console.error('✗ ' + fails.length + ' כשלים:');
  fails.forEach((f) => console.error('  ' + f));
  console.log(pass + ' עברו');
  process.exit(1);
}
console.log(pass + ' sheet-import runtime probe checks passed (real runtime, in-memory Firestore — not the emulator).');
