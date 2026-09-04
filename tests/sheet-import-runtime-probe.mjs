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
    _get(path) { return docs.has(path) ? clone(docs.get(path)) : null; },
    _paths(prefix) { return Array.from(docs.keys()).filter((k) => k.indexOf(prefix) === 0).sort(); }
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

function buildRuntime(db) {
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
    sendPush: async () => ({ sent: 1 })
  });
}
const MGR = 'uid-mgr';
function req(data, uid) {
  return { auth: { uid: uid || MGR, token: { stationId: SID, role: 'firefighter', name: uid || MGR } }, data: data || {} };
}
const PEOPLE = [
  ['u1', 'רועי כהן', 'eilat', 'A'], ['u2', 'דניאל לוי', 'eilat', 'A'], ['u3', 'יוסי מזרחי', 'shahmon', 'B'],
  ['u4', 'עמית פרץ', 'timna', 'C'], ['u5', 'גיא ברק', 'yotvata', 'A'], ['u6', 'רועי אברהם', 'eilat', 'B'],
  ['u7', 'נועם דהן', 'eilat', 'B'], ['u8', 'אורי שלום', 'eilat', 'C'], ['u9', 'ליאור נחום', 'eilat', 'A']
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
  row(['מחלה', 'רועי אברהם', 'רועי אברהם', '']),
  row(['קורסים', '', 'ליאור נחום', '']),
  row(['באילת', '', '', 'רועי כהן']),
  row(['בצפון', 'רועי', '', ''])
].join('\n');

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

  // 2 · דוח לפני ייבוא — בלי כתיבה.
  const before = db._paths(ST + '/schedule_drafts').length;
  const report = await rt.previewScheduleImport(req({ month: '2026-09', paste: SHEET }));
  eq('2.1 תאריכים', report.dates, ['2026-09-01', '2026-09-02', '2026-09-03']);
  eq('2.2 שיבוצים: אילת 7+3+3, שחמון 2, תמנע 1, יטבתה 1 (בלי „רועי" ו„אבטחה")', report.counts.assignments, 7 + 3 + 3 + 2 + 1 + 1);
  eq('2.3 אילת מתחת לקו ב-2.9 ו-3.9 (7 ב-1.9 = לא מתחת)', report.counts.below_minimum, 2);
  eq('2.4 היעדרויות: מחלה×2, קורס, באילת', report.counts.absences, 4);
  eq('2.5 שם לא מזוהה: „רועי" דו-משמעי + „אבטחה"', report.unresolved.map((u) => u.name).sort(), ['אבטחה', 'רועי']);
  eq('2.6 מועמדים ל„רועי" עם שמות', report.unresolved.find((u) => u.name === 'רועי').candidates.map((c) => c.uid), ['u1', 'u6']);
  eq('2.7 חסום עד התאמה', report.blocked, true);
  ok('2.8 האזור החופשי (משורת השעה) מסומן כמדולג', report.blocks.some((b) => b.kind === 'ignored' && b.rows[0] === 14));
  eq('2.9 preview אינו כותב טיוטה', db._paths(ST + '/schedule_drafts').length, before);
  await rejectsCode('2.10 ייבוא כשיש שמות לא מזוהים — נחסם', () => rt.importScheduleSheet(req({ request_id: 'i1', month: '2026-09', paste: SHEET })), 'import-blocked');

  // 3 · התאמת כינויים → ייבוא → טיוטה.
  const aliases = { 'רועי': 'u1', 'אבטחה': null };   // null = „זה לא שם" — אחראי הסידור מסמן תא שאינו אדם
  const ready = await rt.previewScheduleImport(req({ month: '2026-09', paste: SHEET, aliases }));
  eq('3.1 אחרי התאמה — אין לא מזוהים', ready.counts.unresolved, 0);
  eq('3.2 ולא חסום', ready.blocked, false);
  const imported = await rt.importScheduleSheet(req({ request_id: 'i2', month: '2026-09', paste: SHEET, aliases }));
  eq('3.3 טיוטה נוצרה', [imported.duplicate, typeof imported.draft_id, imported.from, imported.to], [false, 'string', '2026-09-01', '2026-09-03']);
  eq('3.4 סיכום: קו לא חוסם, ימים מתחת לקו נספרים בנפרד', [imported.summary.days_below_minimum, imported.summary.imported_below_minimum, imported.summary.imported_absences], [0, 2, 5]);
  const draft = db._get(ST + '/schedule_drafts/' + imported.draft_id);
  eq('3.5 הטיוטה מסומנת כמיובאת ושלמה', [draft.status, draft.imported, draft.import_month, draft.absence_count], ['complete', true, '2026-09', 5]);
  eq('3.6 הכינויים נשמרו — כולל „לא שם"', db._get(ST + '/schedule_state/sheet_aliases').aliases, { 'רועי': 'u1', 'אבטחה': null });
  eq('3.6b תא שסומן „לא שם" נספר כמדולג', ready.counts.skipped, 1);
  const again = await rt.importScheduleSheet(req({ request_id: 'i2', month: '2026-09', paste: SHEET, aliases }));
  eq('3.7 אותו request_id — כפילות, לא טיוטה שנייה', again.duplicate, true);
  await rejectsCode('3.8 אותו request_id עם הדבקה אחרת — סירוב', () => rt.importScheduleSheet(req({ request_id: 'i2', month: '2026-09', paste: SHEET + '\n', aliases })), 'request-conflict');
  const memo = await rt.previewScheduleImport(req({ month: '2026-09', paste: SHEET }));
  eq('3.9 כינוי שנשמר משמש בהדבקה הבאה בלי למסור שוב', memo.counts.unresolved, 0);

  // 4 · תצוגה מקדימה של הטיוטה — השבלונה.
  const preview = await rt.getDraftPreview(req({ draft_id: imported.draft_id, start: '2026-09-01' }));
  eq('4.1 מיובא', preview.imported, true);
  const d1 = preview.days[0];
  eq('4.2 שורות = ארבע התחנות מהמדיניות, בסדר', d1.sub_stations.map((s) => s.sub_station), ['eilat', 'shahmon', 'timna', 'yotvata']);
  eq('4.3 אילת 1.9: 7 אנשים, קו 7, לא מתחת', [d1.sub_stations[0].people.length, d1.sub_stations[0].minimum, d1.sub_stations[0].below_minimum], [7, 7, false]);
  const d2 = preview.days[1];
  eq('4.4 אילת 2.9: 3 אנשים מתחת לקו', [d2.sub_stations[0].people.length, d2.sub_stations[0].below_minimum], [3, true]);
  eq('4.5 צוות לאדם מהסגל הישן (סדר לפי uid: u1,u2,u4,u5,u7,u8,u9)', d1.sub_stations[0].people.map((p) => p.crew), ['A', 'A', 'C', 'A', 'B', 'C', 'A']);
  eq('4.6 צוות היום מהמחזור (1.9=A, 2.9=B, 3.9=C)', preview.days.map((d) => d.crew), ['A', 'B', 'C']);
  eq('4.7 היעדרויות 1.9: מחלה + „רועי"→u1 בצפון', d1.absences.map((a) => [a.uid, a.kind, a.location || null]), [['u6', 'sick', null], ['u1', 'leave', 'north']]);
  eq('4.8 היעדרויות 3.9: באילת', preview.days[2].absences.map((a) => [a.uid, a.kind, a.location, a.display]), [['u1', 'leave', 'eilat', 'רועי כהן']]);
  eq('4.9 סטטוס', d1.absences_status, 'ready');
  eq('4.10 שיבוץ מיובא אינו „אוטומטי" — אין role', d1.sub_stations[0].people[0].role_label, null);

  // 5 · פרסום — אותו מסלול. ב-shadow פרסום הוא „מוכן" בלבד (המצביע זז רק
  // ב-promoteToNew); כאן עוברים ל-new לפני הפרסום כדי לבדוק את הלוח החי.
  const cfg = db._get(ST + '/schedule_state/runtime');
  db._put(ST + '/schedule_state/runtime', { mode: 'new', active_policy_id: cfg.active_policy_id, active_source_id: cfg.active_source_id });
  const published = await rt.publish(req({ request_id: 'pub1', draft_id: imported.draft_id, expected_content_digest: preview.expected_content_digest }));
  ok('5.1 פורסם', published && published.publication_id, JSON.stringify(published));
  const pub = db._get(ST + '/schedule_publications/' + published.publication_id);
  eq('5.2 הפרסום נושא imported + absence_count', [pub.imported, pub.absence_count], [true, 5]);
  const range = await rt.getStationRange(req({ from: '2026-09-01', to: '2026-09-03' }, 'u2'));
  eq('5.3 מקור v2, מיובא', [range.source, range.imported], ['v2', true]);
  eq('5.4 שורות תחנה + היעדרויות + צוות יום', [range.days[0].sub_stations.length, range.days[0].absences.length, range.days.map((d) => d.crew)], [4, 2, ['A', 'B', 'C']]);
  eq('5.5 היעדרויות לכל יום מהפרסום', range.days.map((d) => d.absences.map((a) => a.uid + ':' + a.kind)), [['u6:sick', 'u1:leave'], ['u6:sick', 'u9:course'], ['u1:leave']]);
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

/* 6 · פרסום קודם (בלי היעדרויות) נשאר תקף — החתימה אינה משתנה לו. */
{
  const db = createFakeDb();
  const { rt } = await seed(db);
  const sheet = [row(['', '1/9', '2/9', '3/9']), row(['', 'ג', 'ד', 'ה']),
    row(['אילת', 'רועי כהן', 'רועי כהן', 'רועי כהן']), row(['שחמון', '', '', ''])].join('\n');
  const imported = await rt.importScheduleSheet(req({ request_id: 'i9', month: '2026-09', paste: sheet }));
  const draft = db._get(ST + '/schedule_drafts/' + imported.draft_id);
  eq('6.1 בלי היעדרויות — absence_count 0', draft.absence_count, 0);
  const preview = await rt.getDraftPreview(req({ draft_id: imported.draft_id, start: '2026-09-01' }));
  eq('6.2 שורות ריקות לתחנות בלי שיבוץ — קיימות', preview.days[0].sub_stations.map((s) => s.people.length), [1, 0, 0, 0]);
  eq('6.3 absences ריק אך ready', [preview.days[0].absences, preview.days[0].absences_status], [[], 'ready']);
}

if (fails.length) {
  console.error('✗ ' + fails.length + ' כשלים:');
  fails.forEach((f) => console.error('  ' + f));
  console.log(pass + ' עברו');
  process.exit(1);
}
console.log(pass + ' sheet-import runtime probe checks passed (real runtime, in-memory Firestore — not the emulator).');
