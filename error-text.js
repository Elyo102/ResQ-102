/* ======================================================================
 *  error-text — מילון שגיאות אחד, בעברית, למשתמש.
 *
 *  **למה זה קיים.** לפני הקובץ הזה היו עשר מפות מקומיות, שכל אחת
 *  מכסה תת-קבוצה אחרת של אותם קודים, ואותה רשימת שמונה קודים הוגדרה
 *  ארבע פעמים בנפרד. מה שלא היה במפה — נפל למסלול שמדפיס את הקוד
 *  עצמו. כבאי בשעה שתיים בלילה ראה „פעולה נכשלה: FirebaseError:
 *  Firebase: Error (functions/unavailable)." והסיק שהמערכת שבורה.
 *
 *  **מה הקובץ הזה כן.** תרגום. הוא אומר מה קרה ומה לעשות, בעברית
 *  פשוטה. הוא לעולם אינו מחזיר קוד, ולעולם אינו מחזיר מחרוזת ריקה.
 *
 *  **מה הוא איננו.** הוא אינו מחליט אם הפעולה נשמרה. זו שאלה של
 *  ההקשר, לא של הקוד: אותו `unavailable` על קריאה הוא „לא נטען",
 *  ועל כתיבה הוא „ייתכן שנשמר". לכן המילון אומר רק את מה שנכון תמיד,
 *  והקורא מוסיף את המשפט שלו כשיש לו מה להוסיף.
 *
 *  **הפרטים הטכניים לא נעלמים.** `logError` כותב אותם ל-console,
 *  שם הם שייכים. לא במסך.
 * ====================================================================== */

/* קודים שמשמעותם „השרת ענה, והתשובה שלילית וסופית". מול אלה אין טעם
 * בניסיון חוזר של אותה בקשה: המצב ידוע. כל השאר — לא ידוע, ושם
 * ניסיון חוזר של **אותה בקשה בדיוק** הוא הדבר הנכון.
 *
 * הרשימה הזו הייתה מוגדרת בארבעה קבצים בנפרד. עכשיו היא כאן. */
export const DEFINITE_CODES = Object.freeze(['invalid-argument', 'already-exists', 'aborted',
  'not-found', 'failed-precondition', 'resource-exhausted', 'permission-denied', 'unauthenticated']);

const TEXT = Object.freeze({
  offline: 'אין חיבור לרשת. הפעולה לא נשלחה ואינה ממתינה ברקע. התחברו לרשת ונסו שוב.',
  unavailable: 'השרת אינו זמין כרגע. נסו שוב בעוד רגע.',
  'deadline-exceeded': 'הפעולה לקחה יותר מדי זמן ונעצרה. בדקו את המצב לפני ניסיון נוסף.',
  'permission-denied': 'אין לכם הרשאה לפעולה הזו.',
  unauthenticated: 'פג תוקף ההתחברות. התחברו מחדש ונסו שוב.',
  'resource-exhausted': 'בוצעו פעולות רבות בזמן קצר. המתינו מעט ונסו שוב.',
  aborted: 'הנתונים השתנו בינתיים. רעננו, בדקו את המצב העדכני ואז שמרו שוב.',
  'failed-precondition': 'לא ניתן לבצע את הפעולה במצב הנוכחי. רעננו ובדקו.',
  'invalid-argument': 'חלק מהפרטים אינם תקינים. בדקו את מה שהוזן ונסו שוב.',
  'already-exists': 'הפעולה הזו כבר בוצעה. רעננו ובדקו לפני פעולה נוספת.',
  'not-found': 'הפריט אינו קיים או אינו זמין לכם. רעננו את הרשימה.',
  cancelled: 'הפעולה הופסקה לפני שהסתיימה.',
  'unsupported-browser': 'הדפדפן הזה אינו תומך בפעולה. באייפון יש להוסיף את האתר למסך הבית ולפתוח אותו משם.',
  'push-permission-denied': 'התראות חסומות לאתר הזה בדפדפן. יש לאפשר אותן בהגדרות האתר ואז לנסות שוב.',
  'identity-changed': 'המשתמש או ההרשאות השתנו. רעננו ובדקו את המצב לפני פעולה נוספת.',
  unknown: 'הפעולה נכשלה. נסו שוב; אם זה חוזר, דווחו לאחראי המערכת.'
});

/* ⭐ נרמול. Firebase מגיע בשלוש צורות לפחות לאותה תקלה:
 *   error.code === 'functions/unavailable'
 *   error.code === 'unavailable'
 *   error.message === 'Firebase: Error (functions/unavailable).'
 * ובנפילת רשת גם `auth/network-request-failed` ו-`Failed to fetch`.
 * כולן מגיעות לאותה מילה אחת. */
export function errorCode(error) {
  if (!error) return 'unknown';
  const message = String((error && error.message) || error || '');
  const raw = String((error && error.code) || '').toLowerCase().trim();
  const bare = raw.replace(/^(functions|firestore|storage|auth)\//, '');
  if (bare === 'network-request-failed') return 'offline';
  if (Object.hasOwn(TEXT, bare)) return bare;
  /* קוד שלא הוכר — מחפשים אותו בתוך הטקסט, כי זו הצורה שה-SDK
   * מחזיר כשאין `code` נפרד. */
  const embedded = /\((?:functions|firestore|storage|auth)\/([a-z-]+)\)/i.exec(message);
  if (embedded && Object.hasOwn(TEXT, embedded[1].toLowerCase())) return embedded[1].toLowerCase();
  if (/network\s*error|failed to fetch|network-request-failed|networkerror|err_internet/i.test(message)) return 'offline';
  // Firestore מדווח על כשל טרנזקציה בניסוח חופשי; המשמעות היא aborted.
  if (/transaction failed|too much contention/i.test(message)) return 'aborted';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  return 'unknown';
}

/** האם השרת ענה תשובה שלילית **סופית**, שאין טעם לחזור עליה. */
export const definite = error => DEFINITE_CODES.includes(errorCode(error));

/**
 * משפט בעברית למשתמש. לעולם לא קוד, לעולם לא ריק.
 * `fallback` מחליף רק את ברירת המחדל של „לא ידוע" — קוד מוכר תמיד
 * מקבל את הניסוח שלו, כדי ששני מסכים לא יאמרו דברים שונים על אותה
 * תקלה בדיוק.
 */
export function errorText(error, fallback) {
  const code = errorCode(error);
  if (code === 'unknown' && typeof fallback === 'string' && fallback.trim()) return fallback.trim();
  return TEXT[code];
}

/**
 * הפרטים הטכניים — ל-console בלבד.
 * לא מזהים, לא תוכן פנייה, לא שמות: רק מה שנדרש כדי לאתר תקלה.
 */
export function logError(where, error) {
  const code = String((error && error.code) || '') || errorCode(error);
  const message = String((error && error.message) || '');
  try { console.error('[ResQ] ' + String(where || 'error') + ' · ' + code + (message ? ' · ' + message : '')); }
  catch (ignore) { /* console חסום בחלק מהסביבות; זו לא סיבה להפיל פעולה */ }
}
