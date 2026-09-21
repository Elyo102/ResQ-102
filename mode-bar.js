/* ======================================================================
 *  mode-bar — חיווי מצב ההפעלה, בכותרת, בגודל של תגית.
 *
 *  **למה החיווי קיים.** במצב ניסוי ההתראות נחסמות. בלי סימן על המסך,
 *  מפקד שישלח קריאת פתע ולא יראה תגובה יסיק שההזעקה שבורה — ויתקשר
 *  לכולם בטלפון. „שקט" ו„שבור" נראים אותו דבר בדיוק, וזה ההבדל
 *  היחיד שאפשר להראות.
 *
 *  **ולמה הוא כבר לא פס.** פס רוחב-מסך קבוע בכל מסך הוא רעש: אחרי
 *  יומיים אף אחד לא קורא אותו, והוא גם דוחף את כל התוכן למטה בטלפון,
 *  שם כל פיקסל אנכי נספר. התגית אומרת את אותו דבר בפינה, ומי שרוצה
 *  את המשפט המלא לוחץ ומקבל אותו.
 *
 *  **מה לא השתנה:** לפני פעולה חיה — קריאת פתע, פרסום סידור, שליחת
 *  פוש — הניסוח המלא עדיין מוצג בדיאלוג. תגית קטנה מספיקה כדי לזכור
 *  שהמערכת בניסוי; היא אינה מספיקה כדי לשדר לתחנה בטעות. שני מצבי
 *  התצוגה האלה הם החלטה מכוונת ולא חוסר עקביות.
 *
 *  **הניסוח.** הנוסח הקודם אמר „שום דבר לא יוצא החוצה". זה לא נכון:
 *  `setSilentMode` מקבל רשימת פטורים של עד 40 מזהים, ו-`allowedByRuntime`
 *  מעביר אותם. מי שקרא את המשפט ההוא והניח שאפשר לבדוק בשקט מוחלט —
 *  הניח לא נכון.
 * ====================================================================== */

/* ⭐ משפט אחד, במקום אחד. שני מסכים לא יאמרו דברים שונים על אותו
 * מצב, ותיקון ניסוח הוא תיקון בשורה אחת ולא בשבעה־עשר קבצים. */
export const TRIAL_LABEL = 'אימון';
export const LIVE_LABEL = 'חי';
export const TRIAL_ARIA = 'מצב אימון פעיל';
export const LIVE_ARIA = 'מצב חי';
export const TRIAL_NOTE =
  'מצב אימון פעיל — פעולות נשמרות לבדיקה ונשלחות רק לחשבון הבדיקה המאושר.';
export const LIVE_NOTE =
  'מצב חי — פעולות נשלחות לנמענים האמיתיים שלהן.';

/* הניסוחים המלאים לדיאלוגים שלפני פעולה חיה. הם יושבים כאן ולא
 * במסכים, כדי שלא ייווצר מצב שבו מסך אחד עודכן והשני לא. */
export const TRIAL_BROADCAST_WARNING =
  '🧪 שידור במצב אימון: ההתראה תישלח לחשבון הבדיקה בלבד.';
export const TRIAL_PUBLISH_WARNING =
  '🧪 פרסום במצב אימון: הסידור יעודכן לבדיקה בלבד, ולא יישלחו התראות אמת לצוותים.';

const CHIP_ID = 'modeChip';
const NOTE_ID = 'modeChipNote';
const WRAP_ID = 'modeChipWrap';
const ACTION_ID = 'modeChipAction';
const STATUS_ID = 'modeChipStatus';

/* `null` = לא ידוע. מסך שאין לו מקור מצב לא יציג תגית, ולא ימציא
 * „חי" רק מפני שלא שאל. */
let currentMode = null;
let documentListener = null;
let modeAction = null;

export function stationMode() { return currentMode; }
export const isTrial = () => currentMode === 'trial';

function styleOnce() {
  if (document.getElementById('modeChipStyle')) return;
  const st = document.createElement('style');
  st.id = 'modeChipStyle';
  st.textContent = [
    '#' + WRAP_ID + '{position:relative;display:inline-flex;flex:none;',
    '  margin-inline-start:auto;direction:rtl}',
    // 44×44 הוא המינימום שאצבע פוגעת בו באמינות על מסך טלפון.
    '#' + CHIP_ID + '{display:inline-flex;align-items:center;gap:7px;',
    '  min-height:44px;min-width:44px;box-sizing:border-box;',
    '  padding:0 12px;border-radius:22px;cursor:pointer;',
    '  font:inherit;font-size:13px;font-weight:800;line-height:1;',
    '  border:1px solid var(--line);background:var(--panel);color:var(--txt)}',
    '#' + CHIP_ID + ' .dot{width:9px;height:9px;border-radius:50%;flex:none;',
    '  background:var(--good,#2e7d32)}',
    '#' + CHIP_ID + '[data-mode="trial"]{border-color:var(--warn);',
    '  background:var(--warn-bg);color:var(--warn)}',
    '#' + CHIP_ID + '[data-mode="trial"] .dot{display:none}',
    '#' + CHIP_ID + ':focus-visible{outline:3px solid var(--accent);outline-offset:2px}',
    '#' + NOTE_ID + '{position:absolute;top:calc(100% + 6px);inset-inline-end:0;',
    '  z-index:960;width:max-content;max-width:min(78vw,320px);',
    '  padding:11px 13px;border-radius:11px;font-size:13px;line-height:1.6;',
    '  font-weight:600;text-align:start;',
    '  border:1px solid var(--line);background:var(--card);color:var(--txt);',
    '  box-shadow:0 10px 30px rgba(0,0,0,.28)}',
    '#' + NOTE_ID + '[hidden]{display:none!important}',
    '#' + ACTION_ID + '{display:flex;width:100%;min-height:44px;margin-top:10px;',
    '  align-items:center;justify-content:center;padding:8px 12px;border-radius:9px;',
    '  border:1px solid var(--accent);background:var(--accent);color:var(--accent-on);',
    '  font:inherit;font-weight:800;cursor:pointer}',
    '#' + ACTION_ID + ':disabled{opacity:.62;cursor:wait}',
    '#' + ACTION_ID + ':focus-visible{outline:3px solid var(--accent);outline-offset:2px}',
    '#' + STATUS_ID + '{min-height:1.5em;margin-top:7px;color:var(--muted);font-size:12px}',
    '#' + STATUS_ID + '[data-error="true"]{color:var(--bad-txt)}',
    '@media(max-width:420px){#' + CHIP_ID + '{padding:0 10px;font-size:12px}}'
  ].join('');
  document.head.appendChild(st);
}

function closeNote() {
  const note = document.getElementById(NOTE_ID);
  const chip = document.getElementById(CHIP_ID);
  if (note) note.hidden = true;
  if (chip) chip.setAttribute('aria-expanded', 'false');
  if (documentListener) {
    document.removeEventListener('click', documentListener, true);
    document.removeEventListener('keydown', documentListener, true);
    documentListener = null;
  }
}

function openNote() {
  const note = document.getElementById(NOTE_ID);
  const chip = document.getElementById(CHIP_ID);
  if (!note || !chip) return;
  note.hidden = false;
  chip.setAttribute('aria-expanded', 'true');
  /* סגירה בלחיצה בחוץ וב-Escape. בלי זה ההסבר נשאר פתוח מעל התוכן
   * עד שמישהו ילחץ שוב בדיוק על התגית — וזה בדיוק מה שלא קורה. */
  documentListener = function (event) {
    if (event.type === 'keydown' && event.key !== 'Escape') return;
    const wrap = document.getElementById(WRAP_ID);
    if (event.type === 'click' && wrap && wrap.contains(event.target)) return;
    closeNote();
  };
  document.addEventListener('click', documentListener, true);
  document.addEventListener('keydown', documentListener, true);
}

function buildChip() {
  styleOnce();
  let wrap = document.getElementById(WRAP_ID);
  if (wrap) return wrap;
  wrap = document.createElement('div');
  wrap.id = WRAP_ID;

  const chip = document.createElement('button');
  chip.id = CHIP_ID;
  chip.type = 'button';
  chip.setAttribute('aria-expanded', 'false');
  chip.setAttribute('aria-controls', NOTE_ID);
  const dot = document.createElement('span');
  dot.className = 'dot';
  const label = document.createElement('span');
  label.className = 'label';
  chip.append(dot, label);
  chip.addEventListener('click', function (event) {
    event.stopPropagation();
    const note = document.getElementById(NOTE_ID);
    if (note && note.hidden) openNote(); else closeNote();
  });

  const note = document.createElement('div');
  note.id = NOTE_ID;
  note.setAttribute('role', 'status');
  note.hidden = true;

  wrap.append(chip, note);
  return wrap;
}

function syncChip(wrap) {
  if (!wrap || (currentMode !== 'trial' && currentMode !== 'live')) return;
  const chip = wrap.querySelector('#' + CHIP_ID);
  const note = wrap.querySelector('#' + NOTE_ID);
  if (!chip || !note) return;
  const trial = currentMode === 'trial';
  chip.dataset.mode = currentMode;
  chip.querySelector('.label').textContent = trial ? '🧪 ' + TRIAL_LABEL : LIVE_LABEL;
  chip.setAttribute('aria-label', trial ? TRIAL_ARIA : LIVE_ARIA);
  note.replaceChildren();
  const copy = document.createElement('div');
  copy.textContent = trial ? TRIAL_NOTE : LIVE_NOTE;
  note.appendChild(copy);
  if (typeof modeAction === 'function') {
    const action = document.createElement('button');
    action.id = ACTION_ID;
    action.type = 'button';
    action.textContent = trial ? 'מעבר למצב חי' : 'מעבר למצב אימון';
    const status = document.createElement('div');
    status.id = STATUS_ID;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    action.addEventListener('click', async function () {
      if (action.disabled) return;
      action.disabled = true;
      action.setAttribute('aria-busy', 'true');
      status.dataset.error = 'false';
      status.textContent = 'מעדכן…';
      try {
        await modeAction(trial ? 'live' : 'trial');
        status.textContent = 'מצב המערכת עודכן.';
      } catch (error) {
        status.dataset.error = 'true';
        status.textContent = error && error.userMessage
          ? error.userMessage : 'העדכון לא בוצע. נסה שוב.';
      } finally {
        action.disabled = false;
        action.removeAttribute('aria-busy');
      }
    });
    note.append(action, status);
  }
  document.body.classList.toggle('has-trial-mode', trial);
}

/**
 * Authorizes an action inside the chip. Passing null keeps the chip strictly
 * informational. The controller decides authority; the server remains the
 * enforcement boundary.
 */
export function configureModeAction(action) {
  modeAction = typeof action === 'function' ? action : null;
  const wrap = document.getElementById(WRAP_ID);
  if (wrap) syncChip(wrap);
}

/** מכניס את התגית לכותרת. נקרא גם מ-`nav.js` אחרי בנייה מחדש של הסרגל. */
export function attachModeChip() {
  if (currentMode !== 'trial' && currentMode !== 'live') return;
  const wrap = buildChip();
  const host = document.getElementById('appNav') || document.body;
  if (wrap.parentNode !== host) host.appendChild(wrap);
  syncChip(wrap);
}

/**
 * מצייר את החיווי.
 * `mode` — 'trial' או 'live'. כל ערך אחר מסיר אותו, כי „לא ידוע"
 *          אינו מצב שמותר להציג עליו תגית.
 */
export function renderModeBar(mode) {
  currentMode = mode === 'trial' ? 'trial' : mode === 'live' ? 'live' : null;
  if (!currentMode) {
    closeNote();
    const wrap = document.getElementById(WRAP_ID);
    if (wrap) wrap.remove();
    document.body.classList.remove('has-mode-bar', 'has-trial-mode');
    return;
  }
  const wrap = buildChip();
  attachModeChip();
  syncChip(wrap);
  // `has-trial-mode` נשאר ככלי עזר למסכים; הוא כבר אינו דוחף תוכן.
  document.body.classList.remove('has-mode-bar');
}

/* נשאר כדי שקוראים ותיקים לא יישברו: אין יותר פס שתופס גובה, ולכן
 * אין גובה לשחרר. */
export function clearModeBarOffset() {
  closeNote();
  document.documentElement.style.removeProperty('--resq-mode-bar-height');
}

/* המקור למצב משתנה לפי המסך, ולכן הוא אינו כאן: מסכי קריאת פתע
 * מאזינים ל-`config/mode` ב-Firestore שכבר בידם, ומסך הסידור — שאינו
 * מחזיק Firestore כלל — מקבל את המצב מתוך `getScheduleRuntimeStatus`.
 * הקובץ הזה מצייר בלבד, ולכן אין לו תלות ב-SDK של Firebase. */
