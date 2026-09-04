/* ====================================================================
 *  _schedule-fake.mjs · עזרי בדיקה משותפים: Firestore בזיכרון, runtime
 *  אמיתי, תחנה מזורעת עם מדיניות, מקור חתום וגיליון סינתטי.
 *
 *  הועתק מ-sheet-import-runtime-probe.mjs (שנשאר עצמאי, כפי שנבדק).
 *  שמות מומצאים בלבד. לא אמולטור.
 * ==================================================================== */

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const FN = resolve(HERE, '..', 'functions');
const require_ = createRequire(import.meta.url);

export const runtimeMod = require_(resolve(FN, 'schedule-runtime.js'));
export const calendarMod = require_(resolve(FN, 'schedule-calendar-engine.js'));
export const publicationMod = require_(resolve(FN, 'schedule-publication.js'));
export const serviceMod = require_(resolve(FN, 'schedule-service.js'));

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
    _del(path) { docs.delete(path); },
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
    hash, randomId: (() => { let n = 0; return () => 'rnd' + (++n); })(),
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


export { createFakeDb, SID, ST, hash, stable, digest, buildRuntime, MGR, req, PEOPLE, seed, row, SHEET };

/* ---------------- עזרי הרצה ---------------- */
export function makeChecks() {
  let pass = 0;
  const fails = [];
  const ok = (name, cond, detail) => { if (cond) { pass += 1; return; } fails.push(name + (detail ? ' — ' + detail : '')); };
  const eq = (name, actual, expected) => {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    ok(name, a === b, 'קיבלתי ' + a + ' במקום ' + b);
  };
  const rejectsCode = async (name, fn, code) => {
    try { await fn(); } catch (e) { ok(name, e && e.code === code, 'קוד ' + (e && e.code) + ' במקום ' + code + (e && e.code !== code ? ' · ' + e.message : '')); return; }
    ok(name, false, 'לא נזרקה שגיאה כלל');
  };
  const finish = (label) => {
    if (fails.length) {
      console.error('✗ ' + fails.length + ' כשלים:');
      fails.forEach((f) => console.error('  ' + f));
      console.log(pass + ' עברו');
      process.exit(1);
    }
    console.log(pass + ' ' + label + ' (real runtime, in-memory Firestore — not the emulator).');
  };
  return { ok, eq, rejectsCode, finish, count: () => pass };
}

/** מדביק גיליון, מייבא, עובר ל-new ומפרסם — נקודת התחלה לבדיקות על סידור פעיל. */
export async function publishImportedSchedule(db, rt, options) {
  const opts = options || {};
  const aliases = opts.aliases || { 'רועי': 'u1', 'אבטחה': null, 'גיא': 'u5' };
  const ready = await rt.previewScheduleImport(req({ month: '2026-09', paste: opts.paste || SHEET, aliases, accept: opts.accept || {} }));
  if (ready.blocked) throw new Error('הגיליון הסינתטי חסום: ' + JSON.stringify(ready.blocked_by) + ' ' + JSON.stringify(ready.unresolved));
  const imported = await rt.importScheduleSheet(req({ request_id: opts.request_id || 'seed-import', month: '2026-09', paste: opts.paste || SHEET, aliases, accept: opts.accept || {}, expected_report_digest: ready.report_digest }));
  const preview = await rt.getDraftPreview(req({ draft_id: imported.draft_id, start: '2026-09-01' }));
  const cfg = db._get(ST + '/schedule_state/runtime');
  db._put(ST + '/schedule_state/runtime', { mode: 'new', active_policy_id: cfg.active_policy_id, active_source_id: cfg.active_source_id });
  const published = await rt.publish(req({ request_id: opts.publish_id || 'seed-publish', draft_id: imported.draft_id, expected_content_digest: preview.expected_content_digest, gap_acknowledgement: preview.gaps && preview.gaps.digest }));
  const pointer = db._get(ST + '/schedule_state/active');
  return { imported, preview, published, pointer };
}
