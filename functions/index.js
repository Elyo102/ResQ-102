// =====================================================================
//  תחנה 102 — Cloud Functions
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

admin.initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });

// ---------------------------------------------------------------------
//  קבועים
// ---------------------------------------------------------------------

// מנהל-העל. חייב להיות זהה לערך ב-firestore.rules.
const SUPER_ADMIN_EMAIL = 'fire102.shits@gmail.com';

const VALID_ROLES = [
  'firefighter', 'commander', 'hr_coordinator', 'district_commander'
];
const VALID_SHIFTS = ['A', 'B', 'C'];

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
const SITE_URL = 'https://elyo102.github.io/station-102-Fire';

// קישור שחרור נעילה תקף לשעה. אחריה צריך לחכות או לבקש חדש.
const UNLOCK_TOKEN_MINUTES = 60;

const db = admin.firestore();
const FV = admin.firestore.FieldValue;

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

async function sendMail(to, subject, html) {
  if (!to) return;
  try {
    await db.collection('mail').add({
      to: [to],
      message: { subject: subject, html: html },
      created_at: FV.serverTimestamp()
    });
  } catch (e) {
    console.error('mail queue failed', e);
  }
}

function mailShell(title, bodyHtml) {
  return '<div dir="rtl" style="font-family:Arial,sans-serif;background:#f4f6f8;' +
         'padding:24px"><div style="max-width:520px;margin:0 auto;background:#fff;' +
         'border-radius:12px;padding:26px">' +
         '<h2 style="margin:0 0 4px;color:#222">תחנה 102</h2>' +
         '<div style="color:#888;font-size:13px;margin-bottom:20px">מערכת ניהול כוח אדם</div>' +
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

async function empTaken(emp) {
  const snap = await db.doc('emp_index/' + emp).get();
  return snap.exists;
}

// הקצאת מספר עובד. טרנזקציה, כדי ששני אישורים במקביל לא יקבלו
// את אותו מספר.
//
// המונה מדלג על מספרים תפוסים. זה נחוץ כי במעבר מהמערכת הישנה
// כבאים שומרים את הקוד האישי שהם כבר מכירים — 1990, 1711, 4492 —
// והמונה חייב לעקוף אותם ולא לדרוס אף אחד.
async function allocateEmployeeNumber() {
  const ref = db.doc('meta/emp_counter');

  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = await db.runTransaction(async function (tx) {
      const snap = await tx.get(ref);
      const next = snap.exists ? Number(snap.data().next || EMP_START) : EMP_START;
      tx.set(ref, { next: next + 1, updated_at: FV.serverTimestamp() }, { merge: true });
      return String(next);
    });

    if (!(await empTaken(candidate))) return candidate;
  }

  throw new HttpsError('resource-exhausted',
    'לא נמצא מספר עובד פנוי. פנה למנהל המערכת.');
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

// מכבה אדם בכל המקומות שבהם הוא מופיע: ספרייה, תחנה, רשימת
// התחנה, ומפתח הכניסה לפי מספר עובד.
async function deactivateEverywhere(uid, before) {
  const off = { is_active: false, updated_at: FV.serverTimestamp() };
  const sid = String((before || {}).stationId || '');
  const emp = String((before || {}).emp || '');

  await db.doc('directory/' + uid).set(off, { merge: true }).catch(function () {});

  if (sid) {
    await db.doc('stations/' + sid + '/users/'  + uid).set(off, { merge: true })
            .catch(function () {});
    await db.doc('stations/' + sid + '/roster/' + uid).set(off, { merge: true })
            .catch(function () {});
  }

  if (emp) {
    await db.doc('emp_index/' + emp).delete().catch(function () {});
  }
}

async function resolveUser(data) {
  if (data.uid)   return admin.auth().getUser(String(data.uid));
  if (data.email) return admin.auth().getUserByEmail(String(data.email).toLowerCase());
  throw new HttpsError('invalid-argument', 'צריך למסור uid או email.');
}

// כותב את שלושת המסמכים שמתארים אדם, כל אחד לקהל אחר.
//
//   users      הכל, כולל מספר עובד. נקרא על ידי הכבאי עצמו וסגל.
//   roster     שם, תפקיד, משמרת. נקרא על ידי אנשי התחנה.
//   directory  חיפוש עובד — שם, תפקיד, תחנה, מחוז. כל כבאי בארץ.
//
// ההפרדה קיימת כי כללי Firestore לא יכולים לחסום שדה בודד —
// או שכל המסמך נקרא, או שלא.
async function writeProfile(uid, p) {
  const batch = db.batch();

  batch.set(db.doc('stations/' + p.stationId + '/users/' + uid), {
    employee_number: p.emp,
    full_name:       p.full_name || '',
    email:           p.email || '',
    phone:           p.phone || '',
    role:            p.role,
    crew:            p.shift || '',
    station:         p.stationId,
    district:        p.districtId || '',
    is_active:       true,
    updated_at:      FV.serverTimestamp()
  }, { merge: true });

  batch.set(db.doc('stations/' + p.stationId + '/roster/' + uid), {
    full_name:  p.full_name || '',
    role:       p.role,
    crew:       p.shift || '',
    is_active:  true,
    updated_at: FV.serverTimestamp()
  }, { merge: true });

  // חיפוש עובד. בלי מספר עובד, בלי מייל, בלי טלפון.
  batch.set(db.doc('directory/' + uid), {
    full_name:     p.full_name || '',
    name_prefixes: namePrefixes(p.full_name),
    role:          p.role,
    crew:          p.shift || '',
    station:       p.stationId,
    district:      p.districtId || '',
    is_active:     true,
    updated_at:    FV.serverTimestamp()
  }, { merge: true });

  // מפתח כניסה: מספר עובד אל המשתמש. נקרא רק בשרת.
  batch.set(db.doc('emp_index/' + p.emp), {
    uid:        uid,
    email:      p.email || '',
    stationId:  p.stationId,
    updated_at: FV.serverTimestamp()
  }, { merge: true });

  await batch.commit();
}

// ---------------------------------------------------------------------
//  1. אתחול מנהל-על — פעם אחת
// ---------------------------------------------------------------------

exports.bootstrapSuperAdmin = onCall(async (req) => {
  const auth = requireAuth(req);
  const email = String(auth.token.email || '').toLowerCase();

  if (email !== SUPER_ADMIN_EMAIL) {
    throw new HttpsError('permission-denied', 'החשבון הזה אינו מנהל המערכת.');
  }

  const audit = await openAudit(auth, 'bootstrap_super_admin', auth.uid, { email: email });

  // מיזוג ולא דריסה. אלדד הוא לוחם אש וגם מנהל; דריסה הייתה
  // מוחקת לו מספר עובד, תחנה, מחוז ומשמרת בלחיצה אחת.
  const cur = (await admin.auth().getUser(auth.uid)).customClaims || {};
  const merged = Object.assign({}, cur, { super: true });
  if (!merged.role) merged.role = 'super_admin';
  await admin.auth().setCustomUserClaims(auth.uid, merged);

  await sealAudit(audit);

  return {
    ok: true,
    message: 'הוגדרת כמנהל מערכת. התנתק והתחבר מחדש כדי שהשינוי ייכנס לתוקף.'
  };
});

// ---------------------------------------------------------------------
//  2. אישור בקשת הרשמה
//     כאן מוקצה מספר העובד. הכבאי לא מזין אותו ולא בוחר אותו.
// ---------------------------------------------------------------------

exports.approveRegistration = onCall(async (req) => {
  const auth = requireSuperAdmin(req);
  const d = req.data || {};

  const uid = String(d.uid || '');
  if (!uid) throw new HttpsError('invalid-argument', 'חסר מזהה משתמש.');

  const user = await admin.auth().getUser(uid);

  // הפרטים מגיעים מהבקשה שהכבאי מילא, ומה שהמאשר תיקן עליהם.
  const reqRef  = db.doc('registration_requests/' + uid);
  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) {
    throw new HttpsError('not-found', 'הבקשה לא נמצאה. ייתכן שכבר טופלה.');
  }
  const r = reqSnap.data();

  // הבקשה נקראת מחדש ברגע האישור. אם הכבאי מחק ויצר אותה מחדש
  // בזמן שהמסך היה פתוח, הערכים כאן אינם מה שהמאשר ראה.
  if (String(r.status || '') !== 'pending') {
    throw new HttpsError('failed-precondition',
      'הבקשה כבר טופלה או שונתה. רענן את הרשימה ונסה שוב.');
  }

  const stationId  = String(d.stationId  || r.stationId  || '');
  const districtId = String(d.districtId || r.districtId || '');
  const role       = VALID_ROLES.indexOf(d.role) !== -1 ? d.role : 'firefighter';
  const shift      = VALID_SHIFTS.indexOf(d.shift) !== -1 ? d.shift : '';

  if (!stationId)  throw new HttpsError('invalid-argument', 'חסרה תחנה.');
  if (!districtId) throw new HttpsError('invalid-argument', 'חסר מחוז.');
  if (KNOWN_DISTRICTS.indexOf(districtId) === -1) {
    throw new HttpsError('invalid-argument', 'מחוז לא מוכר: ' + districtId);
  }

  // שם חסר יוצר כבאי אנונימי שלא נמצא בחיפוש ומוצג בכל מסך
  // ככתובת מייל. אותה בדיקה כבר קיימת בהענקת תפקיד ידנית.
  const fullName = String(d.full_name || r.full_name || '').trim();
  if (!fullName) {
    throw new HttpsError('invalid-argument',
      'לבקשה אין שם מלא. הוסף אותו לפני האישור.');
  }
  if (role === 'district_commander' && !districtId) {
    throw new HttpsError('invalid-argument', 'מפקד מחוז חייב שיוך למחוז.');
  }

  // המאשר יכול לקבוע מספר עובד. במעבר מהמערכת הישנה זה מה
  // שמאפשר לכבאי לשמור את הקוד האישי שהוא כבר מכיר, במקום
  // ללמוד מספר חדש בלי סיבה. ריק = הקצאה אוטומטית.
  let emp;
  const wanted = String(d.emp || '').trim();

  if (wanted) {
    if (!validEmp(wanted)) {
      throw new HttpsError('invalid-argument',
        'מספר עובד חייב להיות עד 6 ספרות, ולא להתחיל באפס.');
    }
    // "תפוס" רק אם הוא שייך למישהו אחר. אישור חוזר של אותו אדם
    // עם אותו מספר הוא פעולה לגיטימית.
    const takenSnap = await db.doc('emp_index/' + wanted).get();
    if (takenSnap.exists && String(takenSnap.data().uid || '') !== uid) {
      throw new HttpsError('already-exists',
        'מספר העובד ' + wanted + ' כבר שייך למישהו אחר. בחר אחר או השאר ריק.');
    }
    emp = wanted;
  } else {
    emp = await allocateEmployeeNumber();
  }

  const claims = {
    role:       role,
    stationId:  stationId,
    districtId: districtId,
    shift:      shift,
    emp:        emp
  };

  // מגבלת Custom Claims היא 1000 בתים. אנחנו רחוקים ממנה,
  // אבל הבדיקה זולה ומונעת הפתעה עתידית.
  if (JSON.stringify(claims).length > 900) {
    throw new HttpsError('invalid-argument', 'ההרשאות ארוכות מדי.');
  }

  const audit = await openAudit(auth, 'approve_registration', uid, {
    email: user.email, stationId: stationId, districtId: districtId,
    role: role, shift: shift, emp: emp
  });

  await admin.auth().setCustomUserClaims(uid, claims);

  // מספר עובד קודם, אם המשתמש כבר אושר פעם: בלי המחיקה הזו שני
  // מספרים היו פותחים את אותו חשבון.
  const prevEmp = String((user.customClaims || {}).emp || '');
  if (prevEmp && prevEmp !== emp) {
    await db.doc('emp_index/' + prevEmp).delete().catch(function () {});
  }

  await writeProfile(uid, {
    emp:        emp,
    full_name:  fullName,
    email:      String(user.email || '').toLowerCase(),
    phone:      r.phone || '',
    role:       role,
    shift:      shift,
    stationId:  stationId,
    districtId: districtId
  });

  await reqRef.delete();
  await sealAudit(audit);

  return {
    ok: true,
    uid: uid,
    emp: emp,
    role: role,
    message: 'אושר. מספר העובד שהוקצה: ' + emp +
             '. הכבאי צריך להתנתק ולהתחבר מחדש.'
  };
});

// ---------------------------------------------------------------------
//  3. שינוי תפקיד או שיוך
//     לא מקצה מספר עובד חדש — מספר עובד נשאר עם האדם.
// ---------------------------------------------------------------------

exports.setUserRole = onCall(async (req) => {
  const auth = requireSuperAdmin(req);
  const d = req.data || {};

  const user   = await resolveUser(d);
  const before = user.customClaims || {};
  const role   = String(d.role || '');

  // הבדיקה הזו חייבת לקדום למסלול 'none'. בגרסה הקודמת היא ישבה
  // אחריו — ולכן מנהל שבחר לעצמו "הסרת כל ההרשאות" ננעל מחוץ
  // למערכת בלי אזהרה, כי המסלול הזה חוזר לפני שהיא נבדקת.
  const removingSuper =
    before.super === true && (role === 'none' || d.super === false);
  if (removingSuper && user.uid === auth.uid) {
    throw new HttpsError('failed-precondition',
      'אי אפשר להסיר את הרשאת הניהול מעצמך. בקש ממנהל אחר.');
  }

  if (role === 'none') {
    const audit = await openAudit(auth, 'clear_role', user.uid, { email: user.email });
    await admin.auth().setCustomUserClaims(user.uid, null);

    // מבטל טוקני רענון. שים לב: טוקן שכבר הונפק נשאר תקף מול
    // כללי Firestore עד לתפוגתו — עד שעה.
    await admin.auth().revokeRefreshTokens(user.uid);

    // עזיבה אמיתית, לא רק ניקוי הרשאות. בגרסה הקודמת מספר העובד
    // המשיך לפתוח כניסה, והרשומה המשיכה להופיע בבקרת הגישה עם
    // טלפון ומייל — כלומר עובד שעזב נשאר גלוי ופעיל למראית עין.
    await deactivateEverywhere(user.uid, before);

    await sealAudit(audit);
    return {
      ok: true,
      uid: user.uid,
      message: 'ההרשאות הוסרו והשיוך נוקה. טוקן קיים עשוי להישאר תקף עד שעה.'
    };
  }

  if (VALID_ROLES.indexOf(role) === -1) {
    throw new HttpsError('invalid-argument',
      'תפקיד לא מוכר: ' + role + '. מותר: ' + VALID_ROLES.join(', ') + ' או none.');
  }

  const stationId  = String(d.stationId  || before.stationId  || '');
  const districtId = String(d.districtId || before.districtId || '');
  const shift      = String(d.shift || '');
  const emp        = String(d.emp || before.emp || '');

  if (!stationId) throw new HttpsError('invalid-argument', 'חסרה תחנה.');
  if (!emp)       throw new HttpsError('invalid-argument', 'למשתמש אין מספר עובד.');
  if (!validEmp(emp)) {
    throw new HttpsError('invalid-argument',
      'מספר עובד חייב להיות 1 עד 6 ספרות, ולא להתחיל באפס.');
  }

  // אם המספר תפוס על ידי מישהו אחר — עוצרים. אם הוא תפוס על ידי
  // המשתמש הזה עצמו, זה פשוט אותו מספר ואין בעיה.
  const idxSnap = await db.doc('emp_index/' + emp).get();
  if (idxSnap.exists && String(idxSnap.data().uid || '') !== user.uid) {
    throw new HttpsError('already-exists',
      'מספר העובד ' + emp + ' כבר שייך למישהו אחר.');
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

  const audit = await openAudit(auth, 'set_role', user.uid, {
    email: user.email, before: before, after: claims
  });

  await admin.auth().setCustomUserClaims(user.uid, claims);

  // שם וטלפון נשמרים אם לא נמסרו במפורש. בלי זה, תיקון תפקיד
  // או שינוי מספר עובד היה מוחק לכבאי את השם והטלפון — כי
  // writeProfile כותב את כל השדות, וריק דורס.
  let existing = {};
  try {
    const cur = await db.doc('stations/' + stationId + '/users/' + user.uid).get();
    if (cur.exists) existing = cur.data() || {};
  } catch (ignore) {}

  // רשומה בלי שם אינה ניתנת למציאה בחיפוש עובד, והמסכים מציגים
  // במקומה כתובת מייל. עדיף להיכשל כאן מאשר ליצור כבאי אנונימי.
  const fullName = String(d.full_name || existing.full_name || '').trim();
  if (!fullName) {
    throw new HttpsError('invalid-argument',
      'חסר שם מלא. הזן אותו בטופס — בלעדיו הכבאי לא יימצא בחיפוש.');
  }

  await writeProfile(user.uid, {
    emp:        emp,
    full_name:  fullName,
    email:      String(user.email || '').toLowerCase(),
    phone:      String(d.phone || existing.phone || ''),
    role:       role,
    shift:      shift,
    stationId:  stationId,
    districtId: districtId
  });

  // שינוי מספר עובד משאיר מאחור את מפתח הכניסה הישן. בלי המחיקה
  // הזו שני מספרים היו מכניסים לאותו חשבון — מבלבל בבקרה, וגם
  // משטח תקיפה מיותר.
  const oldEmp = String(before.emp || '');
  if (oldEmp && oldEmp !== emp) {
    await db.doc('emp_index/' + oldEmp).delete().catch(function () {});
  }

  // תחנה שהשתנתה: הרשומה הישנה נשארה קריאה לסגל התחנה הישנה,
  // עם טלפון ומייל, גם אחרי שהכבאי עבר. מכבים אותה.
  const oldSid = String(before.stationId || '');
  if (oldSid && oldSid !== stationId) {
    const off = { is_active: false, updated_at: FV.serverTimestamp() };
    await db.doc('stations/' + oldSid + '/users/'  + user.uid).set(off, { merge: true })
            .catch(function () {});
    await db.doc('stations/' + oldSid + '/roster/' + user.uid).set(off, { merge: true })
            .catch(function () {});
  }

  // בלי ביטול טוקני הרענון, הרשאה שהוסרה ממשיכה לעבוד עד שעה —
  // והכללים קוראים אך ורק את הטוקן, בלי בדיקה נוספת בשרת.
  //
  // יוצא דופן: עריכה עצמית. ביטול כאן היה מנתק את המנהל מהמערכת
  // באמצע העבודה, בלי שביקש.
  if (user.uid !== auth.uid) {
    await admin.auth().revokeRefreshTokens(user.uid).catch(function () {});
  }

  await sealAudit(audit, { emp_before: oldEmp || null, emp_after: emp });

  return {
    ok: true, uid: user.uid, emp: emp,
    message: 'התפקיד הוגדר. המשתמש צריך להתנתק ולהתחבר מחדש כדי שהשינוי ייכנס לתוקף.'
  };
});

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

  if (!idxSnap.exists) {
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

  const body =
    '<p style="font-size:15px;color:#333;line-height:1.8">' +
    'החשבון שלך ננעל לאחר ' + MAX_FAILED_LOGINS + ' ניסיונות כניסה שגויים.<br>' +
    'הנעילה תשתחרר מעצמה בעוד ' + LOCKOUT_MINUTES + ' דקות.</p>' +
    '<p style="font-size:15px;color:#333;line-height:1.8">' +
    'אם זה היית אתה ואתה רוצה לנסות שוב עכשיו:</p>' +
    button(SITE_URL + '/unlock.html?t=' + token, 'שחרור הנעילה') +
    '<p style="font-size:13px;color:#888;line-height:1.8">' +
    'הקישור תקף לשעה אחת ולשימוש יחיד.<br><br>' +
    '<b style="color:#c0392b">אם זה לא היית אתה</b> — מישהו מנסה להיכנס לחשבון שלך. ' +
    'אל תלחץ על הכפתור, ושנה סיסמה בהקדם.</p>';

  await sendMail(email, 'תחנה 102 — החשבון שלך ננעל',
                 mailShell('נעילת חשבון', body));
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
    } catch (e) { return answer; }
  } else {
    const idx = await db.doc('emp_index/' + id).get();
    if (!idx.exists) return answer;
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

  await sendMail(email, 'תחנה 102 — מספר עובד ואיפוס סיסמה',
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
