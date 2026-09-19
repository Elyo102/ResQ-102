/* ======================================================================
 *  eol-guard · בדיקת תווים שעמידה לסוף-שורה של Windows
 *
 *  הבעיה שהיא פותרת, במדויק: במחשב של אלדד מוגדר `core.autocrlf=true`,
 *  ולכן checkout רגיל מוציא את הקבצים לדיסק עם `\r\n`. בדיקה שדוחה כל
 *  `\r` נכשלת שם על עצם ה-checkout — לא על פגם בקוד. זה הופך את
 *  `npm run static` ואת ה-predeploy ללא ניתנים להרצה אחרי cherry-pick
 *  נקי, וזו תקלה בבדיקה, לא במוצר.
 *
 *  מה שאסור לעשות כתגובה: פשוט למחוק את הבדיקה. היא נועדה לתפוס בתים
 *  זרים בקובץ שנמסר — תווי בקרה, CR בודד בסגנון Mac היסטורי, שאריות
 *  של עריכה בינארית. אלה עדיין פגמים אמיתיים.
 *
 *  לכן ההפרדה כאן: `\r\n` הוא סוף-שורה לגיטימי של Windows ומנורמל
 *  לפני הבדיקה; `\r` שאינו חלק מ-CRLF, וכל תו בקרה אחר, עדיין נדחים.
 * ====================================================================== */

/** מנרמל CRLF ל-LF בלבד. אינו נוגע ב-CR בודד — הוא נתון לבדיקה. */
export function normalizeEol(text) {
  return String(text).replace(/\r\n/g, '\n');
}

/* תווי בקרה אסורים: הכול מתחת ל-0x20 חוץ מ-TAB (09) ו-LF (0A), ועוד DEL.
 * CR (0D) אינו ברשימה כי הוא נבדק בנפרד, אחרי הנרמול. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * מחזיר רשימת בעיות (ריקה = נקי). הפרדה בין הסוגים כדי שהודעת הכשל
 * תגיד מה בדיוק נמצא, במקום "יש תו רע איפשהו".
 */
export function eolProblems(text) {
  const normalized = normalizeEol(text);
  const problems = [];
  if (/\r/.test(normalized)) problems.push('lone-cr');
  if (CONTROL.test(normalized)) problems.push('control-char');
  return problems;
}

/** נקי = אין CR בודד ואין תו בקרה. CRLF עצמו מותר. */
export function isCleanText(text) {
  return eolProblems(text).length === 0;
}

/** תיאור קצר לשורת כשל. */
export function describeEol(name, text) {
  const problems = eolProblems(text);
  return problems.length ? name + ': ' + problems.join(', ') : name + ': clean';
}
