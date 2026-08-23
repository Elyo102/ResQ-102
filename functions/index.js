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
const SITE_URL = 'https://elyo102.github.io/ResQ-102';

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

  await sendMail(email, 'ResQ — החשבון שלך ננעל',
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

async function loadSchedule() {
  const rotations = [];
  const overrides = {};
  try {
    const rs = await db.collection('stations/' + STATION_ID + '/rotations').get();
    rs.forEach(d => rotations.push(d.data() || {}));
  } catch (e) { console.error('rotations read failed', e); }
  try {
    const os = await db.collection('stations/' + STATION_ID + '/shift_overrides').get();
    os.forEach(d => { overrides[d.id] = d.data() || {}; });
  } catch (e) { console.error('overrides read failed', e); }
  return { rotations, overrides };
}

// ---------- סריקת חודש של אדם אחד ----------

function scanPerson(person, recs, sched, mk, limit) {
  const findings = [];
  const byDate = {};
  recs.forEach(r => { byDate[r.date] = r; });

  const p = mk.split('-').map(Number);
  const last = new Date(Date.UTC(p[0], p[1], 0)).getUTCDate();

  let total = 0;
  recs.forEach(r => { total += Number(r.hours || 0); });
  total = Math.round(total * 100) / 100;

  for (let d = 1; d <= last; d++) {
    const key = mk + '-' + pad2(d);
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

async function scanMonth(mk) {
  const sched = await loadSchedule();
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
    const out = scanPerson(person, recs, sched, mk, cfg.limit);
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
      if (isWorking(sched.rotations, sched.overrides, p.crew,
                    mk + '-' + pad2(d))) due++;
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

exports.nightlyScan = onSchedule({
  schedule: '10 2 * * *',
  timeZone: 'Asia/Jerusalem',
  region: 'europe-west1'
}, async () => {
  const now = new Date();
  const mk = monthKeyOf(now);
  const { results, cfg } = await scanMonth(mk);

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

  const html = mailShell('דוח נוכחות · ' + heMonth(mk),
    head + results.map(r => personTable(r, cfg)).join(''));

  await db.doc('stations/' + STATION_ID + '/hr_reports/' + mk).set({
    month: mk,
    built_at: FV.serverTimestamp(),
    people: results.length,
    over_limit: over.length,
    flagged: flagged.length,
    hour_limit: cfg.limit,
    sent_to: cfg.email || null
  }, { merge: true });

  if (cfg.email) {
    await sendMail(cfg.email,
      'ResQ — דוח נוכחות ' + heMonth(mk) + ' · ' + STATION_NAME, html);
  }

  console.log('monthlyHrReport', mk, 'people', results.length,
              'over', over.length, 'to', cfg.email || '(none)');
  return { people: results.length, over: over.length, sent: !!cfg.email };
}

exports.monthlyHrReport = onSchedule({
  schedule: '0 6 1 * *',
  timeZone: 'Asia/Jerusalem',
  region: 'europe-west1'
}, async () => {
  await buildAndSendMonthly(prevMonthKey(new Date()));
});

// הרצה ידנית של אחת מהשתיים, למנהל-על. בלי זה אי אפשר לבדוק
// אותן בלי לחכות לחצות או לראשון בחודש.
exports.runReportNow = onCall(async (req) => {
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
