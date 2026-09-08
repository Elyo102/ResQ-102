'use strict';

/* ====================================================================
 *  hr-attachments-storage · המתאם היחיד שנוגע ב-SDK של האחסון.
 *
 *  **הוא דק בכוונה.** כל ההכרעות — מה מאמצים, מה מוחקים, מה מותר
 *  לקרוא — יושבות ב-`hr-attachments.js` הטהור. כאן יש תרגום בלבד:
 *  שלוש פעולות, וגבול טעויות אחד.
 *
 *  **אין כאן:** `getDownloadURL`, signed URL, resumable upload URL,
 *  `firebaseStorageDownloadTokens`, ושום דבר אחר שמייצר הרשאה
 *  **נשאית**. מי שמחזיק במחרוזת כזאת נכנס בלי זהות ובלי תחנה, וזה
 *  סותר „שיוך תחנה מהשרת בלבד".
 *
 *  **הדלי מוזרק ולעולם אינו מגיע מהקורא.** הוא נקבע בשרת בזמן
 *  החיווט; שם דלי שמגיע מבחוץ הוא פרימיטיב גישה.
 *
 *  ------------------------------------------------------------------
 *  שני התיקונים של seq542 §2
 *  ------------------------------------------------------------------
 *  **1 · הדור שנצפה ננעץ לפני קריאת הבייטים.** הגרסה הקודמת קראה
 *  `getMetadata()` ואז `download()` על אותה נקודת נתיב. בין שתי
 *  הקריאות אפשר להחליף את האובייקט — והתוצאה הייתה **המטא-דאטה של
 *  דור אחד עם הבייטים של דור אחר**, כלומר בדיוק הראיה שהמודול הטהור
 *  סומך עליה, מזויפת. עכשיו הבייטים נקראים מידית `bucket.file(path,
 *  {generation: <שנצפה>})`. אם הוחלף — `404`, ואין הגשה.
 *
 *  **2 · התקרה נאכפת על הזרם, לא אחרי האגירה.** `download()` אוגר
 *  את כל האובייקט בזיכרון ורק אז אפשר למדוד. `size` שבמטא-דאטה הוא
 *  **טענה**, ולא מדידה — הוא סונן כאופטימיזציה, אבל האכיפה היא
 *  מנייה חיה על `createReadStream` שנקטע ברגע החריגה.
 *
 *  ⚠ **הקובץ הזה לא הורץ מול אחסון אמיתי ולא מול אמולטור.** ה-jar
 *  של אמולטור ה-Storage אינו במטמון המקומי, ומשיכתו דורשת רשת.
 *  `node --check` ובדיקות מול דלי מזויף בלבד. אינני מציג בדיקה
 *  שלא ראיתי עוברת מול הדבר האמיתי.
 * ==================================================================== */

const MAX_READ_BYTES = 2 * 1024 * 1024;

/** 412 מ-`ifGenerationMatch` — הדור אינו הדור שביקשנו. */
const PRECONDITION = 412;
const NOT_FOUND = 404;

const statusOf = e => {
  if (!e) return 0;
  const raw = typeof e.code === 'number' ? e.code : Number(e.code);
  if (Number.isInteger(raw)) return raw;
  return Number.isInteger(e.status) ? e.status : 0;
};
const isNotFound = e => statusOf(e) === NOT_FOUND;
const isPrecondition = e => statusOf(e) === PRECONDITION;
const genOf = meta => (meta && meta.generation != null ? String(meta.generation) : null);

/**
 * אגירה **תחת תקרה חיה**. נספר בזמן הזרימה ונקטע ברגע החריגה, כדי
 * שאובייקט ענק לא ייכנס לזיכרון רק כדי שנגלה שהוא ענק.
 */
function collectCapped(stream, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      stream.removeAllListeners();
      try { stream.destroy(); } catch (_) { /* הזרם כבר סגור */ }
      if (err) reject(err); else resolve(value);
    };
    stream.on('data', chunk => {
      total += chunk.length;
      if (total > cap) { finish(null, { oversize: true }); return; }
      chunks.push(chunk);
    });
    stream.on('error', e => finish(e));
    stream.on('end', () => finish(null, { bytes: Buffer.concat(chunks, total) }));
  });
}

/**
 * @param {object} deps
 * @param {object} deps.bucket  אובייקט הדלי של Admin SDK, **מוזרק**.
 */
function createHrAttachmentsStorage({ bucket }) {
  if (!bucket || typeof bucket.file !== 'function') throw new TypeError('bucket is required');

  const handle = (path, generation) =>
    (generation == null ? bucket.file(path) : bucket.file(path, { generation: String(generation) }));

  /**
   * שמירה **ליצירה בלבד**. `ifGenerationMatch: 0` נכשל אם האובייקט
   * קיים — וזו התוצאה הרצויה: דריסה אינה קיימת בחוזה הזה. הקורא
   * הטהור מטפל ב-412 דרך מסלול האימוץ.
   *
   * **הדור נלקח מתשובת ההעלאה עצמה**, לא מקריאת מטא-דאטה נוספת:
   * קריאה שנייה יכולה כבר לצפות בדור של כותב אחר. אם התשובה לא
   * נשאה דור — מוחזר `null`, והמודול הטהור פותר את זה במסלול
   * האימוץ, שבו הזהות נקבעת מהתוכן.
   */
  async function save({ path, bytes, contentType, cacheControl, contentDisposition, metadata }) {
    const file = bucket.file(path);
    try {
      await file.save(bytes, {
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          contentType,
          cacheControl: cacheControl || 'private, no-store',
          contentDisposition: contentDisposition || 'attachment',
          /* מטא-דאטה מותאמת — **בלי** `firebaseStorageDownloadTokens`. */
          metadata: Object.assign({}, metadata)
        }
      });
    } catch (e) {
      if (isPrecondition(e)) {
        const conflict = new Error('object-exists');
        conflict.code = 'precondition-failed';
        throw conflict;
      }
      throw e;
    }
    return { generation: genOf(file.metadata) };
  }

  /**
   * קריאה של **דור מסוים** כשנמסר; וכשלא נמסר — הדור שנצפה במטא-דאטה
   * ננעץ מיד לקריאת הבייטים. אובייקט שהוחלף אינו מוגש: הדור הוא חלק
   * מהזהות, לא עיטור.
   *
   * מחזיר `null` כשאין אובייקט — ו**היעדר אינו הוכחת אי-קיום
   * עתידי**; ההכרעה הזאת שייכת לקורא הטהור.
   */
  async function read({ path, generation, maxBytes }) {
    const cap = Number.isSafeInteger(maxBytes) && maxBytes > 0
      ? Math.min(maxBytes, MAX_READ_BYTES) : MAX_READ_BYTES;

    let meta;
    try {
      const [value] = await handle(path, generation).getMetadata();
      meta = value;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }

    /* **הנעיצה.** מכאן והלאה כל קריאה היא על הדור הזה בלבד — גם
     * כשהקורא לא ביקש דור. בלי זה המטא-דאטה והבייטים יכולים לבוא
     * משני אובייקטים שונים. */
    const pinned = genOf(meta);
    if (pinned == null) return null;
    const out = { metadata: (meta && meta.metadata) || {}, generation: pinned };

    /* `size` הוא טענה של הצד השני; שימושי לחסוך העברה, ולא ראיה. */
    const declared = meta && meta.size != null ? Number(meta.size) : NaN;
    if (Number.isFinite(declared) && declared > cap) {
      return { ...out, bytes: null, oversize: true };
    }

    let result;
    try {
      result = await collectCapped(handle(path, pinned).createReadStream(), cap);
    } catch (e) {
      if (isNotFound(e) || isPrecondition(e)) return null;
      throw e;
    }
    if (result.oversize) return { ...out, bytes: null, oversize: true };
    return { ...out, bytes: result.bytes };
  }

  /**
   * מחיקה של **הדור המדויק בלבד**. בלי דור — אין מחיקה: מחיקה לפי
   * נתיב בלבד יכולה להסיר אובייקט חדש שנכתב בינתיים.
   *
   * `removed:false` הוא **עובדה על הרגע הזה**, לא הבטחה לעתיד;
   * הקורא הטהור הוא שמכריע מה זה אומר על המכסה. `412` מקבל סיבה
   * נפרדת מ-`404`: „הוחלף" ו„אינו קיים" אינם אותו דבר.
   */
  async function remove({ path, generation }) {
    if (generation == null) return { removed: false, reason: 'no-generation' };
    try {
      await handle(path, generation).delete({ ifGenerationMatch: String(generation) });
      return { removed: true };
    } catch (e) {
      if (isNotFound(e)) return { removed: false, reason: 'not-found' };
      if (isPrecondition(e)) return { removed: false, reason: 'generation-mismatch' };
      throw e;
    }
  }

  return Object.freeze({ save, read, remove });
}

module.exports = Object.freeze({ createHrAttachmentsStorage, MAX_READ_BYTES });
