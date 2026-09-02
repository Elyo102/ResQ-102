// =====================================================================
//  ResQ-102 — Cloud Functions
//  שכבת היסוד: זהות, תפקידים ומספרי עובד
//
//  שלושה עקרונות
//  --------------
//  1. התפקיד יושב בטוקן ההזדהות, לא במסמך. כללי האבטחה קוראים
//     אותו ישירות — אפס קריאות מסמך לכל בדיקת הרשאה.
//
//  2. מספר העובד מוקצה על ידי המערכת, לא מוזן ביד. הוא מזהה את
//     הכבאי בכל הדיווחים שלו, והוא גם הגנה מפני התחזות — ולכן
//     אינו גלוי לכבאים אחרים.
//
//  3. רק קוד שרת כותב לטוקן. זה הקובץ הזה.
// =====================================================================

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const crypto = require('crypto');
const bulletin = require('./bulletin');
const attendanceShadow = require('./attendance-shadow-runner');
const bulkImportDisabled = require('./bulk-import-disabled');
const registrationSafety = require('./registration-safety');
const identityCoordinatorModule = require('./identity-coordinator');
const scheduleCalendar = require('./schedule-calendar-engine');
const schedulePublication = require('./schedule-publication');
const scheduleService = require('./schedule-service');
const scheduleRuntimeModule = require('./schedule-runtime');
const scheduleAccessAdminModule = require('./schedule-access-admin');
const stationTransferModule = require('./station-transfer');

admin.initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });

// ---------------------------------------------------------------------
//  קבועים
// ---------------------------------------------------------------------

// מנהל-העל. חייב להיות זהה לערך ב-firestore.rules.
const SUPER_ADMIN_EMAIL = 'fire102.shits@gmail.com';

// סגן מפקד משמרת ומפקד תחנה נוספו 23.8.2026.
//
//   deputy            סגן מפקד משמרת. סמכויותיו זהות למפקד
//                     המשמרת, ונעול לאותה משמרת. אלדד חוזר
//                     בכל דרישה על "מפקד משמרת או סגנו", ולכן
//                     זה תפקיד ולא הערה
//   station_commander מפקד התחנה. רואה את שלוש המשמרות, והוא
//                     היחיד שמאשר ירידה מתחת לקו האדום
//   team_leader        מפקד צוות. נוסף 25.8.2026.
//   deputy_team_leader סגן מפקד צוות.
//                     שניהם דרגות שטח: הסמכות היחידה שהם
//                     מקבלים היא לכתוב בלוג המשמרת. בכל השאר
//                     הם לוחם אש לכל דבר — אינם מאשרים טפסים,
//                     אינם מאשרים שעות ואינם רואים נתוני אחרים.
//
// ⚠️ הרשימה הזאת חייבת להיות זהה ל-VALID_ROLES ב-roles.js.
//    השרת אינו יכול לייבא מודול דפדפן, ולכן היא משוכפלת —
//    ו-tests/roles.mjs נופל אם השתיים יוצאות מסנכרון.
const VALID_ROLES = [
  'firefighter', 'deputy_team_leader', 'team_leader',
  'deputy', 'commander', 'station_commander',
  'hr_coordinator', 'district_commander'
];
const VALID_SHIFTS = ['A', 'B', 'C'];

// ---------- מי רשאי לשבץ תפקיד למי ----------
//
// ⚠️ שתי הטבלאות האלה חייבות להיות זהות ל-ROLES ו-ASSIGN_MAX_RANK
//    ב-roles.js. tests/roles.mjs נופל אם הן יוצאות מסנכרון.
//
// אלדד, 25.8.2026: רכזת כוח אדם משבצת "עד סגן מפקד משמרת" —
// כלומר עד דרגה 3, מפקד צוות, כולל.
//
// באפליקציה שהתחנה משתמשת בה היום שיבוץ תפקיד נעול לקוד אחד
// בלבד, עם הערה מפורשת בקוד: "כדי שאף אחד לא יוכל לשדרג את
// עצמו למנהל בטעות או בזדון". פתחנו את זה לרכזת כי בלעדיה
// היא לא יכולה לעבוד — אבל פתיחה **בלי תקרה** אינה מתן הרשאה,
// היא מסירת המערכת: מי שיכול למנות מפקד יכול למנות את עצמה.
const ROLE_RANK = {
  firefighter: 1, deputy_team_leader: 2, team_leader: 3,
  deputy: 4, commander: 5, station_commander: 6,
  hr_coordinator: 6, district_commander: 7
};

const ASSIGN_MAX_RANK = { hr_coordinator: 3 };

function rankOf(role) {
  return ROLE_RANK[String(role || '')] || 0;
}

// המחוזות מאומתים בשרת. עד עכשיו הרשימה חיה רק בקוד הדפדפן,
// כלומר כל מחרוזת שהגיעה מהטופס נכנסה כמות שהיא להרשאות.
const KNOWN_DISTRICTS = ['south', 'center', 'north', 'jerusalem', 'haifa', 'dan'];

// המפתח הציבורי של אפליקציית הווב. מופיע ממילא ב-firebase-config.js
// ונשלח לכל דפדפן — הוא מזהה את הפרויקט, לא מעניק גישה.
const WEB_API_KEY = 'AIzaSyDY13rUZCN0q2Izo8i59JHKmWvnu_0Tw7Q';

// מספרי עובד ארציים, לא לפי תחנה — כדי שמספר יזהה אדם אחד בכל
// המדינה גם אחרי מעבר בין תחנות או מחוזות.
const EMP_START = 1;

// הגנה מפני ניחוש סיסמאות בכניסה עם מספר עובד.
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES   = 15;

// כתובת האתר, לבניית קישורים במיילים.
const SITE_URL = 'https://elyo102.github.io/ResQ-102';

// קישור שחרור נעילה תקף לשעה. אחריה צריך לחכות או לבקש חדש.
const UNLOCK_TOKEN_MINUTES = 60;

const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const identityCoordinator = identityCoordinatorModule.createIdentityCoordinator({
  db: db,
  auth: admin.auth(),
  FieldValue: FV,
  Timestamp: admin.firestore.Timestamp,
  HttpsError: HttpsError,
  randomId: function () { return crypto.randomBytes(16).toString('hex'); },
  // פעולות הזהות מוגבלות ל-120 שניות. גדר של שלוש דקות מונעת
  // מ-worker ישן שהתעורר מאוחר לדרוס פעולה חדשה על אותו משתמש.
  leaseMs: 5 * 60 * 1000,
  fenceMs: 3 * 60 * 1000
});
const attendanceShadowService = attendanceShadow.createAttendanceShadowService({
  db: db,
  admin: admin
});
const scheduleRuntime = scheduleRuntimeModule.createScheduleRuntime({
  db: db,
  FieldValue: FV,
  FieldPath: admin.firestore.FieldPath,
  clock: function () { return new Date().toISOString(); },
  hash: function (value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
  },
  randomId: randomToken,
  createEngine: scheduleCalendar.createCalendarEngine,
  createPublication: schedulePublication.createPublication,
  createService: scheduleService.createScheduleService,
  isSuper: isSuperAdmin,
  sendPush: async function (sid, uid, type, title, body, url, important) {
    const result = await pushToOne(sid, uid, type, title, body, url, important);
    if (!result || result.failed || Number(result.sent || 0) < 1) {
      const code = result && result.error_code
        ? result.error_code : 'NO_ACTIVE_PUSH_TOKEN';
      const error = new Error(code);
      error.code = code;
      throw error;
    }
    return result;
  }
});
const scheduleAccessAdmin = scheduleAccessAdminModule.createScheduleAccessAdmin({
  db: db,
  getUser: function (uid) { return admin.auth().getUser(uid); },
  isSuper: isSuperAdmin,
  HttpsError: HttpsError,
  FieldValue: FV,
  openAudit: openAudit,
  sealAudit: sealAudit
});

// The browser catalogue currently contains one regional station.  Future
// stations can be activated without trusting a client value by creating a
// server-owned stations/{sid} document with districtId and active=true.
const BUILTIN_TRANSFER_STATIONS = Object.freeze({
  eilat_102: Object.freeze({
    id: 'eilat_102', name: 'תחנת כיבוי אילת', districtId: 'south', active: true
  })
});

async function resolveTransferStation(stationId, tx) {
  const sid = String(stationId || '');
  if (!STATION_ID_RE.test(sid)) return null;
  const ref = db.collection('stations').doc(sid);
  const snap = tx && typeof tx.get === 'function' ? await tx.get(ref) : await ref.get();
  if (!snap.exists) return BUILTIN_TRANSFER_STATIONS[sid] || null;
  const value = snap.data() || {};
  const districtId = String(value.districtId || '');
  if (value.active !== true || KNOWN_DISTRICTS.indexOf(districtId) === -1) return null;
  return {
    id: sid,
    name: String(value.name || sid).slice(0, 160),
    districtId: districtId,
    active: true
  };
}

async function listTransferStations() {
  const byId = {};
  Object.keys(BUILTIN_TRANSFER_STATIONS).forEach(function (sid) {
    byId[sid] = BUILTIN_TRANSFER_STATIONS[sid];
  });
  const snap = await db.collection('stations').limit(250).get();
  (snap.docs || []).forEach(function (doc) {
    const sid = String(doc.id || '');
    if (!STATION_ID_RE.test(sid)) return;
    const value = doc.data() || {};
    const districtId = String(value.districtId || '');
    if (value.active !== true || KNOWN_DISTRICTS.indexOf(districtId) === -1) {
      delete byId[sid];
      return;
    }
    byId[sid] = {
      id: sid,
      name: String(value.name || sid).slice(0, 160),
      districtId: districtId,
      active: true
    };
  });
  return Object.keys(byId).sort().map(function (sid) { return byId[sid]; });
}

const stationTransfer = stationTransferModule.createStationTransferService({
  db: db,
  getUser: function (uid) { return admin.auth().getUser(uid); },
  isSuper: isSuperAdmin,
  HttpsError: HttpsError,
  FieldValue: FV,
  identityCoordinator: identityCoordinator,
  stableHash: identityCoordinatorModule.stableHash,
  namePrefixes: namePrefixes,
  rankOf: rankOf,
  resolveStation: resolveTransferStation,
  listStations: listTransferStations
});

// ---------------------------------------------------------------------
//  שליחת מייל
//
//  Firebase Auth יודע לשלוח רק מיילים משלו — אימות ואיפוס.
//  כדי לשלוח מייל עם תוכן שלנו, המסמך נכתב לאוסף mail, ותוסף
//  Trigger Email של Firebase שולח אותו בפועל.
//
//  המבנה כאן הוא בדיוק מה שהתוסף מצפה לו. עד שהוא יותקן,
//  המיילים נצברים באוסף ולא נשלחים — שום דבר לא נשבר.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
//  מצב שקט — תקופת הניסוי
// ---------------------------------------------------------------------
//
//  אלדד: "זה יכול להיות גם בסיס ניסויים מבלי לשלוח להם באמת
//  הודעות."
//
//  **למה זה יושב כאן ולא במסכים.** שתי פונקציות בקובץ הזה הן
//  הפתח היחיד החוצה — sendMail ו-pushToUsers. כל התראה, כל מייל
//  וכל קריאת פתע עוברים באחת מהן. חסימה כאן היא חסימה מלאה;
//  חסימה בכל מסך בנפרד הייתה שוכחת אחד, וזה היה מתגלה כשכבאי
//  אמיתי מקבל הזעקת בדיקה בשלוש לפנות בוקר.
//
//  **מה שלא נחסם: אלדד עצמו.** בלי זה אי אפשר לדעת אם השליחה
//  בכלל עובדת — ו"שקט" ו"שבור" ייראו אותו דבר בדיוק עד יום
//  הפעלת המערכת.
//
//  כל חסימה נרשמת ב-silenced/, כדי שבסוף הניסוי תהיה רשימה של
//  מה היה נשלח לו המערכת הייתה חיה.

const RUNTIME_DOC = 'config/runtime';
let _rt = null, _rtAt = 0;

async function runtime() {
  // 30 שניות מטמון. הדגל נקרא בכל שליחה, וקריאת מסמך לכל התראה
  // הייתה מכפילה את עלות המשלוח בלי להוסיף דיוק.
  const now = Date.now();
  if (_rt && now - _rtAt < 30000) return _rt;
  try {
    const d = await db.doc(RUNTIME_DOC).get();
    _rt = (d.exists ? d.data() : {}) || {};
  } catch (e) { _rt = {}; }
  _rtAt = now;
  return _rt;
}

// uid או אימייל שפטורים מהשקט.
async function silentFor(who) {
  const rt = await runtime();
  if (rt.silent !== true) return false;
  const allow = Array.isArray(rt.silent_allow) ? rt.silent_allow : [];
  const key = String(who || '').toLowerCase();
  return allow.indexOf(key) === -1;
}

async function logSilenced(kind, to, subject) {
  try {
    await db.collection('silenced').add({
      kind: kind, to: String(to || ''), subject: String(subject || '').slice(0, 200),
      at: FV.serverTimestamp()
    });
  } catch (e) {}
}

// מסמך ב-Firestore מוגבל למגה אחד, **כולל שמות השדות**.
// 900KB משאיר מקום לנושא, לנמענים ולחותמות הזמן.
const MAIL_MAX_HTML = 900000;

// מחזירה true אם המייל אכן נכנס לתור.
//
// ⚠️ הערך המוחזר אינו קישוט. עד 25.8.2026 הפונקציה בלעה כל
// שגיאה ו-console.error בלבד, והקורא — buildAndSendMonthly —
// רשם ב-hr_reports ש"הדוח נשלח" בלי לבדוק כלום. כלומר ביום
// שבו הדוח ייכשל, רישום הביקורת יטען שהוא הצליח.
async function sendMail(to, subject, html) {
  if (!to) return false;
  if (await silentFor(to)) { await logSilenced('mail', to, subject); return true; }

  const size = Buffer.byteLength(String(html || ''), 'utf8');
  if (size > MAIL_MAX_HTML) {
    console.error('mail too large', { to: to, subject: subject, bytes: size });
    return false;
  }

  try {
    await db.collection('mail').add({
      to: [to],
      message: { subject: subject, html: html },
      created_at: FV.serverTimestamp()
    });
    return true;
  } catch (e) {
    console.error('mail queue failed', e);
    return false;
  }
}

// גודל ה-HTML בבייטים. עברית היא שני בייטים לתו, ולכן ספירת
// תווים הייתה נותנת חצי מהמספר האמיתי.
function htmlBytes(s) { return Buffer.byteLength(String(s || ''), 'utf8'); }

function mailShell(title, bodyHtml) {
  return '<div dir="rtl" style="font-family:Arial,sans-serif;background:#f4f6f8;' +
         'padding:24px"><div style="max-width:520px;margin:0 auto;background:#fff;' +
         'border-radius:12px;padding:26px">' +
         '<h2 style="margin:0 0 4px;color:#222">ResQ</h2>' +
         '<div style="color:#888;font-size:13px;margin-bottom:20px">ניהול תחנה · תחנה 102</div>' +
         '<h3 style="margin:0 0 12px;color:#222">' + title + '</h3>' +
         bodyHtml +
         '<div style="margin-top:26px;padding-top:14px;border-top:1px solid #eee;' +
         'color:#999;font-size:12px">מייל אוטומטי. אין להשיב עליו.</div>' +
         '</div></div>';
}

function button(href, text) {
  return '<a href="' + href + '" style="display:inline-block;background:#e8590c;' +
         'color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;' +
         'font-size:15px;margin:8px 0">' + text + '</a>';
}

// Math.random אינו מחולל אקראיות קריפטוגרפית — אפשר לשחזר את
// מצבו מכמה פלטים, ומופעי הפונקציות ממוחזרים בין קריאות.
function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ---------------------------------------------------------------------
//  עזרים
// ---------------------------------------------------------------------

function requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'צריך להיות מחובר.');
  return req.auth;
}

function isSuperAdmin(auth) {
  if (auth.token.super === true) return true;
  return String(auth.token.email || '').toLowerCase() === SUPER_ADMIN_EMAIL;
}

function requireSuperAdmin(req) {
  const auth = requireAuth(req);
  if (!isSuperAdmin(auth)) {
    throw new HttpsError('permission-denied', 'הפעולה מותרת למנהל המערכת בלבד.');
  }
  return auth;
}

// מזהה התחנה לפעולות שהמשתמש מפעיל נקבע רק מההרשאות
// החתומות שלו. אין ברירת מחדל לתחנת הפיילוט: חשבון ללא
// שיוך תקין נעצר כדי שלא יכתוב בטעות נתונים לתחנה אחרת.
const STATION_ID_RE = /^[a-z0-9_-]{2,80}$/;

function callerStation(req, auth) {
  const data = (req && req.data) || null;
  if (data && Object.prototype.hasOwnProperty.call(data, 'stationId')) {
    throw new HttpsError('invalid-argument',
      'התחנה נקבעת לפי ההרשאות של החשבון ואינה נשלחת מהלקוח.');
  }

  const sid = String((auth && auth.token && auth.token.stationId) || '');
  if (!sid) {
    throw new HttpsError('failed-precondition',
      'לחשבון אין שיוך לתחנה. פנה למנהל המערכת.');
  }
  if (!STATION_ID_RE.test(sid)) {
    throw new HttpsError('failed-precondition',
      'שיוך התחנה בחשבון אינו תקין. פנה למנהל המערכת.');
  }
  return sid;
}

// ---------- שער השיבוץ ----------
//
// מחזיר את המשתמש המחובר ואת התקרה שלו. מנהל-על מקבל Infinity;
// כל תפקיד שאינו בטבלה מקבל 0, כלומר נדחה. ברירת מחדל אוסרת —
// תפקיד חדש שיתווסף למערכת לא יקבל סמכות שיבוץ בהיסח הדעת.
function requireRoleSetter(req) {
  const auth = requireAuth(req);
  if (isSuperAdmin(auth)) return { auth: auth, cap: Infinity, sid: '', did: '' };

  const cap = ASSIGN_MAX_RANK[String(auth.token.role || '')] || 0;
  if (!cap) {
    throw new HttpsError('permission-denied',
      'שיבוץ תפקידים מותר למנהל המערכת ולרכז/ת כוח אדם בלבד.');
  }
  const sid = String(auth.token.stationId || '');
  const did = String(auth.token.districtId || '');
  if (!sid || !did || KNOWN_DISTRICTS.indexOf(did) === -1) {
    throw new HttpsError('permission-denied',
      'לחשבון המשבץ חסר שיוך תחנה או מחוז תקין. פנה למנהל המערכת.');
  }
  return { auth: auth, cap: cap, sid: sid, did: did };
}

// שלוש בדיקות, ולכל אחת יש תרחיש שהיא מונעת.
//
//  1. התפקיד החדש מתחת לתקרה — אחרת הרכזת ממנה מפקד משמרת.
//  2. התפקיד **הקיים** של היעד מתחת לתקרה — אחרת היא מדיחה
//     מפקד לדרגת לוחם. הורדה בדרגה היא שינוי סמכות בדיוק כמו
//     העלאה, ומי שאינו רשאי למנות מפקד אינו רשאי לפרק אותו.
//  3. לא על עצמה, ולא דגל מנהל-על. בלי אלה כל התקרה מיותרת:
//     די בפעולה אחת על החשבון של עצמה כדי לעקוף אותה.
function assertMayAssign(gate, targetRole, targetBefore, targetUid, wantSuper, targetDesired) {
  if (gate.cap === Infinity) return;

  const beforeRole = String((targetBefore || {}).role || '');

  if (targetUid && targetUid === gate.auth.uid) {
    throw new HttpsError('permission-denied',
      'אי אפשר לשנות את התפקיד של עצמך. בקש ממנהל המערכת.');
  }
  if (wantSuper || (targetBefore || {}).super === true) {
    throw new HttpsError('permission-denied',
      'הרשאת מנהל מערכת ניתנת ומוסרת על ידי מנהל מערכת בלבד.');
  }
  if (targetRole && rankOf(targetRole) > gate.cap) {
    throw new HttpsError('permission-denied',
      'אפשר לשבץ עד ' + heRole(rankName(gate.cap)) + '. ' +
      'שיבוץ ל' + heRole(targetRole) + ' מותר למנהל המערכת בלבד.');
  }
  if (beforeRole && rankOf(beforeRole) > gate.cap) {
    throw new HttpsError('permission-denied',
      'האדם הזה מוגדר כ' + heRole(beforeRole) + '. ' +
      'שינוי תפקיד למי שדרגתו מעל ' + heRole(rankName(gate.cap)) +
      ' מותר למנהל המערכת בלבד.');
  }
  // תחנה ומחוז נבדקים גם במצב הקודם וגם בתוכנית החדשה. בדיקה
  // של התחנה הקודמת בלבד הייתה מאפשרת ללקוח מותאם להעביר אדם
  // לתחנה אחרת. claims חלקיים של המשבץ נכשלים כבר בשער למעלה.
  if (!registrationSafety.withinRoleSetterScope(
      gate, targetBefore || {}, targetDesired || {})) {
    throw new HttpsError('permission-denied',
      'אפשר לשנות תפקידים רק בתוך התחנה והמחוז של המשבץ.');
  }
}

function rankName(cap) {
  const hit = Object.keys(ROLE_RANK).filter(function (k) {
    return ROLE_RANK[k] === cap;
  });
  return hit[0] || '';
}

const ROLE_HE_SRV = {
  firefighter: 'לוחם אש', deputy_team_leader: 'סגן מפקד צוות',
  team_leader: 'מפקד צוות', deputy: 'סגן מפקד משמרת',
  commander: 'קצין / מפקד משמרת', station_commander: 'מפקד תחנה',
  hr_coordinator: 'רכז/ת משאבי אנוש', district_commander: 'מפקד מחוז'
};

function heRole(id) {
  return ROLE_HE_SRV[String(id || '')] || String(id || '');
}

// כל שינוי הרשאה נרשם — לפני שהוא קורה.
//
// הגרסה הראשונה בלעה כישלון והמשיכה, כלומר שינוי הרשאה בלי
// עקבות. במערכת שכר זה התרחיש שאי אפשר לחיות איתו.
//
// עכשיו: אם הרישום נכשל, הפעולה נעצרת ושום דבר לא משתנה.
async function openAudit(actorAuth, action, target, details) {
  return db.collection('admin_audit').add({
    action:      action,
    actor_uid:   actorAuth.uid,
    actor_email: String(actorAuth.token.email || '').toLowerCase(),
    target_uid:  target || null,
    details:     details || {},
    at:          FV.serverTimestamp(),
    outcome:     'started'
  });
}

// רשומה שנשארה 'started' היא סימן חקירה, לא שקט מטעה.
async function sealAudit(ref, extra) {
  try {
    await ref.set(Object.assign({ outcome: 'done' }, extra || {}), { merge: true });
  } catch (e) {
    console.error('audit seal failed', e);
  }
}

// מספר עובד תקין: 1 עד 6 ספרות, בלי אפס מוביל.
//
// מתחילים מ-1 בכוונה. מספר שכבאי לא זוכר הוא מספר שהוא לא
// יקליד, והמספר הזה נועד להיות מוקלד כל בוקר. הסוד הוא
// הסיסמה, לא המספר — ולכן אין ערך באורך מלאכותי.
function validEmp(v) {
  return /^[1-9][0-9]{0,5}$/.test(String(v || ''));
}

// Firestore לא יודע לחפש "מכיל". הוא יודע רק "שווה" ו"מתחיל ב".
//
// הגרסה הראשונה חיפשה לפי תחילת השם המלא בלבד — ולכן מי שחיפש
// "חודרה" או "טויטו" לא מצא כלום, וזו בדיוק הדרך שבה אנשים
// מחפשים אחד את השני. הפתרון: שומרים מראש את כל הקידומות של
// כל מילה בשם, ומחפשים התאמה מדויקת ברשימה הזו.
//
// שם ממוצע מייצר כ-12 ערכים. זול בכתיבה, מיידי בקריאה, ובלי
// שירות חיפוש חיצוני.
function namePrefixes(fullName) {
  const words = String(fullName || '')
    .toLowerCase()
    .replace(/["'`׳״]/g, '')
    .split(/[\s\-־]+/)
    .filter(function (w) { return w.length > 0; });

  const out = {};
  words.forEach(function (w) {
    // מ-2 תווים ומעלה. תו בודד היה מחזיר חצי תחנה.
    for (let i = 2; i <= w.length && i <= 12; i++) {
      out[w.slice(0, i)] = true;
    }
  });

  // גם השם המלא כמחרוזת אחת, למי שמקליד שם ושם משפחה יחד.
  const joined = words.join(' ');
  for (let i = 2; i <= joined.length && i <= 20; i++) {
    out[joined.slice(0, i)] = true;
  }

  return Object.keys(out);
}

// ⚠️ השגיאות כאן חייבות להיות HttpsError.
//
// הגרסה הקודמת נתנה ל-FirebaseAuthError לעלות כמו שהוא.
// onCall אינו יודע לתרגם אותו, ולכן הלקוח קיבל `INTERNAL`
// בלי שום מידע — והמסך הציג "נכשל: INTERNAL".
//
// ב-25.8.2026 זה עלה שעה של חיפוש בלוגים כדי לגלות שהמשמעות
// היא פשוט "אין משתמש עם המייל הזה". זו הודעה שהמסך יכול היה
// להציג מלכתחילה.
async function resolveUser(data) {
  const wanted = String(data.uid || data.email || '');
  try {
    if (data.uid)   return await admin.auth().getUser(String(data.uid));
    if (data.email) return await admin.auth().getUserByEmail(String(data.email).toLowerCase());
  } catch (e) {
    const code = String((e && e.code) || '');
    if (code.indexOf('user-not-found') !== -1) {
      throw new HttpsError('not-found',
        'אין חשבון עם המזהה ' + wanted + '. ' +
        'צריך שהאדם יירשם דרך מסך הכניסה, או שייקלט במסך הקליטה — ' +
        'אי אפשר להעניק תפקיד למי שאין לו חשבון.');
    }
    throw new HttpsError('internal',
      'איתור המשתמש נכשל: ' + ((e && e.message) || code || 'שגיאה לא ידועה'));
  }
  throw new HttpsError('invalid-argument', 'צריך למסור uid או email.');
}

// ---------------------------------------------------------------------
//  1. אתחול מנהל-על — פעם אחת
// ---------------------------------------------------------------------

exports.bootstrapSuperAdmin = onCall({ timeoutSeconds: 120 }, async (req) => {
  const auth = requireAuth(req);
  const email = String(auth.token.email || '').toLowerCase();

  if (email !== SUPER_ADMIN_EMAIL) {
    throw new HttpsError('permission-denied', 'החשבון הזה אינו מנהל המערכת.');
  }

  // מיזוג ולא דריסה. אלדד הוא לוחם אש וגם מנהל; דריסה הייתה
  // מוחקת לו מספר עובד, תחנה, מחוז ומשמרת בלחיצה אחת.
  const cur = (await admin.auth().getUser(auth.uid)).customClaims || {};
  const merged = Object.assign({}, cur, { super: true });
  if (!merged.role) merged.role = 'super_admin';
  const intentFingerprint = identityCoordinatorModule.stableHash({
    kind: 'bootstrap', uid: auth.uid, previous_claims: cur, desired_claims: merged
  });
  const opId = 'bootstrap-' + crypto.createHash('sha256')
    .update(auth.uid + ':' + intentFingerprint).digest('hex').slice(0, 32);
  const acquired = await identityCoordinator.acquireBootstrap({
    uid: auth.uid,
    opId: opId,
    actorUid: auth.uid,
    actorEmail: email,
    previousClaims: cur,
    desiredClaims: merged,
    intentFingerprint: intentFingerprint,
    auditAction: 'bootstrap_super_admin',
    auditDetails: { email: email }
  });
  const result = {
    ok: true,
    message: 'הוגדרת כמנהל מערכת. התנתק והתחבר מחדש כדי שהשינוי ייכנס לתוקף.'
  };
  if (acquired.type === 'completed') return acquired.operation.result;
  return identityCoordinator.runBootstrap(auth.uid, acquired.operation.op_id, result);
});

// ---------------------------------------------------------------------
//  2. אישור בקשת הרשמה
//     כאן מוקצה מספר העובד. הכבאי לא מזין אותו ולא בוחר אותו.
// ---------------------------------------------------------------------

exports.approveRegistration = onCall({ timeoutSeconds: 120 }, async (req) => {
  const auth = requireSuperAdmin(req);
  const d = req.data || {};

  const uid = String(d.uid || '');
  if (!uid) throw new HttpsError('invalid-argument', 'חסר מזהה משתמש.');
  const requestId = String(d.request_id || '');
  const requestGeneration = String(d.request_generation || '');
  const wanted = String(d.emp || '').trim();
  if (wanted && !validEmp(wanted)) {
    throw new HttpsError('invalid-argument',
      'מספר עובד חייב להיות עד 6 ספרות, ולא להתחיל באפס.');
  }

  const user = await admin.auth().getUser(uid);
  const previousClaims = user.customClaims || {};
  const roleInput = VALID_ROLES.indexOf(d.role) !== -1 ? d.role : 'firefighter';
  const shiftInput = VALID_SHIFTS.indexOf(d.shift) !== -1 ? d.shift : '';
  const intentFingerprint = identityCoordinatorModule.stableHash({
    kind: 'approve', uid: uid,
    request_generation: requestGeneration,
    request_id: requestId,
    role: roleInput,
    shift: shiftInput,
    stationId: String(d.stationId || ''),
    districtId: String(d.districtId || ''),
    employee_mode: wanted ? 'fixed' : 'auto',
    wanted_emp: wanted
  });
  const opId = 'approve-' + crypto.createHash('sha256')
    .update(uid + ':' + requestGeneration + ':' + intentFingerprint)
    .digest('hex').slice(0, 32);

  const acquired = await identityCoordinator.acquireAssignment({
    uid: uid,
    opId: opId,
    kind: 'approve',
    actorUid: auth.uid,
    actorEmail: auth.token.email,
    previousClaims: previousClaims,
    previousEmp: previousClaims.emp,
    previousStation: previousClaims.stationId,
    requireRequest: true,
    attachPendingRequest: false,
    requestId: requestId,
    requestGeneration: requestGeneration,
    blockIfAssigned: true,
    intentFingerprint: intentFingerprint,
    employeeMode: wanted ? 'fixed' : 'auto',
    wantedEmp: wanted,
    employeeStart: EMP_START,
    auditAction: 'approve_registration',
    auditDetails: { email: String(user.email || '').toLowerCase() },
    makePlan: function (emp, r) {
      const stationId = String(d.stationId || r.stationId || '');
      const districtId = String(d.districtId || r.districtId || '');
      const role = roleInput;
      const shift = shiftInput;
      const fullName = String(d.full_name || r.full_name || '').trim();
      const liveEmail = String(user.email || '').toLowerCase();
      const requestEmail = String(r.email || '').toLowerCase();

      if (!stationId) throw new HttpsError('invalid-argument', 'חסרה תחנה.');
      if (!districtId) throw new HttpsError('invalid-argument', 'חסר מחוז.');
      if (KNOWN_DISTRICTS.indexOf(districtId) === -1) {
        throw new HttpsError('invalid-argument', 'מחוז לא מוכר: ' + districtId);
      }
      if (!fullName) {
        throw new HttpsError('invalid-argument',
          'לבקשה אין שם מלא. הוסף אותו לפני האישור.');
      }
      if (requestEmail && liveEmail && requestEmail !== liveEmail) {
        throw new HttpsError('failed-precondition',
          'כתובת המייל בחשבון השתנתה מאז הגשת הבקשה. רענן את פרטי הבקשה.');
      }

      const claims = {
        role: role, stationId: stationId, districtId: districtId,
        shift: shift, emp: emp
      };
      if (JSON.stringify(claims).length > 900) {
        throw new HttpsError('invalid-argument', 'ההרשאות ארוכות מדי.');
      }
      return {
        desiredClaims: claims,
        desiredProfile: {
          full_name: fullName,
          name_prefixes: namePrefixes(fullName),
          email: liveEmail,
          phone: String(r.phone || ''),
          role: role,
          shift: shift,
          stationId: stationId,
          districtId: districtId
        }
      };
    }
  });

  if (acquired.type === 'request_stamped') {
    throw new HttpsError('failed-precondition',
      'הבקשה הישנה קיבלה מזהה בטוח. הרשימה תתרענן; אשר אותה שוב.', {
        request_refreshed: true
      });
  }
  if (acquired.type === 'assigned_request_preserved') {
    throw new HttpsError('failed-precondition',
      'החשבון כבר מכיל שיוך חי. הבקשה נשמרה לבדיקה ולא נמחקה.', {
        request_preserved: true,
        needs_recovery: true
      });
  }

  const operation = acquired.operation || await identityCoordinator.getOperation(uid);
  const desired = operation.desired_claims || {};
  const result = {
    ok: true,
    uid: uid,
    emp: String(operation.desired_emp || desired.emp || ''),
    role: String(desired.role || ''),
    message: 'אושר. מספר העובד שהוקצה: ' + String(operation.desired_emp || desired.emp || '') +
             '. הכבאי צריך להתנתק ולהתחבר מחדש.'
  };
  if (acquired.type === 'completed') return operation.result;
  return identityCoordinator.runAssignment(uid, operation.op_id, result, uid === auth.uid);
});

// דחייה עוברת בשרת ונקשרת למזהה הבקשה שהמנהל ראה. מחיקה
// ישירה מהדפדפן הייתה יכולה למחוק בקשה חדשה מכרטיס ישן.
exports.rejectRegistration = onCall({ timeoutSeconds: 60 }, async (req) => {
  const auth = requireSuperAdmin(req);
  const d = req.data || {};
  const uid = String(d.uid || '');
  const requestId = String(d.request_id || '');
  const requestGeneration = String(d.request_generation || '');
  if (!uid) throw new HttpsError('invalid-argument', 'חסר מזהה משתמש.');

  const rejected = await identityCoordinator.rejectRequest({
    uid: uid,
    requestId: requestId,
    requestGeneration: requestGeneration,
    actorUid: auth.uid,
    actorEmail: auth.token.email
  });
  if (rejected.requestStamped) {
    throw new HttpsError('failed-precondition',
      'הבקשה הישנה קיבלה מזהה בטוח. הרשימה תתרענן; דחה אותה שוב.', {
        request_refreshed: true
      });
  }
  return { ok: true, uid: uid };
});

// ---------------------------------------------------------------------
//  3. שינוי תפקיד או שיוך
//     לא מקצה מספר עובד חדש — מספר עובד נשאר עם האדם.
// ---------------------------------------------------------------------

exports.setUserRole = onCall({ timeoutSeconds: 120 }, async (req) => {
  // עד 25.8.2026 היה כאן requireSuperAdmin. נפתח לרכז/ת כוח אדם
  // עם תקרת דרגה — ראה assertMayAssign. **התקרה נאכפת כאן ולא
  // במסך**: הבורר ב-admin.html מציג רק את מה שמותר, אבל מסך
  // שמסתיר אפשרות אינו הרשאה, והקריאה הזאת פתוחה לכל מי שיש לו
  // טוקן.
  const gate = requireRoleSetter(req);
  const auth = gate.auth;
  const d = req.data || {};

  const user   = await resolveUser(d);
  const before = user.customClaims || {};
  const role   = String(d.role || '');

  // מספר עובד הוא המפתח שכל השעות, האבטחות והחתימות תלויות בו.
  // שינוי שלו אינו עריכת שדה אלא העברת נתונים, ולכן הוא נשאר
  // אצל מנהל-על גם אחרי הפתיחה לרכזת.
  if (gate.cap !== Infinity) {
    const wantEmp = String(d.emp || '');
    const curEmp  = String(before.emp || '');
    if (wantEmp && curEmp && wantEmp !== curEmp) {
      throw new HttpsError('permission-denied',
        'שינוי מספר עובד מותר למנהל המערכת בלבד. מספר העובד מקשר את ' +
        'כל השעות והחתימות של האדם, ושינוי שלו מנתק אותן.');
    }
  }

  // הבדיקה הזו חייבת לקדום למסלול 'none'. בגרסה הקודמת היא ישבה
  // אחריו — ולכן מנהל שבחר לעצמו "הסרת כל ההרשאות" ננעל מחוץ
  // למערכת בלי אזהרה, כי המסלול הזה חוזר לפני שהיא נבדקת.
  const removingSuper =
    before.super === true && (role === 'none' || d.super === false);
  if (removingSuper && user.uid === auth.uid) {
    throw new HttpsError('failed-precondition',
      'אי אפשר להסיר את הרשאת הניהול מעצמך. בקש ממנהל אחר.');
  }

  // התקרה נבדקת **לפני** מסלול 'none' ולא אחריו. הסרת תפקיד היא
  // שינוי סמכות לכל דבר, ורכזת שאינה רשאית למנות מפקד משמרת אינה
  // רשאית גם למחוק אותו מהמערכת.
  const requestedStationId = String(d.stationId || before.stationId || '');
  const requestedDistrictId = String(d.districtId || before.districtId || '');

  // An already assigned person may move stations only through the two-party
  // transfer workflow.  Without this guard a super could still use the legacy
  // role editor to bypass destination-station approval entirely.
  if (role !== 'none' && before.stationId &&
      requestedStationId !== String(before.stationId)) {
    throw new HttpsError('failed-precondition',
      'מעבר תחנה דורש בקשת העברה ואישור של תחנת היעד. השתמש במסלול העברת עובד.');
  }
  const desiredScope = role === 'none' ? {
    stationId: String(before.stationId || ''),
    districtId: String(before.districtId || '')
  } : {
    stationId: requestedStationId,
    districtId: requestedDistrictId
  };
  assertMayAssign(gate, role === 'none' ? '' : role, before, user.uid,
                  d.super === true, desiredScope);

  if (role === 'none') {
    const suppliedOpId = String(d.operation_id || '');
    const opId = /^[A-Za-z0-9_-]{16,100}$/.test(suppliedOpId) ? suppliedOpId :
      'clear-' + crypto.randomBytes(16).toString('hex');
    const intentFingerprint = identityCoordinatorModule.stableHash({
      kind: 'clear_role', uid: user.uid, desired_claims: null
    });
    const acquired = await identityCoordinator.acquireAssignment({
      uid: user.uid,
      opId: opId,
      kind: 'clear_role',
      actorUid: auth.uid,
      actorEmail: auth.token.email,
      previousClaims: before,
      previousEmp: before.emp,
      previousStation: before.stationId,
      requireRequest: false,
      attachPendingRequest: true,
      requestId: '',
      requestGeneration: '',
      blockIfAssigned: false,
      intentFingerprint: intentFingerprint,
      employeeMode: 'none',
      wantedEmp: '',
      auditAction: 'clear_role',
      auditDetails: { email: user.email },
      makePlan: function () {
        return { desiredClaims: null, desiredProfile: null };
      }
    });
    if (acquired.type === 'orphan_request') {
      throw new HttpsError('failed-precondition',
        'נמצאה בקשת הרשמה ללא פעולת זהות תואמת. היא נשמרה לבדיקה.', {
          needs_recovery: true
        });
    }
    const operation = acquired.operation || await identityCoordinator.getOperation(user.uid);
    const result = {
      ok: true,
      uid: user.uid,
      message: 'ההרשאות הוסרו והשיוך נוקה. טוקן קיים עשוי להישאר תקף עד שעה.'
    };
    if (acquired.type === 'completed') return operation.result;
    return identityCoordinator.runClear(user.uid, operation.op_id, result);
  }

  if (VALID_ROLES.indexOf(role) === -1) {
    throw new HttpsError('invalid-argument',
      'תפקיד לא מוכר: ' + role + '. מותר: ' + VALID_ROLES.join(', ') + ' או none.');
  }

  const stationId  = requestedStationId;
  const districtId = requestedDistrictId;
  const shift      = String(d.shift || '');
  const emp        = String(d.emp || before.emp || '');

  if (!stationId) throw new HttpsError('invalid-argument', 'חסרה תחנה.');
  if (!emp)       throw new HttpsError('invalid-argument', 'למשתמש אין מספר עובד.');
  if (!validEmp(emp)) {
    throw new HttpsError('invalid-argument',
      'מספר עובד חייב להיות 1 עד 6 ספרות, ולא להתחיל באפס.');
  }

  if (shift && VALID_SHIFTS.indexOf(shift) === -1) {
    throw new HttpsError('invalid-argument', 'משמרת לא מוכרת: ' + shift);
  }

  const claims = {
    role: role, stationId: stationId, districtId: districtId,
    shift: shift, emp: emp
  };

  // ניהול המערכת הוא תוספת לתפקיד, לא תחליף לו. אלדד הוא לוחם
  // אש במשמרת ג' וגם מנהל המערכת — ואין סיבה שיחזיק שני חשבונות
  // ויתחלף ביניהם בכל פעולה.
  //
  // הגרסה הקודמת קיבעה את הניהול לחשבון אחד קבוע בקוד, וזו
  // הייתה טעות תכנון.
  let wantSuper = before.super === true;
  if (d.super === true)  wantSuper = true;
  if (d.super === false) wantSuper = false;

  // אי אפשר להסיר מעצמך את הניהול. אחרת די בלחיצה אחת כדי
  // להישאר בלי אף מנהל במערכת, בלי דרך חזרה.
  if (!wantSuper && before.super === true && user.uid === auth.uid) {
    throw new HttpsError('failed-precondition',
      'אי אפשר להסיר את הרשאת הניהול מעצמך. בקש ממנהל אחר.');
  }

  if (wantSuper) claims.super = true;

  if (JSON.stringify(claims).length > 900) {
    throw new HttpsError('invalid-argument', 'ההרשאות ארוכות מדי.');
  }

  // **האימות לפני הכתיבה, ולא אחריה.**
  //
  // בגרסה הקודמת ההרשאות נכתבו כאן והבדיקה הזו רצה אחריהן.
  // כשהיא נכשלה — שם ריק במעבר תחנה — התפקיד, התחנה והמשמרת
  // כבר השתנו, כתיבת הפרופיל לא רצה, ומפתח מספר העובד לא הופנה
  // מחדש, והמסך הציג "נכשל" על פעולה שכבר חצי בוצעה.
  // שם וטלפון נשמרים אם לא נמסרו במפורש. בלי זה, תיקון תפקיד
  // או שינוי מספר עובד היה מוחק לכבאי את השם והטלפון — כי
  // תוכנית הפרופיל כותבת את כל השדות, וריק דורס.
  //
  // ⚠️ הקריאה הזאת **חייבת** להיות לפני בדיקת השם למטה.
  //
  // עד 25.8.2026 היא ישבה אחריה, ו-existing הוגדר ב-let
  // אחרי שכבר נקרא. בגלל ש-|| עוצר בערך הראשון שאינו ריק,
  // זה לא קרס תמיד — הוא קרס **בדיוק כששדה השם הושאר ריק**,
  // שזה המקרה הרגיל: במסך הניהול כתוב "ריק = לא משנה את השם
  // הקיים". כלומר כל שינוי תפקיד לאדם קיים, בלי להקליד את
  // שמו מחדש, נפל על
  //   ReferenceError: Cannot access 'existing' before initialization
  // והתפקיד לא השתנה.
  let existing = {};
  try {
    const cur = await db.doc('stations/' + stationId + '/users/' + user.uid).get();
    if (cur.exists) existing = cur.data() || {};
  } catch (ignore) {}

  // **האימות לפני הכתיבה, ולא אחריה.**
  //
  // רשומה בלי שם אינה ניתנת למציאה בחיפוש עובד, והמסכים
  // מציגים במקומה כתובת מייל. עדיף להיכשל כאן מאשר ליצור
  // כבאי אנונימי — ולהיכשל **לפני** שההרשאות נכתבו, כדי
  // שלא יישאר מצב חצי-מעודכן.
  const fullName = String(d.full_name || existing.full_name || '').trim();
  if (!fullName) {
    throw new HttpsError('invalid-argument',
      'חסר שם מלא. הזן אותו בטופס — בלעדיו הכבאי לא יימצא בחיפוש.');
  }

  const phone = String(d.phone || existing.phone || '');
  const intentFingerprint = identityCoordinatorModule.stableHash({
    kind: 'set_role', uid: user.uid, role: role,
    stationId: stationId, districtId: districtId, shift: shift, emp: emp,
    full_name: fullName, phone: phone, super: wantSuper === true
  });

  const suppliedOpId = String(d.operation_id || '');
  const opId = /^[A-Za-z0-9_-]{16,100}$/.test(suppliedOpId) ? suppliedOpId :
    'role-' + crypto.randomBytes(16).toString('hex');
  const acquired = await identityCoordinator.acquireAssignment({
    uid: user.uid,
    opId: opId,
    kind: 'set_role',
    actorUid: auth.uid,
    actorEmail: auth.token.email,
    previousClaims: before,
    previousEmp: before.emp,
    previousStation: before.stationId,
    requireRequest: false,
    attachPendingRequest: true,
    requestId: '',
    requestGeneration: '',
    blockIfAssigned: false,
    intentFingerprint: intentFingerprint,
    employeeMode: 'fixed',
    wantedEmp: emp,
    auditAction: 'set_role',
    auditDetails: { email: user.email, before: before, after: claims },
    makePlan: function (reservedEmp) {
      const desiredClaims = Object.assign({}, claims, { emp: reservedEmp });
      return {
        desiredClaims: desiredClaims,
        desiredProfile: {
          full_name: fullName,
          name_prefixes: namePrefixes(fullName),
          email: String(user.email || '').toLowerCase(),
          phone: phone,
          role: desiredClaims.role,
          shift: desiredClaims.shift || '',
          stationId: desiredClaims.stationId,
          districtId: desiredClaims.districtId || ''
        }
      };
    }
  });
  if (acquired.type === 'orphan_request') {
    throw new HttpsError('failed-precondition',
      'נמצאה בקשת הרשמה ללא פעולת זהות תואמת. היא נשמרה לבדיקה.', {
        needs_recovery: true
      });
  }

  const operation = acquired.operation || await identityCoordinator.getOperation(user.uid);
  const planned = operation.desired_claims || {};
  assertMayAssign(gate, planned.role || '', operation.previous_claims || {}, user.uid,
                  planned.super === true, planned);
  if (gate.cap !== Infinity && String(operation.previous_emp || '') &&
      String(operation.previous_emp || '') !== String(operation.desired_emp || '')) {
    throw new HttpsError('permission-denied',
      'שינוי מספר עובד מותר למנהל המערכת בלבד.');
  }

  const result = {
    ok: true, uid: user.uid, emp: String(operation.desired_emp || ''),
    message: 'התפקיד הוגדר. המשתמש צריך להתנתק ולהתחבר מחדש כדי שהשינוי ייכנס לתוקף.'
  };
  if (acquired.type === 'completed') return operation.result;
  return identityCoordinator.runAssignment(user.uid, operation.op_id, result,
    user.uid === auth.uid);
});

// ממשיך רק תוכנית זהות שכבר ננעלה בשרת. הלקוח אינו שולח כאן
// תפקיד, תחנה, מספר עובד או תוצאה חדשה — ולכן רענון מסך לא יכול
// להחליף בשקט את מה שהמנהל אישר קודם.
exports.resumeIdentityOperation = onCall({ timeoutSeconds: 120 }, async (req) => {
  const auth = requireSuperAdmin(req);
  const d = req.data || {};
  const uid = String(d.uid || '');
  const opId = String(d.operation_id || '');
  const planFingerprint = String(d.plan_fingerprint || '');
  if (!uid || !/^[A-Za-z0-9_-]{16,100}$/.test(opId) ||
      !/^[a-f0-9]{64}$/.test(planFingerprint)) {
    throw new HttpsError('invalid-argument', 'פרטי פעולת ההתאוששות חסרים או אינם תקינים.');
  }

  const before = await identityCoordinator.getOperation(uid);
  if (!before) throw new HttpsError('not-found', 'פעולת הזהות לא נמצאה.');
  if (before.kind === 'bootstrap') {
    const email = String(auth.token.email || '').toLowerCase();
    if (uid !== auth.uid || email !== SUPER_ADMIN_EMAIL) {
      throw new HttpsError('permission-denied', 'אתחול מנהל ניתן להמשך רק בידי אותו חשבון.');
    }
  } else if (['approve', 'set_role', 'clear_role'].indexOf(before.kind) === -1) {
    throw new HttpsError('failed-precondition', 'סוג פעולת הזהות אינו ניתן להמשך.');
  }

  if (before.kind === 'set_role' && before.previous_station &&
      String(((before.desired_profile || {}).stationId) || '') !==
        String(before.previous_station)) {
    throw new HttpsError('failed-precondition',
      'פעולת התפקיד הישנה כוללת מעבר תחנה ללא אישור יעד ולכן אינה ניתנת להמשך.');
  }

  if (uid === auth.uid && (before.previous_claims || {}).super === true &&
      (before.desired_claims == null || before.desired_claims.super !== true)) {
    throw new HttpsError('failed-precondition',
      'אי אפשר להמשיך פעולה שמסירה ממך את הרשאת הניהול.');
  }

  const resumed = await identityCoordinator.resumeOperation({
    uid: uid,
    opId: opId,
    planFingerprint: planFingerprint,
    actorUid: auth.uid,
    actorEmail: auth.token.email
  });
  const operation = resumed.operation;
  if (resumed.type === 'completed') return operation.result;

  const summary = operation.plan_summary || {};
  if (operation.kind === 'clear_role') {
    return identityCoordinator.runClear(uid, operation.op_id, {
      ok: true, uid: uid,
      message: 'ההרשאות הוסרו והשיוך נוקה. המשתמש צריך להתחבר מחדש.'
    });
  }
  if (operation.kind === 'bootstrap') {
    return identityCoordinator.runBootstrap(uid, operation.op_id, {
      ok: true,
      message: 'הגדרת מנהל המערכת הושלמה. התחבר מחדש כדי לרענן הרשאות.'
    });
  }
  return identityCoordinator.runAssignment(uid, operation.op_id, {
    ok: true,
    uid: uid,
    emp: String(summary.emp || ''),
    role: String(summary.role || ''),
    message: operation.kind === 'approve' ?
      'האישור השמור הושלם. מספר העובד: ' + String(summary.emp || '') + '.' :
      'שינוי התפקיד השמור הושלם. המשתמש צריך להתחבר מחדש.'
  }, uid === auth.uid);
});

// ---------------------------------------------------------------------
//  3b. העברת עובד בין תחנות — בקשה במקור ואישור ביעד
// ---------------------------------------------------------------------

exports.searchStationTransferCandidates = onCall({
  enforceAppCheck: true, timeoutSeconds: 60
}, async (req) => stationTransfer.search(req));

exports.createStationTransfer = onCall({
  enforceAppCheck: true, timeoutSeconds: 120
}, async (req) => stationTransfer.create(req));

exports.listStationTransfers = onCall({
  enforceAppCheck: true, timeoutSeconds: 60
}, async (req) => stationTransfer.list(req));

exports.decideStationTransfer = onCall({
  enforceAppCheck: true, timeoutSeconds: 120
}, async (req) => stationTransfer.decide(req));

exports.cancelStationTransfer = onCall({
  enforceAppCheck: true, timeoutSeconds: 60
}, async (req) => stationTransfer.cancel(req));

// ---------------------------------------------------------------------
//  4. כניסה עם מספר עובד
//
//  Firebase מזהה משתמשים לפי מייל. הפונקציה הזו היא הגשר:
//  הכבאי מקליד מספר עובד וסיסמה, השרת מוצא את החשבון, מאמת את
//  הסיסמה מול Firebase, ומחזיר אישור כניסה.
//
//  למה לא לתרגם מספר עובד למייל בדפדפן: זה היה מאפשר לכל אחד
//  לסרוק מספרי עובד ולאסוף כתובות מייל של עובדים.
//
//  הסיסמה עוברת דרך הפונקציה. היא לא נשמרת ולא נרשמת ביומן.
// ---------------------------------------------------------------------

exports.loginWithEmployeeNumber = onCall(async (req) => {
  const d = req.data || {};
  const emp      = String(d.emp || '').trim();
  const password = String(d.password || '');

  if (!emp || !password) {
    throw new HttpsError('invalid-argument', 'נא להזין מספר עובד וסיסמה.');
  }

  // בלי הבדיקה הזו, מספר עובד עם לוכסן היה נכנס לנתיב מסמך
  // ויוצר מסמכים במקומות שרירותיים, או מפיל את הפונקציה.
  if (!validEmp(emp)) {
    throw new HttpsError('unauthenticated', 'מספר עובד או סיסמה שגויים.');
  }

  const lockRef = db.doc('login_attempts/' + emp);
  const lockSnap = await lockRef.get();
  const lock = lockSnap.exists ? lockSnap.data() : {};

  if (lock.locked_until && lock.locked_until.toMillis() > Date.now()) {
    const mins = Math.ceil((lock.locked_until.toMillis() - Date.now()) / 60000);
    throw new HttpsError('resource-exhausted',
      'יותר מדי ניסיונות. נסה שוב בעוד ' + mins + ' דקות.');
  }

  const idxSnap = await db.doc('emp_index/' + emp).get();

  // הודעת שגיאה זהה בין "מספר לא קיים" ל"סיסמה שגויה", כדי שלא
  // יהיה אפשר לגלות אילו מספרי עובד קיימים.
  const generic = 'מספר עובד או סיסמה שגויים.';

  if (!idxSnap.exists || !identityCoordinatorModule.activeIndex(idxSnap.data() || {})) {
    // מספר עובד לא קיים. נספר את הניסיון, אבל אין למי לשלוח מייל.
    await noteFailedLogin(lockRef, lock, emp, '');
    throw new HttpsError('unauthenticated', generic);
  }

  const email = String(idxSnap.data().email || '');
  if (!email) {
    throw new HttpsError('failed-precondition',
      'לחשבון הזה אין מייל משויך. פנה למנהל המערכת.');
  }

  let res;
  try {
    res = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + WEB_API_KEY,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: email, password: password, returnSecureToken: false })
      }
    );
  } catch (e) {
    throw new HttpsError('internal',
      'שלב 1 (אימות סיסמה) נכשל: ' + (e && e.message ? e.message : String(e)));
  }

  if (!res.ok) {
    await noteFailedLogin(lockRef, lock, emp, email);
    throw new HttpsError('unauthenticated', generic);
  }

  await lockRef.set({ failed: 0, locked_until: null }, { merge: true });

  const uid = String(idxSnap.data().uid || '');
  if (!uid) {
    throw new HttpsError('failed-precondition',
      'רשומת הכניסה של מספר העובד הזה פגומה. פנה למנהל המערכת.');
  }

  // ---------------------------------------------------------------
  //  למה לא טוקן חתום
  //
  //  הגרסה הקודמת החזירה טוקן שנוצר ב-createCustomToken. חתימת
  //  טוקן דורשת מחשבון השירות של הפונקציות את ההרשאה
  //  iam.serviceAccounts.signBlob, ש-Google אינה מעניקה כברירת
  //  מחדל — וזה הפיל את כל הכניסות עם מספר עובד.
  //
  //  במקום להישען על הגדרת ענן, השרת מחזיר את המייל המשויך,
  //  והדפדפן נכנס בדרך הרגילה. אין חתימה, אין תלות בהרשאה.
  //
  //  האבטחה לא נחלשת: המייל מוחזר רק אחרי שהסיסמה כבר אומתה
  //  מול Google בשורות שלמעלה. מי שאינו יודע את הסיסמה מקבל
  //  את אותה שגיאה גנרית ולא לומד דבר, והנעילה אחרי
  //  MAX_FAILED_LOGINS ניסיונות נשארת בתוקף.
  // ---------------------------------------------------------------

  return { ok: true, email: email, uid: uid };
});

// המונה חייב להיות טרנזקציה. בגרסה הקודמת הוא נקרא פעם אחת
// בתחילת הבקשה, וכל הבקשות המקבילות כתבו את אותו ערך — כך שמאה
// ניסיונות בו-זמנית נספרו כאחד, והנעילה לא הופעלה לעולם.
async function noteFailedLogin(ref, lockIgnored, emp, email) {
  const locked = await db.runTransaction(async function (tx) {
    const snap   = await tx.get(ref);
    const failed = Number((snap.exists ? snap.data().failed : 0) || 0) + 1;

    if (failed < MAX_FAILED_LOGINS) {
      tx.set(ref, { failed: failed, last_failed_at: FV.serverTimestamp() },
             { merge: true });
      return false;
    }

    tx.set(ref, {
      failed: 0,
      last_failed_at: FV.serverTimestamp(),
      locked_until: admin.firestore.Timestamp.fromMillis(
        Date.now() + LOCKOUT_MINUTES * 60000)
    }, { merge: true });
    return true;
  });

  if (!locked || !email) return;

  // המייל יוצא רק לכתובת השמורה. מי שמנסה לנחש סיסמאות לא
  // מקבל אותו, ולכן הכפתור לא מחליש את ההגנה.
  const token = randomToken();
  await db.doc('unlock_tokens/' + token).set({
    emp:        emp,
    created_at: FV.serverTimestamp(),
    expires_at: admin.firestore.Timestamp.fromMillis(
      Date.now() + UNLOCK_TOKEN_MINUTES * 60000
    )
  });

  // ההודעה יוצאת בפוש, לא במייל.
  //
  // להתראה הזו שני תפקידים, ושניהם נשמרים: לתת לבעל החשבון
  // דרך לחזור מיד במקום לחכות רבע שעה, ולהזהיר אותו שמישהו
  // מנסה להיכנס בשמו.
  //
  // הפוש מגיע רק למכשירים הרשומים של אותו משתמש — אותה תכונת
  // אמון שהייתה למייל, ובלי שרת דואר חיצוני. מי שמנחש סיסמאות
  // אינו מקבל דבר.
  //
  // למי שאין מכשיר רשום פשוט לא מקבל התראה, וממתין רבע שעה.
  // מסך הכניסה כבר אומר לו כמה דקות נשארו, ולכן הוא אינו
  // תקוע בלי הסבר.
  try {
    const u = await admin.auth().getUserByEmail(email);
    await pushToUsers(STATION_ID, [u.uid], 'lockout',
      'ResQ — החשבון שלך ננעל',
      'אחרי ' + MAX_FAILED_LOGINS + ' ניסיונות שגויים. ' +
      'הנעילה משתחררת בעוד ' + LOCKOUT_MINUTES + ' דקות — ' +
      'או עכשיו, בלחיצה כאן. אם זה לא היית אתה, שנה סיסמה.',
      './unlock.html?t=' + token, true);
  } catch (e) {
    // כישלון בהתראה אינו מבטל את הנעילה. ההגנה עצמה כבר נרשמה,
    // וזה החלק שחשוב.
    console.error('lockout push failed', e);
  }
}

// ---------------------------------------------------------------------
//  5. שכחתי פרטים
//
//  המייל שנשלח מכיל את מספר העובד וקישור לבחירת סיסמה חדשה.
//
//  הסיסמה עצמה לא נשלחת ולא יכולה להישלח: Firebase שומר טביעה
//  חד-כיוונית שלה, ואי אפשר לחשב ממנה בחזרה את הסיסמה. גם אילו
//  היה אפשר — סיסמה במייל נשארת בתיבה ובגיבויים לנצח.
// ---------------------------------------------------------------------

exports.requestPasswordReset = onCall(async (req) => {
  const id = String((req.data || {}).id || '').trim();
  if (!id) throw new HttpsError('invalid-argument', 'נא להזין מספר עובד או מייל.');

  // תשובה זהה בכל מקרה, כדי שלא יהיה אפשר לסרוק מספרי עובד
  // ולגלות מי רשום במערכת.
  const answer = {
    ok: true,
    message: 'אם הפרטים קיימים במערכת, נשלח מייל לכתובת השמורה.'
  };

  let email = '';
  let emp   = '';

  if (id.indexOf('@') !== -1) {
    email = id.toLowerCase();
    try {
      const u = await admin.auth().getUserByEmail(email);
      const c = u.customClaims || {};
      emp = String(c.emp || '');
      if (emp) {
        const liveIndex = await db.doc('emp_index/' + emp).get();
        if (!liveIndex.exists || !identityCoordinatorModule.activeIndex(liveIndex.data() || {}) ||
            String((liveIndex.data() || {}).uid || '') !== u.uid) emp = '';
      }
    } catch (e) { return answer; }
  } else {
    const idx = await db.doc('emp_index/' + id).get();
    if (!idx.exists || !identityCoordinatorModule.activeIndex(idx.data() || {})) return answer;
    email = String(idx.data().email || '');
    emp   = id;
    if (!email) return answer;
  }

  let link = '';
  try {
    link = await admin.auth().generatePasswordResetLink(email);
  } catch (e) {
    return answer;
  }

  const body =
    (emp
      ? '<p style="font-size:15px;color:#333;line-height:1.8">מספר העובד שלך הוא:<br>' +
        '<span style="font-size:26px;font-weight:bold;color:#e8590c;letter-spacing:2px">' +
        emp + '</span></p>'
      : '') +
    '<p style="font-size:15px;color:#333;line-height:1.8">' +
    'לבחירת סיסמה חדשה, לחץ כאן:</p>' +
    button(link, 'בחירת סיסמה חדשה') +
    '<p style="font-size:13px;color:#888;line-height:1.8">' +
    'הסיסמה הקודמת שלך אינה ניתנת לשחזור — המערכת אינה שומרת אותה, ' +
    'ולכן צריך לבחור חדשה.<br>' +
    'אם לא ביקשת את המייל הזה, אפשר להתעלם ממנו.</p>';

  await sendMail(email, 'ResQ — מספר עובד ואיפוס סיסמה',
                 mailShell('הפרטים שלך', body));

  return answer;
});

// ---------------------------------------------------------------------
//  5ב. שחרור נעילה
//     הקישור נשלח למייל השמור בלבד, ולכן רק בעל החשבון יכול
//     להשתמש בו. חד-פעמי, ותקף לשעה.
// ---------------------------------------------------------------------

exports.unlockAccount = onCall(async (req) => {
  const token = String((req.data || {}).token || '').trim();
  if (!token) throw new HttpsError('invalid-argument', 'קישור לא תקין.');

  const ref  = db.doc('unlock_tokens/' + token);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new HttpsError('not-found', 'הקישור אינו תקף או שכבר נעשה בו שימוש.');
  }

  const t = snap.data();
  if (t.expires_at && t.expires_at.toMillis() < Date.now()) {
    await ref.delete().catch(function () {});
    throw new HttpsError('deadline-exceeded', 'הקישור פג תוקף. בקש קישור חדש.');
  }

  await db.doc('login_attempts/' + t.emp)
          .set({ failed: 0, locked_until: null }, { merge: true });

  await ref.delete().catch(function () {});

  return { ok: true, message: 'הנעילה שוחררה. אפשר לנסות להיכנס שוב.' };
});

// ---------------------------------------------------------------------
//  הצטרפות עם קוד תחנה — מושבתת ב-41B
// ---------------------------------------------------------------------
//
//  קוד הלקוח הישן בדק claims מתוך token שעלול להיות בן שעה.
//  קריאה ישירה בזמן אישור מקביל הייתה יכולה לשכתב שיוך ומספר
//  עובד. משאירים את שם הפונקציה ללקוחות ישנים, אבל השרת חוסם
//  אותה בלי לקרוא payload ובלי שום תופעת לוואי. עד מנגנון
//  אטומי בגרסה 42, כל בקשת הרשמה עוברת אישור מנהל ידני.

const JOIN_DOC = 'config/join';
exports.joinWithCode = onCall(
  registrationSafety.createDisabledJoinHandler({
    requireAuth: requireAuth,
    HttpsError: HttpsError
  })
);

// קביעת הקוד — מנהל-על בלבד.
exports.setJoinCode = onCall(async (req) => {
  const auth = requireSuperAdmin(req);
  const d = req.data || {};
  const code = String(d.code || '').trim();
  const active = d.active === true;

  if (active && code.length < 4) {
    throw new HttpsError('invalid-argument', 'הקוד חייב להיות באורך 4 תווים לפחות.');
  }

  const audit = await openAudit(auth, 'set_join_code', null, { active: active });
  await db.doc(JOIN_DOC).set({
    code: code, active: active,
    stationId: STATION_ID, districtId: 'south',
    updated_by: auth.uid, updated_at: FV.serverTimestamp()
  }, { merge: true });
  await sealAudit(audit, { active: active });
  return { ok: true, active: active };
});

exports.getJoinCode = onCall(async (req) => {
  requireSuperAdmin(req);
  const snap = await db.doc(JOIN_DOC).get().catch(function () { return null; });
  const v = (snap && snap.exists ? snap.data() : {}) || {};
  return { code: String(v.code || ''), active: v.active === true };
});

// ---------------------------------------------------------------------
//  לוח מודעות לפי תחנת משנה
// ---------------------------------------------------------------------
//
// לקוחות אינם כותבים לאוסף ישירות. שתי הפונקציות האלה הן שער
// הכתיבה היחיד, ולכן שם הכותב, התפקיד, המשמרת וחותמת הזמן אינם
// מגיעים מהדפדפן. כך הודעה שמוצגת כ"מפקד התחנה" באמת נכתבה
// מחשבון עם הטוקן הזה, ושעון מכשיר שגוי אינו משנה את סדר הלוח.
//
// מזהה הבקשה נשמר בנפרד. ניסיון חוזר עם אותו תוכן מחזיר את אותה
// תוצאה בלי ליצור כפילות ובלי לצרוך מכסת קצב; שימוש חוזר באותו
// מזהה עם תוכן אחר נחסם. קבלות הבקשה ומסמכי מגבלת הקצב חסומים
// לחלוטין ללקוח בכללי Firestore.

function translateBulletinError(error) {
  if (error instanceof bulletin.BulletinError) {
    return new HttpsError(error.code, error.message);
  }
  return null;
}

function parseBulletinPost(req) {
  try {
    return {
      // The fallback is server-owned and is used only for a verified super
      // account that predates station claims. Ordinary users can never choose
      // a station in the payload; their station always comes from the token.
      identity: bulletin.postingIdentity(req.auth, {
        isSuper: !!(req.auth && isSuperAdmin(req.auth)),
        defaultStationId: STATION_ID
      }),
      input: bulletin.parsePostInput(req.data)
    };
  } catch (error) {
    const translated = translateBulletinError(error);
    if (translated) throw translated;
    throw error;
  }
}

function bulletinIdentityFor(req) {
  try {
    return bulletin.postingIdentity(req.auth, {
      isSuper: !!(req.auth && isSuperAdmin(req.auth)),
      defaultStationId: STATION_ID
    });
  } catch (error) {
    const translated = translateBulletinError(error);
    if (translated) throw translated;
    throw error;
  }
}

function requireShiftCommand(identity) {
  if (!bulletin.mayUseShiftCommandActions(identity)) {
    throw new HttpsError('permission-denied',
      'רק ראש משמרת או סגן ראש משמרת רשאים לבצע את הפעולה.');
  }
}

// טוקן מאומת קובע את גבול התחנה, ומסמך המשתמש קובע שהחשבון
// עדיין פעיל ושהתפקיד לא השתנה מאז הנפקת הטוקן. שלוש פעולות
// הלוח משתמשות באותו שער כדי שלא תיווצר ביניהן סטיית הרשאות.
function verifiedBulletinActor(identity, userSnap) {
  if (!userSnap.exists && !identity.isSuper) {
    throw new HttpsError('failed-precondition',
      'כרטיס המשתמש בתחנה לא נמצא. פנה למנהל המערכת.');
  }
  const user = userSnap.exists ? (userSnap.data() || {}) : {};
  if (user.is_active === false && !identity.isSuper) {
    throw new HttpsError('permission-denied', 'החשבון אינו פעיל.');
  }
  const byName = String(user.full_name ||
    (identity.isSuper ? 'מנהל המערכת' : '')).trim();
  if (!byName || byName.length > 120) {
    throw new HttpsError('failed-precondition',
      'חסר שם מלא תקין בכרטיס המשתמש.');
  }

  const storedRole = String(user.role || '').trim();
  const storedCrew = String(user.crew || '').trim();
  if (!identity.isSuper && storedRole !== identity.role) {
    throw new HttpsError('failed-precondition',
      'ההרשאה השתנתה. התנתק והתחבר מחדש לפני הפרסום.');
  }
  if (!identity.isSuper && storedCrew !== identity.crew) {
    throw new HttpsError('failed-precondition',
      'שיוך המשמרת השתנה. התנתק והתחבר מחדש לפני הפרסום.');
  }
  return { user: user, byName: byName };
}

exports.postBulletinMessage = onCall(async (req) => {
  const parsed = parseBulletinPost(req);
  const identity = parsed.identity;
  const input = parsed.input;
  const sid = identity.sid;

  const msgId = bulletin.messageId(identity.uid, input.requestId);
  const reqKey = bulletin.requestKey(identity.uid, input.requestId);
  const msgRef = db.doc(
    'stations/' + sid + '/sub_stations/' + input.subStationId +
    '/bulletin_messages/' + msgId
  );
  const receiptRef = db.doc('stations/' + sid + '/bulletin_requests/' + reqKey);
  const rateRef = db.doc(
    'stations/' + sid + '/bulletin_rate_limits/' +
    bulletin.requestKey(identity.uid, 'rate-limit-v1')
  );
  const userRef = db.doc('stations/' + sid + '/users/' + identity.uid);
  const subStationRef = db.doc(
    'stations/' + sid + '/sub_stations/' + input.subStationId
  );
  const hash = bulletin.contentHash(identity, input);

  try {
    return await db.runTransaction(async function (tx) {
      // Every authorization and existence read happens before the first write.
      // This keeps the transaction valid and ensures an old retry cannot bypass
      // a user deactivation or an archived sub-station.
      const userSnap = await tx.get(userRef);
      const subStationSnap = await tx.get(subStationRef);
      const receiptSnap = await tx.get(receiptRef);

      const actor = verifiedBulletinActor(identity, userSnap);

      if (!subStationSnap.exists ||
          !bulletin.subStationAvailable(subStationSnap.data() || {})) {
        throw new HttpsError('failed-precondition',
          'תחנת המשנה אינה קיימת או שאינה פעילה.');
      }

      const prior = receiptSnap.exists ? (receiptSnap.data() || {}) : null;
      const requestState = bulletin.requestState(prior, hash, msgRef.path);
      if (requestState === 'conflict') {
        throw new HttpsError('already-exists',
          'מזהה הבקשה כבר שימש להודעה אחרת. רענן ונסה שוב.');
      }
      if (requestState === 'duplicate') {
        return {
          ok: true,
          id: String(prior.message_id || msgId),
          duplicate: true,
          createdKey: String(prior.created_key || '')
        };
      }

      const rateSnap = await tx.get(rateRef);
      const nowMillis = Date.now();
      let rate;
      try {
        rate = bulletin.rateDecision(
          rateSnap.exists ? (rateSnap.data() || {}) : null,
          nowMillis
        );
      } catch (error) {
        const translated = translateBulletinError(error);
        if (translated) throw translated;
        throw error;
      }
      if (!rate.allowed) {
        throw new HttpsError('resource-exhausted',
          'נשלחו יותר מדי הודעות. נסה שוב בעוד ' +
          rate.retryAfterSeconds + ' שניות.',
          { retryAfterSeconds: rate.retryAfterSeconds });
      }

      const createdAt = admin.firestore.Timestamp.fromMillis(nowMillis);
      const createdKey = new Date(nowMillis).toISOString();
      const message = {
        kind: 'bulletin',
        text: input.text,
        category: input.category,
        audience: 'board',
        by_uid: identity.uid,
        by_name: actor.byName,
        by_role: identity.role,
        by_crew: identity.crew,
        hidden: false,
        reply_count: 0,
        created_at: createdAt,
        created_key: createdKey,
        request_hash: hash
      };

      tx.create(msgRef, message);
      tx.create(receiptRef, {
        request_hash: hash,
        message_path: msgRef.path,
        message_id: msgId,
        created_key: createdKey,
        created_at: createdAt
      });
      tx.set(rateRef, {
        count: rate.count,
        window_started_at: admin.firestore.Timestamp.fromMillis(
          rate.windowStartedMillis
        ),
        updated_at: createdAt
      }, { merge: true });

      return { ok: true, id: msgId, duplicate: false, createdKey: createdKey };
    });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    const translated = translateBulletinError(error);
    if (translated) throw translated;
    console.error('postBulletinMessage failed', {
      uid: identity.uid, sid: sid, subStationId: input.subStationId,
      requestKey: reqKey, error: String(error && error.message || error)
    });
    throw new HttpsError('internal',
      'פרסום ההודעה נכשל. לא נוצרה הודעה חלקית; נסה שוב.');
  }
});

// פרסום רחב הוא פעולה נפרדת בכוונה. הלקוח אינו שולח sid או
// רשימת יעדים; השרת גוזר את התחנה מהטוקן וקורא בעצמו את כל
// תחנות-המשנה הפעילות. הטרנזקציה כותבת את כולן או אף אחת.
exports.broadcastBulletinMessage = onCall(async (req) => {
  const identity = bulletinIdentityFor(req);
  requireShiftCommand(identity);
  let input;
  try {
    input = bulletin.parseBroadcastInput(req.data);
  } catch (error) {
    const translated = translateBulletinError(error);
    if (translated) throw translated;
    throw error;
  }

  const sid = identity.sid;
  const msgId = bulletin.broadcastMessageId(identity.uid, input.requestId);
  const reqKey = bulletin.broadcastRequestKey(identity.uid, input.requestId);
  const targetKey = 'stations/' + sid +
    '/sub_stations/*/bulletin_messages/' + msgId;
  const receiptRef = db.doc('stations/' + sid + '/bulletin_requests/' + reqKey);
  const rateRef = db.doc(
    'stations/' + sid + '/bulletin_rate_limits/' +
    bulletin.broadcastRequestKey(identity.uid, 'rate-limit-v1')
  );
  const userRef = db.doc('stations/' + sid + '/users/' + identity.uid);
  const boardsQuery = db.collection('stations/' + sid + '/sub_stations');

  try {
    return await db.runTransaction(async function (tx) {
      const userSnap = await tx.get(userRef);
      // The query belongs to the transaction so the target set and all writes
      // share one serializable snapshot. A board cannot silently become active
      // between an external list call and this commit.
      const boardSnapshot = await tx.get(boardsQuery);
      const receiptSnap = await tx.get(receiptRef);
      const rateSnap = await tx.get(rateRef);

      const actor = verifiedBulletinActor(identity, userSnap);
      const targets = boardSnapshot.docs.filter(function (item) {
        return bulletin.subStationAvailable(item.data() || {});
      }).sort(function (a, b) { return a.id.localeCompare(b.id); });
      if (!targets.length) {
        throw new HttpsError('failed-precondition',
          'לא נמצאו תחנות משנה פעילות להפצה.');
      }
      if (targets.length > bulletin.MAX_BROADCAST_BOARDS) {
        throw new HttpsError('failed-precondition',
          'מספר תחנות המשנה גדול ממכסת ההפצה הבטוחה.');
      }
      const boardIds = targets.map(function (item) { return item.id; });
      const targetRefs = targets.map(function (item) {
        return {
          id: item.id,
          messageRef: item.ref.collection('bulletin_messages').doc(msgId)
        };
      });
      const hash = bulletin.broadcastContentHash(identity, input, boardIds);

      const prior = receiptSnap.exists ? (receiptSnap.data() || {}) : null;
      const requestState = bulletin.requestState(prior, hash, targetKey);
      if (requestState === 'conflict') {
        throw new HttpsError('already-exists',
          'בקשת ההפצה כבר שימשה לתוכן או לרשימת תחנות אחרת.');
      }
      if (requestState === 'duplicate') {
        return {
          ok: true,
          id: String(prior.message_id || msgId),
          duplicate: true,
          targetCount: Number(prior.target_count || boardIds.length),
          boardIds: Array.isArray(prior.sub_station_ids)
            ? prior.sub_station_ids : boardIds
        };
      }

      let rate;
      try {
        rate = bulletin.broadcastRateDecision(
          rateSnap.exists ? (rateSnap.data() || {}) : null,
          Date.now()
        );
      } catch (error) {
        const translated = translateBulletinError(error);
        if (translated) throw translated;
        throw error;
      }
      if (!rate.allowed) {
        throw new HttpsError('resource-exhausted',
          'נשלחו יותר מדי הפצות. נסה שוב בעוד ' +
          rate.retryAfterSeconds + ' שניות.',
          { retryAfterSeconds: rate.retryAfterSeconds });
      }

      const nowMillis = Date.now();
      const createdAt = admin.firestore.Timestamp.fromMillis(nowMillis);
      const createdKey = new Date(nowMillis).toISOString();
      const message = {
        kind: 'bulletin',
        text: input.text,
        category: input.category,
        audience: 'all_sub_stations',
        broadcast_id: msgId,
        broadcast_count: boardIds.length,
        sub_station_ids: boardIds,
        by_uid: identity.uid,
        by_name: actor.byName,
        by_role: identity.role,
        by_crew: identity.crew,
        hidden: false,
        reply_count: 0,
        created_at: createdAt,
        created_key: createdKey,
        request_hash: hash
      };

      targetRefs.forEach(function (target) {
        tx.create(target.messageRef, message);
      });
      tx.create(receiptRef, {
        request_hash: hash,
        message_path: targetKey,
        message_id: msgId,
        target_count: boardIds.length,
        sub_station_ids: boardIds,
        created_key: createdKey,
        created_at: createdAt
      });
      tx.set(rateRef, {
        count: rate.count,
        window_started_at: admin.firestore.Timestamp.fromMillis(
          rate.windowStartedMillis
        ),
        updated_at: createdAt
      }, { merge: true });

      return {
        ok: true, id: msgId, duplicate: false,
        targetCount: boardIds.length, boardIds: boardIds
      };
    });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    const translated = translateBulletinError(error);
    if (translated) throw translated;
    console.error('broadcastBulletinMessage failed', {
      uid: identity.uid, sid: sid, requestKey: reqKey,
      error: String(error && error.message || error)
    });
    throw new HttpsError('internal',
      'הפצת ההודעה נכשלה. לא נוצר פרסום חלקי; נסה שוב.');
  }
});

exports.replyToBulletinMessage = onCall(async (req) => {
  const identity = bulletinIdentityFor(req);
  requireShiftCommand(identity);
  let input;
  try {
    input = bulletin.parseReplyInput(req.data);
  } catch (error) {
    const translated = translateBulletinError(error);
    if (translated) throw translated;
    throw error;
  }

  const sid = identity.sid;
  const replyId = bulletin.replyId(identity.uid, input.requestId);
  const reqKey = bulletin.replyRequestKey(identity.uid, input.requestId);
  const parentRef = db.doc(
    'stations/' + sid + '/sub_stations/' + input.subStationId +
    '/bulletin_messages/' + input.messageId
  );
  const replyRef = parentRef.collection('bulletin_replies').doc(replyId);
  const subStationRef = db.doc(
    'stations/' + sid + '/sub_stations/' + input.subStationId
  );
  const userRef = db.doc('stations/' + sid + '/users/' + identity.uid);
  const receiptRef = db.doc('stations/' + sid + '/bulletin_requests/' + reqKey);
  const rateRef = db.doc(
    'stations/' + sid + '/bulletin_rate_limits/' +
    bulletin.replyRequestKey(identity.uid, 'rate-limit-v1')
  );
  const hash = bulletin.replyContentHash(identity, input);

  try {
    return await db.runTransaction(async function (tx) {
      const userSnap = await tx.get(userRef);
      const subStationSnap = await tx.get(subStationRef);
      const parentSnap = await tx.get(parentRef);
      const receiptSnap = await tx.get(receiptRef);
      const rateSnap = await tx.get(rateRef);

      const actor = verifiedBulletinActor(identity, userSnap);
      if (!subStationSnap.exists ||
          !bulletin.subStationAvailable(subStationSnap.data() || {})) {
        throw new HttpsError('failed-precondition',
          'תחנת המשנה אינה קיימת או שאינה פעילה.');
      }
      if (!parentSnap.exists) {
        throw new HttpsError('not-found', 'ההודעה שאליה מגיבים לא נמצאה.');
      }
      const parent = parentSnap.data() || {};
      if (parent.kind !== 'bulletin' || parent.hidden === true) {
        throw new HttpsError('failed-precondition',
          'אי אפשר להגיב להודעה שאינה פעילה.');
      }

      const prior = receiptSnap.exists ? (receiptSnap.data() || {}) : null;
      const requestState = bulletin.requestState(prior, hash, replyRef.path);
      if (requestState === 'conflict') {
        throw new HttpsError('already-exists',
          'מזהה הבקשה כבר שימש לתגובה אחרת. רענן ונסה שוב.');
      }
      if (requestState === 'duplicate') {
        return {
          ok: true,
          id: String(prior.message_id || replyId),
          duplicate: true,
          createdKey: String(prior.created_key || '')
        };
      }

      let rate;
      try {
        rate = bulletin.replyRateDecision(
          rateSnap.exists ? (rateSnap.data() || {}) : null,
          Date.now()
        );
      } catch (error) {
        const translated = translateBulletinError(error);
        if (translated) throw translated;
        throw error;
      }
      if (!rate.allowed) {
        throw new HttpsError('resource-exhausted',
          'נשלחו יותר מדי תגובות. נסה שוב בעוד ' +
          rate.retryAfterSeconds + ' שניות.',
          { retryAfterSeconds: rate.retryAfterSeconds });
      }

      const replyCount = Math.max(0, Math.floor(Number(parent.reply_count || 0)));
      if (replyCount >= 500) {
        throw new HttpsError('failed-precondition',
          'הדיון הגיע למספר התגובות המרבי. יש לפרסם הודעת המשך.');
      }
      const nowMillis = Date.now();
      const createdAt = admin.firestore.Timestamp.fromMillis(nowMillis);
      const createdKey = new Date(nowMillis).toISOString();
      tx.create(replyRef, {
        kind: 'bulletin_reply',
        parent_message_id: input.messageId,
        text: input.text,
        by_uid: identity.uid,
        by_name: actor.byName,
        by_role: identity.role,
        by_crew: identity.crew,
        hidden: false,
        created_at: createdAt,
        created_key: createdKey,
        request_hash: hash
      });
      tx.update(parentRef, {
        reply_count: replyCount + 1,
        last_reply_at: createdAt
      });
      tx.create(receiptRef, {
        request_hash: hash,
        message_path: replyRef.path,
        message_id: replyId,
        created_key: createdKey,
        created_at: createdAt
      });
      tx.set(rateRef, {
        count: rate.count,
        window_started_at: admin.firestore.Timestamp.fromMillis(
          rate.windowStartedMillis
        ),
        updated_at: createdAt
      }, { merge: true });
      return { ok: true, id: replyId, duplicate: false, createdKey: createdKey };
    });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    const translated = translateBulletinError(error);
    if (translated) throw translated;
    console.error('replyToBulletinMessage failed', {
      uid: identity.uid, sid: sid, subStationId: input.subStationId,
      messageId: input.messageId, requestKey: reqKey,
      error: String(error && error.message || error)
    });
    throw new HttpsError('internal',
      'שליחת התגובה נכשלה. לא נוצרה תגובה חלקית; נסה שוב.');
  }
});

exports.hideBulletinMessage = onCall(async (req) => {
  const auth = requireSuperAdmin(req);
  let input;
  try {
    input = bulletin.parseHideInput(req.data);
  } catch (error) {
    const translated = translateBulletinError(error);
    if (translated) throw translated;
    throw error;
  }

  const messageRef = db.doc(
    'stations/' + input.sid + '/sub_stations/' + input.subStationId +
    '/bulletin_messages/' + input.messageId
  );
  const audit = await openAudit(
    auth, 'hide_bulletin_message', messageRef.path,
    { sid: input.sid, sub_station_id: input.subStationId,
      message_id: input.messageId }
  );

  try {
    const result = await db.runTransaction(async function (tx) {
      const selectedSnap = await tx.get(messageRef);
      if (!selectedSnap.exists) {
        throw new HttpsError('not-found', 'ההודעה לא נמצאה.');
      }
      const message = selectedSnap.data() || {};
      if (message.kind !== 'bulletin') {
        throw new HttpsError('failed-precondition',
          'המסמך שנמצא אינו הודעת לוח תקינה.');
      }
      let targetIds;
      const isBroadcast = message.audience === 'all_sub_stations';
      try {
        targetIds = bulletin.hideTargetIds(
          input.subStationId, input.messageId, message
        );
      } catch (error) {
        const translated = translateBulletinError(error);
        if (translated) throw translated;
        throw error;
      }
      const targets = [];
      for (const targetId of targetIds) {
        const ref = db.doc(
          'stations/' + input.sid + '/sub_stations/' + targetId +
          '/bulletin_messages/' + input.messageId
        );
        const snap = targetId === input.subStationId
          ? selectedSnap : await tx.get(ref);
        targets.push({ id: targetId, ref: ref, snap: snap });
      }

      // All copies are read before the first update. For a broad message this
      // makes moderation all-or-none across the original target set, including
      // boards that were archived after publication.
      let alreadyHiddenCount = 0;
      let missingCount = 0;
      const toHide = [];
      targets.forEach(function (target) {
        if (!target.snap.exists) {
          missingCount += 1;
          return;
        }
        const copy = target.snap.data() || {};
        if (copy.kind !== 'bulletin' ||
            (isBroadcast &&
             (copy.audience !== 'all_sub_stations' ||
              String(copy.broadcast_id || '') !== input.messageId))) {
          throw new HttpsError('failed-precondition',
            'עותקי ההפצה אינם עקביים; לא בוצעה הסתרה חלקית.');
        }
        if (copy.hidden === true) {
          alreadyHiddenCount += 1;
        } else {
          toHide.push(target);
        }
      });
      const hiddenAt = admin.firestore.Timestamp.fromMillis(Date.now());
      toHide.forEach(function (target) {
        tx.update(target.ref, {
          hidden: true,
          hidden_at: hiddenAt,
          hidden_by: auth.uid
        });
      });
      return {
        alreadyHidden: toHide.length === 0,
        broadcast: isBroadcast,
        targetCount: targetIds.length,
        hiddenCount: toHide.length,
        alreadyHiddenCount: alreadyHiddenCount,
        missingCount: missingCount,
        messagePaths: targets.map(function (target) { return target.ref.path; })
      };
    });

    await sealAudit(audit, {
      message_path: messageRef.path,
      message_paths: result.messagePaths,
      broadcast: result.broadcast,
      target_count: result.targetCount,
      hidden_count: result.hiddenCount,
      already_hidden_count: result.alreadyHiddenCount,
      missing_count: result.missingCount,
      already_hidden: result.alreadyHidden
    });
    return { ok: true, id: input.messageId,
             alreadyHidden: result.alreadyHidden,
             broadcast: result.broadcast,
             targetCount: result.targetCount,
             hiddenCount: result.hiddenCount };
  } catch (error) {
    await sealAudit(audit, {
      outcome: 'failed',
      error_code: String(error && error.code || 'internal').slice(0, 80)
    });
    if (error instanceof HttpsError) throw error;
    console.error('hideBulletinMessage failed', {
      path: messageRef.path, error: String(error && error.message || error)
    });
    throw new HttpsError('internal', 'הסתרת ההודעה נכשלה. נסה שוב.');
  }
});

exports.hideBulletinReply = onCall(async (req) => {
  const auth = requireSuperAdmin(req);
  let input;
  try {
    input = bulletin.parseHideReplyInput(req.data);
  } catch (error) {
    const translated = translateBulletinError(error);
    if (translated) throw translated;
    throw error;
  }

  const parentRef = db.doc(
    'stations/' + input.sid + '/sub_stations/' + input.subStationId +
    '/bulletin_messages/' + input.messageId
  );
  const replyRef = parentRef.collection('bulletin_replies').doc(input.replyId);
  const audit = await openAudit(
    auth, 'hide_bulletin_reply', replyRef.path,
    { sid: input.sid, sub_station_id: input.subStationId,
      message_id: input.messageId, reply_id: input.replyId }
  );

  try {
    const result = await db.runTransaction(async function (tx) {
      const parentSnap = await tx.get(parentRef);
      const replySnap = await tx.get(replyRef);
      if (!parentSnap.exists || (parentSnap.data() || {}).kind !== 'bulletin') {
        throw new HttpsError('not-found', 'הודעת המקור לא נמצאה.');
      }
      if (!replySnap.exists) {
        throw new HttpsError('not-found', 'התגובה לא נמצאה.');
      }
      const reply = replySnap.data() || {};
      if (reply.kind !== 'bulletin_reply') {
        throw new HttpsError('failed-precondition',
          'המסמך שנמצא אינו תגובת לוח תקינה.');
      }
      if (reply.hidden === true) return { alreadyHidden: true };

      const parent = parentSnap.data() || {};
      const count = Math.max(0, Math.floor(Number(parent.reply_count || 0)));
      const hiddenAt = admin.firestore.Timestamp.fromMillis(Date.now());
      tx.update(replyRef, {
        hidden: true,
        hidden_at: hiddenAt,
        hidden_by: auth.uid
      });
      tx.update(parentRef, { reply_count: Math.max(0, count - 1) });
      return { alreadyHidden: false };
    });

    await sealAudit(audit, {
      message_path: replyRef.path,
      already_hidden: result.alreadyHidden
    });
    return { ok: true, id: input.replyId,
             alreadyHidden: result.alreadyHidden };
  } catch (error) {
    await sealAudit(audit, {
      outcome: 'failed',
      error_code: String(error && error.code || 'internal').slice(0, 80)
    });
    if (error instanceof HttpsError) throw error;
    console.error('hideBulletinReply failed', {
      path: replyRef.path, error: String(error && error.message || error)
    });
    throw new HttpsError('internal', 'הסתרת התגובה נכשלה. נסה שוב.');
  }
});

// ---------------------------------------------------------------------
//  קליטת סגל מרוכזת — מושבתת ב-41B
// ---------------------------------------------------------------------
//
// ה-UI הישן הוסר יחד עם קובץ הסגל הפרטי. משאירים את שם
// הפונקציה קיים כדי שגם לקוח ישן יקבל חסימה מפורשת, במקום
// להמשיך להגיע למימוש ישן או לקבל שגיאת "פונקציה לא קיימת".
exports.bulkImport = onCall(
  { timeoutSeconds: 540 },
  bulkImportDisabled.createHandler({
    requireSuperAdmin: requireSuperAdmin,
    HttpsError: HttpsError
  })
);

// ---------------------------------------------------------------------
//  מצב שקט — הפעלה וכיבוי
// ---------------------------------------------------------------------
//
//  silent_allow מכיל uid-ים ואימיילים שממשיכים לקבל. הרשימה
//  נשמרת באותיות קטנות כי אימייל אינו תלוי־רישיות, ואי־התאמה
//  כאן משמעה שאלדד מפסיק לקבל בלי להבין למה.

exports.setSilentMode = onCall(async (req) => {
  const auth = requireSuperAdmin(req);
  const d = req.data || {};
  const on = d.silent === true;
  const allow = (Array.isArray(d.allow) ? d.allow : [])
    .map(x => String(x || '').trim().toLowerCase()).filter(Boolean).slice(0, 40);

  const audit = await openAudit(auth, 'set_silent_mode', null,
                               { silent: on, allow: allow.length });

  await db.doc(RUNTIME_DOC).set({
    silent: on, silent_allow: allow,
    updated_by: auth.uid, updated_at: FV.serverTimestamp()
  }, { merge: true });

  // מסמך שני, ציבורי, עם שדה אחד: ניסוי או חי.
  //
  // **למה בכלל שני מסמכים.** את המצב צריך לקרוא כל כבאי, כדי
  // שפס "מצב ניסוי" יופיע לו על המסך. את רשימת הפטורים אסור
  // שיקרא — היא מגלה מי כן מקבל התראות כשכולם חושבים שהמערכת
  // שקטה. שדה בודד אי אפשר לחסום בכלל אבטחה: או שכל המסמך
  // נקרא, או שלא. לכן שניים.
  await db.doc('config/mode').set({
    mode: on ? 'trial' : 'live',
    since: FV.serverTimestamp()
  }, { merge: true });

  _rt = null;   // מאלץ קריאה מחדש, אחרת המטמון היה משהה את השינוי בחצי דקה
  await sealAudit(audit, { silent: on });
  return { ok: true, silent: on, allow: allow, mode: on ? 'trial' : 'live' };
});

exports.getSilentMode = onCall(async (req) => {
  requireSuperAdmin(req);
  const d = await db.doc(RUNTIME_DOC).get().catch(() => null);
  const v = (d && d.exists ? d.data() : {}) || {};
  let blocked = 0;
  try {
    const c = await db.collection('silenced').count().get();
    blocked = c.data().count;
  } catch (e) {}
  // כמה חשבונות קיימים, וכמה מהם כבר נכנסו פעם אחת. בלי
  // המספרים האלה "להפוך לחי" היא החלטה בעיניים עצומות.
  let accounts = 0, signedIn = 0;
  try {
    let pageToken = undefined;
    do {
      const page = await admin.auth().listUsers(1000, pageToken);
      page.users.forEach(function (u) {
        accounts++;
        if (u.metadata && u.metadata.lastSignInTime) signedIn++;
      });
      pageToken = page.pageToken;
    } while (pageToken);
  } catch (e) {}

  return { silent: v.silent === true,
           mode: v.silent === true ? 'trial' : 'live',
           allow: Array.isArray(v.silent_allow) ? v.silent_allow : [],
           blocked: blocked,
           accounts: accounts, signed_in: signedIn };
});

// ---------------------------------------------------------------------
//  6. רשימת משתמשים למסך הניהול
// ---------------------------------------------------------------------

exports.listUsersWithClaims = onCall(async (req) => {
  requireSuperAdmin(req);

  const result = [];
  let pageToken = undefined;

  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    page.users.forEach(function (u) {
      result.push({
        uid:            u.uid,
        email:          u.email || '',
        email_verified: u.emailVerified === true,
        disabled:       u.disabled === true,
        created:        u.metadata.creationTime,
        last_signin:    u.metadata.lastSignInTime,
        claims:         u.customClaims || {}
      });
    });
    pageToken = page.pageToken;
  } while (pageToken);

  // ---------- שם וטלפון מהפרופיל ----------
  //
  // ההרשאות בטוקן מכילות תפקיד, תחנה, משמרת ומספר עובד —
  // **אבל לא שם.** השם נשמר בפרופיל, ב-users/{uid}.
  //
  // בלי זה, בורר האנשים במסך הניהול היה מציג רשימה של
  // כתובות מייל. אלדד ביקש לבחור **לפי שם**, וזה גם הדבר
  // הנכון: מי שמתקן תפקיד מכיר את האדם בשמו, לא לפי
  // ramiha25@gmail.com.
  //
  // קריאה אחת לכל תחנה שמופיעה ברשימה, ולא אחת לכל אדם.
  const sids = Array.from(new Set(result
    .map(function (u) { return String((u.claims || {}).stationId || ''); })
    .filter(Boolean)));

  const byUid = {};
  for (const sid of sids) {
    try {
      const snap = await db.collection('stations/' + sid + '/users').get();
      snap.forEach(function (d) {
        const v = d.data() || {};
        byUid[d.id] = { full_name: v.full_name || '', phone: v.phone || '' };
      });
    } catch (e) { /* תחנה שאין אליה גישה — הרשימה פשוט בלי שמות */ }
  }

  result.forEach(function (u) {
    const p = byUid[u.uid] || {};
    u.full_name = p.full_name || '';
    u.phone     = p.phone || '';
  });

  return { ok: true, count: result.length, users: result };
});

// ---------------------------------------------------------------------
//  7. מי אני — לאבחון
// ---------------------------------------------------------------------

exports.whoAmI = onCall(async (req) => {
  if (!req.auth) return { signedIn: false };

  const user = await admin.auth().getUser(req.auth.uid);

  return {
    signedIn: true,
    uid:      req.auth.uid,
    email:    req.auth.token.email || '',
    claims_in_token: {
      role:       req.auth.token.role       || null,
      stationId:  req.auth.token.stationId  || null,
      districtId: req.auth.token.districtId || null,
      shift:      req.auth.token.shift      || null,
      emp:        req.auth.token.emp        || null,
      super:      req.auth.token.super      || false
    },
    claims_on_server: user.customClaims || {},
    note: 'אם שתי הרשימות שונות — הטוקן ישן. צריך getIdToken(true).'
  };
});

// ---------------------------------------------------------------------
//  9. בנייה מחדש של מפתח החיפוש
//
//  רשומות שנכתבו לפני שמפתח החיפוש קיים אינן ניתנות למציאה.
//  הפונקציה הזו עוברת על הספרייה ומוסיפה להן אותו. אפשר להריץ
//  אותה שוב ושוב — היא כותבת את אותו ערך ולא משנה שום נתון אחר.
// ---------------------------------------------------------------------

exports.reindexDirectory = onCall(async (req) => {
  const auth = requireSuperAdmin(req);

  const snaps = await db.collection('directory').get();
  if (snaps.empty) return { ok: true, scanned: 0, updated: 0 };

  const audit = await openAudit(auth, 'reindex_directory', null,
                               { count: snaps.size });

  let updated = 0;
  let batch = db.batch();
  let inBatch = 0;

  for (const d of snaps.docs) {
    const name = String((d.data() || {}).full_name || '');
    if (!name) continue;

    batch.set(d.ref, {
      name_prefixes: namePrefixes(name),
      updated_at:    FV.serverTimestamp()
    }, { merge: true });

    updated++;
    inBatch++;

    // מגבלת Firestore היא 500 פעולות לאצווה.
    if (inBatch === 400) {
      await batch.commit();
      batch = db.batch();
      inBatch = 0;
    }
  }

  if (inBatch > 0) await batch.commit();
  await sealAudit(audit, { updated: updated });

  return { ok: true, scanned: snaps.size, updated: updated };
});


// =====================================================================
//  ריצת לילה ודוח חודשי
//
//  הסידור משתנה — חריגה נוספת, מישהו מחליף מישהו — והדוח שנבנה
//  לפני שבועיים כבר לא תואם. שתי המשימות כאן רצות מעצמן ומוצאות
//  את הפערים לפני שמשאבי אנוש מוצאים אותם.
//
//  שתיהן קוראות את השעות מהשדה hours שנשמר על הרשומה, ואינן
//  מחשבות אותן מחדש. החישוב חי במקום אחד — hours.js בדפדפן —
//  והמשתמש אישר בדיוק את המספרים האלה. חישוב שני כאן היה יוצר
//  אפשרות שהמייל אומר מספר אחד והמסך אומר אחר, וזה בדיוק הפער
//  שהמערכת הישנה סבלה ממנו.
// =====================================================================

const { onSchedule } = require('firebase-functions/v2/scheduler');

const STATION_ID   = 'eilat_102';
const STATION_NAME = 'תחנה 102';

// =====================================================================
//  41A · נוכחות אוטומטית במצב Shadow בלבד
// =====================================================================
//
// הריצה מצלמת את הסידור הקנוני ב-05:30 ומשווה אותו לדיווחים
// הקיימים. היא אינה כותבת ל-attendance או ל-monthly_reports.
// המעבר מ-Shadow למנגנון שמייצר שעות אינו קיים בגרסה הזאת בכוונה.

const SHADOW_AUDITOR_ROLES = ['hr_coordinator', 'station_commander'];

function attendanceShadowStation(req, auth) {
  const claimed = String((auth && auth.token && auth.token.stationId) || '');
  if (claimed) return claimed;
  if (auth && isSuperAdmin(auth)) return STATION_ID;
  throw new HttpsError('failed-precondition', 'לחשבון אין שיוך לתחנה.');
}

async function requireAttendanceShadowAuditor(req) {
  const auth = requireAuth(req);
  const sid = attendanceShadowStation(req, auth);
  if (isSuperAdmin(auth)) return { auth: auth, sid: sid, super: true };

  const tokenRole = String(auth.token.role || '');
  if (SHADOW_AUDITOR_ROLES.indexOf(tokenRole) === -1) {
    throw new HttpsError('permission-denied',
      'בקרת השעות פתוחה לרכז/ת כוח אדם ולמפקד התחנה בלבד.');
  }
  const userSnap = await db.doc('stations/' + sid + '/users/' + auth.uid).get();
  if (!userSnap.exists) {
    throw new HttpsError('failed-precondition', 'כרטיס המשתמש בתחנה לא נמצא.');
  }
  const user = userSnap.data() || {};
  if (user.is_active === false) {
    throw new HttpsError('permission-denied', 'החשבון אינו פעיל.');
  }
  if (String(user.role || '') !== tokenRole) {
    throw new HttpsError('failed-precondition',
      'ההרשאה השתנתה. התנתק והתחבר מחדש לפני פתיחת הבקרה.');
  }
  return { auth: auth, sid: sid, super: false };
}

function translateAttendanceShadowError(error) {
  if (error instanceof HttpsError) return error;
  if (!(error instanceof attendanceShadow.AttendanceShadowError)) return null;
  const code = String(error.code || 'internal');
  if (code === 'run-in-progress' || code === 'report-in-progress' ||
      code === 'run-lost' || code === 'report-lost') {
    return new HttpsError('aborted', 'צילום הצל של היום כבר רץ. נסה שוב בעוד כמה דקות.');
  }
  if (code === 'shadow-disabled') {
    return new HttpsError('failed-precondition', 'מצב הצל כבוי.');
  }
  if (code === 'source-changed') {
    return new HttpsError('failed-precondition',
      'הסידור השתנה בזמן הצילום. לא נשמר צילום חלקי; אפשר להריץ שוב.');
  }
  if (code === 'station-too-large' || code === 'swap-dependency-limit' ||
      code.indexOf('too-many-') === 0) {
    return new HttpsError('resource-exhausted',
      'כמות הנתונים גדולה ממגבלת הבטיחות של ריצת הצל.');
  }
  if (code.indexOf('invalid-') === 0) {
    return new HttpsError('invalid-argument', 'הבקשה לריצת הצל אינה תקינה.');
  }
  return new HttpsError('internal',
    'ריצת הצל נעצרה בבטחה. לא בוצע שינוי בשעות הקיימות.');
}

exports.getAttendanceShadowStatus = onCall(async (req) => {
  const gate = await requireAttendanceShadowAuditor(req);
  try {
    return await attendanceShadowService.status(gate.sid);
  } catch (error) {
    const translated = translateAttendanceShadowError(error);
    if (translated) throw translated;
    console.error('attendanceShadow status failed', error);
    throw new HttpsError('internal', 'מצב בקרת השעות אינו זמין כרגע.');
  }
});

exports.setAttendanceShadowMode = onCall(async (req) => {
  const auth = requireSuperAdmin(req);
  const sid = attendanceShadowStation(req, auth);
  const mode = String((req.data || {}).mode || '');
  if (mode !== 'shadow' && mode !== 'off') {
    throw new HttpsError('invalid-argument', 'מצב לא מוכר.');
  }
  const audit = await openAudit(auth, 'set_attendance_shadow_mode', null, {
    station_id: sid, mode: mode
  });
  const configRef = db.doc(attendanceShadow.CONFIG_PATH);
  await db.runTransaction(async function (tx) {
    const snap = await tx.get(configRef);
    const prior = snap.exists ? (snap.data() || {}) : {};
    const stationIds = Array.isArray(prior.station_ids)
      ? prior.station_ids.map(String).filter(function (value) {
        return /^[a-z0-9_-]{2,80}$/.test(value);
      }) : [];
    const unique = Array.from(new Set(stationIds));
    const at = unique.indexOf(sid);
    if (mode === 'shadow' && at === -1) unique.push(sid);
    if (mode === 'off' && at !== -1) unique.splice(at, 1);
    unique.sort();
    tx.set(configRef, {
      schema_version: 1,
      mode: unique.length ? 'shadow' : 'off',
      station_ids: unique,
      generator_version: attendanceShadow.GENERATOR_VERSION,
      updated_by: auth.uid,
      updated_at: FV.serverTimestamp()
    }, { merge: true });
  });
  await sealAudit(audit, { station_id: sid, mode: mode });
  return { ok: true, mode: mode, station_id: sid };
});

exports.runAttendanceShadowNow = onCall({
  timeoutSeconds: 540,
  memory: '512MiB'
}, async (req) => {
  const gate = await requireAttendanceShadowAuditor(req);
  const audit = await openAudit(gate.auth, 'run_attendance_shadow_now', null, {
    station_id: gate.sid, mode: 'shadow'
  });
  try {
    const result = await attendanceShadowService.runStation({
      sid: gate.sid,
      trigger: 'manual',
      requestedBy: gate.auth.uid
    });
    await sealAudit(audit, {
      station_id: gate.sid,
      duplicate: result.duplicate === true,
      entries: Number(result.entries || 0)
    });
    return result;
  } catch (error) {
    const translated = translateAttendanceShadowError(error);
    if (translated) throw translated;
    console.error('attendanceShadow manual run failed', error);
    throw new HttpsError('internal',
      'ריצת הצל נעצרה בבטחה. לא בוצע שינוי בשעות הקיימות.');
  }
});

exports.attendanceShadowDaily = onSchedule({
  timeoutSeconds: 540,
  memory: '512MiB',
  schedule: '30 5 * * *',
  timeZone: 'Asia/Jerusalem',
  region: 'europe-west1'
}, async () => {
  const config = await attendanceShadowService.configuredStations();
  if (config.mode !== 'shadow' || !config.stationIds.length) {
    console.log('attendanceShadowDaily · disabled');
    return;
  }
  const failures = [];
  for (const sid of config.stationIds) {
    try {
      const result = await attendanceShadowService.runStation({
        sid: sid, trigger: 'scheduled', requestedBy: 'scheduler'
      });
      console.log('attendanceShadowDaily · station', sid,
        'entries', Number(result.entries || 0), 'duplicate', result.duplicate === true);
    } catch (error) {
      const code = String(error && error.code || 'internal');
      failures.push(sid + ':' + code);
      console.error('attendanceShadowDaily · station failed', sid, code);
    }
  }
  if (failures.length) {
    throw new Error('Attendance Shadow failed for ' + failures.join(', '));
  }
});

// חריגה בסך שעות חודשי. ניתן לשנות במסמך ההגדרות.
const DEFAULT_HOUR_LIMIT = 265;

// משאבי אנוש. ברירת מחדל, כדי שהדוח יישלח גם בלי שמישהו
// יגדיר משהו. מסמך ההגדרות דורס אותה — כתובת מתחלפת, ואין
// סיבה שהחלפה תדרוש פריסה מחדש.
const DEFAULT_HR_EMAIL = 'lisaa@102.gov.il';
const DEFAULT_HR_NAME  = 'ליסה עגיב';

const HE_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני',
                   'יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

function pad2(n) { return String(n).padStart(2, '0'); }

function monthKeyOf(d) {
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1);
}

function prevMonthKey(d) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  return m === 0 ? (y - 1) + '-12' : y + '-' + pad2(m);
}

function heMonth(mk) {
  const p = String(mk).split('-');
  return (HE_MONTHS[Number(p[1]) - 1] || p[1]) + ' ' + p[0];
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- הגדרות משאבי אנוש ----------
//
// כתובת המייל אינה קבועה בקוד. היא יושבת במסמך שאפשר לערוך,
// כי כתובת מתחלפת ואין סיבה שהחלפה כזו תדרוש פריסה מחדש.
async function hrConfig() {
  let cfg = {};
  try {
    const snap = await db.doc('stations/' + STATION_ID + '/config/hr').get();
    if (snap.exists) cfg = snap.data() || {};
  } catch (e) {
    console.error('hr config read failed', e);
  }
  return {
    email: String(cfg.email || DEFAULT_HR_EMAIL).trim(),
    name:  String(cfg.name  || DEFAULT_HR_NAME).trim(),
    limit: Number(cfg.hour_limit || DEFAULT_HOUR_LIMIT)
  };
}

// ---------- איזו משמרת עובדת בתאריך ----------
//
// אותה נוסחה בדיוק שב-rotation.js, כולל עדיפות החריגות.
// היא מוכפלת כאן כי הדפדפן והשרת אינם חולקים קוד, וזו כפילות
// מודעת: כל שינוי בכלל הזה חייב להיעשות בשני המקומות.
const CREWS = ['A', 'B', 'C'];

function daysBetweenKeys(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round(
    (Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000
  );
}

function crewOnKey(rotations, overrides, dateKey) {
  const ov = overrides[dateKey];
  if (ov && ov.crew && CREWS.indexOf(ov.crew) !== -1) return ov.crew;

  const active = (rotations || []).filter(r => r.is_active !== false);
  if (!active.length) return null;

  const base   = active[0];
  const cycle  = Number(base.cycle_days) || CREWS.length;
  const anchor = String(base.anchor_date || '');
  if (!anchor) return null;

  const diff = daysBetweenKeys(anchor, dateKey);
  const idx  = ((diff % cycle) + cycle) % cycle;
  const hit  = active.find(r => Number(r.position_in_cycle) === idx);
  return hit ? hit.crew : null;
}

function isWorking(rotations, overrides, crew, dateKey) {
  if (crewOnKey(rotations, overrides, dateKey) === crew) return true;
  const ov = overrides[dateKey];
  return !!(ov && Array.isArray(ov.extra_crews) && ov.extra_crews.indexOf(crew) !== -1);
}

async function loadSchedule(sid) {
  if (typeof sid !== 'string' || !sid.trim() || sid !== sid.trim()) {
    throw new Error('loadSchedule requires an explicit station id');
  }
  const rotations = [];
  const overrides = {};
  try {
    const rs = await db.collection('stations/' + sid + '/rotations').get();
    rs.forEach(d => rotations.push(d.data() || {}));
  } catch (e) {
    throw new Error('schedule rotations read failed');
  }
  try {
    const os = await db.collection('stations/' + sid + '/shift_overrides').get();
    os.forEach(d => { overrides[d.id] = d.data() || {}; });
  } catch (e) {
    throw new Error('schedule overrides read failed');
  }
  return { rotations, overrides };
}

// ---------- סריקת חודש של אדם אחד ----------

function scanPerson(person, recs, sched, mk, limit, cutoff) {
  const findings = [];
  const byDate = {};
  recs.forEach(r => { byDate[r.date] = r; });

  const p = mk.split('-').map(Number);
  const last = new Date(Date.UTC(p[0], p[1], 0)).getUTCDate();

  // **עד היום בלבד.** הסריקה רצה על החודש הנוכחי, והלולאה
  // הגיעה עד סופו — כך שב-5 בחודש כל משמרת עתידית נספרה
  // כ"עבד ואין דיווח". התוצאה: כעשרים ממצאים מומצאים לכל
  // אדם, בכל לילה, שמטביעים את הממצאים האמיתיים.
  const stop = cutoff || (mk + '-' + pad2(last));

  let total = 0;
  recs.forEach(r => { total += Number(r.hours || 0); });
  total = Math.round(total * 100) / 100;

  for (let d = 1; d <= last; d++) {
    const key = mk + '-' + pad2(d);
    if (key > stop) break;
    const working = person.crew &&
      isWorking(sched.rotations, sched.overrides, person.crew, key);
    const rec = byDate[key];

    // הסידור אומר שעבד ואין דיווח.
    if (working && !rec) {
      findings.push({ kind: 'missing', date: key,
                      text: 'הסידור אומר שעבד ואין דיווח' });
    }
    // דווח כיום רגיל והסידור אומר שלא עבד. לא בהכרח טעות —
    // נע״ת, ישיבה או החלפה נראים כך — ולכן זו הערה ולא שגיאה.
    if (!working && rec && rec.day_type === 'regular') {
      findings.push({ kind: 'unscheduled', date: key,
                      text: 'דווח יום רגיל והסידור אומר שלא עבד' });
    }
    // משמרת שנפתחה ולא נסגרה.
    if (rec && rec.start && !rec.end) {
      findings.push({ kind: 'open', date: key,
                      text: 'משמרת נפתחה בשעון ולא נסגרה' });
    }
    // יום שדורש נימוק ואין. הדגל reason_required נכתב על הרשומה
    // בדפדפן, ששם חיים כללי הנימוק.
    if (rec && rec.reason_required && !String(rec.overtime_reason || '').trim()) {
      findings.push({ kind: 'no_reason', date: key,
                      text: 'יום שדורש נימוק ואין בו נימוק' });
    }
    // שעות שנשמרו ולא מסתדרות בכלל.
    if (rec && (rec.hours == null || Number(rec.hours) < 0 || Number(rec.hours) > 48)) {
      findings.push({ kind: 'bad_hours', date: key,
                      text: 'שעות לא סבירות: ' + rec.hours });
    }
  }

  if (total > limit) {
    findings.push({ kind: 'over_limit', date: '',
                    text: 'סך ' + total + ' שעות, מעל הסף של ' + limit });
  }

  return { total, findings };
}

// ---------- סריקה מלאה ----------

// cutoff — התאריך האחרון שנסרק. חודש סגור נסרק במלואו; החודש
// הנוכחי נסרק עד היום בלבד, אחרת כל משמרת עתידית נספרת
// כדיווח חסר.
async function scanMonth(mk, cutoff) {
  const sched = await loadSchedule(STATION_ID);
  const cfg = await hrConfig();

  const people = [];
  const rs = await db.collection('stations/' + STATION_ID + '/roster').get();
  rs.forEach(d => {
    const v = d.data() || {};
    if (v.is_active === false) return;
    people.push({ uid: d.id, full_name: v.full_name || '', crew: v.crew || '' });
  });

  const att = await db.collection('stations/' + STATION_ID + '/attendance')
    .where('month', '==', mk).get();

  const byEmp = {};
  att.forEach(d => {
    const v = d.data() || {};
    const e = String(v.emp_number || '');
    if (!e) return;
    (byEmp[e] = byEmp[e] || []).push(v);
  });

  const results = [];
  for (const emp of Object.keys(byEmp)) {
    const recs = byEmp[emp];
    const first = recs[0] || {};
    const person = {
      emp: emp,
      uid: first.uid || '',
      full_name: first.full_name || '',
      crew: first.crew || ''
    };
    const out = scanPerson(person, recs, sched, mk, cfg.limit, cutoff);
    results.push(Object.assign({ person, recs }, out));
  }

  // מי שיש לו משמרות בסידור ולא דיווח אף יום — לא יופיע כלל
  // בסריקה שמבוססת על דיווחים, ולכן נבדק בנפרד.
  const reported = {};
  results.forEach(r => { reported[r.person.uid] = true; });
  people.forEach(function (p) {
    if (reported[p.uid] || !p.crew) return;
    const pk = mk.split('-').map(Number);
    const last = new Date(Date.UTC(pk[0], pk[1], 0)).getUTCDate();
    let due = 0;
    for (let d = 1; d <= last; d++) {
      const key = mk + '-' + pad2(d);
      if (cutoff && key > cutoff) break;   // אותו חתך כמו ב-scanPerson
      if (isWorking(sched.rotations, sched.overrides, p.crew, key)) due++;
    }
    if (due) {
      results.push({
        person: { emp: '', uid: p.uid, full_name: p.full_name, crew: p.crew },
        recs: [], total: 0,
        findings: [{ kind: 'nothing_reported', date: '',
                     text: due + ' משמרות בסידור ואף יום לא דווח' }]
      });
    }
  });

  results.sort((a, b) =>
    String(a.person.full_name).localeCompare(String(b.person.full_name), 'he'));
  return { results, cfg, mk };
}

// ---------- ריצת הלילה ----------
//
// 02:10 בלילה, שעון ישראל. מוקדם מספיק כדי שהבוקר יתחיל עם
// תמונה נכונה, ומאוחר מספיק כדי שדיווחי הערב כבר נכנסו.

// ---------------------------------------------------------------------
//  תצלום לילי — גילוי אובדן נתונים
// ---------------------------------------------------------------------
//
//  **מה זה כן, ומה זה לא.**
//
//  זה **אינו** גיבוי. שחזור אמיתי של Firestore הוא Point-In-Time
//  Recovery בקונסולה — הוא מחזיר את בסיס הנתונים לכל רגע בשבעה
//  ימים אחורה, הוא חינם, והוא לא דורש שאיש יזכור כלום. הוא
//  כבוי כרגע, ואי אפשר להפעיל אותו רטרואקטיבית.
//
//  מה שזה כן: **גלאי**. כל לילה נספרים המסמכים בכל אוסף
//  ומושווים לאתמול. ירידה חדה — מחיקה בטעות, סקריפט שרץ פעמיים,
//  כלל שנפרס שגוי ומחק — מייצרת התראה בבוקר.
//
//  בלי זה, אובדן נתונים מתגלה כשמישהו מחפש משהו ולא מוצא, וזה
//  קורה שבועות אחרי — הרבה אחרי שחלון השחזור נסגר.

const SNAP_COLS = [
  'roster', 'users', 'quals', 'member_quals', 'rotations',
  'shift_overrides', 'sub_stations', 'vehicles', 'vehicle_views',
  'attendance', 'monthly_reports', 'swaps', 'guards', 'faults',
  'handovers', 'submissions', 'broadcasts'
];

// ירידה של יותר מרבע, או היעלמות מוחלטת של אוסף שהיה מלא.
const DROP_RATIO = 0.75;

exports.nightlySnapshot = onSchedule({
  timeoutSeconds: 300,
  schedule: '15 3 * * *',
  timeZone: 'Asia/Jerusalem',
  region: 'europe-west1'
}, async () => {
  const sid = STATION_ID;
  const today = new Date().toISOString().slice(0, 10);
  const counts = {};

  for (const name of SNAP_COLS) {
    try {
      const c = await db.collection('stations/' + sid + '/' + name).count().get();
      counts[name] = c.data().count;
    } catch (e) {
      // ספירה שנכשלה נרשמת כ-null ולא כאפס. אפס פירושו "נמחק
      // הכל", וזו התראה שגויה שתישלח כל לילה עד שמישהו יבדוק.
      counts[name] = null;
    }
  }

  // אתמול, להשוואה.
  let prev = null;
  try {
    const snap = await db.collection('stations/' + sid + '/backups')
      .orderBy('date', 'desc').limit(1).get();
    if (!snap.empty) prev = (snap.docs[0].data() || {}).counts || null;
  } catch (e) {}

  const drops = [];
  if (prev) {
    for (const name of SNAP_COLS) {
      const was = prev[name], now = counts[name];
      if (was == null || now == null) continue;
      if (was >= 5 && now < was * DROP_RATIO) {
        drops.push(name + ': ' + was + ' → ' + now);
      }
    }
  }

  await db.doc('stations/' + sid + '/backups/' + today).set({
    date: today, counts: counts, drops: drops,
    at: FV.serverTimestamp()
  });

  if (drops.length) {
    console.error('DATA LOSS SUSPECTED', drops.join(' | '));

    // פוש ולא מייל.
    //
    // ההתראה הזו מגיעה לאדם אחד — מנהל המערכת — והוא זה שמחזיק
    // את האפליקציה בטלפון. מייל היה מחייב שרת דואר חיצוני,
    // חשבון אצל חברה כלשהי ותשלום חודשי, בשביל התראה אחת
    // שנשלחת אולי פעם בשנה. הפוש כבר קיים ועובד.
    //
    // הודעה רגילה ולא דחופה: היא נשלחת ב-03:15, ואין מה לעשות
    // בשלוש לפנות בוקר. המידע ממתין בטלפון עד הבוקר.
    try {
      const admUser = await admin.auth().getUserByEmail(SUPER_ADMIN_EMAIL);
      await pushToUsers(sid, [admUser.uid], 'data_loss',
        'ResQ — ירידה חדה בנתונים',
        drops.join(' · ') + ' — בדוק לפני שהחלון של שבעה ימים ייסגר.',
        './check.html', false);
    } catch (e) {
      // כישלון בהתראה לא מבטל את הגיבוי עצמו. הספירה כבר
      // נכתבה, והיא הנתון שממנו משחזרים.
      console.error('data-loss push failed', e);
    }
  }

  console.log('snapshot ' + today + ' · ' +
    Object.keys(counts).length + ' collections · ' +
    drops.length + ' drops');
});

exports.nightlyScan = onSchedule({
  timeoutSeconds: 540,
  memory: '1GiB',
  schedule: '10 2 * * *',
  timeZone: 'Asia/Jerusalem',
  region: 'europe-west1'
}, async () => {
  const now = new Date();
  const mk = monthKeyOf(now);
  // עד היום. הסריקה רצה בלילה על החודש הרץ.
  const today = mk + '-' + pad2(now.getUTCDate());
  const { results, cfg } = await scanMonth(mk, today);

  const flagged = results.filter(r => r.findings.length);
  const total = flagged.reduce((s, r) => s + r.findings.length, 0);

  await db.doc('stations/' + STATION_ID + '/scans/' + mk).set({
    month: mk,
    ran_at: FV.serverTimestamp(),
    people_checked: results.length,
    people_flagged: flagged.length,
    findings_total: total,
    hour_limit: cfg.limit,
    people: flagged.map(r => ({
      emp: r.person.emp,
      full_name: r.person.full_name,
      crew: r.person.crew,
      total_hours: r.total,
      findings: r.findings
    }))
  }, { merge: true });

  console.log('nightlyScan', mk, 'checked', results.length,
              'flagged', flagged.length, 'findings', total);
});

// ---------- הדוח החודשי למשאבי אנוש ----------
//
// ב-1 לחודש ב-06:00, על החודש שהסתיים. מייל אחד מאוחד עם כל
// המשתמשים, כפי שאלדד ביקש — ולא 39 מיילים נפרדים.

function personTable(r, cfg) {
  const rows = r.recs.slice().sort((a, b) =>
    String(a.date).localeCompare(String(b.date)));

  const body = rows.map(function (v) {
    // בלי סימון "לא צוינה סיבה" — השמירה חסומה בלעדיו.
    const note = esc(String(v.overtime_reason || '').trim() || v.notes || '');
    const t = function (x) {
      return '<span style="direction:ltr;unicode-bidi:isolate;display:inline-block">' +
             esc(x || '—') + '</span>';
    };
    const p = String(v.date).split('-');
    return '<tr>' +
      '<td style="padding:6px;border:1px solid #e6eaee;text-align:center">' +
        Number(p[2]) + '.' + Number(p[1]) + '</td>' +
      '<td style="padding:6px;border:1px solid #e6eaee;text-align:center">' +
        esc(v.day_type_he || v.day_type || '') + '</td>' +
      '<td style="padding:6px;border:1px solid #e6eaee;text-align:center">' +
        (v.start ? t(v.start) : '—') + '</td>' +
      '<td style="padding:6px;border:1px solid #e6eaee;text-align:center">' +
        (v.end ? t(v.end) : '—') + '</td>' +
      '<td style="padding:6px;border:1px solid #e6eaee;text-align:center">' +
        esc(v.site_name || '') + '</td>' +
      '<td style="padding:6px;border:1px solid #e6eaee;text-align:right">' + note + '</td>' +
      '<td style="padding:6px;border:1px solid #e6eaee;text-align:center;' +
        'font-weight:700">' + (v.hours == null ? '—' : v.hours) + '</td>' +
    '</tr>';
  }).join('');

  const over = r.total > cfg.limit;
  const flags = r.findings.filter(f => f.kind !== 'over_limit');

  return '<div style="margin:0 0 30px">' +
    '<div style="font-size:19px;font-weight:800;color:#c62828">' +
      esc(r.person.full_name || r.person.emp) + '</div>' +
    '<div style="font-size:12.5px;color:#666;margin-bottom:8px">מס׳ ' +
      esc(r.person.emp) + (r.person.crew ? ' · משמרת ' + esc(r.person.crew) : '') +
      '</div>' +
    (rows.length
      ? '<table style="width:100%;border-collapse:collapse;font-size:12.5px">' +
        '<thead><tr>' +
        ['תאריך','סוג יום','כניסה','יציאה','מקום','הערות','שעות'].map(function (h) {
          return '<th style="background:#f4f6f8;color:#1565c0;padding:7px;' +
                 'border:1px solid #dde3e8">' + h + '</th>'; }).join('') +
        '</tr></thead><tbody>' + body + '</tbody></table>'
      : '<div style="color:#c62828;font-weight:700">לא דווח אף יום</div>') +
    (flags.length
      ? '<div style="border:1px solid #e0a23c;background:#fff8e6;border-radius:6px;' +
        'padding:9px;margin-top:8px;font-size:12.5px;color:#8a6100">' +
        flags.map(f => (f.date ? f.date.slice(8) + '.' + f.date.slice(5, 7) + ' · ' : '') +
                       esc(f.text)).join('<br>') + '</div>'
      : '') +
    '<div style="border:2px solid ' + (over ? '#c62828' : '#dde3e8') +
      ';border-radius:6px;padding:11px;margin-top:8px;text-align:center;' +
      'font-size:16px;font-weight:800' + (over ? ';color:#c62828' : '') + '">' +
      'סך שעות: ' + r.total + (over ? '  ⚠ חריגה מעל ' + cfg.limit : '') +
    '</div></div>';
}

async function buildAndSendMonthly(mk) {
  const { results, cfg } = await scanMonth(mk);

  const over = results.filter(r => r.total > cfg.limit);
  const flagged = results.filter(r => r.findings.length);

  const head =
    (cfg.name
      ? '<div style="font-size:14px;color:#222;margin-bottom:12px">' +
        esc(cfg.name) + ' שלום,</div>'
      : '') +
    '<div style="font-size:13px;color:#444;line-height:1.9;margin-bottom:22px;' +
      'border:1px solid #dde3e8;border-radius:8px;padding:13px">' +
    'דוח נוכחות ' + esc(heMonth(mk)) + ' · ' + esc(STATION_NAME) + '<br>' +
    '<b>' + results.length + '</b> עובדים · ' +
    '<b>' + over.length + '</b> חריגות מעל ' + cfg.limit + ' שעות · ' +
    '<b>' + flagged.length + '</b> עובדים עם הערות' +
    '</div>';

  // ---------- חלוקה למיילים לפי גודל ----------
  //
  //  **הדוח הזה היה בדרך לשבור את עצמו, ובשקט.**
  //
  //  כל יום עבודה של כבאי הוא שורת טבלה של כ-714 בייטים
  //  (סגנונות מוטבעים בכל תא, כי לקוחות דואר לא מבטיחים
  //  תמיכה ב-CSS חיצוני). 25 ימים לאדם ≈ 18KB לאדם.
  //
  //  מסמך ב-Firestore מוגבל למגה. החשבון:
  //     44 אנשים  → 0.80MB   ← 80% מהמגבלה, היום
  //     55 אנשים  → מעל המגבלה
  //    100 אנשים  → 1.8MB, נדחה
  //
  //  וכשזה היה נדחה, sendMail בלעה את השגיאה ו-hr_reports
  //  כבר נכתב עם sent_to. כלומר ליסה לא הייתה מקבלת דוח,
  //  ורישום הביקורת היה טוען שהוא נשלח.
  //
  //  הפתרון אינו לקצץ את הדוח — כל שורה בו היא שעות של אדם.
  //  הוא נחתך לכמה מיילים לפי גודל אמיתי בבייטים, וכל אחד
  //  מסומן "חלק N מתוך M" כדי שיהיה ברור שאין חסר.

  const PART_MAX = 700000;          // מתחת ל-900KB של sendMail, עם מרווח
  const tables = results.map(r => ({ r: r, html: personTable(r, cfg) }));

  const parts = [];
  let cur = [], curBytes = htmlBytes(head);
  tables.forEach(function (t) {
    const b = htmlBytes(t.html);
    // אדם בודד שגדול מהמכסה יקבל מייל משלו. עדיף מייל אחד
    // חריג מאשר להשמיט אותו.
    if (cur.length && curBytes + b > PART_MAX) {
      parts.push(cur); cur = []; curBytes = htmlBytes(head);
    }
    cur.push(t); curBytes += b;
  });
  if (cur.length) parts.push(cur);

  await db.doc('stations/' + STATION_ID + '/hr_reports/' + mk).set({
    month: mk,
    built_at: FV.serverTimestamp(),
    people: results.length,
    over_limit: over.length,
    flagged: flagged.length,
    hour_limit: cfg.limit,
    parts: parts.length
  }, { merge: true });

  let sentAll = true;
  if (cfg.email) {
    for (let i = 0; i < parts.length; i++) {
      const label = parts.length > 1
        ? ' · חלק ' + (i + 1) + ' מתוך ' + parts.length : '';
      const body = (i === 0 ? head : '') +
        parts[i].map(t => t.html).join('');
      const ok = await sendMail(cfg.email,
        'ResQ — דוח נוכחות ' + heMonth(mk) + ' · ' + STATION_NAME + label,
        mailShell('דוח נוכחות · ' + heMonth(mk) + label, body));
      if (!ok) sentAll = false;
    }

    // **רישום הביקורת אומר את האמת.** sent_to נכתב רק אם
    // המייל באמת נכנס לתור; אחרת נשמרת הסיבה, ומנהל-העל
    // מקבל התראה — כי דוח שכר שלא יצא הוא לא משהו שמגלים
    // חודש אחרי.
    await db.doc('stations/' + STATION_ID + '/hr_reports/' + mk).set({
      sent_to: sentAll ? cfg.email : null,
      send_failed: !sentAll
    }, { merge: true });

    if (!sentAll) {
      console.error('monthlyHrReport: לא כל החלקים נשלחו', mk);
      try {
        await sendMail(SUPER_ADMIN_EMAIL,
          '⚠️ דוח הנוכחות ' + heMonth(mk) + ' לא נשלח במלואו',
          mailShell('הדוח החודשי נכשל',
            '<p>הדוח לחודש ' + esc(heMonth(mk)) + ' נבנה מ-' +
            parts.length + ' חלקים, ולפחות אחד מהם לא נכנס לתור ' +
            'הדואר. ליסה <b>לא</b> קיבלה דוח מלא.</p>' +
            '<p>הרץ אותו ידנית ממסך הבדיקה.</p>'));
      } catch (e) {}
    }
  }

  console.log('monthlyHrReport', mk, 'people', results.length,
              'over', over.length, 'parts', parts.length,
              'to', cfg.email || '(none)', 'ok', sentAll);
  return { people: results.length, over: over.length,
           parts: parts.length, sent: !!cfg.email && sentAll };
}

exports.monthlyHrReport = onSchedule({
  timeoutSeconds: 540,
  memory: '1GiB',
  schedule: '0 6 1 * *',
  timeZone: 'Asia/Jerusalem',
  region: 'europe-west1'
}, async () => {
  await buildAndSendMonthly(prevMonthKey(new Date()));
});

// הרצה ידנית של אחת מהשתיים, למנהל-על. בלי זה אי אפשר לבדוק
// אותן בלי לחכות לחצות או לראשון בחודש.
exports.runReportNow = onCall(
  { timeoutSeconds: 540, memory: '1GiB' },
  async (req) => {
  const auth = req.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'צריך להיות מחובר.');
  const isSuper = auth.token.super === true ||
    String(auth.token.email || '').toLowerCase() === SUPER_ADMIN_EMAIL;
  if (!isSuper) throw new HttpsError('permission-denied', 'למנהל מערכת בלבד.');

  const mk = String((req.data || {}).month || '') ||
             prevMonthKey(new Date());
  const what = String((req.data || {}).what || 'report');

  if (what === 'scan') {
    const { results, cfg } = await scanMonth(mk);
    const flagged = results.filter(r => r.findings.length);
    await db.doc('stations/' + STATION_ID + '/scans/' + mk).set({
      month: mk, ran_at: FV.serverTimestamp(),
      people_checked: results.length, people_flagged: flagged.length,
      findings_total: flagged.reduce((s, r) => s + r.findings.length, 0),
      hour_limit: cfg.limit,
      people: flagged.map(r => ({
        emp: r.person.emp, full_name: r.person.full_name, crew: r.person.crew,
        total_hours: r.total, findings: r.findings
      }))
    }, { merge: true });
    return { ok: true, month: mk, checked: results.length,
             flagged: flagged.length };
  }

  const out = await buildAndSendMonthly(mk);
  return Object.assign({ ok: true, month: mk }, out);
});


// =====================================================================
//  התראות פוש
// =====================================================================
//
// שלוש דרכים שהתראה נולדת:
//
//   אוטומטית    שינוי מצב בהחלפה או בדוח חודשי מפעיל טריגר
//   מתוזמנת     תזכורת דיווח שעות, ארבעה ימים לפני סוף החודש
//   ידנית       מפקד או כבאי כותב הודעה ושולח
//
// התזכורת החודשית נלקחה מהמערכת שכבאי אילת משתמשים בה. שם היא
// מייל שנשלח ב-dailyReminderCheck_ כשנשארו בדיוק ארבעה ימים
// לסוף החודש. אותו יום, אותו נוסח, ערוץ אחר.

const { onDocumentWritten, onDocumentCreated } = require('firebase-functions/v2/firestore');

const PUSH_STATION = 'eilat_102';

// שולח לרשימת uid. מסנן לפי העדפות, מנקה מזהי מכשיר מתים,
// ולעולם לא מפיל את הפעולה שקראה לו: התראה שלא יצאה היא
// מטרד, אבל החלפה שלא אושרה בגללה היא תקלה.
// ---------------------------------------------------------------------
//  שליחת התראות
// ---------------------------------------------------------------------
//
//  **למה זה רץ במקביל ולא בטור.**
//
//  הגרסה הקודמת טיפלה בנמען אחד בכל פעם: קריאה לבדיקת השתקה,
//  קריאה למזהי המכשיר, שליחה ל-FCM, ולפעמים כתיבה — הכל
//  ברצף, לכל אדם בנפרד. כ-175 אלפיות שנייה לאדם.
//
//  ב-44 אנשים זה כשמונה שניות. **בקריאת פתע.** שמונה שניות
//  שבהן חלק מהמשמרת כבר קיבלה הזעקה וחלק עוד לא, והמפקד
//  מסתכל על מסך שלא סיים.
//
//  ובקנה מידה גדול זה נשבר לגמרי: ב-1000 איש זה כ-175 שניות,
//  מעל תקרת הזמן של הפונקציה — כלומר השליחה נקטעת באמצע,
//  חלק מהאנשים לא מוזעקים, ואין שום דרך לדעת מי.
//
//  עכשיו: 25 במקביל. אותה לוגיקה בדיוק לכל אדם, רק לא בתור.
//  25 ולא הכל-בבת-אחת, כדי לא להציף את FCM ולא לנפח זיכרון.

const PUSH_CONCURRENCY = 25;

async function pushToUsers(sid, uids, type, title, body, url, important) {
  const unique = Array.from(new Set((uids || []).filter(Boolean)));
  if (!unique.length) return { people: 0, devices: 0 };

  let people = 0, devices = 0;

  for (let i = 0; i < unique.length; i += PUSH_CONCURRENCY) {
    const group = unique.slice(i, i + PUSH_CONCURRENCY);
    const res = await Promise.all(group.map(function (uid) {
      return pushToOne(sid, uid, type, title, body, url, important)
        .catch(function (e) {
          // נמען אחד שנכשל לא מפיל את השאר. זו הזעקה.
          console.error('push failed for ' + uid + ': ' + (e && e.message));
          return { sent: 0 };
        });
    }));
    res.forEach(function (r) {
      if (r && r.sent) { people++; devices += r.sent; }
    });
  }

  return { people, devices };
}

async function pushToOne(sid, uid, type, title, body, url, important) {
  {
    // הבדיקה לכל נמען בנפרד, ולא פעם אחת לכל הקבוצה: קריאת פתע
    // לכל המשמרת צריכה להגיע לאלדד ולהיחסם לשאר, באותה שליחה.
    if (await silentFor(uid)) { await logSilenced('push', uid, title); return { sent: 0 }; }

    let snap;
    try {
      snap = await db.doc('stations/' + sid + '/push_tokens/' + uid).get();
    } catch (e) {
      return { sent: 0, failed: true, error_code: String((e && e.code) || 'TOKEN_READ_FAILED') };
    }
    if (!snap.exists) return { sent: 0 };

    const v = snap.data() || {};
    const prefs = v.prefs || {};

    // סוגים שנוגעים ישירות למשתמש נשלחים תמיד. השאר לפי בחירתו.
    // קריאת פתע נמצאת ברשימה הזו מסיבה אחרת: היא הזעקה, ומי
    // שכיבה התראות עדיין צריך להגיע לתחנה.
    const must = type === 'swap_mine' || type === 'report_mine' ||
                 type === 'callout'   || type === 'guard_mine' ||
                 type === 'schedule_mine';
    if (!must && prefs[type] === false) return { sent: 0 };

    const list = Array.isArray(v.tokens) ? v.tokens : [];
    if (!list.length) return { sent: 0 };

    const toks = list.map(t => t && t.token).filter(Boolean);
    if (!toks.length) return { sent: 0 };

    let res;
    try {
      res = await admin.messaging().sendEachForMulticast({
        tokens: toks,
        data: {
          title: String(title || 'ResQ'),
          body: String(body || ''),
          url: String(url || './login.html'),
          tag: String(type || 'resq'),
          important: important ? '1' : '0'
        },
        webpush: { headers: { Urgency: important ? 'high' : 'normal' } }
      });
    } catch (e) {
      console.error('push failed for ' + uid + ': ' + e.message);
      return { sent: 0, failed: true, error_code: String((e && e.code) || 'FCM_SEND_FAILED') };
    }

    let sent = 0;
    const dead = [];
    res.responses.forEach(function (r, i) {
      if (r.success) { sent++; return; }
      const code = (r.error && r.error.code) || '';
      // מזהה שנמחק או לא רשום — המכשיר כבר לא קיים. מנקים,
      // אחרת הרשימה מתמלאת במזהים מתים והשליחה מאטה בהדרגה.
      if (code.indexOf('registration-token-not-registered') !== -1 ||
          code.indexOf('invalid-argument') !== -1) {
        dead.push(toks[i]);
      }
    });

    if (dead.length) {
      const left = list.filter(t => dead.indexOf(t.token) === -1);
      await db.doc('stations/' + sid + '/push_tokens/' + uid)
        .set({ tokens: left, updated_at: FV.serverTimestamp() }, { merge: true })
        .catch(() => {});
    }

    return { sent: sent };
  }
}

async function uidsInCrew(sid, crew) {
  const out = [];
  try {
    const rs = await db.collection('stations/' + sid + '/roster').get();
    rs.forEach(function (d) {
      const v = d.data() || {};
      if (v.is_active === false) return;
      if (crew && v.crew !== crew) return;
      out.push(d.id);
    });
  } catch (e) {}
  return out;
}

async function commandersOf(sid, crew) {
  const out = [];
  try {
    const rs = await db.collection('stations/' + sid + '/users').get();
    rs.forEach(function (d) {
      const v = d.data() || {};
      if (v.is_active === false) return;
      if (v.role === 'hr_coordinator') { out.push(d.id); return; }
      // מפקד התחנה מקבל הכל, כמו רכז כוח אדם.
      if (v.role === 'station_commander') { out.push(d.id); return; }
      // סגן מפקד משמרת — אלדד: "תמיד התראה למפקד משמרת וסגנו".
      if ((v.role === 'commander' || v.role === 'deputy') &&
          (!crew || v.crew === crew)) out.push(d.id);
    });
  } catch (e) {}
  return out;
}

const CREW_HE_S = { A: "א'", B: "ב'", C: "ג'" };
function dmyS(k) {
  const p = String(k || '').split('-');
  return p.length === 3 ? Number(p[2]) + '.' + Number(p[1]) : String(k || '');
}

// ---------- החלפות ----------
//
// כל מעבר מצב מייצר התראה אחת, למי שהכדור עבר אליו.
// אין התראה על מצב שלא השתנה — עדכון של שדה צדדי לא אמור
// לצלצל בטלפון של אף אחד.

// ---------------------------------------------------------------------
//  חוק 48 השעות — אכיפה בשרת
// ---------------------------------------------------------------------
//
//  אלדד: "כבאי לא יכול לעבוד 48 שעות רצוף. אם משמרת א׳ עבדה
//  בראשון לחודש, כל מי שעבד לא יכול לעבוד בשני לחודש."
//
//  **הבדיקה קיימת במסך מאז שהוגדרה, ורק שם.** מסך אפשר לעקוף:
//  קריאה ישירה ל-Firestore, לשונית ישנה שנשארה פתוחה עם קוד
//  קודם, או פשוט באג. כלל אבטחה לא יכול לבדוק את זה — הוא
//  היה צריך לקרוא את הסבב, את החריגות ואת שאר ההחלפות, וכל
//  הקובץ בנוי על אפס קריאות get().
//
//  **לכן: הדק, ולא שער.** ההחלפה נכתבת, ומיד אחריה השרת בודק
//  ומחזיר אותה ל-rejected אם היא פוגעת במנוחה. זה לא מונע את
//  הכתיבה, אבל זה סמכותי — אי אפשר לעקוף טריגר — והתוצאה
//  הסופית זהה: החלפה לא חוקית אינה שורדת.
//
//  **ההשלכה שאינה מובנת מאליה**, ואלדד אישר אותה: בסבב אחד
//  לשלושה כל יום פנוי צמוד ליום עבודה. לכן החלפה חוקית חייבת
//  לוותר על המשמרת הצמודה — כלומר החלפה מזיזה משמרת ביום אחד.

function keyPlus(key, n) {
  const p = String(key).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// האם האדם עובד בתאריך, **אחרי** שההחלפה תיכנס לתוקף.
function worksAfterSwap(sched, approved, uid, crew, key, gainKey, loseKey) {
  if (!key) return false;
  if (loseKey && key === loseKey) return false;
  if (gainKey && key === gainKey) return true;

  // החלפות מאושרות אחרות שכבר הזיזו לו ימים.
  for (const sw of approved) {
    if (sw.from_uid === uid && sw.from_date === key) return false;
    if (sw.to_uid   === uid && sw.to_date   === key) return false;
    if (sw.from_uid === uid && sw.to_date   === key) return true;
    if (sw.to_uid   === uid && sw.from_date === key) return true;
  }
  if (!crew) return false;
  return isWorking(sched.rotations, sched.overrides, crew, key);
}

// הימים שנפגעים בשני הצדדים. ריק = ההחלפה חוקית.
function restBreaks(sched, approved, sw) {
  const out = [];
  const sides = [
    { uid: sw.from_uid, name: sw.from_name || 'המבקש',
      crew: sw.from_crew, gain: sw.to_date,   lose: sw.from_date },
    { uid: sw.to_uid,   name: sw.to_name   || 'המחליף',
      crew: sw.to_crew,   gain: sw.from_date, lose: sw.to_date }
  ];

  for (const p of sides) {
    if (!p.uid || !p.gain) continue;
    for (const n of [-1, 1]) {
      const k = keyPlus(p.gain, n);
      if (worksAfterSwap(sched, approved, p.uid, p.crew, k, p.gain, p.lose)) {
        out.push({ who: p.name, gain: p.gain, clash: k });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------
//  כתיבה ללוג המשמרת
// ---------------------------------------------------------------------
//
//  הטקסטים עצמם יושבים ב-shiftlog.js המשותף עם הדפדפן, כדי
//  שהם ייבדקו בלי להריץ פונקציות ענן. כאן רק הכתיבה.
//
//  הפונקציה אינה זורקת לעולם. לוג הוא רישום ולא תנאי —
//  כישלון בכתיבה שלו אסור שיבטל החלפה שאושרה או התראה
//  שצריכה לצאת.

async function writeShiftLog(sid, text, extra) {
  if (!sid || !text) return null;
  const rec = Object.assign({
    text: String(text).slice(0, 2000),
    kind: 'system',
    by_uid: '', by_name: 'המערכת', by_role: '', by_crew: '', by_vehicle: '',
    hidden: false,
    created_key: new Date().toISOString(),
    created_at: FV.serverTimestamp()
  }, extra || {});
  return db.collection('stations/' + sid + '/shift_log').add(rec);
}

// גרסת שרת של הטקסטים. זהה ל-swapSystemText ב-shiftlog.js,
// ו-tests/shiftlog.mjs משווה ביניהן ונופל אם הן יוצאות
// מסנכרון — בדיוק כמו רשימת התפקידים.
function swapSystemText(status, d) {
  const s = d || {};
  const from = s.from_name || 'כבאי';
  const to   = s.to_name   || 'כבאי';
  const dt = function (k) {
    const p = String(k || '').split('-');
    return p.length === 3 ? Number(p[2]) + '.' + Number(p[1]) : String(k || '');
  };
  switch (status) {
    case 'open':      return from + ' פרסם בקשת החלפה ל-' + dt(s.from_date) + '.';
    case 'peer':      return from + ' ביקש להחליף עם ' + to + ' · ' +
                             dt(s.from_date) + ' מול ' + dt(s.to_date) + '.';
    case 'cmd_from':  return to + ' הסכים להחלפה עם ' + from + '. ממתין למפקדים.';
    case 'cmd_to':    return 'מפקד המשמרת של ' + from + ' אישר. ממתין למפקד של ' + to + '.';
    case 'approved':  return '✅ ההחלפה אושרה: ' + from + ' ↔ ' + to + ' · ' +
                             dt(s.from_date) + ' מול ' + dt(s.to_date) + '.';
    case 'rejected':  return '❌ ההחלפה בין ' + from + ' ל-' + to + ' נדחתה.';
    case 'cancelled': return 'הבקשה של ' + from + ' בוטלה.';
    default:          return '';
  }
}

exports.onSwapChange = onDocumentWritten(
  'stations/{sid}/swaps/{swapId}',
  async (event) => {
    const before = event.data && event.data.before && event.data.before.exists
      ? event.data.before.data() : null;
    const after = event.data && event.data.after && event.data.after.exists
      ? event.data.after.data() : null;
    if (!after) return;

    const sid = event.params.sid;
    const was = before ? before.status : '';
    const now = after.status;
    if (was === now) return;

    const url = './swaps.html';
    const both = [after.from_uid, after.to_uid];

    // ---------- הודעה בלוג המשמרת ----------
    //
    // אותו פיד שבו הפיקוד מתכתב מקבל גם את ההיסטוריה
    // האוטומטית. בלי זה, הלוג הוא שיחה — ועם זה הוא רישום
    // מלא של מה שקרה למשמרת, ואפשר לגלול אחורה ולראות מי
    // אישר מה ומתי בלי לחפש בשלושה מסכים.
    //
    // נכתב **רק בשרת**. הכלל ב-firestore.rules חוסם לקוח
    // שמנסה לכתוב kind:'system' — הודעה שנראית כאילו המערכת
    // אמרה אותה היא ההודעה שאיש לא מפקפק בה.
    try {
      const line = swapSystemText(now, after);
      if (line) await writeShiftLog(sid, line, { swap_id: event.params.swapId });
    } catch (e) {
      // לוג הוא רישום, לא תנאי. כישלון כאן לא מבטל התראה
      // ולא עוצר את ההחלפה.
      console.error('shift_log write failed', e);
    }

    // ---------- אכיפת המנוחה ----------
    //
    // רק ברגע האישור. בקשה פתוחה או ממתינה עדיין לא מזיזה
    // אף משמרת, ולחסום אותה מוקדם מדי היה מונע גם בקשות
    // שיהיו חוקיות אחרי שהצד השני יבחר תאריך אחר.
    if (now === 'approved' && was !== 'approved') {
      try {
        const sched = await loadSchedule(sid);
        const apSnap = await db.collection('stations/' + sid + '/swaps')
          .where('status', '==', 'approved').get();
        const approved = [];
        apSnap.forEach(function (d) {
          if (d.id === event.params.swapId) return;   // לא סופרים את עצמנו
          approved.push(d.data() || {});
        });

        const breaks = restBreaks(sched, approved, after);
        if (breaks.length) {
          const why = breaks.map(function (b) {
            return b.who + ' יעבוד ב-' + dmyS(b.gain) +
                   ' וגם ב-' + dmyS(b.clash);
          }).join('; ');

          await db.doc('stations/' + sid + '/swaps/' + event.params.swapId).set({
            status: 'rejected',
            rejected_by_system: true,
            reject_why: 'חוק 48 השעות: ' + why + '. בין שתי משמרות ' +
                        'חייב להיות יום מנוחה.',
            rejected_key: new Date().toISOString()
          }, { merge: true });

          await pushToUsers(sid, both, 'swap_mine',
            'ההחלפה בוטלה',
            'חוק 48 השעות: ' + why + '.', url, true);

          console.warn('swap ' + event.params.swapId + ' reverted — rest rule', why);
          return;
        }
      } catch (e) {
        // כשל זמני בקריאה אינו יכול להפוך לאישור שקט. מחזירים את
        // ההחלפה לשלב האישור האחרון, כך שאפשר לנסות שוב אחרי שהמסד
        // חזר, בלי להמציא תוצאת מנוחה ובלי למחוק את הבקשה.
        await db.doc('stations/' + sid + '/swaps/' + event.params.swapId).set({
          status: 'cmd_to',
          rest_check_pending: true,
          rest_check_failed_at: new Date().toISOString()
        }, { merge: true });

        await pushToUsers(sid, both, 'swap_mine',
          'ההחלפה ממתינה לבדיקת מנוחה',
          'לא ניתן היה להשלים את בדיקת המנוחה. האישור לא נכנס לתוקף.',
          url, true);

        console.error('rest check failed; swap returned to cmd_to');
        return;
      }
    }

    if (now === 'peer') {
      await pushToUsers(sid, [after.to_uid], 'swap_mine',
        'בקשת החלפה',
        after.from_name + ' מבקש להחליף איתך — ' + dmyS(after.from_date) +
        ' מול ' + dmyS(after.to_date),
        url, true);
      return;
    }

    if (now === 'cmd_from') {
      await pushToUsers(sid, [after.from_uid], 'swap_mine',
        'ההחלפה התקדמה',
        after.to_name + ' הסכים. הבקשה עברה למפקד המשמרת.', url);
      await pushToUsers(sid, await commandersOf(sid, after.from_crew),
        'swap_approve', 'החלפה ממתינה לאישורך',
        after.from_name + ' ⇄ ' + after.to_name + ' · ' + dmyS(after.from_date),
        url);
      return;
    }

    if (now === 'cmd_to') {
      await pushToUsers(sid, both, 'swap_mine',
        'ההחלפה אושרה בשלב הראשון',
        'אושר ע״י ' + (after.from_appr_name || 'מפקד המשמרת') +
        '. ממתין למפקד משמרת ' + (CREW_HE_S[after.to_crew] || after.to_crew) + '.',
        url);
      await pushToUsers(sid, await commandersOf(sid, after.to_crew),
        'swap_approve', 'החלפה ממתינה לאישורך',
        after.from_name + ' ⇄ ' + after.to_name + ' · ' + dmyS(after.to_date),
        url);
      return;
    }

    if (now === 'approved') {
      await pushToUsers(sid, both, 'swap_mine',
        'ההחלפה אושרה',
        'אושר ע״י ' + (after.from_appr_name || '—') + ' ו' +
        (after.to_appr_name || '—') + '. הסידור עודכן.',
        url, true);
      return;
    }

    if (now === 'rejected') {
      await pushToUsers(sid, both, 'swap_mine',
        'ההחלפה נדחתה',
        'נדחה ע״י ' + (after.reject_name || '—') +
        (after.reject_reason ? ' — ' + after.reject_reason : ''),
        url, true);
      return;
    }
  });

// ---------- דוח חודשי ----------

exports.onReportChange = onDocumentWritten(
  'stations/{sid}/monthly_reports/{docId}',
  async (event) => {
    const before = event.data && event.data.before && event.data.before.exists
      ? event.data.before.data() : null;
    const after = event.data && event.data.after && event.data.after.exists
      ? event.data.after.data() : null;
    if (!after) return;

    const sid = event.params.sid;
    const was = before ? before.status : '';
    const now = after.status;
    if (was === now) return;

    const url = './attendance.html';
    const mk = after.month || '';

    if (now === 'submitted') {
      await pushToUsers(sid, await commandersOf(sid, after.crew),
        'report_submit', 'דוח נוכחות הוגש',
        (after.full_name || '') + ' · ' + mk + ' · ' +
        (after.total_hours != null ? after.total_hours + ' שעות' : ''),
        url);
      return;
    }

    if (now === 'approved') {
      await pushToUsers(sid, [after.uid], 'report_mine',
        'הדוח שלך אושר',
        mk + ' אושר ע״י ' + (after.approved_by_name || 'המפקד') + '.', url, true);
      return;
    }

    if (now === 'draft' && was === 'approved') {
      await pushToUsers(sid, [after.uid], 'report_mine',
        'הדוח שלך נפתח מחדש',
        mk + ' נפתח ע״י ' + (after.reopened_by_name || 'המפקד') +
        '. אפשר לתקן ולשלוח שוב.', url, true);
      return;
    }
  });

// ---------- תזכורת דיווח שעות ----------
//
// ארבעה ימים לפני סוף החודש, כמו במערכת הקיימת. הפונקציה רצה
// כל יום ובודקת בעצמה — כמו dailyReminderCheck_ שם — כי אין
// ביטוי cron ל"ארבעה ימים לפני הסוף" בחודש באורך משתנה.

exports.hoursReminder = onSchedule({
  timeoutSeconds: 540,
  memory: '512MiB',
  schedule: '0 17 * * *',
  timeZone: 'Asia/Jerusalem',
  region: 'europe-west1'
}, async () => {
  // שלושה ימים לפני סוף החודש. היה ארבעה, ואלדד ביקש שלושה:
  // מוקדם מדי והתזכורת מגיעה לפני שהמשמרות האחרונות נסגרו,
  // ואז היא סתם רעש. שלושה ימים משאירים זמן לתקן ועדיין
  // מגיעים אחרי שרוב החודש כבר מדווח.
  //
  // הריצה יומית ויוצאת רק ביום הנכון, כי אורך החודש משתנה —
  // ה-28 בפברואר וה-28 באוגוסט אינם אותו מרחק מהסוף.
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  if (last - now.getDate() !== 3) return;

  const sid = PUSH_STATION;
  const uids = await uidsInCrew(sid, '');
  // שתי פעולות ולא אחת: לדווח את מה שחסר, **ולאשר** את הדוח.
  // דוח שלא אושר אינו מגיע לרכז כוח אדם, וכבאי שדיווח הכל
  // ושכח לאשר בטוח שסיים.
  const res = await pushToUsers(sid, uids, 'reminder',
    'תזכורת דוח שעות',
    'נשארו שלושה ימים לסוף החודש. בדוק שכל המשמרות מדווחות, ' +
    'ואשר את הדוח — בלי אישור הוא לא נשלח.',
    './attendance.html');
  console.log('hoursReminder: ' + res.people + ' people, ' +
              res.devices + ' devices');
});

// ---------- שליחה ידנית ----------
//
// ההרשאה נאכפת כאן ולא במסך:
//   מנהל-על ורכז כוח אדם  כל התחנה או משמרת נבחרת
//   מפקד משמרת            המשמרת שלו בלבד
//   כבאי                  המשמרת שלו בלבד
//
// כבאי יכול לשלוח למשמרת שלו במכוון — כך אלדד הגדיר. זה לא
// צ׳אט: כל הודעה נשמרת עם שם השולח ועם היעד, וכל אחד בתחנה
// רואה את ההיסטוריה.

exports.sendBroadcast = onCall(
  { timeoutSeconds: 300 },
  async (req) => {
  const auth = req.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'צריך להיות מחובר.');

  const t = auth.token || {};
  const sid = callerStation(req, auth);
  const isSuper = t.super === true ||
                  String(t.email || '').toLowerCase() === SUPER_ADMIN_EMAIL;
  const role = t.role || '';
  const myCrew = t.shift || '';

  const text = String((req.data || {}).text || '').trim();
  const target = String((req.data || {}).target || '').trim();
  if (!text) throw new HttpsError('invalid-argument', 'צריך לכתוב הודעה.');
  if (text.length > 400) throw new HttpsError('invalid-argument', 'ההודעה ארוכה מדי.');

  const wide = isSuper || role === 'hr_coordinator' ||
               role === 'station_commander';
  let crew = '', targetHe = '';

  if (target === 'station') {
    if (!wide) throw new HttpsError('permission-denied',
      'רק רכז כוח אדם ומנהל המערכת שולחים לכל התחנה.');
    targetHe = 'כל התחנה';
  } else if (target.indexOf('crew:') === 0) {
    crew = target.slice(5);
    if (['A', 'B', 'C'].indexOf(crew) === -1) {
      throw new HttpsError('invalid-argument', 'משמרת לא מוכרת.');
    }
    if (!wide && crew !== myCrew) {
      throw new HttpsError('permission-denied',
        'אפשר לשלוח רק למשמרת שלך.');
    }
    targetHe = 'משמרת ' + (CREW_HE_S[crew] || crew);
  } else {
    throw new HttpsError('invalid-argument', 'יעד לא מוכר.');
  }

  // ⚠️ מפקד צוות וסגנו נוספו כאן ב-25.8.2026.
  //
  // בלעדיהם נוצר מצב הפוך מהכוונה: **לוחם אש יכול היה לשדר
  // הודעה, ומפקד צוות לא.** התפקידים האלה אמורים להיות לוחם
  // אש לכל דבר ועוד כתיבה בלוג — לא פחות ממנו.
  if (!wide && ['commander','deputy','firefighter',
                'team_leader','deputy_team_leader'].indexOf(role) === -1) {
    throw new HttpsError('permission-denied', 'אין לך הרשאה לשלוח הודעות.');
  }

  let name = '';
  try {
    const u = await db.doc('stations/' + sid + '/users/' + auth.uid).get();
    if (u.exists) name = (u.data() || {}).full_name || '';
  } catch (e) {}

  const uids = (await uidsInCrew(sid, crew)).filter(u => u !== auth.uid);
  const res = await pushToUsers(sid, uids, 'broadcast',
    name || 'הודעה מהתחנה', text, './alerts.html');

  await db.collection('stations/' + sid + '/broadcasts').add({
    by_uid: auth.uid, by_name: name, by_role: role,
    target: target, target_he: targetHe,
    text: text, people: res.people, devices: res.devices,
    created_key: new Date().toISOString(),
    created_at: FV.serverTimestamp()
  }).catch(() => {});

  return { ok: true, people: res.people, devices: res.devices };
});


// ---------- קריאת פתע ----------
//
// הודעה רגילה מגיעה למי שרוצה לקבל אותה. קריאת פתע מגיעה לכולם
// ברשימה, גם למי שכיבה התראות, וקופצת על המסך במקום להמתין
// בשורת ההתראות. זה כלי הזעקה, לא כלי הודעות — ולכן:
//
//   * מי ששולח            מפקד משמרת, רכז כוח אדם, מנהל מערכת
//   * מי שמקבל            משמרת שלמה, או רשימת אנשים נבחרת
//   * אי אפשר לכבות       הסוג 'callout' עוקף את ההעדפות
//   * חייב תשובה          מגיע או לא זמין, נשמר על המסמך
//
// מפקד משמרת מזעיק את המשמרת שלו, ובבחירה ידנית — כל אדם
// בתחנה. הבחירה הידנית פתוחה לכל התחנה במכוון: אירוע שמצריך
// הזעקה לא עוצר בגבול המשמרת. השם של מי שהזעיק נשמר על כל
// קריאה, וזו הבקרה — לא הצרה של הרשימה.

// שמות סוגי התקלה בעברית. משוכפל מ-faults.js כי השרת אינו
// מייבא מודולים של הדפדפן — שינוי בשם צריך להיעשות בשניהם.
const FAULT_KIND_HE = {
  vehicle: 'תקלת רכב', damage: 'פגיעה ברכב', gear: 'תקלת ציוד',
  building: 'תקלת מבנה', task_st: 'משימת תחזוקת תחנה',
  task_eq: 'משימת תחזוקת ציוד', note: 'מסר'
};
function kindHeS(k) { return FAULT_KIND_HE[k] || 'תקלה'; }

const CALLOUT_ROLE_HE = {
  commander: 'מפקד משמרת',
  hr_coordinator: 'רכז כוח אדם',
  super_admin: 'מנהל מערכת',
  firefighter: 'כבאי'
};

function hhmmIL(d) {
  try {
    return new Intl.DateTimeFormat('he-IL', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem'
    }).format(d);
  } catch (e) { return ''; }
}

exports.sendCallout = onCall(
  { timeoutSeconds: 300 },
  async (req) => {
  const auth = req.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'צריך להיות מחובר.');

  const t = auth.token || {};
  const sid = callerStation(req, auth);
  const isSuper = t.super === true ||
                  String(t.email || '').toLowerCase() === SUPER_ADMIN_EMAIL;
  const role = t.role || '';
  const myCrew = t.shift || '';

  if (!isSuper && ['commander','deputy','station_commander',
                   'hr_coordinator'].indexOf(role) === -1) {
    throw new HttpsError('permission-denied',
      'קריאת פתע שמורה למפקד משמרת ולרכז כוח אדם.');
  }

  const d = req.data || {};
  const text = String(d.text || '').trim();
  if (!text) throw new HttpsError('invalid-argument', 'צריך לכתוב מה הקריאה.');
  if (text.length > 300) {
    throw new HttpsError('invalid-argument',
      'קריאת פתע קצרה מ-300 תווים. מה שארוך מזה לא נקרא בריצה.');
  }

  const wide = isSuper || role === 'hr_coordinator' ||
               role === 'station_commander';
  const target = String(d.target || '').trim();
  let uids = [], targetHe = '', crew = '';

  if (target.indexOf('crew:') === 0) {
    crew = target.slice(5);
    if (['A', 'B', 'C'].indexOf(crew) === -1) {
      throw new HttpsError('invalid-argument', 'משמרת לא מוכרת.');
    }
    // הזעקת משמרת שלמה שאינה שלך היא החלטה של רכז כוח אדם או
    // של מנהל המערכת. מפקד שצריך אנשים ממשמרת אחרת בוחר אותם
    // בשמם — כך יש לו כוונה, ולא לחיצה אחת שמעירה תשעים איש.
    if (!wide && crew !== myCrew) {
      throw new HttpsError('permission-denied',
        'אפשר להזעיק את המשמרת שלך. לאנשים ממשמרת אחרת — בחר אותם בשמם.');
    }
    uids = await uidsInCrew(sid, crew);
    targetHe = 'משמרת ' + (CREW_HE_S[crew] || crew);

  } else if (target === 'people') {
    const raw = Array.isArray(d.uids) ? d.uids : [];
    const want = Array.from(new Set(raw.map(String).filter(Boolean)));
    if (!want.length) throw new HttpsError('invalid-argument', 'לא נבחרו אנשים.');
    if (want.length > 120) {
      throw new HttpsError('invalid-argument', 'יותר מדי אנשים בבחירה אחת.');
    }
    // מסננים מול הסגל בפועל: uid שאינו בתחנה או שאינו פעיל
    // לא נכנס לרשימה, גם אם נשלח מהדפדפן.
    const live = await uidsInCrew(sid, '');
    uids = want.filter(u => live.indexOf(u) !== -1);
    if (!uids.length) {
      throw new HttpsError('invalid-argument',
        'אף אחד מהנבחרים אינו סגל פעיל בתחנה.');
    }
    targetHe = uids.length + ' אנשים בבחירה ידנית';

  } else if (target === 'station') {
    if (!wide) throw new HttpsError('permission-denied',
      'הזעקת כל התחנה שמורה לרכז כוח אדם ולמנהל המערכת.');
    uids = await uidsInCrew(sid, '');
    targetHe = 'כל התחנה';

  } else {
    throw new HttpsError('invalid-argument', 'יעד לא מוכר.');
  }

  // המזעיק לא מזעיק את עצמו.
  uids = uids.filter(u => u !== auth.uid);

  // מי שבחופשה מאושרת מחוץ לאילת אינו ניתן להזעקה. זו כל
  // הסיבה שטופס החופשה שואל איפה הכבאי נמצא — בלי השימוש
  // הזה השדה היה נתון שאיש לא קורא.
  //
  // הזעקה לאדם שנמצא ביוון אינה רק חסרת תועלת: היא מלמדת
  // את כולם שקריאת פתע לא תמיד רלוונטית, וזה בדיוק מה
  // שהורג כלי הזעקה.
  const awayNames = [];
  try {
    const today = new Date().toISOString().slice(0, 10);
    const ls = await db.collection('stations/' + sid + '/submissions')
      .where('form_id', '==', 'leave')
      .where('status', '==', 'approved').get();
    const blocked = {};
    ls.forEach(function (d) {
      const v = d.data() || {};
      const val = v.values || {};
      if (!val.from || !val.to) return;
      if (String(today) < String(val.from) || String(today) > String(val.to)) return;
      if (String(val.where || '') === 'באילת') return;   // עדיין ניתן להזעקה
      blocked[v.by_uid] = v.by_name || '';
    });
    uids = uids.filter(function (u) {
      if (blocked[u] == null) return true;
      awayNames.push(blocked[u] || u);
      return false;
    });
  } catch (e) {
    // כישלון כאן לא עוצר הזעקה. עדיף להזעיק אדם שבחופשה
    // מאשר לא להזעיק אף אחד.
    console.warn('leave filter: ' + e.message);
  }

  if (!uids.length && awayNames.length) {
    throw new HttpsError('failed-precondition',
      'כל מי שברשימה בחופשה מחוץ לאילת: ' + awayNames.join(', '));
  }
  if (!uids.length) {
    throw new HttpsError('invalid-argument', 'אין למי לשלוח.');
  }

  let name = '';
  try {
    const u = await db.doc('stations/' + sid + '/users/' + auth.uid).get();
    if (u.exists) name = (u.data() || {}).full_name || '';
  } catch (e) {}

  const now = new Date();
  const roleHe = isSuper ? CALLOUT_ROLE_HE.super_admin
                         : (CALLOUT_ROLE_HE[role] || '');
  const whenHe = hhmmIL(now);

  // כותבים קודם, שולחים אחר כך. אם השליחה תיפול, הקריאה עדיין
  // תקפוץ למי שהאפליקציה פתוחה אצלו — וזה עדיף על כלום.
  const ref = db.collection('stations/' + sid + '/callouts').doc();
  await ref.set({
    by_uid: auth.uid, by_name: name, by_role: role,
    by_role_he: roleHe, by_crew: myCrew,
    target: target, target_he: targetHe, crew: crew,
    text: text, uids: uids, acks: {}, active: true,
    when_he: whenHe,
    created_key: now.toISOString(),
    created_at: FV.serverTimestamp()
  });

  const res = await pushToUsers(sid, uids, 'callout',
    'קריאת פתע · ' + (name || 'מפקד'),
    text, './login.html', true);

  await ref.set({ people: res.people, devices: res.devices },
                { merge: true }).catch(() => {});

  return { ok: true, id: ref.id, sent: uids.length,
           people: res.people, devices: res.devices,
           skipped_away: awayNames };
});


// סוגר קריאה. הקריאה מפסיקה לקפוץ למי שעוד לא ענה, וההיסטוריה
// נשארת עם התשובות שכן התקבלו.
exports.closeCallout = onCall(async (req) => {
  const auth = req.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'צריך להיות מחובר.');

  const t = auth.token || {};
  const sid = callerStation(req, auth);
  const isSuper = t.super === true ||
                  String(t.email || '').toLowerCase() === SUPER_ADMIN_EMAIL;
  const role = t.role || '';

  const id = String((req.data || {}).id || '').trim();
  if (!id) throw new HttpsError('invalid-argument', 'חסר מזהה קריאה.');

  const ref = db.doc('stations/' + sid + '/callouts/' + id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'הקריאה לא נמצאה.');

  const v = snap.data() || {};
  const mine = v.by_uid === auth.uid;
  if (!mine && !isSuper && role !== 'hr_coordinator') {
    throw new HttpsError('permission-denied',
      'רק מי שפתח את הקריאה יכול לסגור אותה.');
  }

  await ref.set({ active: false, closed_at: FV.serverTimestamp(),
                  closed_by: auth.uid }, { merge: true });
  return { ok: true };
});


// =====================================================================
//  אבטחות
// =====================================================================
//
// אבטחה היא הצבת כוח באירוע — משחק, הופעה, עבודות חמות.
//
// שתי פעולות עוברות דרך השרת ולא דרך הדפדפן, ולכל אחת סיבה:
//
//   guardSignup   הרשמה משנה מסמך משותף. משתמש שיכול לכתוב
//                 לתוכו ישירות יכול גם למחוק את ההרשמות של
//                 האחרים — בטעות או לא
//   assignGuard   השיבוץ הוא ההחלטה. הוא מפעיל התראות, והוא
//                 מה שקובע למי נספרת האבטחה בחלוקת העומס
//
// ההבחנה שקובעת הכל: אבטחה שנופלת ביום שהכבאי ממילא במשמרת
// נבלעת ב-24 השעות שלו — אין שעות נוספות ואין שכר נוסף.
// אבטחה ביום החופש שלו היא יציאה מהבית. הצד הזה של השרת לא
// מחשב את ההבחנה (היא נגזרת מהסבב בצד הלקוח), אבל הנוסח של
// ההתראה כן מזכיר את התאריך, כדי שהכבאי יידע מיד במה מדובר.

function guardWhen(v) {
  const d = dmyS(v.date);
  const t = (v.start || '') + '–' + (v.end || '');
  return d + ' ' + t;
}

// Interest in an open guard is a server transaction.  This prevents a late
// browser request from recreating a signup after the manager cancelled or
// completed the guard, and applies the same live station check as the rest of
// the schedule surface.
exports.guardSignup = onCall({ enforceAppCheck: true }, async (req) =>
  invokeSchedule('signupGuard', req));


// Compatibility name for a browser cached before the new controls arrived.
// It deliberately delegates to the live schedule-manager gateway; legacy
// callers that lack an idempotency token or a revision fail closed instead of
// retaining the old commander/HR bypass.
exports.assignGuard = onCall({ enforceAppCheck: true }, async (req) => {
  const d = req && req.data ? req.data : {};
  return invokeSchedule('manageGuard', Object.assign({}, req, {
    data: {
      action: 'set_assignees',
      request_id: d.request_id,
      guard_id: d.id,
      expected_revision: d.expected_revision,
      uids: d.uids
    }
  }));
});


// אבטחה חדשה נפתחה — מתעדים התראה גנרית למי שיכול להירשם.
//
// לכל התחנה ולא רק למשמרת: אבטחה ביום חופש היא בהגדרה יום
// שהמשמרת שלך לא עובדת בו, ולכן צמצום לפי משמרת היה מסתיר
// אותה בדיוק ממי שהיא רלוונטית לו.  הטריגר אינו שולח Push בעצמו:
// הוא יוצר משימות דטרמיניסטיות בתור השרת, עם ניסיון חוזר ודילוג אם
// האבטחה אוישה, נדחתה, בוטלה או נסגרה לפני הפאנאאוט.
exports.onGuardOpen = onDocumentCreated({
  document: 'stations/{sid}/guards/{gId}',
  retry: true,
  region: 'europe-west1',
  timeoutSeconds: 120
},
  async (event) => {
    const sid = event.params.sid;
    const after = event.data && event.data.data();
    if (!after) return;
    await scheduleRuntime.enqueueGuardOpenNotifications({
      sid: sid,
      guard_id: event.params.gId,
      revision: after.revision
    });
  });


// תזכורת ערב לפני, 19:00. מי ששובץ למחר מקבל תזכורת אחת.
exports.guardReminder = onSchedule(
  {
  timeoutSeconds: 300, schedule: '0 19 * * *', timeZone: 'Asia/Jerusalem',
    region: 'europe-west1' },
  async () => {
    const sid = PUSH_STATION;
    const t = new Date(Date.now() + 24 * 3600 * 1000);
    const key = t.toISOString().slice(0, 10);

    let snap;
    try {
      snap = await db.collection('stations/' + sid + '/guards')
        .where('date', '==', key).get();
    } catch (e) { console.error('guardReminder: ' + e.message); return; }

    for (const d of snap.docs) {
      const v = d.data() || {};
      if (v.status === 'cancelled') continue;
      const uids = Array.isArray(v.assigned) ? v.assigned : [];
      if (!uids.length) continue;
      await pushToUsers(sid, uids, 'guard_mine',
        'מחר: ' + (v.title || 'אבטחה'),
        (v.start || '') + '–' + (v.end || '') +
          (v.place ? ' · ' + v.place : ''),
        './guards.html', true);
    }
  });


// ---------- תקלה משביתה ----------
//
// רכב שיוצא מכלל שימוש הוא לא עוד פריט ברשימה — הוא משנה את
// מה שהמשמרת יכולה לעשות. מפקד שיגלה את זה כשהוא כבר בדרך
// לאירוע גילה מאוחר מדי.
//
// נשלח רק על 'blocking', ורק בפתיחה או בהסלמה. תקלה קלה
// שנפתחת פעמיים ביום לא אמורה לצלצל אצל אף אחד.

exports.onFaultBlocking = onDocumentWritten(
  'stations/{sid}/faults/{faultId}',
  async (event) => {
    const sid = event.params.sid;
    const before = event.data && event.data.before && event.data.before.data();
    const after  = event.data && event.data.after  && event.data.after.data();
    if (!after) return;

    // תקלה חדשה על רכב או ציוד — התראה תמיד, גם קלה.
    //
    // אלדד: "תמיד התראה למפקד משמרת וסגנו על תקלות ברכבים
    // וציוד." למי בדיוק: מפקד וסגן של המשמרת **שדיווחה** —
    // מי שנמצא בתחנה עכשיו ויכול לגשת לרכב. מפקד התחנה מקבל
    // הכל ממילא דרך commandersOf.
    //
    // מי שנכנס מחר לא מקבל התראה, וזה בכוונה: הוא יראה את זה
    // בדף החפיפה, שנבנה בדיוק בשביל זה. התראה בשלוש לפנות
    // בוקר על פנס שרוף אצל מי שישן בבית היא הדרך המהירה
    // ביותר לגרום לו לכבות התראות.
    const HW = ['vehicle', 'damage', 'gear', 'building'];
    if (!before && HW.indexOf(after.kind) !== -1) {
      const crew = after.crew || '';
      const who = (await commandersOf(sid, crew))
        .filter(u => u !== after.by_uid);
      if (who.length) {
        const what = after.kind === 'damage' ? 'פגיעה' : 'תקלה';
        await pushToUsers(sid, who, 'fault_new',
          what + ' חדשה — ' + (after.vehicle_name || kindHeS(after.kind)),
          (after.title || '') + ' · דווח ע״י ' + (after.by_name || '') +
            (after.severity === 'unset' && after.kind !== 'damage'
              ? ' · ממתינה לקביעת חומרה' : ''),
          './faults.html');
      }
    }

    const wasBlocking = !!(before && before.severity === 'blocking' &&
                           before.status !== 'fixed');
    const isBlocking  = after.severity === 'blocking' && after.status !== 'fixed';

    // נסגרה תקלה משביתה — גם זה שווה הודעה. מפקד שממתין
    // לרכב צריך לדעת שהוא חזר.
    if (wasBlocking && !isBlocking && after.status === 'fixed') {
      await pushToUsers(sid, await commandersOf(sid, ''), 'fault_blocking',
        'רכב חזר לכשירות',
        (after.vehicle_name || after.title || '') + ' — התקלה נסגרה' +
          (after.fixed_by_name ? ' ע״י ' + after.fixed_by_name : '') + '.',
        './faults.html');
      return;
    }

    if (!isBlocking || wasBlocking) return;   // רק מעבר למשבית

    await pushToUsers(sid, await commandersOf(sid, ''), 'fault_blocking',
      'תקלה משביתה — ' + (after.vehicle_name || 'ציוד'),
      (after.title || '') + ' · דווח ע״י ' + (after.by_name || '') + '.',
      './faults.html', true);
  });

// ---------------------------------------------------------------------
//  תפיסת מזהה מכשיר — מכשיר אחד, משתמש אחד
//
//  מזהה הפוש שייך ל**דפדפן**, לא לאדם. במחשב התחנה נכנסים
//  בזה אחר זה כמה כבאים, וכל אחד שמפעיל התראות רושם את אותו
//  מזהה בדיוק — תחת שם המשתמש שלו.
//
//  התוצאה: התראה שנשלחת לאדם אחד מגיעה למכשיר שיושב מולו
//  מישהו אחר. בקשת החלפה, דוח שעות, ובמקרה הגרוע קריאת פתע
//  ששולחת מישהו לשריפה — כולם מוצגים על מסך של מי שבמקרה
//  עומד שם.
//
//  מצאתי את זה בנתונים החיים של האפליקציה הקיימת: לשני
//  משתמשים רשום אותו מזהה בדיוק. ResQ נבנתה באותו מבנה,
//  ולכן ירשה את אותו הפגם.
//
//  הכלל כאן פשוט: מזהה מכשיר שייך למי שנכנס בו אחרון.
//  ההרשמה מפנה אותו מכל שאר המשתמשים.
//
//  סריקה ולא שאילתה: הרשומות מחזיקות מערך של אובייקטים,
//  ו-array-contains דורש התאמה מדויקת של האובייקט כולו —
//  כולל התווית והשעה, שנבדלות בין משתמשים. בתחנה יש כחמישים
//  רשומות, וזה רץ רק כשמפעילים התראות.
exports.claimPushToken = onCall(async (req) => {
  const auth = req.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'צריך להיות מחובר.');

  const sid = callerStation(req, auth);
  const me  = auth.uid;

  const token = String((req.data || {}).token || '').trim();
  if (!token || token.length < 20) {
    throw new HttpsError('invalid-argument', 'מזהה מכשיר לא תקין.');
  }

  const col  = db.collection('stations/' + sid + '/push_tokens');
  const snap = await col.get();

  let evicted = 0;
  for (const d of snap.docs) {
    if (d.id === me) continue;
    const list = Array.isArray((d.data() || {}).tokens) ? d.data().tokens : [];
    const kept = list.filter(x => String((x || {}).token || '') !== token);
    if (kept.length === list.length) continue;
    await d.ref.set({ tokens: kept, updated_at: FV.serverTimestamp() },
                    { merge: true });
    evicted++;
  }

  if (evicted) {
    console.log('claimPushToken: ' + me + ' claimed a device from ' +
                evicted + ' other user(s)');
  }
  return { evicted: evicted };
});


// =======================================================================
//  בדיקת מייל מקצה לקצה
// =======================================================================
//  כל הדואר במערכת נכתב לאוסף mail/ ונשלח בידי תוסף Trigger Email.
//  כל עוד התוסף לא מותקן, sendMail מצליחה — המסמך נכתב — ואף מייל
//  לא יוצא. זו תקלה שקטה: המערכת "חושבת" ששלחה.
//
//  sendTestMail כותבת מסמך אחד ומחזירה את המזהה שלו. מיד אחר כך
//  checkTestMail קוראת את אותו מסמך ומדווחת מה התוסף עשה איתו:
//  התוסף כותב שדה delivery עם state (PENDING / PROCESSING / SUCCESS /
//  ERROR). אם השדה לא קיים אחרי כמה שניות — התוסף לא מותקן, או
//  שהוא מאזין לאוסף אחר.

exports.sendTestMail = onCall(async (req) => {
  const auth = requireSuperAdmin(req);
  const to = String((req.data && req.data.to) || '').trim();
  if (!to || to.indexOf('@') === -1) {
    throw new HttpsError('invalid-argument', 'צריך כתובת מייל תקינה.');
  }

  const stamp = new Date().toISOString();
  const ref = await db.collection('mail').add({
    to: [to],
    message: {
      subject: 'ResQ — בדיקת מייל',
      html: mailShell('בדיקת מייל',
        '<p style="margin:0 0 10px;color:#444">אם הגעת לכאן, תוסף שליחת ' +
        'המייל מותקן ועובד. כל הדואר של המערכת — איפוס סיסמה, הודעת ' +
        'נעילה, הדוח החודשי — יוצא מאותו צינור.</p>' +
        '<p style="margin:0;color:#888;font-size:12px">נשלח ' + stamp + '</p>')
    },
    created_at: FV.serverTimestamp(),
    is_test: true
  });

  console.log('sendTestMail: נכתב מסמך ' + ref.id + ' עבור ' + to);
  return {
    id: ref.id,
    to: to,
    note: 'המסמך נכתב לאוסף mail. הרץ checkTestMail בעוד כ-15 שניות.'
  };
});

exports.checkTestMail = onCall(async (req) => {
  requireSuperAdmin(req);
  const id = String((req.data && req.data.id) || '').trim();
  if (!id) throw new HttpsError('invalid-argument', 'צריך מזהה מסמך.');

  const snap = await db.collection('mail').doc(id).get();
  if (!snap.exists) {
    return { state: 'MISSING', ok: false,
             message: 'המסמך לא נמצא. ייתכן שנמחק, או שהמזהה שגוי.' };
  }

  const d = snap.data() || {};
  const delivery = d.delivery || null;

  if (!delivery) {
    return {
      state: 'NO_DELIVERY', ok: false,
      message: 'המסמך נכתב, אבל התוסף לא נגע בו. ' +
               'או שהוא לא מותקן, או שהוא מאזין לאוסף אחר. ' +
               'ודא שפרמטר MAIL_COLLECTION מוגדר בדיוק "mail".'
    };
  }

  const state = String(delivery.state || '');
  const ok = (state === 'SUCCESS');
  const messages = {
    'SUCCESS': 'המייל נשלח. הצינור עובד מקצה לקצה.',
    'PENDING': 'התוסף קלט את המסמך וממתין. הרץ שוב בעוד כמה שניות.',
    'PROCESSING': 'התוסף שולח כרגע. הרץ שוב בעוד כמה שניות.',
    'RETRY': 'השליחה נכשלה והתוסף מנסה שוב.',
    'ERROR': 'השליחה נכשלה. ראה את השדה error.'
  };

  return {
    state: state, ok: ok,
    message: messages[state] || 'מצב לא מוכר: ' + state,
    error: delivery.error ? String(delivery.error).slice(0, 400) : '',
    attempts: delivery.attempts || 0,
    info: delivery.info || null
  };
});


// =======================================================================
//  שליחת הדואר בפועל
// =======================================================================
//  זו החלופה לתוסף Trigger Email של גוגל. התוסף ננעל להגדרות ב-31
//  במרץ 2027 — הוא ימשיך לרוץ, אבל אי אפשר יהיה לשנות לו את סיסמת
//  ה-SMTP או את כתובת השולח. סיסמת אפליקציה של Gmail נשללת מדי פעם
//  מעצמה, ובאותו יום צינור הדואר היה מת בלי דרך לתקן. לכן הוא נכתב
//  כאן, בקוד שאפשר לשנות בכל רגע.
//
//  החוזה זהה לזה של התוסף, בכוונה: מסמך נכנס ל-mail/, והשולח כותב
//  בחזרה שדה delivery עם state. כך sendTestMail ו-checkTestMail
//  עובדות בלי שינוי, וכך גם אפשר לחזור לתוסף בעתיד בלי לגעת בקוד.
//
//  ⚙️ שינוי כתובת השולח — כאן ורק כאן.
//  ⚙️ שינוי הסיסמה — לא בקוד. פקודה אחת:
//     firebase functions:secrets:set GMAIL_APP_PASSWORD

const MAIL_FROM_NAME = 'ResQ · תחנה 102';
const MAIL_FROM_ADDR = 'fire102.shits@gmail.com';
const MAIL_ATTEMPTS  = 3;

const { defineSecret } = require('firebase-functions/params');

const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD');

// מנוע השליחה נבנה פעם אחת לכל מופע ולא בכל מייל — פתיחת חיבור
// SMTP היא הפעולה היקרה כאן, והספרייה יודעת להחזיק אותו פתוח.
let mailer = null;
function getMailer(pass) {
  if (!mailer) {
    const nodemailer = require('nodemailer');
    mailer = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: MAIL_FROM_ADDR, pass: pass },
      pool: true,
      maxConnections: 3
    });
  }
  return mailer;
}

function asList(v) {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v])
    .map(x => String(x || '').trim())
    .filter(x => x.indexOf('@') !== -1);
}

exports.deliverMail = onDocumentCreated(
  { document: 'mail/{mailId}', secrets: [GMAIL_APP_PASSWORD] },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const ref = snap.ref;
    const d = snap.data() || {};

    // הגנת כפילות. onDocumentCreated יכול לירות פעמיים על אותו
    // מסמך (ניסיון חוזר של התשתית), ומייל כפול לכבאי הוא באג גלוי.
    if (d.delivery && d.delivery.state) {
      console.log('deliverMail: ' + ref.id + ' כבר טופל (' + d.delivery.state + ')');
      return;
    }

    const to  = asList(d.to);
    const cc  = asList(d.cc);
    const bcc = asList(d.bcc);
    const msg = d.message || {};

    if (to.length === 0) {
      await ref.set({ delivery: {
        state: 'ERROR', attempts: 0,
        error: 'אין נמען תקין בשדה to',
        endTime: FV.serverTimestamp()
      } }, { merge: true });
      return;
    }

    await ref.set({ delivery: {
      state: 'PROCESSING', attempts: 0, startTime: FV.serverTimestamp()
    } }, { merge: true });

    const mail = {
      from: MAIL_FROM_NAME + ' <' + MAIL_FROM_ADDR + '>',
      to: to.join(', '),
      subject: String(msg.subject || '(ללא נושא)')
    };
    if (cc.length) mail.cc = cc.join(', ');
    if (bcc.length) mail.bcc = bcc.join(', ');
    if (msg.html) mail.html = String(msg.html);
    if (msg.text) mail.text = String(msg.text);
    if (!mail.html && !mail.text) mail.text = '(ללא תוכן)';

    let lastErr = '';
    for (let attempt = 1; attempt <= MAIL_ATTEMPTS; attempt++) {
      try {
        const info = await getMailer(GMAIL_APP_PASSWORD.value()).sendMail(mail);
        await ref.set({ delivery: {
          state: 'SUCCESS', attempts: attempt, error: '',
          info: {
            messageId: String(info.messageId || ''),
            accepted: (info.accepted || []).length,
            rejected: (info.rejected || []).length
          },
          endTime: FV.serverTimestamp()
        } }, { merge: true });
        console.log('deliverMail: ' + ref.id + ' נשלח אל ' + to.join(', ') +
                    ' בניסיון ' + attempt);
        return;
      } catch (e) {
        lastErr = String((e && e.message) || e);
        console.warn('deliverMail: ' + ref.id + ' ניסיון ' + attempt +
                     ' נכשל — ' + lastErr);
        // חיבור שנפל נשאר תקוע במאגר. זורקים אותו כדי שהניסיון
        // הבא ייפתח נקי במקום לחזור לאותו שקע מת.
        try { if (mailer) mailer.close(); } catch (e2) {}
        mailer = null;
        if (attempt < MAIL_ATTEMPTS) {
          await new Promise(r => setTimeout(r, attempt * 2000));
        }
      }
    }

    await ref.set({ delivery: {
      state: 'ERROR', attempts: MAIL_ATTEMPTS, error: lastErr.slice(0, 500),
      endTime: FV.serverTimestamp()
    } }, { merge: true });

    // כישלון שליחה הוא תקלה שקטה מטבעה — אין מי שיתלונן, כי בדיוק
    // מי שהיה מתלונן הוא זה שלא קיבל. לכן הוא נרשם ליומן התקלות
    // שהמנהל רואה, ולא רק ללוג של הפונקציה.
    try {
      await db.collection('mail_failures').add({
        mail_id: ref.id, to: to, subject: mail.subject,
        error: lastErr.slice(0, 500), at: FV.serverTimestamp()
      });
    } catch (e) {}
  }
);


// =======================================================================
//  גיבוי הנתונים לגיליון Google Sheets
// =======================================================================
//  Firestore הוא בסיס נתונים שאי אפשר לפתוח ולהסתכל בו. גיבוי
//  אמיתי כבר יש — PITR ל-7 ימים וגיבויים מתוזמנים ל-98 יום — אבל
//  שניהם משחזרים לתוך Firestore, ואי אפשר לקרוא בהם.
//
//  הגיליון הזה הוא השכבה השלישית, וייעודה שונה: לשבת פתוח ולתת
//  לקרוא. אם ביום מן הימים המערכת תיפול, או שיצטרכו להוכיח שעות
//  מול משאבי אנוש בלי גישה לאפליקציה — הנתונים שם, בטבלה שכל
//  אחד יודע לפתוח.
//
//  לשונית לכל אוסף, נכתבת מחדש בכל לילה.
//
//  ⚙️ הקמה — שני צעדים, פעם אחת:
//
//  1. הפעל את Sheets API:
//     https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=station-102
//
//  2. פתח את הגיליון "פיירסטור-102", לחץ שיתוף, והוסף כעורך את:
//     52676411962-compute@developer.gserviceaccount.com
//
//  3. הדבק כאן את מזהה הגיליון — החלק הארוך מתוך הכתובת שלו,
//     בין /d/ לבין /edit:

const BACKUP_SHEET_ID = '';

// כמה מסמכים לכל היותר מכל אוסף. גיליון גוגל נחנק סביב חמישה
// מיליון תאים, והמגבלה כאן מונעת ריצה שנופלת באמצע ומשאירה
// גיליון חצי כתוב.
const BACKUP_MAX_ROWS = 5000;

async function sheetsClient_() {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

// Firestore מחזיר ערכים מקוננים, חותמות זמן ומערכים. גיליון
// מקבל טקסט בלבד, ולכן כל ערך מומר לצורה שאדם יכול לקרוא.
function flat_(v) {
  if (v === null || v === undefined) return '';
  if (v && typeof v.toDate === 'function') {
    try { return v.toDate().toISOString().replace('T', ' ').slice(0, 19); }
    catch (e) { return ''; }
  }
  if (Array.isArray(v)) return v.map(flat_).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function backupCollectionToSheet_(sheets, sheetId, colName, path) {
  const snap = await db.collection(path).limit(BACKUP_MAX_ROWS).get();

  if (snap.empty) return { name: colName, rows: 0 };

  // איחוד כל השדות שמופיעים באיזשהו מסמך. אוסף ב-Firestore
  // אינו חייב מבנה אחיד, ולכן כותרת שנלקחת מהמסמך הראשון
  // הייתה מפילה שדות שקיימים רק בחלק מהשורות.
  const fields = new Set();
  snap.docs.forEach(d => Object.keys(d.data()).forEach(k => fields.add(k)));
  const cols = ['_id'].concat(Array.from(fields).sort());

  const rows = [cols];
  snap.docs.forEach(d => {
    const data = d.data();
    rows.push(cols.map(c => c === '_id' ? d.id : flat_(data[c])));
  });

  // יוצרים את הלשונית אם אינה קיימת. שגיאה כאן פירושה בדרך
  // כלל שהיא כבר שם, וזה בסדר גמור.
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: colName } } }] }
    });
  } catch (e) { /* קיימת */ }

  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId, range: colName
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: colName + '!A1',
    valueInputOption: 'RAW',
    requestBody: { values: rows }
  });

  return { name: colName, rows: snap.size };
}

async function runSheetBackup_() {
  if (!BACKUP_SHEET_ID) {
    console.log('גיבוי לשיטס: BACKUP_SHEET_ID ריק — מדלג.');
    return { skipped: true, reason: 'לא הוגדר מזהה גיליון' };
  }

  const sheets = await sheetsClient_();
  const sid = STATION_ID;
  const done = [];
  const failed = [];

  for (const name of SNAP_COLS) {
    try {
      done.push(await backupCollectionToSheet_(
        sheets, BACKUP_SHEET_ID, name, 'stations/' + sid + '/' + name));
    } catch (e) {
      failed.push(name + ': ' + String((e && e.message) || e).slice(0, 200));
    }
  }

  // חותמת זמן, כדי שיהיה אפשר לראות בגיליון מתי הוא עודכן
  // לאחרונה בלי לחפש בלוגים.
  try {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: BACKUP_SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: 'עדכון אחרון' } } }] }
      });
    } catch (e) { /* קיימת */ }
    await sheets.spreadsheets.values.update({
      spreadsheetId: BACKUP_SHEET_ID,
      range: 'עדכון אחרון!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [
        ['עודכן', stamp + ' UTC'],
        ['אוספים', String(done.length)],
        ['שורות', String(done.reduce((a, b) => a + b.rows, 0))],
        ['נכשלו', failed.length ? failed.join(' | ') : 'אין']
      ] }
    });
  } catch (e) { /* לא קריטי */ }

  const total = done.reduce((a, b) => a + b.rows, 0);
  console.log('גיבוי לשיטס: ' + done.length + ' אוספים, ' + total +
              ' שורות' + (failed.length ? ', ' + failed.length + ' נכשלו' : ''));

  if (failed.length) {
    try {
      await sendMail(SUPER_ADMIN_EMAIL, '⚠️ גיבוי לשיטס — ' + failed.length + ' אוספים נכשלו',
        mailShell('גיבוי לשיטס',
          '<p>' + failed.join('<br>') + '</p>'));
    } catch (e) {}
  }

  return { ok: true, collections: done.length, rows: total, failed: failed };
}

// רץ כל לילה, אחרי הסריקה הלילית ולפני תחילת המשמרת.
exports.nightlySheetBackup = onSchedule({
  schedule: '40 3 * * *',
  timeZone: 'Asia/Jerusalem',
  region: 'europe-west1',
  timeoutSeconds: 540
}, async () => { await runSheetBackup_(); });

// הרצה ידנית מתוך check.html, לבדיקה אחרי ההקמה.
exports.backupToSheetNow = onCall({ timeoutSeconds: 540 }, async (req) => {
  requireSuperAdmin(req);
  return await runSheetBackup_();
});


// =======================================================================
//  תזכורת חתימה
// =======================================================================
//  חתימה שאיש אינו יודע שהיא ממתינה לו לא תיחתם. ראש משמרת
//  אינו פותח את המערכת כדי לבדוק אם מישהו הגיש טופס — הוא
//  פותח אותה כשמשהו קרא לו.
//
//  שתי תזכורות שונות בכוונה, ולא אחת:
//
//    לכבאי  — יומיים לפני סוף החודש, על דוח השעות שלו.
//             מוקדם מזה והוא עוד לא סיים לדווח.
//
//    למפקד  — כל יום ראשון, על כל מה שתקוע אצלו. פעם בשבוע
//             ולא כל יום: התראה יומית על אותו דבר הופכת
//             לרעש, ומי שמתרגל להתעלם מתעלם גם מהחשובות.
//
//  שתיהן שקטות כשאין מה להזכיר. תזכורת "יש לך 0 מסמכים"
//  היא הדרך המהירה ביותר ללמד אנשים לכבות התראות.

const SIGN_COLS = ['monthly_reports', 'submissions', 'handovers'];

// כמה מסמכים ממתינים לשלב מסוים בשרשרת.
//
// הספירה כאן פשוטה בכוונה: אין ניסיון לשחזר את כל הלוגיקה של
// signflow.js בשרת. השרת סופר "מסמך שאינו חתום בשלב הזה",
// והמסך הוא זה שמכריע מי בדיוק רשאי לחתום עליו. תזכורת שמצביעה
// על מסך שבו יש שלושה פריטים במקום ארבעה עדיין עשתה את עבודתה;
// שתי מימושים של אותו כלל שמתפצלים עם הזמן — לא.
// ---------------------------------------------------------------------
//  מה ממתין לחתימה
// ---------------------------------------------------------------------
//
//  **קוראים פעם אחת, סופרים בזיכרון.**
//
//  הגרסה הקודמת קראה את המסד **מחדש עבור כל אדם**: שלוש
//  שאילתות, עד 300 מסמכים כל אחת. ב-44 כבאים זה כ-40,000
//  קריאות מסמך בכל ריצה לילית — יותר מהמכסה החינמית היומית
//  של Firestore, בשביל שאלה אחת שהתשובה לה זהה לכולם.
//
//  ובנוסף היא הייתה **פשוט שגויה**: ה-limit(300) חתך את
//  התוצאה. ברגע שיש יותר מ-300 מסמכים פתוחים באוסף, הספירה
//  מפסיקה שם — כלומר אנשים שממתינה להם חתימה פשוט לא
//  נספרים, ולא מקבלים תזכורת.
//
//  עכשיו: שאילתה אחת לכל אוסף, בלי תקרה, והספירה לכל אדם
//  נעשית על מה שכבר בזיכרון.

async function loadAwaiting(sid) {
  const out = [];
  for (const col of SIGN_COLS) {
    try {
      const snap = await db.collection('stations/' + sid + '/' + col)
                           .where('status', 'in', ['submitted', 'pending', 'draft'])
                           .get();
      snap.forEach(function (d) { out.push(d.data() || {}); });
    } catch (e) { /* אוסף שאינו קיים, או אינדקס חסר */ }
  }
  return out;
}

// ספירה טהורה על מה שכבר נטען. בלי גישה לרשת.
function countAwaitingIn(docs, step, matches) {
  let n = 0;
  (docs || []).forEach(function (v) {
    const s = v.signatures || {};
    if (s[step] && s[step].image) return;        // כבר חתום בשלב הזה
    if (matches && !matches(v)) return;
    n++;
  });
  return n;
}

exports.signReminder = onSchedule({
  timeoutSeconds: 540,
  memory: '512MiB',
  schedule: '30 17 * * *',
  timeZone: 'Asia/Jerusalem',
  region: 'europe-west1'
}, async () => {
  const sid = PUSH_STATION;
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = last - now.getDate();
  const isSunday = now.getDay() === 0;

  // ---------- לכבאים, יומיים לפני הסוף ----------
  if (daysLeft === 2) {
    const uids = await uidsInCrew(sid, '');
    const need = [];

    // המסמכים הפתוחים נטענים **פעם אחת** לכל הריצה, ולא
    // מחדש לכל כבאי. ראה loadAwaiting.
    const pending = await loadAwaiting(sid);

    for (const uid of uids) {
      try {
        // ⚠️ נקרא מ-users ולא מ-roster.
        //
        // מסמך ה-roster מכיל שם, תפקיד, משמרת ו-is_active
        // בלבד — **אין בו מספר עובד**. ראה identity-coordinator:
        // employee_number נכתב ל-users, ו-roster מקבל רק את
        // מה שכל אנשי התחנה רשאים לראות.
        //
        // הגרסה הקודמת קראה roster.emp_number, קיבלה מחרוזת
        // ריקה עבור **כל** כבאי, ונפלה מיד ל-continue. כלומר
        // תזכורת החתימה לכבאים לא נשלחה מעולם, לאף אחד, ואף
        // שגיאה לא נזרקה. התגלה ב-25.8.2026 בזמן שדיברנו על
        // משהו אחר לגמרי.
        const p = await db.doc('stations/' + sid + '/users/' + uid).get();
        const d = p.data() || {};
        const emp = String(d.employee_number || d.emp_number || '');
        if (!emp) continue;
        const n = countAwaitingIn(pending, 'employee',
          (v) => String(v.emp_number || '') === emp ||
                 String(v.by_uid || '') === uid);
        if (n > 0) need.push(uid);
      } catch (e) {}
    }

    if (need.length) {
      const res = await pushToUsers(sid, need, 'reminder',
        'ממתין לחתימתך',
        'נשארו יומיים לסוף החודש, ויש מסמכים שטרם חתמת עליהם. ' +
        'דוח שלא נחתם אינו נשלח.',
        './sign.html');
      console.log('signReminder · כבאים: ' + res.people + ' אנשים');
    } else {
      console.log('signReminder · כבאים: אין מה להזכיר');
    }
  }

  // ---------- למפקדים, בכל יום ראשון ----------
  if (isSunday) {
    try {
      const rs = await db.collection('stations/' + sid + '/roster').get();
      const staff = [];
      rs.forEach(function (d) {
        const v = d.data() || {};
        if (v.is_active === false) return;
        if (['commander', 'deputy', 'station_commander', 'hr_coordinator']
              .indexOf(v.role) === -1) return;
        staff.push({ uid: d.id, crew: v.crew || '', role: v.role });
      });

      // גם כאן: טעינה אחת לכל המפקדים.
      const pendingCmd = await loadAwaiting(sid);

      for (const s of staff) {
        // מפקד משמרת נעול למשמרת שלו; מפקד תחנה ורכז כוח אדם
        // רואים הכל — אותו כלל בדיוק כמו בכל שאר המערכת.
        const wide = s.role === 'station_commander' ||
                     s.role === 'hr_coordinator' || !s.crew;
        const n = countAwaitingIn(pendingCmd, 'commander',
          wide ? null : (v) => String(v.crew || '') === s.crew);
        if (n <= 0) continue;

        await pushToUsers(sid, [s.uid], 'reminder',
          n === 1 ? 'מסמך אחד ממתין לאישורך'
                  : n + ' מסמכים ממתינים לאישורך',
          'פתח את מסך החתימות כדי לאשר.',
          './sign.html');
      }
      console.log('signReminder · מפקדים: נבדקו ' + staff.length);
    } catch (e) {
      console.warn('signReminder · מפקדים נכשל: ' + (e && e.message));
    }
  }
});


// =====================================================================
//  כלב שמירה — בדיקת בריאות יומית של המערכת
// =====================================================================
//
//  **למה הוא קיים.**
//
//  אלדד, 25.8.2026: "תהליך שבודק את כלל המערכות כדי לזהות באגים."
//
//  הרקע הוא שלושה באגים שנמצאו באוגוסט, ולשלושתם צורה אחת:
//  הם לא הפילו כלום. תזכורת החתימה קראה שדה שאף פעם לא נכתב
//  והפסיקה לצאת — בשקט, במשך חודשים. הדוח החודשי נכשל, בלע את
//  השגיאה, ורשם בביקורת שהוא הצליח. שניהם רצו בייצור ואף אחד
//  לא ידע.
//
//  קריסה רועשת. **הכישלון המסוכן פה הוא השקט**, ולכן צריך משהו
//  שיבדוק כל בוקר שהדברים שאמורים לקרות אכן קרו.
//
//  **מייל נשלח רק כשיש ממצא.** שקט פירושו תקין. כלב שמירה
//  שמדווח כל יום "הכל בסדר" הופך תוך שבועיים למייל שמוחקים
//  בלי לפתוח, ואז הוא חסר ערך בדיוק ביום שבו הוא צודק.
//
//  ⚠️ המייל יוצא גם במצב ניסוי. sendMail חוסם את כולם חוץ
//  מאלדד, והנמען כאן הוא אלדד — אחרת כלב השמירה היה שותק
//  בדיוק בתקופה שבה הכי צריך אותו.

// כמה מסמכים מסך בודד רשאי לקרוא לפני שזה מדאיג. הקצבה החינמית
// של Firestore היא 50,000 קריאות ליום לכל הפרויקט, ומתאפסת כל
// בוקר. הסף כאן נמוך ממנה בהרבה בכוונה: הוא לא מסמן "חרגת",
// הוא מסמן "מסך אחד כבר אוכל אחוזים מהיום, וזה רק גדל".
const SCREEN_READ_WARN = 3000;

// האוספים ש-stats.html קורא **שלמים** — בלי where ובלי limit.
// שלושת הראשונים גדלים לנצח ואינם מסוננים לפי תאריך.
const WHOLE_READ_COLS = ['faults', 'guards', 'swaps'];

// גבול מסמך ב-Firestore הוא מגה-בייט אחד. מסמן ב-70%, כי
// הדוח החודשי גדל עם מספר האנשים ואי אפשר לחכות ל-100%.
const DOC_WARN_BYTES = 700000;

const CONSOLE_URL = 'https://console.firebase.google.com/project/station-102';

exports.systemHealth = onSchedule({
  timeoutSeconds: 540,
  memory: '512MiB',
  schedule: '0 6 * * *',
  timeZone: 'Asia/Jerusalem',
  region: 'europe-west1'
}, async () => {
  const sid   = STATION_ID;
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  const found = [];

  // level: 'stop' עוצר עלייה לאוויר, 'warn' צריך טיפול, 'info' לידיעה
  function add(level, title, detail) {
    found.push({ level: level, title: title, detail: String(detail || '') });
  }

  // כל בדיקה בתוך try משלה. בדיקה שנופלת אינה מפילה את השאר —
  // והנפילה עצמה היא ממצא, כי בדיקה שקרסה בשקט היא בדיוק סוג
  // הבעיה שכלב השמירה נועד לתפוס.
  async function check(name, fn) {
    try { await fn(); }
    catch (e) { add('warn', 'בדיקה נכשלה · ' + name, (e && e.message) || String(e)); }
  }

  // ---------- 1. מצב ניסוי ----------
  await check('מצב ניסוי', async () => {
    const rt = await db.doc('config/runtime').get();
    if (!rt.exists || (rt.data() || {}).silent !== true) return;

    let days = null;
    try {
      const md = await db.doc('config/mode').get();
      const since = md.exists ? (md.data() || {}).since : null;
      if (since && since.toDate) {
        days = Math.floor((now - since.toDate()) / 86400000);
      }
    } catch (ignore) {}

    add('stop', 'המערכת עדיין במצב ניסוי',
        'אף התראה, מייל או קריאת פתע אינם מגיעים לאף אחד חוץ ממך' +
        (days === null ? '.' : ', כבר ' + days + ' ימים.') +
        ' המתג נמצא במסך הקליטה.');
  });

  // ---------- 2. אוספים שנקראים שלמים ----------
  //
  // הספירה כבר נעשית כל לילה ב-nightlySnapshot ונשמרת ב-backups.
  // קוראים משם במקום לספור שוב — ספירה היא קריאה בתשלום.
  await check('גודל אוספים', async () => {
    const snap = await db.collection('stations/' + sid + '/backups')
      .orderBy('date', 'desc').limit(1).get();
    if (snap.empty) {
      add('warn', 'אין תצלום אוספים',
          'nightlySnapshot לא כתב אף רשומה. ייתכן שהוא אינו רץ.');
      return;
    }
    const counts = (snap.docs[0].data() || {}).counts || {};
    WHOLE_READ_COLS.forEach(function (name) {
      const n = counts[name];
      if (typeof n !== 'number' || n < SCREEN_READ_WARN) return;
      add('warn', 'אוסף ' + name + ' הגיע ל-' + n + ' מסמכים',
          'מסך הסטטיסטיקה קורא את האוסף הזה שלם, בלי סינון תאריך. ' +
          'כל פתיחה של המסך עולה ' + n + ' קריאות, וזה רק גדל. ' +
          'צריך לסנן אותו לטווח תאריכים.');
    });
  });

  // ---------- 3. מסמכים שמתקרבים לגבול המגה-בייט ----------
  await check('גודל מסמכים', async () => {
    const cols = ['hr_reports', 'scans'];
    for (const col of cols) {
      const s = await db.collection('stations/' + sid + '/' + col)
        .orderBy('__name__', 'desc').limit(3).get();
      s.forEach(function (d) {
        let bytes = 0;
        try { bytes = Buffer.byteLength(JSON.stringify(d.data() || {}), 'utf8'); }
        catch (ignore) { return; }
        if (bytes < DOC_WARN_BYTES) return;
        add('warn', col + '/' + d.id + ' שוקל ' + Math.round(bytes / 1024) + 'KB',
            'הגבול הקשיח של מסמך ב-Firestore הוא 1024KB. מעבר לו הכתיבה ' +
            'נכשלת, ולא לאט — פתאום. צריך לפצל.');
      });
    }
  });

  // ---------- 4. כשלי מייל ב-24 השעות האחרונות ----------
  await check('כשלי מייל', async () => {
    const since = new Date(now.getTime() - 86400000);
    const s = await db.collection('mail_failures')
      .where('at', '>=', since).limit(50).get();
    if (s.empty) return;
    const sample = s.docs.slice(0, 3).map(function (d) {
      const v = d.data() || {};
      return (v.to || '?') + ' · ' + (v.error || v.subject || '');
    }).join(' | ');
    add('warn', s.size + ' מיילים נכשלו ביממה האחרונה', sample);
  });

  // ---------- 5. משימות מתוזמנות ששתקו ----------
  //
  // זה הלב. תזכורת שהפסיקה לצאת אינה מייצרת שגיאה — היא פשוט
  // לא קורית, וזה נראה בדיוק כמו "לא היה למי לשלוח".
  await check('משימות מתוזמנות', async () => {
    const twoDays = new Date(now.getTime() - 2 * 86400000);

    const scan = await db.doc('stations/' + sid + '/scans/' + monthKeyOf(now)).get();
    const ranAt = scan.exists ? (scan.data() || {}).ran_at : null;
    if (!ranAt || !ranAt.toDate || ranAt.toDate() < twoDays) {
      add('warn', 'nightlyScan לא רץ ביומיים האחרונים',
          'סריקת חריגות השעות היא מה שמייצר את ההתראות לרכזת. ' +
          'אם היא שותקת, אין התראות — וזה נראה כמו חודש בלי חריגות.');
    }

    const bk = await db.collection('stations/' + sid + '/backups')
      .orderBy('date', 'desc').limit(1).get();
    const last = bk.empty ? '' : String((bk.docs[0].data() || {}).date || '');
    if (last && last < twoDays.toISOString().slice(0, 10)) {
      add('warn', 'nightlySnapshot לא רץ מאז ' + last,
          'התצלום היומי הוא מה שמזהה מחיקה המונית. בלעדיו לא נדע.');
    }
  });

  // ---------- 6. יתומים במפתח מספרי העובד ----------
  //
  // emp_index הוא מה שהופך מספר עובד ל-uid. רשומה שמצביעה על
  // משתמש שכבר לא קיים פירושה מספר עובד תפוס בלי בעלים —
  // והוא יחסום את מי שינסה לקבל אותו, בלי שיהיה ברור למה.
  await check('מפתח מספרי עובד', async () => {
    const idx = await db.collection('emp_index').limit(200).get();
    const orphans = [];
    for (const d of idx.docs) {
      const indexData = d.data() || {};
      if (!identityCoordinatorModule.activeIndex(indexData)) continue;
      const uid = String(indexData.uid || '');
      if (!uid) { orphans.push(d.id + ' (בלי uid)'); continue; }
      const u = await db.doc('stations/' + sid + '/users/' + uid).get();
      if (!u.exists) orphans.push(d.id);
    }
    if (!orphans.length) return;
    add('warn', orphans.length + ' מספרי עובד מצביעים על משתמש שאינו קיים',
        orphans.slice(0, 10).join(', '));
  });

  // ---------- הרישום ----------
  //
  // נכתב תמיד, גם כשאין ממצאים. בלי רשומה יומית אי אפשר להבדיל
  // בין "הכל תקין" לבין "כלב השמירה עצמו מת".
  const stop = found.filter(f => f.level === 'stop').length;
  const warn = found.filter(f => f.level === 'warn').length;

  try {
    await db.doc('stations/' + sid + '/health/' + today).set({
      date: today, ran_at: FV.serverTimestamp(),
      findings: found, stop: stop, warn: warn
    });
  } catch (e) {
    console.error('systemHealth · רישום נכשל: ' + (e && e.message));
  }

  console.log('systemHealth', today, 'stop', stop, 'warn', warn);

  if (!found.length) return;   // שקט פירושו תקין

  const rows = found.map(function (f) {
    const color = f.level === 'stop' ? '#c92a2a' : '#e8590c';
    return '<div style="border-right:4px solid ' + color + ';padding:8px 12px;' +
           'margin:0 0 12px;background:#fafafa">' +
           '<div style="font-weight:bold;color:#222">' + f.title + '</div>' +
           '<div style="color:#666;font-size:14px;margin-top:4px">' + f.detail + '</div>' +
           '</div>';
  }).join('');

  const subject = (stop ? '⛔ ' : '⚠️ ') + 'בדיקת מערכת · ' +
                  (stop ? stop + ' חוסמים' : warn + ' לטיפול');

  await sendMail(SUPER_ADMIN_EMAIL, subject, mailShell(
    'בדיקת הבריאות היומית מצאה ' + found.length + ' דברים',
    rows +
    '<div style="color:#888;font-size:13px;margin-top:16px">' +
    'המייל הזה נשלח רק כשיש ממצא. יום בלי מייל הוא יום תקין.</div>' +
    button(CONSOLE_URL, 'לקונסולה')
  ));
});


// =======================================================================
//  מנוע סידור חודשי חדש · 42F
// =======================================================================
// ברירת המחדל היא off. עצם פריסת הקוד אינה מפעילה מנוע, אינה משנה
// סידור קיים ואינה שולחת הודעה. הפעלה דורשת מסמך מדיניות, מקור חתום
// ומצב runtime מפורש. התחנה לעולם אינה מתקבלת מגוף הבקשה.

async function invokeSchedule(method, req) {
  try {
    return await scheduleRuntime[method](req);
  } catch (error) {
    if (error instanceof scheduleRuntimeModule.ScheduleRuntimeError) {
      throw new HttpsError(error.httpCode || 'failed-precondition', error.message, {
        schedule_code: error.code
      });
    }
    throw error;
  }
}

exports.getScheduleRuntimeStatus = onCall({ enforceAppCheck: true }, async (req) =>
  invokeSchedule('getStatus', req));

exports.getScheduleManagerSetup = onCall({ enforceAppCheck: true }, async (req) =>
  invokeSchedule('getManagerSetup', req));

// מינוי "אחראי/ת סידור" נפרד מהתפקיד הראשי ומן הטוקן. שתי
// הפעולות מפיקות את התחנה מהזהות החיה בשרת; הדפדפן אינו רשאי
// לשלוח stationId ואינו מקבל גישה ישירה למסמכי schedule_access.
exports.getScheduleManagerAccess = onCall({ enforceAppCheck: true }, async (req) =>
  scheduleAccessAdmin.list(req));

exports.setScheduleManagerAccess = onCall({ enforceAppCheck: true }, async (req) =>
  scheduleAccessAdmin.set(req));

exports.runSchedulePlanner = onCall({
  enforceAppCheck: true,
  timeoutSeconds: 540,
  memory: '1GiB'
}, async (req) => invokeSchedule('runPlanner', req));

exports.getScheduleDraftPreview = onCall({ enforceAppCheck: true }, async (req) =>
  invokeSchedule('getDraftPreview', req));

exports.publishSchedule = onCall({
  enforceAppCheck: true,
  timeoutSeconds: 540,
  memory: '1GiB'
}, async (req) => invokeSchedule('publish', req));

exports.rollbackSchedule = onCall({
  enforceAppCheck: true,
  timeoutSeconds: 540,
  memory: '1GiB'
}, async (req) => invokeSchedule('rollback', req));

exports.getMyScheduleV2 = onCall({ enforceAppCheck: true }, async (req) =>
  invokeSchedule('getMy', req));

exports.getStationScheduleV2 = onCall({ enforceAppCheck: true }, async (req) =>
  invokeSchedule('getStation', req));

// Temporary server-only bridge for operational screens that still evaluate
// the legacy rotation cycle while runtime.mode is off or shadow.  The callable
// accepts no station or range input and returns only the allow-listed fields;
// direct client reads remain closed in Firestore rules.
exports.getLegacyScheduleCompatibilityContext = onCall({ enforceAppCheck: true }, async (req) =>
  invokeSchedule('getLegacyCompatibility', req));

// Raw guard documents contain notes, places, sign-up records and audit data.
// These read-only callables are the only browser boundary for the legacy guard
// screens; each runtime method returns an explicit, role-appropriate projection.
exports.getScheduleGuardBoard = onCall({ enforceAppCheck: true }, async (req) =>
  invokeSchedule('getGuardBoard', req));

exports.getScheduleGuardManagerBoard = onCall({ enforceAppCheck: true }, async (req) =>
  invokeSchedule('getGuardManagerBoard', req));

exports.getMyGuardAttendance = onCall({ enforceAppCheck: true }, async (req) =>
  invokeSchedule('getMyGuardAttendance', req));

exports.getGuardLoadStatistics = onCall({ enforceAppCheck: true }, async (req) =>
  invokeSchedule('getGuardLoadStatistics', req));

exports.respondToSchedule = onCall({ enforceAppCheck: true }, async (req) =>
  invokeSchedule('respond', req));

// Guard operations stay live even while the monthly engine is off or in
// shadow mode.  Authority is nevertheless the same live, explicit
// schedule-manager appointment used by the engine itself.
exports.manageScheduleGuard = onCall({ enforceAppCheck: true }, async (req) =>
  invokeSchedule('manageGuard', req));

// Guard notifications have their own outbox: unlike publication notices they
// must not depend on an active monthly publication or on runtime.mode === new.
exports.fanoutScheduleGuardNotifications = onDocumentWritten({
  document: 'stations/{sid}/guard_notification_jobs/{jobId}'
}, async (event) => {
  const after = event.data && event.data.after;
  if (!after || !after.exists) return;
  const next = after.data() || {};
  const before = event.data.before && event.data.before.exists
    ? (event.data.before.data() || {}) : {};
  if (next.status !== 'queued' || before.status === 'queued') return;
  await scheduleRuntime.fanoutGuardOutbox(after.ref);
});

exports.deliverScheduleGuardOutbox = onDocumentWritten({
  document: 'stations/{sid}/guard_outbox/{outboxId}'
}, async (event) => {
  const after = event.data && event.data.after;
  if (!after || !after.exists) return;
  const next = after.data() || {};
  const before = event.data.before && event.data.before.exists
    ? (event.data.before.data() || {}) : {};
  if (next.status !== 'queued' || before.status === 'queued') return;
  await scheduleRuntime.deliverGuardOutbox(after.ref);
});

exports.resumeScheduleGuardOutbox = onSchedule({
  schedule: 'every 5 minutes',
  timeZone: 'Asia/Jerusalem',
  timeoutSeconds: 120,
  region: 'europe-west1'
}, async () => scheduleRuntime.resumeGuardOutbox());

// טריגר השליחה רץ רק כאשר רשומת outbox עוברת במפורש ל-queued.
// הרשומות נוצרות blocked; שחרור השרת בודק טרנזקציונית את הפרסום
// הפעיל ואת ה-pointer לפני המעבר, לכן פוש אינו יכול להקדים פרסום.
exports.deliverScheduleOutbox = onDocumentWritten({
  document: 'stations/{sid}/schedule_publications/{publicationId}/schedule_outbox/{outboxId}'
}, async (event) => {
  const after = event.data && event.data.after;
  if (!after || !after.exists) return;
  const next = after.data() || {};
  const before = event.data.before && event.data.before.exists
    ? (event.data.before.data() || {}) : {};
  if (next.status !== 'queued' || before.status === 'queued') return;
  await scheduleRuntime.deliverOutbox(after.ref);
});

// אם פונקציית הפרסום הסתיימה אחרי החלפת המצב הפעיל ולפני ששחררה
// את התור, או אם FCM היה זמנית לא זמין, הריצה הזאת ממשיכה בבטחה.
exports.resumeScheduleOutbox = onSchedule({
  schedule: 'every 5 minutes',
  timeZone: 'Asia/Jerusalem',
  timeoutSeconds: 120,
  region: 'europe-west1'
}, async () => scheduleRuntime.resumeOutbox());
