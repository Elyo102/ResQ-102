/* ======================================================================
 *  mode-bar — פס „מצב ניסוי", בקובץ אחד, לכל מסך.
 *
 *  **למה הפס קיים.** במצב ניסוי ההתראות נחסמות. בלי סימן על המסך,
 *  מפקד שישלח קריאת פתע ולא יראה תגובה יסיק שההזעקה שבורה — ויתקשר
 *  לכולם בטלפון. „שקט" ו„שבור" נראים אותו דבר בדיוק, וזה ההבדל
 *  היחיד שאפשר להראות.
 *
 *  **למה הוא יצא מ-`callout.js`.** הוא היה שם כי `watchCallouts`
 *  נקראת מהרבה מסכים. אבל לא מכולם: מסך הסידור אינו קורא לה, ולכן
 *  רכזת יכלה להיות בשקט גלובלי מלא ולראות על המסך „מצב חי". פס
 *  שתלוי בפיצ'ר אחר הוא פס שנשכח בדיוק במסך שבו הוא נחוץ.
 *
 *  **ולמה הניסוח השתנה.** הנוסח הקודם אמר „שום דבר לא יוצא החוצה".
 *  זה לא נכון: `setSilentMode` מקבל רשימת פטורים של עד 40 מזהים,
 *  ו-`allowedByRuntime` מעביר אותם. מי שקרא את המשפט ההוא והניח
 *  שאפשר לבדוק בשקט מוחלט — הניח לא נכון. הנוסח כאן אומר מה שקורה.
 * ====================================================================== */

/* ⭐ משפט אחד, במקום אחד. שני מסכים לא יאמרו דברים שונים על אותו
 * מצב, ותיקון ניסוח הוא תיקון בשורה אחת ולא בשבעה־עשר קבצים. */
export const TRIAL_NOTE = 'התראות ומיילים אינם נשלחים לצוות. רק חשבונות הבדיקה המאושרים מקבלים.';
export const TRIAL_TITLE = 'מצב ניסוי';

let modeResizeObserver = null;

export function clearModeBarOffset() {
  if (modeResizeObserver) {
    try { modeResizeObserver.disconnect(); } catch (ignore) {}
    modeResizeObserver = null;
  }
  document.documentElement.style.removeProperty('--resq-mode-bar-height');
}

function trackModeBarHeight(el) {
  clearModeBarOffset();
  const update = function () {
    if (!el || !el.isConnected) return;
    const height = Math.ceil(el.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--resq-mode-bar-height', height + 'px');
  };
  update();
  if (typeof ResizeObserver === 'function') {
    modeResizeObserver = new ResizeObserver(update);
    modeResizeObserver.observe(el);
  }
}

/**
 * מצייר או מסיר את הפס.
 * `mode` — 'trial' מדליק, כל ערך אחר מכבה.
 * `note` — משפט נוסף למסך שיודע משהו שהפס הכללי אינו יודע (מנוע
 *           הסידור, למשל). הוא **נוסף** לניסוח הקבוע ואינו מחליף אותו,
 *           כדי שאי אפשר יהיה להחליש את האזהרה ממסך מסוים.
 */
export function renderModeBar(mode, note) {
  const on = mode === 'trial';
  let el = document.getElementById('modeBar');

  if (!on) {
    if (el) el.remove();
    document.body.classList.remove('has-mode-bar');
    clearModeBarOffset();
    return;
  }
  document.body.classList.add('has-mode-bar');
  const extra = typeof note === 'string' && note.trim() ? ' ' + note.trim() : '';
  if (!el) {
    el = document.createElement('div');
    el.id = 'modeBar';
    el.setAttribute('role', 'status');
    el.style.cssText = [
      'position:sticky', 'top:var(--resq-safe-top-override,env(safe-area-inset-top,0px))', 'z-index:950',
      'background:var(--warn-bg)', 'color:var(--warn)',
      'border-bottom:2px solid var(--warn)',
      'padding:9px 16px', 'box-sizing:border-box',
      'width:100%', 'align-self:stretch',
      'font-size:13px', 'font-weight:600',
      'line-height:1.6', 'direction:rtl', 'text-align:center',
      'font-family:"Segoe UI",Arial,sans-serif',
      'margin:0'
    ].join(';');
    document.body.insertBefore(el, document.body.firstChild);
  }
  // בלי innerHTML: הכותרת והמשפט נבנים כצמתים, ו-`note` מגיע מקוד
  // המסך ולא מהשרת — אבל גם כך אין סיבה להשאיר פתח.
  el.replaceChildren();
  const title = document.createElement('b');
  title.textContent = TRIAL_TITLE;
  el.append(title, document.createTextNode(' · ' + TRIAL_NOTE + extra));
  trackModeBarHeight(el);
}

/* המקור למצב משתנה לפי המסך, ולכן הוא אינו כאן:
 * מסכי קריאת פתע מאזינים ל-`config/mode` ב-Firestore שכבר בידם,
 * ומסך הסידור — שאינו מחזיק Firestore כלל — מקבל את המצב
 * מתוך `getScheduleRuntimeStatus`. הקובץ הזה מצייר בלבד, ולכן אין לו
 * תלות ב-SDK של Firebase — מסך שאינו טוען אותו לא יטען אותו
 * רק כדי להציג פס אזהרה. */
