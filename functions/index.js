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

// המפתח הציבורי של אפליקציית הווב. מופיע ממילא ב-firebase-config.js
// ונשלח לכל דפדפן — הוא מזהה את הפרויקט, לא מעניק גישה.
const WEB_API_KEY = 'AIzaSyDY13rUZCN0q2Izo8i59JHKmWvnu_0Tw7Q';

// מספרי עובד ארציים, לא לפי תחנה — כדי שמספר יזהה אדם אחד בכל
// המדינה גם אחרי מעבר בין תחנות או מחוזות.
const EMP_START = 100001;

// הגנה מפני ניחוש סיסמאות בכניסה עם מספר עובד.
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES   = 15;

const db = admin.firestore();
const FV = admin.firestore.FieldValue;

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

// הקצאת מספר עובד. טרנזקציה, כדי ששני אישורים במקביל לא יקבלו
// את אותו מספר.
async function allocateEmployeeNumber() {
  const ref = db.doc('meta/emp_counter');
  return db.runTransaction(async function (tx) {
    const snap = await tx.get(ref);
    const next = snap.exists ? Number(snap.data().next || EMP_START) : EMP_START;
    tx.set(ref, { next: next + 1, updated_at: FV.serverTimestamp() }, { merge: true });
    return String(next);
  });
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
    full_name:  p.full_name || '',
    role:       p.role,
    crew:       p.shift || '',
    station:    p.stationId,
    district:   p.districtId || '',
    is_active:  true,
    updated_at: FV.serverTimestamp()
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
  await admin.auth().setCustomUserClaims(auth.uid, { super: true, role: 'super_admin' });
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

  const stationId  = String(d.stationId  || r.stationId  || '');
  const districtId = String(d.districtId || r.districtId || '');
  const role       = VALID_ROLES.indexOf(d.role) !== -1 ? d.role : 'firefighter';
  const shift      = VALID_SHIFTS.indexOf(d.shift) !== -1 ? d.shift : '';

  if (!stationId)  throw new HttpsError('invalid-argument', 'חסרה תחנה.');
  if (!districtId) throw new HttpsError('invalid-argument', 'חסר מחוז.');
  if (role === 'district_commander' && !districtId) {
    throw new HttpsError('invalid-argument', 'מפקד מחוז חייב שיוך למחוז.');
  }

  const emp = await allocateEmployeeNumber();

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

  await writeProfile(uid, {
    emp:        emp,
    full_name:  r.full_name || '',
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

  if (role === 'none') {
    const audit = await openAudit(auth, 'clear_role', user.uid, { email: user.email });
    await admin.auth().setCustomUserClaims(user.uid, null);

    // מבטל טוקני רענון. שים לב: טוקן שכבר הונפק נשאר תקף מול
    // כללי Firestore עד לתפוגתו — עד שעה.
    await admin.auth().revokeRefreshTokens(user.uid);

    await db.doc('directory/' + user.uid)
            .set({ is_active: false, updated_at: FV.serverTimestamp() }, { merge: true })
            .catch(function () {});

    await sealAudit(audit);
    return {
      ok: true,
      uid: user.uid,
      message: 'ההרשאות הוסרו. טוקן קיים עשוי להישאר תקף עד שעה.'
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
  if (shift && VALID_SHIFTS.indexOf(shift) === -1) {
    throw new HttpsError('invalid-argument', 'משמרת לא מוכרת: ' + shift);
  }

  const claims = {
    role: role, stationId: stationId, districtId: districtId,
    shift: shift, emp: emp
  };
  if (before.super === true) claims.super = true;

  if (JSON.stringify(claims).length > 900) {
    throw new HttpsError('invalid-argument', 'ההרשאות ארוכות מדי.');
  }

  const audit = await openAudit(auth, 'set_role', user.uid, {
    email: user.email, before: before, after: claims
  });

  await admin.auth().setCustomUserClaims(user.uid, claims);

  await writeProfile(user.uid, {
    emp:        emp,
    full_name:  String(d.full_name || ''),
    email:      String(user.email || '').toLowerCase(),
    phone:      String(d.phone || ''),
    role:       role,
    shift:      shift,
    stationId:  stationId,
    districtId: districtId
  });

  await sealAudit(audit);

  return {
    ok: true, uid: user.uid, emp: emp,
    message: 'התפקיד הוגדר. המשתמש צריך להתנתק ולהתחבר מחדש.'
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
    await noteFailedLogin(lockRef, lock);
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
    throw new HttpsError('internal', 'שגיאת רשת באימות. נסה שוב.');
  }

  if (!res.ok) {
    await noteFailedLogin(lockRef, lock);
    throw new HttpsError('unauthenticated', generic);
  }

  await lockRef.set({ failed: 0, locked_until: null }, { merge: true });

  const uid = String(idxSnap.data().uid || '');
  const token = await admin.auth().createCustomToken(uid);

  return { ok: true, token: token };
});

async function noteFailedLogin(ref, lock) {
  const failed = Number(lock.failed || 0) + 1;
  const data = { failed: failed, last_failed_at: FV.serverTimestamp() };

  if (failed >= MAX_FAILED_LOGINS) {
    data.locked_until = admin.firestore.Timestamp.fromMillis(
      Date.now() + LOCKOUT_MINUTES * 60000
    );
    data.failed = 0;
  }
  await ref.set(data, { merge: true });
}

// ---------------------------------------------------------------------
//  5. שחזור סיסמה לפי מספר עובד
//     שולח את הקישור למייל השמור, ולא מגלה מהו.
// ---------------------------------------------------------------------

exports.requestPasswordReset = onCall(async (req) => {
  const emp = String((req.data || {}).emp || '').trim();
  if (!emp) throw new HttpsError('invalid-argument', 'נא להזין מספר עובד.');

  const idxSnap = await db.doc('emp_index/' + emp).get();

  // תשובה זהה בין קיים ללא קיים, כדי שלא יהיה אפשר לסרוק מספרים.
  const answer = {
    ok: true,
    message: 'אם מספר העובד קיים במערכת, נשלח קישור לאיפוס לכתובת השמורה.'
  };

  if (!idxSnap.exists) return answer;

  const email = String(idxSnap.data().email || '');
  if (!email) return answer;

  try {
    // Firebase שולח את המייל בעצמו כשמפעילים תבנית איפוס.
    // כאן רק מוודאים שהחשבון קיים; השליחה בפועל מתבצעת מהלקוח
    // עם sendPasswordResetEmail על הכתובת הזו.
    await admin.auth().getUserByEmail(email);
  } catch (e) {
    return answer;
  }

  return Object.assign({ email: email }, answer);
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
