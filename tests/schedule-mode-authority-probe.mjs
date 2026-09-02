/* ====================================================================
 *  schedule-mode-authority-probe
 *
 *  המתג שמפעיל את מנוע הסידור — מי רשאי, לאן מותר, ומה חייב
 *  להיאמר לפני שהוא זז.
 *
 *  ----------------------------------------------------------------
 *  מה הבדיקה הזאת שומרת עליו
 *  ----------------------------------------------------------------
 *
 *  ⭐ **`schedule_manager` אינו מפעיל מנוע.** זו ההכרעה, וזו גם
 *  הטעות הקלה ביותר לעשות: אחראי הסידור הוא מי שעובד עם המנוע
 *  יום-יום, ולכן טבעי לתת לו גם את המתג. הזזת מצב משנה את מה
 *  שכל התחנה רואה — היא שייכת לפיקוד.
 *
 *  שלוש שכבות של הגנה נבדקות כאן, ולא אחת:
 *   1. המודול הטהור — האם הוא מחליט נכון.
 *   2. **טקסט המקור** — האם `manager` יכול בכלל להגיע להחלטה.
 *   3. הנתיב המחווט — האם השרת אוכף אותה בפועל.
 *
 *  שכבה 2 קיימת כי שכבה 1 עוברת גם אם `manager` **יתווסף** מחר
 *  לרשימת המורשים; רק קריאת המקור תופסת את זה.
 *
 *  יציאה: 0 עבר · 1 נכשל · 2 לא רץ.
 * ==================================================================== */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

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
function throwsCode(name, fn, code) {
  try { fn(); } catch (e) { ok(name, e && e.code === code, 'קוד ' + (e && e.code) + ' במקום ' + code); return; }
  ok(name, false, 'לא נזרקה שגיאה כלל');
}
async function rejectsCode(name, fn, code) {
  try { await fn(); } catch (e) {
    ok(name, e && e.code === code, 'קוד ' + (e && e.code) + ' במקום ' + code); return;
  }
  ok(name, false, 'לא נזרקה שגיאה כלל');
}

let mod, MOD_SRC, RUNTIME_SRC, INDEX_SRC, runtimeMod, calendarMod, publicationMod, serviceMod;
try {
  MOD_SRC = readFileSync(resolve(FN, 'schedule-mode-authority.js'), 'utf8');
  RUNTIME_SRC = readFileSync(resolve(FN, 'schedule-runtime.js'), 'utf8');
  INDEX_SRC = readFileSync(resolve(FN, 'index.js'), 'utf8');
  mod = require_(resolve(FN, 'schedule-mode-authority.js'));
  runtimeMod = require_(resolve(FN, 'schedule-runtime.js'));
  calendarMod = require_(resolve(FN, 'schedule-calendar-engine.js'));
  publicationMod = require_(resolve(FN, 'schedule-publication.js'));
  serviceMod = require_(resolve(FN, 'schedule-service.js'));
} catch (e) {
  console.error('NOT RUN — לא ניתן לטעון את המודולים: ' + e.message);
  process.exit(2);
}

const A = mod.createModeAuthority();
const CODE = mod.CODE;
const READY = { policy: true, source: true, people: 44 };

function change(over) {
  return A.planModeChange(Object.assign({
    current: 'off', target: 'shadow',
    actor: { uid: 'uid-cmd', role: 'commander', super: false },
    confirmation: 'shadow', reason_code: 'initial_activation', readiness: READY
  }, over || {}));
}

/* ==================================================================
 * 1 · מי רשאי
 * ================================================================== */

eq('1.1 מפקד רשאי', A.mayChangeMode({ role: 'commander' }), true);
eq('1.2 סגן רשאי', A.mayChangeMode({ role: 'deputy' }), true);
eq('1.3 מנהל-על רשאי', A.mayChangeMode({ role: 'firefighter', super: true }), true);

// ⭐ הלב של ההכרעה.
eq('1.4 אחראי סידור אינו רשאי',
  A.mayChangeMode({ role: 'firefighter', manager: true }), false);
eq('1.5 גם אחראי סידור שהוא ראש צוות אינו רשאי',
  A.mayChangeMode({ role: 'team_leader', manager: true }), false);
eq('1.6 רכזת כוח אדם אינה רשאית', A.mayChangeMode({ role: 'hr_coordinator' }), false);
eq('1.7 כבאי אינו רשאי', A.mayChangeMode({ role: 'firefighter' }), false);
eq('1.8 בלי שחקן כלל', A.mayChangeMode(null), false);
eq('1.9 super שאינו בוליאני אינו super', A.mayChangeMode({ role: 'x', super: 'true' }), false);

// station_commander אינו ברשימה — במכוון, עד להכרעה מפורשת.
eq('1.10 station_commander אינו ברשימה כרגע',
  A.mayChangeMode({ role: 'station_commander' }), false);

throwsCode('1.11 אחראי סידור נעצר בתכנון',
  () => change({ actor: { uid: 'u', role: 'firefighter', manager: true } }), CODE.FORBIDDEN);
throwsCode('1.12 רכזת נעצרת בתכנון',
  () => change({ actor: { uid: 'u', role: 'hr_coordinator' } }), CODE.FORBIDDEN);

// ⭐ ההרשאה נבדקת לפני הכול. מי שאינו רשאי אינו לומד מהשגיאה
// מה חסר כדי להפעיל.
try {
  change({ actor: { uid: 'u', role: 'firefighter' }, readiness: { policy: false, source: false, people: 0 } });
  ok('1.13 הרשאה נבדקת לפני מוכנות', false, 'לא נזרקה שגיאה');
} catch (e) {
  ok('1.13 הרשאה נבדקת לפני מוכנות', e.code === CODE.FORBIDDEN, 'קוד ' + e.code);
  ok('1.14 והשגיאה אינה מפרטת מה חסר', e.message.indexOf('חוקי תחנה') === -1);
}

/* ==================================================================
 * 2 · לאן מותר
 * ================================================================== */

eq('2.1 כבוי → בדיקה', change().transition, 'enable_shadow');
eq('2.2 בדיקה → פעיל',
  change({ current: 'shadow', target: 'new', confirmation: 'new',
    reason_code: 'validation_complete' }).transition, 'promote');
eq('2.3 פעיל → בדיקה',
  change({ current: 'new', target: 'shadow', reason_code: 'validation_failed' }).transition, 'demote');
eq('2.4 בדיקה → כבוי',
  change({ current: 'shadow', target: 'off', confirmation: 'off',
    reason_code: 'operational_safety' }).transition, 'disable');
eq('2.5 פעיל → כבוי',
  change({ current: 'new', target: 'off', confirmation: 'off',
    reason_code: 'operational_safety' }).transition, 'disable');

// ⭐ הקפיצה האסורה. `shadow` הוא המקום היחיד לראות תוצאה בלי
// שמישהו יקבל אותה כסידור.
throwsCode('2.6 כבוי → פעיל אסור',
  () => change({ target: 'new', confirmation: 'new' }), CODE.TRANSITION_FORBIDDEN);
try {
  change({ target: 'new', confirmation: 'new' });
} catch (e) {
  ok('2.7 והשגיאה מסבירה למה', e.message.indexOf('בלי שאיש יקבל הודעה') !== -1, e.message);
}

eq('2.8 אותו מצב אינו שינוי', change({ target: 'off', confirmation: 'off' }).kind, 'unchanged');
throwsCode('2.9 מצב שאינו קיים',
  () => change({ target: 'paused', confirmation: 'paused' }), CODE.MODE_INVALID);
throwsCode('2.10 מצב נוכחי שאינו קיים',
  () => change({ current: 'weird' }), CODE.MODE_INVALID);

/* ==================================================================
 * 3 · מה חייב להיאמר
 * ================================================================== */

throwsCode('3.1 בלי אישור', () => change({ confirmation: undefined }), CODE.CONFIRMATION);
throwsCode('3.2 אישור בוליאני אינו אישור',
  () => change({ confirmation: true }), CODE.CONFIRMATION);
throwsCode('3.3 אישור למצב אחר',
  () => change({ confirmation: 'new' }), CODE.CONFIRMATION);
throwsCode('3.4 בלי סיבה', () => change({ reason_code: undefined }), CODE.REASON);
throwsCode('3.5 סיבה חופשית נדחית',
  () => change({ reason_code: 'כי ככה' }), CODE.REASON);
ok('3.6 רשימת הסיבות סגורה', mod.REASONS.length === 6 && mod.REASONS.indexOf('other') !== -1);

/* ==================================================================
 * 4 · מוכנות · והמתג שתמיד עובד
 * ================================================================== */

throwsCode('4.1 אין חוקי תחנה',
  () => change({ readiness: { policy: false, source: true, people: 44 } }), CODE.NOT_READY);
throwsCode('4.2 אין מקור',
  () => change({ readiness: { policy: true, source: false, people: 44 } }), CODE.NOT_READY);
throwsCode('4.3 מקור בלי אנשים',
  () => change({ readiness: { policy: true, source: true, people: 0 } }), CODE.NOT_READY);
try {
  change({ readiness: { policy: false, source: false, people: 0 } });
} catch (e) {
  eq('4.4 השגיאה מפרטת מה חסר', e.detail.missing, ['policy', 'source', 'people']);
}
throwsCode('4.5 העלאה לפעיל דורשת מוכנות',
  () => change({ current: 'shadow', target: 'new', confirmation: 'new',
    reason_code: 'validation_complete', readiness: { policy: true, source: false, people: 3 } }),
  CODE.NOT_READY);

// ⭐ מתג חירום שדורש שהמערכת תהיה תקינה כדי לפעול אינו מתג חירום.
const killed = change({ current: 'new', target: 'off', confirmation: 'off',
  reason_code: 'operational_safety', readiness: { policy: false, source: false, people: 0 } });
eq('4.6 כיבוי עובד גם כשהכול שבור', killed.transition, 'disable');
const killedNoReadiness = change({ current: 'shadow', target: 'off', confirmation: 'off',
  reason_code: 'operational_safety', readiness: undefined });
eq('4.7 כיבוי אינו דורש מוכנות כלל', killedNoReadiness.to, 'off');

/* ==================================================================
 * 5 · תיעוד
 * ================================================================== */

const audited = change({ actor: { uid: 'uid-cmd-9', role: 'commander', super: false } });
eq('5.1 שדות היומן', Object.keys(audited.audit).sort(),
  ['actor_role', 'actor_uid', 'by_super', 'from', 'reason_code', 'to', 'transition']);
eq('5.2 מי', audited.audit.actor_uid, 'uid-cmd-9');
eq('5.3 באיזה תפקיד', audited.audit.actor_role, 'commander');
eq('5.4 ולא כמנהל-על', audited.audit.by_super, false);
eq('5.5 מאיפה לאן', [audited.audit.from, audited.audit.to], ['off', 'shadow']);
eq('5.6 מנהל-על מסומן ככזה',
  change({ actor: { uid: 'root', role: 'firefighter', super: true } }).audit.by_super, true);

const PII = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b05\d[- ]?\d{7}\b/;
ok('5.7 אין PII ביומן', !PII.test(JSON.stringify(audited.audit)));
ok('5.8 אין שם אדם ביומן',
  JSON.stringify(audited.audit).indexOf('name') === -1);

/* ==================================================================
 * 6 · מה המסך רשאי להציע
 * ================================================================== */

const offReady = A.options({ current: 'off', actor: { role: 'commander' }, readiness: READY });
eq('6.1 מכבוי אפשר רק לבדיקה', offReady.targets.map((t) => t.to), ['shadow']);
eq('6.2 והיא זמינה', offReady.targets[0].available, true);

const offBlank = A.options({ current: 'off', actor: { role: 'commander' },
  readiness: { policy: false, source: false, people: 0 } });
eq('6.3 בלי הגדרות היעד מוצג אך חסום', offBlank.targets[0].available, false);
eq('6.4 והסיבה נאמרת', offBlank.targets[0].blocked_by, 'not_ready');

const newMode = A.options({ current: 'new', actor: { role: 'deputy' },
  readiness: { policy: false, source: false, people: 0 } });
eq('6.5 מפעיל אפשר לחזור לבדיקה או לכבות',
  newMode.targets.map((t) => t.to).sort(), ['off', 'shadow']);
const off = newMode.targets.find((t) => t.to === 'off');
eq('6.6 כיבוי זמין גם כשהכול שבור', off.available, true);
const shadow = newMode.targets.find((t) => t.to === 'shadow');
eq('6.7 חזרה לבדיקה חסומה בלי הגדרות', shadow.available, false);

const notAllowed = A.options({ current: 'off', actor: { role: 'firefighter', manager: true },
  readiness: READY });
eq('6.8 אחראי סידור אינו מקבל אפשרויות', notAllowed.may_change, false);
eq('6.9 והיעדים חסומים', notAllowed.targets.map((t) => t.blocked_by), ['forbidden']);

/* ==================================================================
 * 7 · טקסט המקור · מה שבדיקת התנהגות אינה תופסת
 *
 * ⭐ סעיף 1 עובר גם אם מחר מישהו יוסיף `manager` לרשימת המורשים
 * ואז יתקן את הבדיקה. השכבה הזאת קוראת את המקור עצמו.
 * ================================================================== */

ok('7.1 רשימת המורשים היא בדיוק שני תפקידים',
  /AUTHORITY_ROLES = Object\.freeze\(\['commander', 'deputy'\]\)/.test(MOD_SRC));
ok('7.2 המודול אינו קורא את שדה `manager` בכלל',
  MOD_SRC.indexOf('actor.manager') === -1 && MOD_SRC.indexOf('.manager') === -1);
// המודול מסביר את ההכרעה בהערה, וזה רצוי. מה שאסור הוא שהמינוי
// יופיע כ**ערך** — ברשימה, בהשוואה או בתנאי.
ok('7.3 schedule_manager אינו ערך בשום מקום במודול',
  !/['"]schedule_manager['"]/.test(MOD_SRC));
ok('7.4 המודול טהור — אין Firebase',
  !/require\(['"]firebase|firebase-admin/.test(MOD_SRC));
ok('7.5 המודול אינו קורא שעון מערכת', MOD_SRC.indexOf('Date.now()') === -1);
ok('7.6 off→new אינו ברשימת המעברים',
  !/from: MODE\.OFF, to: MODE\.NEW/.test(MOD_SRC));
ok('7.7 חמישה מעברים בדיוק', mod.TRANSITIONS.length === 5);

// ⭐ הנתיב בשרת אינו קורא ל-requireManager.
const start = RUNTIME_SRC.indexOf('async function setRuntimeMode(req)');
const end = RUNTIME_SRC.indexOf('async function runPlanner(req)', start);
const wired = RUNTIME_SRC.slice(start, end);
ok('7.8 הנתיב בשרת אותר', start > -1 && end > start);
ok('7.9 השרת אינו דורש מינוי אחראי סידור',
  wired.indexOf('requireManager') === -1);
ok('7.10 השרת אינו מוסר את המינוי למודול',
  RUNTIME_SRC.indexOf('function modeActor(ctx)') > -1
  && /function modeActor\(ctx\) \{[\s\S]{0,400}?return \{ uid: ctx\.uid, role: ctx\.role, super: ctx\.super === true \};/.test(RUNTIME_SRC));
ok('7.11 השרת חוסם הרשאה לפני שהוא קורא את המקור',
  wired.indexOf('mayChangeMode') < wired.indexOf('modeReadiness'));
ok('7.12 הגנה מדריסה קיימת',
  wired.indexOf("'mode-conflict'") !== -1 && wired.indexOf('data.expected_mode') !== -1);
ok('7.13 מניעת כפילות קיימת',
  wired.indexOf("'mode-request-reused'") !== -1 && wired.indexOf('fingerprint') !== -1);
ok('7.14 יומן נכתב', wired.indexOf('modeAuditRef(ctx.sid, requestId)') !== -1);
ok('7.15 שתי הפעולות רשומות ב-index עם App Check',
  INDEX_SRC.indexOf("exports.setScheduleRuntimeMode = onCall({\n  enforceAppCheck: true") !== -1
  && INDEX_SRC.indexOf("exports.getScheduleModeOptions = onCall({ enforceAppCheck: true }") !== -1);
ok('7.16 התחנה אינה מתקבלת מהלקוח בנתיב הזה',
  !/data\.(station_id|stationId)/.test(wired));

/* ==================================================================
 * 8 · הנתיב המחווט · Firestore בזיכרון
 * ================================================================== */

function createFakeDb() {
  const docs = new Map();
  function snapshot(path) {
    const has = docs.has(path);
    return {
      exists: has, id: path.slice(path.lastIndexOf('/') + 1), ref: docRef(path),
      data: () => (has ? JSON.parse(JSON.stringify(docs.get(path))) : undefined)
    };
  }
  function collectionRef(path) {
    return {
      path, doc: (id) => docRef(path + '/' + String(id)),
      async get() {
        const prefix = path + '/';
        const out = [];
        for (const key of Array.from(docs.keys()).sort()) {
          if (key.indexOf(prefix) !== 0) continue;
          if (key.slice(prefix.length).indexOf('/') !== -1) continue;
          out.push(snapshot(key));
        }
        return { docs: out, size: out.length, empty: out.length === 0 };
      },
      where() { return this; }, limit() { return this; }
    };
  }
  function docRef(path) {
    return {
      path, id: path.slice(path.lastIndexOf('/') + 1),
      collection: (name) => collectionRef(path + '/' + name),
      async get() { return snapshot(path); },
      async set(value, options) {
        const next = JSON.parse(JSON.stringify(value));
        if (options && options.merge && docs.has(path)) {
          docs.set(path, Object.assign({}, docs.get(path), next));
        } else docs.set(path, next);
      }
    };
  }
  return {
    collection: (name) => collectionRef(name),
    async getAll(...refs) { return Promise.all(refs.map((r) => r.get())); },
    async runTransaction(fn) {
      const staged = [];
      let wrote = false;
      const tx = {
        async get(ref) {
          if (wrote) {
            const e = new Error('reads must precede writes');
            e.code = 'transaction-read-after-write';
            throw e;
          }
          return ref.get();
        },
        set(ref, value, options) { wrote = true; staged.push([ref, value, options]); }
      };
      const out = await fn(tx);
      for (const [ref, value, options] of staged) await ref.set(value, options);
      return out;
    },
    _put(path, value) { docs.set(path, JSON.parse(JSON.stringify(value))); },
    _get(path) { return docs.has(path) ? JSON.parse(JSON.stringify(docs.get(path))) : null; },
    _paths(prefix) { return Array.from(docs.keys()).filter((k) => k.indexOf(prefix) === 0).sort(); }
  };
}

const SID = 'station-102';
function buildRuntime(db) {
  return runtimeMod.createScheduleRuntime({
    db,
    FieldValue: { serverTimestamp: () => '__ts__' },
    FieldPath: function FieldPath() {},
    clock: () => new Date(Date.UTC(2026, 8, 2, 6, 0, 0)).toISOString(),
    hash: (v) => createHash('sha256').update(String(v), 'utf8').digest('hex'),
    randomId: () => 'rnd',
    createEngine: calendarMod.createCalendarEngine,
    createPublication: publicationMod.createPublication,
    createService: serviceMod.createScheduleService,
    isSuper: () => false,
    sendPush: async () => ({ sent: 1 })
  });
}
function seed(db, options) {
  const opts = options || {};
  const uid = opts.uid || 'uid-cmd';
  db._put('stations/' + SID + '/users/' + uid, {
    station_id: SID, is_active: true, active: true,
    role: opts.role || 'commander', full_name: 'מפקד התחנה'
  });
  if (opts.manager) {
    db._put('stations/' + SID + '/schedule_access/' + uid, {
      schema_version: 1, station_id: SID, uid,
      roles: ['schedule_manager'], active: true, revision: 2
    });
  }
  db._put('stations/' + SID + '/schedule_state/runtime', { mode: opts.mode || 'off' });
}
function req(data, options) {
  const opts = options || {};
  return {
    auth: { uid: opts.uid || 'uid-cmd',
      token: { stationId: SID, role: opts.role || 'commander' } },
    data
  };
}

await (async () => {
  const db = createFakeDb();
  seed(db, { role: 'firefighter', uid: 'uid-mgr', manager: true });
  const rt = buildRuntime(db);
  // ⭐ הבדיקה שסוגרת את ההכרעה: אחראי סידור חי ומאושר, ועדיין
  // אינו יכול להזיז את המנוע.
  await rejectsCode('8.1 אחראי סידור נחסם בשרת', () => rt.setRuntimeMode(req({
    request_id: 'r1', target: 'shadow', confirmation: 'shadow',
    reason_code: 'initial_activation', expected_mode: 'off'
  }, { uid: 'uid-mgr', role: 'firefighter' })), 'mode-authority-forbidden');
  eq('8.2 והמצב לא זז', db._get('stations/' + SID + '/schedule_state/runtime').mode, 'off');
  eq('8.3 ולא נכתב יומן', db._paths('stations/' + SID + '/schedule_mode_audit/').length, 0);

  const view = await rt.getModeOptions(req({}, { uid: 'uid-mgr', role: 'firefighter' }));
  eq('8.4 והוא אינו רואה אפשרויות', view.may_change, false);
  eq('8.5 ואינו לומד מה חסר', view.targets, []);
})();

await (async () => {
  const db = createFakeDb();
  seed(db, { role: 'commander' });
  const rt = buildRuntime(db);
  // אין מדיניות ואין מקור — הפעלה נחסמת, אבל בקוד אחר לגמרי.
  await rejectsCode('8.6 מפקד בלי הגדרות נחסם על מוכנות', () => rt.setRuntimeMode(req({
    request_id: 'r2', target: 'shadow', confirmation: 'shadow',
    reason_code: 'initial_activation', expected_mode: 'off'
  })), 'mode-not-ready');

  const view = await rt.getModeOptions(req({}));
  eq('8.7 הוא כן רואה שהוא רשאי', view.may_change, true);
  eq('8.8 ורואה שחסר', view.ready, false);
  eq('8.9 והיעד מוצג חסום', view.targets[0].blocked_by, 'not_ready');
})();

await (async () => {
  const db = createFakeDb();
  seed(db, { role: 'commander' });
  const rt = buildRuntime(db);

  // מדיניות אמיתית, שנכתבת דרך נתיב הכתיבה האמיתי.
  db._put('stations/' + SID + '/schedule_access/uid-mgr', {
    schema_version: 1, station_id: SID, uid: 'uid-mgr',
    roles: ['schedule_manager'], active: true, revision: 1
  });
  db._put('stations/' + SID + '/users/uid-mgr', {
    station_id: SID, is_active: true, active: true, role: 'firefighter'
  });
  const saved = await rt.savePolicy({
    auth: { uid: 'uid-mgr', token: { stationId: SID, role: 'firefighter' } },
    data: {
      request_id: 'p1', activate: true,
      draft: {
        sub_stations: { rashit: { label: 'ראשית', minimum: 3,
          requirements: [{ role: 'ff', count: 3, required: true }] } },
        rest: { min_gap_days: 1 }, rotation: null, max_shifts_per_month: null
      }
    }
  });
  ok('8.10 מדיניות נכתבה', saved.written === true);

  // מקור מזויף אך שלם, כדי שהבדיקה המקדימה תרוץ עד הסוף.
  const source = 'src_1';
  const base = 'stations/' + SID + '/schedule_sources/' + source;
  db._put(base + '/people/p1', { id: 'p1', active: true, sub_station: 'rashit', roles: ['ff'] });
  db._put(base + '/people/p2', { id: 'p2', active: true, sub_station: 'rashit', roles: ['ff'] });
  db._put('stations/' + SID + '/schedule_state/runtime', {
    mode: 'off', active_policy_id: saved.policy_id, active_source_id: source
  });
  // מסמך מקור בלי חתימה תקינה — הבדיקה המקדימה חייבת לתפוס אותו.
  db._put(base, { station_id: SID, complete: true, version: '1', revision: '1',
    person_count: 2, availability_count: 0, locked_count: 0, event_count: 0,
    content_digest: 'לא-נכון' });

  await rejectsCode('8.11 מקור עם חתימה שבורה אינו מוכנות', () => rt.setRuntimeMode(req({
    request_id: 'r3', target: 'shadow', confirmation: 'shadow',
    reason_code: 'initial_activation', expected_mode: 'off'
  })), 'mode-not-ready');

  const view = await rt.getModeOptions(req({}));
  eq('8.12 המדיניות נטענת', view.readiness.policy, true);
  eq('8.13 המקור אינו', view.readiness.source, false);
  // ⭐ הכשל נאמר בקוד שלו, ולא כ„עדיין לא הוגדר".
  ok('8.14 והכשל נקוב בשמו',
    view.readiness.problems.indexOf('source-digest-mismatch') !== -1,
    JSON.stringify(view.readiness.problems));
})();

await (async () => {
  const db = createFakeDb();
  seed(db, { role: 'deputy', mode: 'new' });
  const rt = buildRuntime(db);
  // ⭐ כיבוי עובד בלי מדיניות, בלי מקור ובלי שום דבר תקין.
  const killed = await rt.setRuntimeMode(req({
    request_id: 'k1', target: 'off', confirmation: 'off',
    reason_code: 'operational_safety', expected_mode: 'new'
  }, { role: 'deputy' }));
  eq('8.15 כיבוי הצליח', killed.changed, true);
  eq('8.16 המצב נכתב', db._get('stations/' + SID + '/schedule_state/runtime').mode, 'off');

  const audit = db._get(db._paths('stations/' + SID + '/schedule_mode_audit/')[0]);
  eq('8.17 היומן מתעד מאיפה לאן', [audit.from, audit.to], ['new', 'off']);
  eq('8.18 ואת הסיבה', audit.reason_code, 'operational_safety');
  eq('8.19 ואת התפקיד', audit.actor_role, 'deputy');
  ok('8.20 והיומן נקי מ-PII', !PII.test(JSON.stringify(audit)));

  // חזרה על אותה בקשה
  const again = await rt.setRuntimeMode(req({
    request_id: 'k1', target: 'off', confirmation: 'off',
    reason_code: 'operational_safety', expected_mode: 'new'
  }, { role: 'deputy' }));
  eq('8.21 חזרה מסומנת ככפולה', again.duplicate, true);
  eq('8.22 ולא נוצר יומן שני',
    db._paths('stations/' + SID + '/schedule_mode_audit/').length, 1);

  // אותו מזהה בקשה לפעולה אחרת
  db._put('stations/' + SID + '/schedule_state/runtime', { mode: 'new' });
  await rejectsCode('8.23 מזהה בקשה שמשמש לפעולה אחרת', () => rt.setRuntimeMode(req({
    request_id: 'k1', target: 'shadow', confirmation: 'shadow',
    reason_code: 'validation_failed', expected_mode: 'new'
  }, { role: 'deputy' })), 'mode-request-reused');
})();

await (async () => {
  const db = createFakeDb();
  seed(db, { role: 'commander', mode: 'shadow' });
  const rt = buildRuntime(db);
  // ⭐ הגנה מדריסה: המסך ראה `off`, בשרת כבר `shadow`.
  await rejectsCode('8.24 מצב שהשתנה מאז טעינת המסך', () => rt.setRuntimeMode(req({
    request_id: 'c1', target: 'shadow', confirmation: 'shadow',
    reason_code: 'initial_activation', expected_mode: 'off'
  })), 'mode-conflict');
  eq('8.25 והמצב לא נגע', db._get('stations/' + SID + '/schedule_state/runtime').mode, 'shadow');

  await rejectsCode('8.26 קפיצה מכבוי לפעיל נחסמת בשרת גם היא', () => {
    db._put('stations/' + SID + '/schedule_state/runtime', { mode: 'off' });
    return rt.setRuntimeMode(req({
      request_id: 'c2', target: 'new', confirmation: 'new',
      reason_code: 'initial_activation', expected_mode: 'off'
    }));
  }, 'mode-transition-forbidden');

  await rejectsCode('8.27 בלי הקלדת המצב אין שינוי', () => rt.setRuntimeMode(req({
    request_id: 'c3', target: 'shadow', confirmation: true,
    reason_code: 'initial_activation', expected_mode: 'off'
  })), 'mode-confirmation-required');

  await rejectsCode('8.28 בלי סיבה אין שינוי', () => rt.setRuntimeMode(req({
    request_id: 'c4', target: 'shadow', confirmation: 'shadow', expected_mode: 'off'
  })), 'mode-reason-required');

  eq('8.29 ואף אחת מהן לא כתבה דבר',
    db._paths('stations/' + SID + '/schedule_mode_audit/').length, 0);
})();

await (async () => {
  const db = createFakeDb();
  seed(db, { role: 'commander', mode: 'new' });
  const rt = buildRuntime(db);
  // התחנה לעולם אינה מתקבלת מהלקוח.
  await rejectsCode('8.30 תחנה בגוף הבקשה נדחית', () => rt.setRuntimeMode({
    auth: { uid: 'uid-cmd', token: { stationId: SID, role: 'commander' } },
    data: { request_id: 's1', target: 'off', confirmation: 'off',
      reason_code: 'operational_safety', station_id: 'station-999' }
  }), 'client-station-forbidden');
  eq('8.31 ושום דבר לא נכתב בתחנה זרה', db._paths('stations/station-999/').length, 0);
})();

/* ==================================================================
 * 9 · מוטציות · הבדיקות חייבות ליפול על קוד שבור
 * ================================================================== */

function survives(name, from, to, check) {
  if (MOD_SRC.indexOf(from) === -1) { ok(name, false, 'הטקסט לא נמצא: ' + from); return; }
  const src = MOD_SRC.split(from).join(to);
  const m = { exports: {} };
  let api;
  try {
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', 'require', src)(m, m.exports, require_);
    api = m.exports.createModeAuthority();
  } catch (e) { ok(name, false, 'הקוד המוטנטי לא נטען: ' + e.message); return; }
  let caught = false;
  try { caught = check(api) === false; } catch (_) { caught = true; }
  ok(name, caught, 'המוטציה שרדה — הבדיקה אינה בודקת דבר');
}

// ⭐ 9.1 — אחראי סידור מתווסף לרשימת המורשים. זו התקלה שכל
// הקובץ הזה קיים כדי למנוע.
survives('9.1 אחראי סידור מקבל את המתג',
  "if (actor.super === true) return true;",
  "if (actor.super === true || actor.manager === true) return true;",
  (api) => api.mayChangeMode({ role: 'firefighter', manager: true }) === false);

survives('9.2 רשימת המורשים נפתחת',
  "return AUTHORITY_ROLES.indexOf(String(actor.role || '')) !== -1;",
  "return true;",
  (api) => api.mayChangeMode({ role: 'firefighter' }) === false);

survives('9.3 קפיצה מכבוי לפעיל מותרת',
  "Object.freeze({ from: MODE.NEW, to: MODE.OFF, kind: 'disable' })",
  "Object.freeze({ from: MODE.NEW, to: MODE.OFF, kind: 'disable' }),\n  Object.freeze({ from: MODE.OFF, to: MODE.NEW, kind: 'jump' })",
  // התנהגות תקינה = **נזרקת** שגיאה. `survives` מצפה שה-check
  // ידווח על ההתנהגות התקינה, ולכן true כאן פירושו „נחסם כראוי".
  (api) => {
    try {
      api.planModeChange({ current: 'off', target: 'new',
        actor: { uid: 'u', role: 'commander' }, confirmation: 'new',
        reason_code: 'initial_activation', readiness: READY });
      return false;
    } catch (_) { return true; }
  });

survives('9.4 אישור מפורש מתבטל',
  "if (input.confirmation !== target) {",
  "if (false) {",
  // התנהגות תקינה = **נזרקת** שגיאה. `survives` מצפה שה-check
  // ידווח על ההתנהגות התקינה, ולכן true כאן פירושו „נחסם כראוי".
  (api) => {
    try {
      api.planModeChange({ current: 'off', target: 'shadow',
        actor: { uid: 'u', role: 'commander' },
        reason_code: 'initial_activation', readiness: READY });
      return false;
    } catch (_) { return true; }
  });

survives('9.5 סיבה חופשית מתקבלת',
  "REASONS.indexOf(input.reason_code) === -1",
  "false",
  // התנהגות תקינה = **נזרקת** שגיאה. `survives` מצפה שה-check
  // ידווח על ההתנהגות התקינה, ולכן true כאן פירושו „נחסם כראוי".
  (api) => {
    try {
      api.planModeChange({ current: 'off', target: 'shadow',
        actor: { uid: 'u', role: 'commander' }, confirmation: 'shadow',
        reason_code: 'כי ככה', readiness: READY });
      return false;
    } catch (_) { return true; }
  });

survives('9.6 מוכנות מפסיקה להיבדק',
  "if (target !== MODE.OFF) {",
  "if (false) {",
  // התנהגות תקינה = **נזרקת** שגיאה. `survives` מצפה שה-check
  // ידווח על ההתנהגות התקינה, ולכן true כאן פירושו „נחסם כראוי".
  (api) => {
    try {
      api.planModeChange({ current: 'off', target: 'shadow',
        actor: { uid: 'u', role: 'commander' }, confirmation: 'shadow',
        reason_code: 'initial_activation',
        readiness: { policy: false, source: false, people: 0 } });
      return false;
    } catch (_) { return true; }
  });

// ⭐ 9.7 — הכיוון ההפוך: כיבוי מתחיל לדרוש מוכנות. מתג חירום
// שמפסיק לעבוד כשהמערכת שבורה הוא בדיוק מה שאסור.
survives('9.7 כיבוי מתחיל לדרוש מוכנות',
  "if (target !== MODE.OFF) {",
  "if (true) {",
  (api) => {
    try {
      api.planModeChange({ current: 'new', target: 'off',
        actor: { uid: 'u', role: 'commander' }, confirmation: 'off',
        reason_code: 'operational_safety',
        readiness: { policy: false, source: false, people: 0 } });
      return true;
    } catch (_) { return false; }
  });

survives('9.8 ההרשאה נבדקת אחרי המוכנות',
  "if (!mayChangeMode(actor)) {",
  "if (false && !mayChangeMode(actor)) {",
  // התנהגות תקינה = **נזרקת** שגיאה. `survives` מצפה שה-check
  // ידווח על ההתנהגות התקינה, ולכן true כאן פירושו „נחסם כראוי".
  (api) => {
    try {
      api.planModeChange({ current: 'off', target: 'shadow',
        actor: { uid: 'u', role: 'firefighter' }, confirmation: 'shadow',
        reason_code: 'initial_activation', readiness: READY });
      return false;
    } catch (_) { return true; }
  });

/* ==================================================================
 * סיכום
 * ================================================================== */

if (fails.length) {
  console.error('schedule-mode-authority-probe · נכשל');
  for (const f of fails) console.error('  ✗ ' + f);
  console.error('  ' + pass + ' עברו · ' + fails.length + ' נכשלו');
  process.exit(1);
}
console.log('schedule-mode-authority-probe · ' + pass + '/' + pass + ' עברו');
console.log('  לא נבדק כאן: כללי Firestore והתנגשות טרנזקציה אמיתית.');
