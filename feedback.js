/* ======================================================================
 * חוות דעת — הלוגיקה של המסך, בלי DOM ובלי Firebase, כדי שתיבדק לבד.
 *
 * מזהה אקראי נשמר בזיכרון עם גוף הבקשה עד לתשובת הצלחה תקינה.
 * ניסיון חוזר אינו תלוי ביום; שינוי ההסכמה יוצר כוונה חדשה.
 * השרת מאמת את כל התוכן ומוסיף זהות מתוך החברות החיה בתחנה.
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

function feedbackError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizedIntent(input, context) {
  if (validateLocal(input).length) throw feedbackError('feedback-invalid-input');
  const ctx = context || {};
  const text = String(input.text || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (text.length < TEXT_MIN) throw feedbackError('feedback-invalid-input');
  const rating = input.rating === null || input.rating === undefined || input.rating === ''
    ? null : Number(input.rating);
  const screen = ctx.screen || 'feedback.html';
  const version = ctx.version || '0';
  if (typeof screen !== 'string' || !/^[a-z0-9-]{1,48}\.html$/.test(screen)
      || typeof version !== 'string' || !/^[A-Za-z0-9.\-]{1,24}$/.test(version)
      || (input.allow_contact !== undefined && typeof input.allow_contact !== 'boolean')) {
    throw feedbackError('feedback-invalid-input');
  }
  return {
    screen, version, category: input.category, rating, text,
    allow_contact: input.allow_contact === true
  };
}

export async function buildSubmission(input, context) {
  const intent = normalizedIntent(input, context);
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.getRandomValues !== 'function') {
    throw feedbackError('feedback-secure-random-required');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const id = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return Object.freeze(Object.assign({ request_id: 'fb_' + id }, intent));
}

export function validSubmissionResult(result) {
  return !!result && typeof result === 'object' && !Array.isArray(result)
    && typeof result.id === 'string' && /^f_[a-f0-9]{40}$/.test(result.id)
    && typeof result.duplicate === 'boolean';
}

export function createFeedbackSubmissionSession() {
  // No persistent browser storage of free-text feedback. Do not evict an
  // unresolved request: eviction could turn its retry into a duplicate write.
  const pending = new Map();
  return Object.freeze({
    async prepare(input, context) {
      const key = JSON.stringify(normalizedIntent(input, context));
      if (pending.has(key)) return pending.get(key);
      if (pending.size >= 20) throw feedbackError('feedback-pending-limit');
      const promise = buildSubmission(input, context);
      pending.set(key, promise);
      try {
        return await promise;
      } catch (error) {
        if (pending.get(key) === promise) pending.delete(key);
        throw error;
      }
    },
    complete(payload, result) {
      if (!validSubmissionResult(result)) throw feedbackError('feedback-response-invalid');
      const key = JSON.stringify(normalizedIntent(payload, payload));
      pending.delete(key);
      return result;
    }
  });
}

export function errorText(error) {
  const code = error && error.code;
  if (code === 'feedback-response-invalid') return 'לא התקבל אישור שמירה תקין. הטקסט נשמר כאן; אפשר לנסות שוב בבטחה.';
  if (code === 'feedback-secure-random-required') return 'לא ניתן ליצור מזהה בקשה בטוח בדפדפן הזה. הטקסט לא נשלח.';
  if (code === 'feedback-pending-limit') return 'יש יותר מדי בקשות שטרם אושרו. נסה שוב אחת מהן לפני שליחת נוסח חדש.';
  if (code === 'functions/permission-denied' || code === 'functions/unauthenticated') return 'אין הרשאה לשליחה כרגע. בדוק את החיבור ואת השיוך לתחנה.';
  if (code === 'functions/resource-exhausted') return 'הגעת למכסת השליחות. הטקסט נשמר כאן.';
  if (code === 'functions/already-exists') return 'הבקשה אינה תואמת לניסיון הקודם. הטקסט נשמר כאן.';
  return 'השליחה לא אושרה. הטקסט נשמר כאן; אפשר לנסות שוב בבטחה.';
}
