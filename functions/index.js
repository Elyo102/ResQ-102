// =====================================================================
//  תחנה 102 — Cloud Functions
//  שכבת היסוד: ניהול תפקידים דרך Custom Claims
//
//  למה הקובץ הזה קיים
//  ------------------
//  התפקיד של המשתמש (כבאי / קצין / רכזת משאבי אנוש) נשמר בתוך
//  טוקן ההזדהות שלו, ולא כשדה במסמך ב-Firestore.
//
//  היתרון: כללי האבטחה קוראים את התפקיד ישירות מהטוקן, בלי אף
//  קריאת מסמך. לפני השינוי הזה כל פעולה עלתה 4-5 קריאות מסמך
//  שגוגל מחייבת עליהן.
//
//  המחיר: רק קוד שרת יכול לכתוב לטוקן. זה הקובץ הזה.
//
//  כלל ברזל: הטוקן הוא מקור האמת להרשאות.
//  המסמך ב-Firestore הוא לתצוגה בלבד.
// =====================================================================

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();

// eur3 הוא מיקום מסד הנתונים. הפונקציות יושבות באזור הקרוב ביותר,
// כדי שהמרחק בין הפונקציה למסד לא יוסיף זמן תגובה מיותר.
setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });

// ---------------------------------------------------------------------
//  קבועים
// ---------------------------------------------------------------------

// מנהל-העל של המערכת. חייב להיות זהה לערך בקובץ firestore.rules.
const SUPER_ADMIN_EMAIL = 'fire102.shits@gmail.com';

const VALID_ROLES  = ['firefighter', 'commander', 'hr_coordinator'];
const VALID_SHIFTS = ['A', 'B', 'C'];

const db = admin.firestore();

// ---------------------------------------------------------------------
//  עזרים
// ---------------------------------------------------------------------

function requireVerifiedAuth(req) {
  if (!req.auth) {
    throw new HttpsError('unauthenticated', 'צריך להיות מחובר.');
  }
  if (req.auth.token.email_verified !== true) {
    throw new HttpsError('permission-denied', 'צריך לאמת את כתובת המייל קודם.');
  }
  return req.auth;
}

function isSuperAdmin(auth) {
  if (auth.token.super === true) return true;
  return String(auth.token.email || '').toLowerCase() === SUPER_ADMIN_EMAIL;
}

function requireSuperAdmin(req) {
  const auth = requireVerifiedAuth(req);
  if (!isSuperAdmin(auth)) {
    throw new HttpsError('permission-denied', 'הפעולה הזו מותרת למנהל המערכת בלבד.');
  }
  return auth;
}

// כל שינוי הרשאה נרשם. מערכת שמחזיקה נתוני שכר ומחלה חייבת
// להיות מסוגלת לענות על "מי נתן למי גישה, ומתי".
async function writeAudit(actorAuth, action, target, details) {
  try {
    await db.collection('admin_audit').add({
      action:       action,
      actor_uid:    actorAuth.uid,
      actor_email:  String(actorAuth.token.email || '').toLowerCase(),
      target_uid:   target || null,
      details:      details || {},
      at:           admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    // כישלון ברישום לא מפיל את הפעולה עצמה, אבל כן נרשם ללוג.
    console.error('audit write failed', e);
  }
}

async function resolveUser(data) {
  if (data.uid) {
    return admin.auth().getUser(String(data.uid));
  }
  if (data.email) {
    return admin.auth().getUserByEmail(String(data.email).toLowerCase());
  }
  throw new HttpsError('invalid-argument', 'צריך למסור uid או email.');
}

// ---------------------------------------------------------------------
//  1. אתחול מנהל-על
//     רץ פעם אחת בהתחלה, כדי שלמנהל-העל יהיה claim ולא רק מייל.
//     אין כאן פרצה: הפונקציה בודקת שהקורא הוא בדיוק אותו מייל
//     שמוגדר קשיח למעלה, ושהמייל שלו מאומת.
// ---------------------------------------------------------------------

exports.bootstrapSuperAdmin = onCall(async (req) => {
  const auth = requireVerifiedAuth(req);
  const email = String(auth.token.email || '').toLowerCase();

  if (email !== SUPER_ADMIN_EMAIL) {
    throw new HttpsError('permission-denied', 'החשבון הזה אינו מנהל המערכת.');
  }

  await admin.auth().setCustomUserClaims(auth.uid, {
    super: true,
    role:  'super_admin'
  });

  await writeAudit(auth, 'bootstrap_super_admin', auth.uid, { email: email });

  return {
    ok: true,
    message: 'הוגדרת כמנהל מערכת. התנתק והתחבר מחדש כדי שהשינוי ייכנס לתוקף.'
  };
});

// ---------------------------------------------------------------------
//  2. הענקת תפקיד
//     מותר למנהל-על בלבד (החלטה של אלדד, 22.8.2026).
//     קל להרחיב בעתיד לרכזת משאבי אנוש — שינוי של שורה אחת.
// ---------------------------------------------------------------------

exports.setUserRole = onCall(async (req) => {
  const auth = requireSuperAdmin(req);
  const d = req.data || {};

  const user = await resolveUser(d);

  // role: 'none' מסיר את כל ההרשאות
  const role = String(d.role || '');
  if (role !== 'none' && VALID_ROLES.indexOf(role) === -1) {
    throw new HttpsError('invalid-argument',
      'תפקיד לא מוכר: ' + role + '. מותר: ' + VALID_ROLES.join(', ') + ' או none.');
  }

  if (role === 'none') {
    await admin.auth().setCustomUserClaims(user.uid, null);
    await writeAudit(auth, 'clear_role', user.uid, { email: user.email });
    return { ok: true, uid: user.uid, message: 'ההרשאות הוסרו.' };
  }

  const stationId = String(d.stationId || '');
  if (!stationId) {
    throw new HttpsError('invalid-argument', 'חסר מזהה תחנה.');
  }

  const shift = String(d.shift || '');
  if (shift && VALID_SHIFTS.indexOf(shift) === -1) {
    throw new HttpsError('invalid-argument',
      'משמרת לא מוכרת: ' + shift + '. מותר: ' + VALID_SHIFTS.join(', '));
  }

  const code = String(d.code || '');
  if (!code) {
    throw new HttpsError('invalid-argument', 'חסר קוד אישי.');
  }

  const before = user.customClaims || {};

  const claims = {
    role:      role,
    stationId: stationId,
    shift:     shift,
    code:      code
  };
  // מנהל-על שמקבל גם תפקיד בתחנה שומר על מעמדו
  if (before.super === true) claims.super = true;

  await admin.auth().setCustomUserClaims(user.uid, claims);

  // שיקוף למסמך התצוגה. לא מקור האמת — רק כדי שהממשק יוכל
  // להציג שם ותפקיד בלי לפענח טוקנים.
  await db.doc('stations/' + stationId + '/users/' + user.uid).set({
    email:         String(user.email || '').toLowerCase(),
    role:          role,
    crew:          shift,
    personal_code: code,
    is_active:     true,
    updated_at:    admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await writeAudit(auth, 'set_role', user.uid, {
    email:  user.email,
    before: before,
    after:  claims
  });

  return {
    ok: true,
    uid: user.uid,
    message: 'התפקיד הוגדר. המשתמש צריך להתנתק ולהתחבר מחדש, ' +
             'או שהאפליקציה תקרא ל-getIdToken(true).'
  };
});

// ---------------------------------------------------------------------
//  3. אישור בקשת הרשמה
//     קורא את הרשומה מרשימת התחנה, מעניק תפקיד, ומוחק את הבקשה.
//     פעולה אחת במקום שלוש — ובלי אפשרות שהמשתמש ישפיע על התוצאה.
// ---------------------------------------------------------------------

exports.approveRegistration = onCall(async (req) => {
  const auth = requireSuperAdmin(req);
  const d = req.data || {};

  const uid       = String(d.uid || '');
  const stationId = String(d.stationId || '');
  const code      = String(d.code || '');

  if (!uid || !stationId || !code) {
    throw new HttpsError('invalid-argument', 'חסר uid, מזהה תחנה או קוד אישי.');
  }

  const user = await admin.auth().getUser(uid);

  const pendingRef  = db.doc('stations/' + stationId + '/pending_users/' + code);
  const pendingSnap = await pendingRef.get();
  if (!pendingSnap.exists) {
    throw new HttpsError('not-found', 'הקוד האישי ' + code + ' לא נמצא ברשימת התחנה.');
  }
  const p = pendingSnap.data();

  const role  = VALID_ROLES.indexOf(p.role) !== -1 ? p.role : 'firefighter';
  const shift = VALID_SHIFTS.indexOf(p.crew) !== -1 ? p.crew : '';

  await admin.auth().setCustomUserClaims(uid, {
    role:      role,
    stationId: stationId,
    shift:     shift,
    code:      code
  });

  await db.doc('stations/' + stationId + '/users/' + uid).set({
    personal_code: code,
    full_name:     p.full_name || '',
    email:         String(user.email || '').toLowerCase(),
    phone:         p.phone || '',
    crew:          shift,
    role:          role,
    position:      p.position || '',
    is_active:     true,
    created_at:    admin.firestore.FieldValue.serverTimestamp(),
    updated_at:    admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await pendingRef.delete();
  await db.doc('stations/' + stationId + '/registration_requests/' + uid)
          .delete()
          .catch(function () {});

  await writeAudit(auth, 'approve_registration', uid, {
    email: user.email, stationId: stationId, code: code, role: role, shift: shift
  });

  return { ok: true, uid: uid, role: role, message: 'הבקשה אושרה.' };
});

// ---------------------------------------------------------------------
//  4. רשימת משתמשים והרשאותיהם — למסך הניהול
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
//  5. מי אני — לאבחון
//     מחזיר למשתמש את ההרשאות שהשרת רואה עליו.
//     שימושי כשמשהו לא עובד ולא ברור אם הבעיה בטוקן או בכללים.
// ---------------------------------------------------------------------

exports.whoAmI = onCall(async (req) => {
  if (!req.auth) return { signedIn: false };

  const user = await admin.auth().getUser(req.auth.uid);

  return {
    signedIn:       true,
    uid:            req.auth.uid,
    email:          req.auth.token.email || '',
    email_verified: req.auth.token.email_verified === true,
    claims_in_token: {
      role:      req.auth.token.role      || null,
      stationId: req.auth.token.stationId || null,
      shift:     req.auth.token.shift     || null,
      code:      req.auth.token.code      || null,
      super:     req.auth.token.super     || false
    },
    claims_on_server: user.customClaims || {},
    note: 'אם שתי הרשימות שונות — הטוקן ישן. צריך getIdToken(true).'
  };
});
