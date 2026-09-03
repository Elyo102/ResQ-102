/* ======================================================================
 * חוות דעת — הלוגיקה של המסך, בלי DOM ובלי Firebase, כדי שתיבדק לבד.
 *
 * מה שנשלח לשרת: request_id יציב (נגזר מהתוכן — לחיצה כפולה אחרי
 * רשת שנפלה היא אותה בקשה), המסך שממנו הגיע המשתמש, גרסה, קטגוריה,
 * דירוג, טקסט, ו„מותר לפנות אליי". השרת מוסיף את הזהות מהטוקן.
 * ====================================================================== */

export const CATEGORIES = Object.freeze([
  { id: 'works',   label: 'עובד טוב',      hint: 'משהו שעוזר לך — כדי שלא נשבור אותו' },
  { id: 'problem', label: 'לא עובד / מבלבל', hint: 'מה ניסית לעשות ומה קרה' },
  { id: 'idea',    label: 'רעיון',         hint: 'מה היה חוסך לך זמן' },
  { id: 'other',   label: 'אחר',           hint: '' }
]);

export const TEXT_MIN = 3;
export const TEXT_MAX = 1000;

/* מסך המקור מגיע ב-`?from=swaps.html`. כל דבר אחר → המסך הזה עצמו. */
export function sourceScreen(search) {
  const params = new URLSearchParams(String(search || ''));
  const from = String(params.get('from') || '');
  return /^[a-z0-9-]{1,48}\.html$/.test(from) ? from : 'feedback.html';
}

export function validateLocal(input) {
  const errors = [];
  const category = String(input && input.category || '');
  if (!CATEGORIES.some((c) => c.id === category)) errors.push('בחר סוג חוות דעת.');
  const text = String(input && input.text || '').trim();
  if (text.length < TEXT_MIN) errors.push('כתוב לפחות כמה מילים.');
  if (text.length > TEXT_MAX) errors.push('הטקסט ארוך מדי (עד ' + TEXT_MAX + ' תווים).');
  if (input && input.rating !== null && input.rating !== undefined && input.rating !== '') {
    const r = Number(input.rating);
    if (!(r >= 1 && r <= 5 && Number.isInteger(r))) errors.push('הדירוג הוא 1 עד 5.');
  }
  return errors;
}

async function sha256Hex(text) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle && typeof TextEncoder === 'function') {
    const bytes = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)));
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // הקשר לא מאובטח: גזירה יציבה בלי hash, בתוך חוזה המזהה.
  return text.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
}

/* ⭐ מזהה בקשה יציב: אותו טקסט + קטגוריה + דירוג + מסך + יום → אותו
 * מזהה. השרת מזהה חזרה ומחזיר duplicate בלי לכתוב שוב. */
export async function buildSubmission(input, context) {
  const ctx = context || {};
  const text = String(input.text || '').trim();
  const rating = input.rating === null || input.rating === undefined || input.rating === ''
    ? null : Number(input.rating);
  const screen = ctx.screen || 'feedback.html';
  const day = String(ctx.day || new Date().toISOString().slice(0, 10));
  const seed = ['feedback', screen, input.category, rating === null ? '' : rating, text, day].join('|');
  const requestId = 'fb_' + (await sha256Hex(seed)).slice(0, 40);
  const out = {
    request_id: requestId,
    screen,
    version: String(ctx.version || '0').slice(0, 24),
    category: input.category,
    text,
    allow_contact: input.allow_contact === true
  };
  if (rating !== null) out.rating = rating;
  return out;
}

export function errorText(error) {
  const message = String((error && error.message) || 'השליחה נכשלה.');
  return message.replace(/^Firebase:\s*/i, '').replace(/^\w+\/[^:]+:\s*/i, '');
}
