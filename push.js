// התראות פוש — הצד של הדפדפן.
//
// שלושה דברים שקורים כאן, וכל אחד מהם יכול להיכשל בנפרד:
//
//   1. מפתח VAPID. נוצר בקונסולה של Firebase ונשמר במסמך
//      הגדרות, לא בקוד — כדי שהחלפת מפתח לא תדרוש פריסה.
//   2. רשות מהמשתמש. הדפדפן שואל, והמשתמש יכול לסרב לתמיד.
//   3. Service Worker. חייב להירשם, אחרת אין למי לשלוח.
//
// כל אחד מהם מחזיר הודעה מדויקת בעברית. "ההתראות לא עובדות"
// היא הודעה שאי אפשר לעשות איתה כלום.

// המפתח הציבורי של הפרויקט. זה החצי הפומבי של זוג מפתחות —
// הוא נשלח ממילא מכל דפדפן שנרשם, ולכן מותר לו לשבת בקוד.
// החצי הפרטי נשאר אצל Firebase ואינו מופיע כאן.
//
// מסמך ההגדרות ב-Firestore גובר עליו, כדי שהחלפת מפתח לא
// תדרוש פריסה מחדש.
export const DEFAULT_VAPID =
  'BGjGPb4X4kZ--G_fCg5ssV9i3yXuijLtRs_wS8oq' +
  '85R6jNxn1O62HmCOHi59tLcjn4qu94DRqlF19HE0HbX_htI';

export const ALERT_TYPES = [
  // הזעקה. מופיעה ברשימה כדי שיהיה ברור שהיא קיימת ושאי אפשר
  // לכבות אותה — לא כדי לתת בחירה.
  { id: 'callout',     he: 'קריאת פתע',                must: true,
    note: 'הזעקה מהמפקד. קופצת על המסך ודורשת תשובה' },

  // חובה — נוגעות ישירות למשתמש ולכן לא ניתנות לכיבוי.
  { id: 'swap_mine',   he: 'החלפה שנוגעת אליי',        must: true,
    note: 'בקשה שהגיעה אליך, אישור או דחייה של בקשה שלך' },
  { id: 'report_mine', he: 'הדוח החודשי שלי',           must: true,
    note: 'אושר, נפתח מחדש, או נדרש תיקון' },
  { id: 'guard_mine',  he: 'אבטחה שאני משובץ אליה',     must: true,
    note: 'שובצת, הוסרת, או תזכורת ערב לפני' },

  // ניתנות לכיבוי.
  { id: 'swap_approve', he: 'החלפות שממתינות לאישורי',  must: false,
    note: 'למפקד משמרת בלבד' },
  { id: 'report_submit', he: 'דוחות שהוגשו לאישורי',    must: false,
    note: 'למפקד משמרת ולרכז כוח אדם' },
  { id: 'guard_open',   he: 'אבטחה חדשה נפתחה',          must: false,
    note: 'פתוחה להרשמה. לכל התחנה, לא רק למשמרת' },
  { id: 'fault_blocking', he: 'רכב יצא מכלל שימוש',       must: false,
    note: 'תקלה משביתה נפתחה או נסגרה. למפקדים' },
  { id: 'redline',      he: 'המשמרת ירדה מתחת לקו האדום', must: false,
    note: 'למפקד משמרת' },
  { id: 'scan',         he: 'ממצאים מהסריקה הלילית',    must: false,
    note: 'פערים בין הדוח שלך לסידור' },
  { id: 'reminder',     he: 'תזכורת דיווח שעות',        must: false,
    note: 'ארבעה ימים לפני סוף החודש' },
  { id: 'broadcast',    he: 'הודעות מהמפקדים',          must: false,
    note: 'הודעות שמפקד או רכז כוח אדם שולחים' }
];

export function isMust(id) {
  const t = ALERT_TYPES.filter(function (x) { return x.id === id; })[0];
  return !!(t && t.must);
}

// ברירת מחדל: הכל דולק. מי שרוצה שקט מכבה בעצמו.
export function defaultPrefs() {
  const out = {};
  ALERT_TYPES.forEach(function (t) { out[t.id] = true; });
  return out;
}

export function pushSupported() {
  return typeof window !== 'undefined' &&
         'serviceWorker' in navigator &&
         'Notification' in window &&
         'PushManager' in window;
}

export function permissionState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;   // 'granted' | 'denied' | 'default'
}

// מחזיר { ok, token, why }.
//
// why הוא טקסט בעברית שאפשר להציג כמו שהוא. אין כאן "שגיאה
// כללית" — לכל כישלון יש סיבה שאפשר לפעול לפיה.
export async function enablePush(messagingMod, messaging, vapidKey) {
  if (!pushSupported()) {
    return { ok: false, why: 'הדפדפן הזה לא תומך בהתראות פוש. ' +
      'באייפון צריך להוסיף את האתר למסך הבית ולפתוח אותו משם.' };
  }
  if (!vapidKey) {
    return { ok: false, why: 'חסר מפתח התראות. מנהל המערכת צריך ' +
      'ליצור אותו בקונסולה של Firebase ולהזין אותו כאן.' };
  }

  let perm = Notification.permission;
  if (perm === 'default') {
    try { perm = await Notification.requestPermission(); }
    catch (e) { return { ok: false, why: 'בקשת הרשות נכשלה.' }; }
  }
  if (perm === 'denied') {
    return { ok: false, why: 'חסמת התראות מהאתר הזה. צריך לפתוח ' +
      'את הגדרות האתר בדפדפן ולאפשר התראות, ואז לנסות שוב.' };
  }
  if (perm !== 'granted') {
    return { ok: false, why: 'לא ניתנה רשות להתראות.' };
  }

  let reg;
  try {
    reg = await navigator.serviceWorker.register('./firebase-messaging-sw.js');
    await navigator.serviceWorker.ready;
  } catch (e) {
    return { ok: false, why: 'רישום ה-Service Worker נכשל. ' +
      '(' + (e.message || e) + ')' };
  }

  try {
    const token = await messagingMod.getToken(messaging, {
      vapidKey: vapidKey, serviceWorkerRegistration: reg });
    if (!token) return { ok: false, why: 'לא התקבל מזהה מכשיר.' };
    return { ok: true, token: token };
  } catch (e) {
    return { ok: false, why: 'קבלת מזהה המכשיר נכשלה. ' +
      'ודא ש-Cloud Messaging מופעל בפרויקט. (' + (e.message || e) + ')' };
  }
}

// שם קריא למכשיר, כדי שמי שנכנס מכמה מכשירים יזהה אותם ברשימה.
export function deviceLabel() {
  const ua = String(navigator.userAgent || '');
  const os = /Android/i.test(ua) ? 'אנדרואיד'
           : /iPhone|iPad|iPod/i.test(ua) ? 'אייפון'
           : /Windows/i.test(ua) ? 'ווינדוס'
           : /Mac/i.test(ua) ? 'מק' : 'מכשיר';
  const br = /Edg\//i.test(ua) ? 'Edge'
           : /Chrome\//i.test(ua) ? 'Chrome'
           : /Firefox\//i.test(ua) ? 'Firefox'
           : /Safari\//i.test(ua) ? 'Safari' : '';
  return os + (br ? ' · ' + br : '');
}
