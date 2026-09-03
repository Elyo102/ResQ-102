'use strict';

/* ======================================================================
 * יומן תקלות תוכנה — שגיאות בלקוח וקריאות שרת שנכשלו.
 *
 * מה זה **כן**: רשומה אחת לכל טביעת-אצבע של תקלה (תחנה + סוג + מסך +
 * קוד + הודעה מנורמלת), עם מונה, „נראה לראשונה", „נראה לאחרונה",
 * הגרסאות והמסכים שבהם הופיעה, ודוגמה אחת של ההודעה.
 *
 * מה זה **לא**: יומן של אנשים. ⭐ הרשומה אינה נושאת uid, שם, דוא"ל,
 * מספר עובד או טלפון — לא של המדווח ולא של מי שמוזכר בהודעה.
 * ההודעה עוברת ניקוי דפוסים (דוא"ל, טלפון, מזהי Firebase, מחרוזות
 * שאילתה) ונחתכת. מה שלא ניתן לנקות באופן אמין — שם בעברית בתוך
 * טקסט חופשי — לא נכנס מלכתחילה: אין כאן שדה טקסט חופשי מהמשתמש,
 * רק מה שהדפדפן זרק. לחוות דעת של אנשים יש מודול משלה (`feedback.js`).
 *
 * המודול אינו יודע Firebase Admin. `db`, `FieldValue`, `HttpsError`,
 * `hash` ו-`clock` מוזרקים, ולכן הגבול נבדק בלי פרויקט חי. אין כאן
 * `console.*` — פלט תפעולי הוא הרשומה עצמה, לא לוג.
 *
 * התחנה נקבעת מה-claim של הטוקן בלבד. לקוח ששולח `stationId` נדחה.
 * ====================================================================== */

const KINDS = Object.freeze(['client-error', 'unhandled-rejection', 'callable-failed', 'manual']);
const STATUSES = Object.freeze(['open', 'resolved', 'ignored']);

const LIMITS = Object.freeze({
  screen: 64,
  version: 24,
  code: 80,
  message: 300,
  frame: 200,
  callable: 64,
  role: 40,
  fingerprintText: 120,
  screensPerIncident: 12,
  versionsPerIncident: 12,
  rolesPerIncident: 12
});

const INCIDENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DAY_TTL_MS = 3 * 24 * 60 * 60 * 1000;
// תקרה יומית לתחנה. לולאת שגיאה בדף אחד לא תמלא את בסיס הנתונים.
const DAY_CAP = 500;

const STATION_ID_RE = /^[a-z0-9_-]{2,80}$/;
// אותו חוזה כמו schedule-access.AUTH_UID_RE.
const UID_RE = /^[^\u0000-\u001F\u007F/]{1,128}$/;
const SCREEN_RE = /^[a-z0-9-]{1,48}\.html$/;
const VERSION_RE = /^[A-Za-z0-9.\-]{1,24}$/;
const CODE_RE = /^[A-Za-z0-9_\-/.:]{0,80}$/;
const CALLABLE_RE = /^[A-Za-z0-9_]{0,64}$/;
const FINGERPRINT_RE = /^[a-f0-9]{40}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const ALLOWED_INPUT = Object.freeze([
  'kind', 'screen', 'version', 'code', 'message', 'frame', 'callable'
]);

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const out = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return out.length > max ? out.slice(0, max) : out;
}

/* ⭐ ניקוי דפוסים. זו רשימה של מה שאפשר לזהות באופן מכני; היא אינה
 * מבטיחה היעדר מידע אישי, ולכן ההודעה נחשבת „טכנית" רק כשהמקור שלה
 * הוא הדפדפן ולא אדם. הסדר: דוא"ל לפני טלפון, כי כתובת יכולה להכיל
 * ספרות. מזהי Firebase (28 תווים) ומחרוזות hex ארוכות מוחלפים גם הם —
 * הם מזהים אדם או מסמך, ואינם נחוצים לקיבוץ. */
const SCRUB_RULES = Object.freeze([
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\?[^\s"'<>]*/g, '?[query]'],
  [/(?:\+?\d[\d\-\s()]{6,}\d)/g, '[phone]'],
  [/\b[A-Za-z0-9]{28}\b/g, '[uid]'],
  [/\b[a-f0-9]{24,}\b/g, '[hex]'],
  [/\b\d{5,}\b/g, '[num]']
]);

function scrub(value) {
  let out = String(value || '');
  let touched = false;
  for (const [pattern, replacement] of SCRUB_RULES) {
    const next = out.replace(pattern, replacement);
    if (next !== out) touched = true;
    out = next;
  }
  return { text: out, scrubbed: touched };
}

/* טביעת אצבע: אותה תקלה בהודעות שנבדלות רק במספרים או ברווחים היא
 * רשומה אחת. */
function normalizeForFingerprint(message) {
  return String(message || '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.fingerprintText);
}

function dayKey(iso) {
  return String(iso).slice(0, 10);
}

function createIncidentLog(deps) {
  const d = plain(deps) ? deps : {};
  const db = d.db;
  const FieldValue = d.FieldValue;
  const HttpsError = d.HttpsError;
  const hash = d.hash;
  const clock = typeof d.clock === 'function' ? d.clock : () => new Date().toISOString();

  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('db with collection and runTransaction is required');
  }
  if (!FieldValue || typeof FieldValue.serverTimestamp !== 'function'
      || typeof FieldValue.increment !== 'function'
      || typeof FieldValue.arrayUnion !== 'function') {
    throw new TypeError('FieldValue.serverTimestamp/increment/arrayUnion are required');
  }
  if (typeof HttpsError !== 'function') throw new TypeError('HttpsError is required');
  if (typeof hash !== 'function') throw new TypeError('hash is required');

  function fail(code, message) {
    return new HttpsError(code, message);
  }

  function stationRef(sid) {
    return db.collection('stations').doc(sid);
  }
  function incidentRef(sid, fingerprint) {
    return stationRef(sid).collection('incidents').doc(fingerprint);
  }
  function dayRef(sid, day) {
    return stationRef(sid).collection('incident_days').doc(day);
  }

  function requireAuth(req) {
    if (!req || !req.auth || !UID_RE.test(String(req.auth.uid || ''))) {
      throw fail('unauthenticated', 'צריך להיות מחובר.');
    }
    return req.auth;
  }

  /* התחנה: מהטוקן בלבד. שדה `stationId` בבקשה הוא שגיאה, לא רמז. */
  function callerStation(req, auth) {
    const data = req && req.data;
    if (plain(data) && Object.prototype.hasOwnProperty.call(data, 'stationId')) {
      throw fail('invalid-argument', 'התחנה נקבעת לפי ההרשאות של החשבון ואינה נשלחת מהלקוח.');
    }
    const sid = String((auth && auth.token && auth.token.stationId) || '');
    if (!STATION_ID_RE.test(sid)) {
      throw fail('failed-precondition', 'לחשבון אין שיוך תקין לתחנה.');
    }
    return sid;
  }

  function dataOf(req) {
    const data = req && req.data === undefined ? {} : (req && req.data);
    if (!plain(data)) throw fail('invalid-argument', 'נתוני הבקשה אינם תקינים.');
    const keys = Object.keys(data);
    if (keys.some((key) => ALLOWED_INPUT.indexOf(key) === -1)) {
      throw fail('invalid-argument', 'הדיווח אינו מקבל תחנה, זהות או שדות נוספים.');
    }
    return data;
  }

  /* בונה את הרשומה מהקלט. מחזיר אובייקט טהור; לא נוגע ב-db. */
  function planIncident(sid, role, data) {
    const kind = String(data.kind || '');
    if (KINDS.indexOf(kind) === -1) throw fail('invalid-argument', 'סוג הדיווח אינו מוכר.');

    const screen = text(data.screen, LIMITS.screen);
    if (screen === null || !SCREEN_RE.test(screen)) {
      throw fail('invalid-argument', 'שם המסך אינו תקין.');
    }
    const version = text(data.version, LIMITS.version);
    if (version === null || !VERSION_RE.test(version)) {
      throw fail('invalid-argument', 'גרסת האפליקציה אינה תקינה.');
    }
    const code = text(data.code, LIMITS.code);
    if (code === null || !CODE_RE.test(code)) throw fail('invalid-argument', 'קוד השגיאה אינו תקין.');
    const callable = text(data.callable, LIMITS.callable);
    if (callable === null || !CALLABLE_RE.test(callable)) {
      throw fail('invalid-argument', 'שם הפעולה אינו תקין.');
    }
    if (kind === 'callable-failed' && !callable) {
      throw fail('invalid-argument', 'דיווח על פעולת שרת חייב לשאת את שם הפעולה.');
    }

    const rawMessage = text(data.message, LIMITS.message);
    const rawFrame = text(data.frame, LIMITS.frame);
    if (rawMessage === null || rawFrame === null) {
      throw fail('invalid-argument', 'ההודעה או המיקום אינם מחרוזת.');
    }
    if (!rawMessage && !code) {
      throw fail('invalid-argument', 'דיווח ריק: אין הודעה ואין קוד.');
    }
    const message = scrub(rawMessage);
    const frame = scrub(rawFrame);

    const fingerprint = String(hash(
      'incident|' + sid + '|' + kind + '|' + screen + '|' + code + '|'
      + normalizeForFingerprint(message.text)
    )).slice(0, 40);
    if (!FINGERPRINT_RE.test(fingerprint)) {
      throw fail('internal', 'טביעת האצבע אינה תקינה.');
    }

    return Object.freeze({
      fingerprint,
      kind,
      screen,
      version,
      code,
      callable,
      message: message.text,
      frame: frame.text,
      scrubbed: message.scrubbed || frame.scrubbed,
      role: text(role, LIMITS.role) || 'unknown'
    });
  }

  /* --- הדיווח עצמו ------------------------------------------------ */
  async function report(req) {
    const auth = requireAuth(req);
    const sid = callerStation(req, auth);
    const data = dataOf(req);
    const role = auth.token && typeof auth.token.role === 'string' ? auth.token.role : '';
    const plan = planIncident(sid, role, data);

    const nowIso = clock();
    const now = new Date(nowIso).getTime();
    if (!Number.isFinite(now)) throw fail('internal', 'השעון אינו תקין.');
    const day = dayKey(nowIso);
    if (!DAY_RE.test(day)) throw fail('internal', 'השעון אינו תקין.');

    const ref = incidentRef(sid, plan.fingerprint);
    const dRef = dayRef(sid, day);

    return db.runTransaction(async (tx) => {
      const [daySnap, snap] = await Promise.all([tx.get(dRef), tx.get(ref)]);
      const dayData = daySnap.exists ? (daySnap.data() || {}) : {};
      const dayCount = Number(dayData.count || 0);
      if (dayCount >= DAY_CAP) {
        /* ⭐ לא זורקים: זריקה הייתה מייצרת בלקוח עוד דחייה-לא-מטופלת,
         * ועוד דיווח. מחזירים „לא התקבל" והלקוח שותק. */
        return { accepted: false, reason: 'day-cap', fingerprint: plan.fingerprint };
      }
      tx.set(dRef, {
        day,
        count: FieldValue.increment(1),
        expires_at: new Date(now + DAY_TTL_MS)
      }, { merge: true });

      const exists = snap.exists;
      const current = exists ? (snap.data() || {}) : {};
      const base = {
        station_id: sid,
        fingerprint: plan.fingerprint,
        kind: plan.kind,
        code: plan.code,
        callable: plan.callable,
        last_seen: FieldValue.serverTimestamp(),
        last_seen_iso: nowIso,
        last_version: plan.version,
        last_message: plan.message,
        last_frame: plan.frame,
        count: FieldValue.increment(1),
        screens: FieldValue.arrayUnion(plan.screen),
        versions: FieldValue.arrayUnion(plan.version),
        roles: FieldValue.arrayUnion(plan.role),
        scrubbed: plan.scrubbed || current.scrubbed === true,
        expires_at: new Date(now + INCIDENT_TTL_MS)
      };
      if (!exists) {
        Object.assign(base, {
          status: 'open',
          first_seen: FieldValue.serverTimestamp(),
          first_seen_iso: nowIso,
          first_version: plan.version,
          first_screen: plan.screen,
          sample_message: plan.message,
          sample_frame: plan.frame,
          resolved_at: null,
          resolved_by: null,
          note: null
        });
      } else if (current.status === 'resolved' && current.last_version !== plan.version) {
        /* תקלה שנפתרה וחזרה בגרסה אחרת — נפתחת מחדש, והפתרון הישן נשמר
         * ב-`reopened_from`. תקלה שחזרה באותה גרסה נשארת „נפתרה" עם
         * מונה עולה: זה כנראה משתמש שעדיין לא עדכן. */
        Object.assign(base, {
          status: 'open',
          reopened_from: {
            resolved_at: current.resolved_at || null,
            resolved_by: current.resolved_by || null,
            version: current.last_version || null
          }
        });
      }
      tx.set(ref, base, { merge: true });
      return {
        accepted: true,
        fingerprint: plan.fingerprint,
        count: Number(current.count || 0) + 1,
        first: !exists
      };
    });
  }

  /* --- כלים לצד המנהל (סקריפט הייצוא, admin SDK) ------------------ */

  async function list(options) {
    const o = plain(options) ? options : {};
    const sid = String(o.sid || '');
    if (!STATION_ID_RE.test(sid)) throw new TypeError('sid is required');
    const limit = Math.min(Math.max(Number(o.limit || 500), 1), 2000);
    const snap = await stationRef(sid).collection('incidents').get();
    const rows = [];
    for (const docSnap of snap.docs) {
      const data = docSnap.data() || {};
      if (o.status && data.status !== o.status) continue;
      rows.push(Object.assign({ id: docSnap.id }, data));
    }
    rows.sort((a, b) => String(b.last_seen_iso || '').localeCompare(String(a.last_seen_iso || '')));
    return rows.slice(0, limit);
  }

  /* סימון טיפול. `by` הוא תווית („codex", „claude", „eldad"), לא uid. */
  async function setStatus(options) {
    const o = plain(options) ? options : {};
    const sid = String(o.sid || '');
    const fingerprint = String(o.fingerprint || '');
    const status = String(o.status || '');
    // תווית, לא זהות — ולא נחתכת: תווית ארוכה מדי היא שגיאה.
    const by = typeof o.by === 'string' ? o.by : '';
    const note = text(o.note, 300);
    if (!STATION_ID_RE.test(sid)) throw new TypeError('sid is required');
    if (!FINGERPRINT_RE.test(fingerprint)) throw new TypeError('fingerprint is not valid');
    if (STATUSES.indexOf(status) === -1) throw new TypeError('status is not valid');
    if (!by || !/^[a-z]{2,40}$/.test(by)) throw new TypeError('by must be a label, not an identity');
    if (note === null) throw new TypeError('note must be a string');
    const ref = incidentRef(sid, fingerprint);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('incident-not-found');
      const patch = { status };
      if (status === 'open') {
        patch.resolved_at = null;
        patch.resolved_by = null;
      } else {
        patch.resolved_at = clock();
        patch.resolved_by = by;
      }
      if (note) patch.note = scrub(note).text;
      tx.set(ref, patch, { merge: true });
      return Object.assign({ fingerprint }, patch);
    });
  }

  return Object.freeze({ report, list, setStatus, planIncident });
}

module.exports = Object.freeze({
  createIncidentLog,
  scrub,
  normalizeForFingerprint,
  KINDS,
  STATUSES,
  LIMITS,
  DAY_CAP,
  INCIDENT_TTL_MS,
  DAY_TTL_MS
});
