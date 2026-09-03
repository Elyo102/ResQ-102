/* ====================================================================
 *  schedule-hidden-authority-probe · ג5
 *
 *  האם יש הרשאת עריכה שמסתתרת מאחורי כפתור מוסתר.
 *
 *  ----------------------------------------------------------------
 *  השאלה שהבדיקה הזאת שואלת
 *  ----------------------------------------------------------------
 *
 *  מסך שמסתיר כפתור אינו מונע דבר. `hidden`, `display:none`, ושאילתת
 *  מדיה שמצמצמת תפריט בנייד — כולם שכבת **תצוגה**. הכפתור עדיין
 *  בעמוד, המאזין עדיין מחובר, וקריאה אחת מקונסולת הדפדפן מפעילה
 *  אותו. מי שיש לו טלפון יש לו גם דפדפן.
 *
 *  ⭐ לכן הבדיקה אינה שואלת „האם הכפתור מוסתר". היא שואלת שתי
 *  שאלות אחרות:
 *
 *   1. **האם השרת עוצר?** לכל פעולה משנה יש שער מפורש בשרת,
 *      והשער נבדק בטקסט המקור — לא בהתנהגות, כי התנהגות אפשר
 *      לבדוק על מקרה אחד ולהחמיץ שער שנשמט מפעולה חדשה.
 *
 *   2. **האם המסך מתיימר?** מסך שמסתיר כפתור ומשאיר אותו לחיץ
 *      אומר לאדם „אין לך את זה" ואומר לשרת „נסה". שתי האמירות
 *      אינן יכולות להיות נכונות.
 *
 *  ----------------------------------------------------------------
 *  מה **אינו** פער
 *  ----------------------------------------------------------------
 *
 *  `respondToSchedule` ו-`guardSignup` אינם דורשים מינוי, ובצדק:
 *  כבאי מאשר את המשמרת של עצמו ונרשם לאבטחה בעצמו. מה שהם כן
 *  חייבים הוא להיות **כבולים ל-uid של הקורא** ולא לקבל זהות
 *  מהלקוח — וזה נבדק כאן בנפרד.
 *
 *  יציאה: 0 עבר · 1 נכשל · 2 לא רץ.
 * ==================================================================== */

import { readSource } from './source-text.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const read = (file) => readSource(resolve(ROOT, file));

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  ok(name, a === b, 'קיבלתי ' + a + ' במקום ' + b);
}

let INDEX, RUNTIME, UI, HTML, RULES;
try {
  INDEX = read('functions/index.js');
  RUNTIME = read('functions/schedule-runtime.js');
  UI = read('schedule-management.js');
  HTML = read('schedule-management.html');
  RULES = read('firestore.rules');
} catch (e) {
  console.error('NOT RUN — ' + e.message);
  process.exit(2);
}

/* ==================================================================
 * 0 · הגלאים
 *
 * ⭐ כל תנאי שהבדיקה בודקת מוגדר כאן פעם אחת, ומשמש **גם** את
 * הבדיקה על המקור האמיתי (סעיפים 3–7) **וגם** את בדיקות המוטציה
 * (סעיף 8). בלי זה היו שני עותקים של אותו ביטוי, ומוטציה הייתה
 * ממשיכה „לעבור" אחרי שהקוד השתנה והעותק שבסעיף 8 התיישן.
 * ================================================================== */

/* ⭐ שערים נבדקים על **קוד**, לא על הערות.
 *
 * `promoteToNew` נושא הערה שמסבירה במפורש ש-`requireManager` אינו
 * נקרא בו — והבדיקה נפלה על ההערה הזאת. זה נראה כמו מטרד, אבל
 * הכיוון ההפוך חמור: פונקציה בלי שער בכלל, שיש בה הערה על
 * `requireManager`, הייתה **עוברת** את 3.M. גלאי שהערה יכולה לספק
 * אותו אינו גלאי.
 */
function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const D = Object.freeze({
  mgrGate: (body) => /requireManager\(ctx\)|requireLiveManagerNow\(ctx\)/
    .test(stripComments(body)),
  noClientStation: (body) => !/data\.(station_id|stationId)/.test(stripComments(body)),
  commandGate: (body) => stripComments(body).indexOf('mayChangeMode') !== -1,
  commandNotManager: (body) => stripComments(body).indexOf('requireManager') === -1,
  selfIdentity: (body) => body.indexOf('await context(req)') !== -1,
  noClientIdentity: (body) => !/data\.(uid|person|subject|recipient|employee)/.test(body),
  noUidFromBody: (runtime) => !/req\.data\.uid|data\.uid\b/.test(runtime),
  capFromServer: (ui) =>
    /function canManageSchedule\(\) \{[\s\S]{0,220}state\.status\.manager === true/.test(ui),
  notFromClaims: (ui) => !/claims\.(manager|schedule_manager|roles)/.test(ui),
  notFromWidth: (ui) => !/matchMedia|innerWidth\s*[<>]/.test(ui),
  modeFromServer: (ui) => /view\.may_change !== true/.test(ui),
  uiNoRoleMath: (ui) =>
    !/'commander'|'deputy'|'station_commander'|'super_admin'/.test(ui),
  noMediaHide: (html) => {
    const blocks = html.split('@media').slice(1).join('@media');
    return !/#(savePolicy|publish|rollback|runPlanner|modeApply|sourceSave|sourceCheck)/
      .test(blocks);
  },
  noManualFetch: (ui) => !/fetch\(|XMLHttpRequest|axios/.test(ui),
  // ⭐ כל פעולת ניהול קשורה דרך שער אחד. `hidden`/`disabled` הם
  // תצוגה בלבד — בדיקת הדפדפן הוכיחה שהסרתם הפעילה את המנוע —
  // ולכן המאזין עצמו חייב לשאול את תשובת השרת.
  /* ⭐ P1-1 · השער התפצל, ובכוונה.
   *
   * הזנת חוקי תחנה ומקור מותרת בכל מצב, כולל `off` — בלעדיה תחנה
   * חדשה נתקעת בלולאה: אי אפשר להעביר ל-shadow בלי מדיניות, ואי
   * אפשר היה להזין מדיניות בלי shadow.
   *
   * הרצה, הכנה ופרסום נשארות חסומות ב-`off`. שתי הרשימות נבדקות
   * בנפרד, כדי שהחלפה בין השערים לא תעבור בשקט. */
  gatedListeners: (ui) =>
    ['savePolicy', 'sourceCheck', 'sourceSave'].every((id) =>
      ui.indexOf("$('" + id + "').addEventListener('click', managerAction(") !== -1)
    && ['runPlanner', 'publish', 'rollback'].every((id) =>
      ui.indexOf("$('" + id + "').addEventListener('click', runAction(") !== -1),
  modeListenerGated: (ui) =>
    ui.indexOf("$('modeApply').addEventListener('click', commandAction(") !== -1,
  gateAsksServer: (ui) =>
    /function managerAction\(fn\) \{[\s\S]{0,160}if \(!canManageSchedule\(\)\) return;/.test(ui)
    && /function runAction\(fn\) \{[\s\S]{0,160}if \(!canRunSchedule\(\)\) return;/.test(ui)
    && /function commandAction\(fn\) \{[\s\S]{0,200}may_change !== true\) return;/.test(ui),
  // ⭐ אותו לקח: החלון נעצר בבלוק match הבא. חלון של 260 תווים היה
  // מוצא את `if false` של האוסף הבא ומדווח „סגור" על אוסף פתוח.
  ruleClosed: (rules, name) => {
    const at = rules.indexOf('match /' + name + '/');
    if (at === -1) return false;
    const next = rules.indexOf('match /', at + 7);
    const block = rules.slice(at, next === -1 ? rules.length : next);
    return /allow read, write: if false;/.test(block);
  },
  uiNoFirestore: (ui) => !/firebase-firestore|getFirestore|collection\(/.test(ui),
  directNavBounced: (ui) =>
    ui.indexOf("if (name === 'manage' && !canManageSchedule()) name = 'station'") !== -1,
  tabHidden: (ui) => ui.indexOf("$('manageTab').hidden = !canManageSchedule()") !== -1,
  // ⭐ מצב `off` חוסם **הרצה ופרסום**, לא הזנה. זו ההכרעה החדשה.
  offBlocks: (ui) =>
    /function canRunSchedule\(\) \{[\s\S]{0,220}\['shadow', 'new'\]\.indexOf\(state\.status\.mode\)/.test(ui),
  // ⭐ החלון נעצר ביצוא הבא ולא אחרי מספר תווים שרירותי. חלון קבוע
  // היה גולש אל ההגדרה הבאה ומוצא שם את enforceAppCheck של מישהו אחר —
  // כלומר מדווח „מוגן" על פונקציה חשופה. מוטציה 8.8 תפסה בדיוק את זה.
  appCheck: (index, name) => {
    const at = index.indexOf('exports.' + name + ' = onCall');
    if (at === -1) return false;
    const next = index.indexOf('\nexports.', at + 1);
    const block = index.slice(at, next === -1 ? index.length : next);
    return block.indexOf('enforceAppCheck: true') !== -1;
  }
});

/* ==================================================================
 * 1 · כל פעולה משנה, והשער שלה
 *
 * ⭐ הרשימה כתובה במפורש ובודקת את עצמה מול המקור: אם ייווצר
 * callable חדש של סידור שאינו כאן, סעיף 2 ייפול. בלי זה הבדיקה
 * הייתה מגנה על מה שהיה נכון ביום שנכתבה.
 * ================================================================== */

const GATE = Object.freeze({
  MANAGER: 'מינוי אחראי/ת סידור חי',
  COMMAND: 'פיקוד התחנה או מנהל-על',
  HR: 'רכזת כוח אדם או מנהל-על',
  SELF: 'הקורא, על עצמו בלבד',
  VIEW: 'צפייה'
});

const CALLABLES = Object.freeze([
  { name: 'saveSchedulePolicy', method: 'savePolicy', gate: GATE.MANAGER },
  { name: 'previewSchedulePolicy', method: 'previewPolicy', gate: GATE.MANAGER },
  { name: 'saveScheduleSource', method: 'saveSource', gate: GATE.MANAGER },
  { name: 'previewScheduleSource', method: 'previewSource', gate: GATE.MANAGER },
  { name: 'runSchedulePlanner', method: 'runPlanner', gate: GATE.MANAGER },
  { name: 'publishSchedule', method: 'publish', gate: GATE.MANAGER },
  { name: 'rollbackSchedule', method: 'rollback', gate: GATE.MANAGER },
  { name: 'getScheduleDraftPreview', method: 'getDraftPreview', gate: GATE.MANAGER },
  { name: 'getScheduleManagerSetup', method: 'getManagerSetup', gate: GATE.MANAGER },
  { name: 'manageScheduleGuard', method: 'manageGuard', gate: GATE.MANAGER },
  { name: 'getScheduleGuardManagerBoard', method: 'getGuardManagerBoard', gate: GATE.MANAGER },
  { name: 'previewScheduleCutover', method: 'previewCutover', gate: GATE.MANAGER },
  { name: 'setScheduleRuntimeMode', method: 'setRuntimeMode', gate: GATE.COMMAND },
  { name: 'getScheduleModeOptions', method: 'getModeOptions', gate: GATE.COMMAND },
  { name: 'setScheduleManagerAccess', method: null, gate: GATE.HR },
  { name: 'getScheduleManagerAccess', method: null, gate: GATE.HR },
  { name: 'respondToSchedule', method: 'respond', gate: GATE.SELF },
  { name: 'guardSignup', method: 'signupGuard', gate: GATE.SELF },
  { name: 'getMyScheduleV2', method: 'getMy', gate: GATE.SELF },
  { name: 'getMyGuardAttendance', method: 'getMyGuardAttendance', gate: GATE.SELF },
  { name: 'getStationScheduleV2', method: 'getStation', gate: GATE.VIEW },
  { name: 'getStationScheduleRange', method: 'getStationRange', gate: GATE.VIEW },
  { name: 'getScheduleRuntimeStatus', method: 'getStatus', gate: GATE.VIEW },
  { name: 'getScheduleGuardBoard', method: 'getGuardBoard', gate: GATE.VIEW },
  { name: 'getGuardLoadStatistics', method: 'getGuardLoadStatistics', gate: GATE.VIEW },
  // ⭐ שם תאימות לדפדפן שנשמר במטמון לפני הפקדים החדשים. הוא נראה
  // תמים אבל הוא מפעיל manageGuard — כלומר הוא שער מנהל לכל דבר.
  { name: 'assignGuard', method: 'manageGuard', gate: GATE.MANAGER },
  { name: 'getLegacyScheduleCompatibilityContext', method: 'getLegacyCompatibility', gate: GATE.VIEW }
]);

function methodBody(name, src) {
  const text = src === undefined ? RUNTIME : src;
  const start = text.indexOf('async function ' + name + '(req)');
  if (start === -1) return null;
  const end = text.indexOf('\n  async function ', start + 10);
  const stop = text.indexOf('\n  function ', start + 10);
  const cut = [end, stop].filter((x) => x > start).sort((a, b) => a - b)[0];
  return text.slice(start, cut === undefined ? start + 4000 : cut);
}

// כיסוי הרשימה מול המקור — כפונקציה, כדי שסעיף 8 יוכל להוכיח
// שהיא באמת תופסת callable שנשמט.
function coverageMissing(index, names) {
  const declaredSet = new Set(names);
  return (index.match(/^exports\.(\w*(?:[Ss]chedule|[Gg]uard)\w*)/gm) || [])
    .map((line) => line.replace('exports.', ''))
    .filter((name) => !/^on|Outbox$|Fanout$|Resume/i.test(name))
    .filter((name) => !declaredSet.has(name)
      && index.indexOf('exports.' + name + ' = onCall') !== -1);
}

/* ==================================================================
 * 2 · הרשימה מכסה את כל מה שקיים
 * ================================================================== */

const NAMES = CALLABLES.map((item) => item.name);
// ⭐ הסריקה חייבת לתפוס גם שמות שאין בהם המילה schedule. `guardSignup`
// ו-`assignGuard` הם פעולות סידור לכל דבר, ו-`assignGuard` מפעיל את
// manageGuard. אילו הסריקה חיפשה רק „schedule" הם היו נשארים מחוץ
// לרשימה בלי שאף בדיקה תתלונן.
eq('2.1 אין callable של סידור שאינו ברשימה', coverageMissing(INDEX, NAMES), []);

const absent = CALLABLES.filter((item) =>
  INDEX.indexOf('exports.' + item.name + ' = onCall') === -1);
eq('2.2 כל מה שברשימה קיים במקור', absent.map((x) => x.name), []);
ok('2.2a ב-42G.0 אין callable ציבורי לקידום המנוע',
  INDEX.indexOf('exports.promoteScheduleToNew = onCall') === -1);

// ⭐ App Check על כולם. בלי זה כל אחד ברשת יכול לנסות.
CALLABLES.forEach((item) => {
  ok('2.3 ' + item.name + ' אוכף App Check', D.appCheck(INDEX, item.name));
});

/* ==================================================================
 * 3 · ⭐ השער עצמו, בקוד ולא בעיצוב
 * ================================================================== */

CALLABLES.filter((item) => item.gate === GATE.MANAGER && item.method).forEach((item) => {
  const body = methodBody(item.method);
  ok('3.M ' + item.method + ' דורש מינוי חי',
    !!body && D.mgrGate(body), 'אין requireManager בגוף הפונקציה');
  // התחנה לעולם אינה מגיעה מהלקוח.
  ok('3.S ' + item.method + ' אינו מקבל תחנה מהלקוח',
    !!body && D.noClientStation(body));
});

CALLABLES.filter((item) => item.gate === GATE.COMMAND && item.method).forEach((item) => {
  const body = methodBody(item.method);
  ok('3.C ' + item.method + ' דורש פיקוד', !!body && D.commandGate(body));
  // ⭐ ובמפורש: המינוי התפעולי אינו פותח את השער הזה.
  ok('3.C! ' + item.method + ' אינו נפתח במינוי אחראי סידור',
    !!body && D.commandNotManager(body));
});

/* ==================================================================
 * 4 · פעולות אישיות · כבולות לקורא
 *
 * אלה **אינן** פער: כבאי מאשר את המשמרת של עצמו. הן חייבות
 * להיות כבולות ל-uid של הקורא ולא לקבל זהות מהלקוח.
 * ================================================================== */

CALLABLES.filter((item) => item.gate === GATE.SELF && item.method).forEach((item) => {
  const body = methodBody(item.method);
  ok('4.1 ' + item.method + ' נבנה מזהות השרת', !!body && D.selfIdentity(body));
  // ⭐ הליבה: אין דרך לומר לשרת „אני מישהו אחר".
  ok('4.2 ' + item.method + ' אינו מקבל זהות מהלקוח',
    !!body && D.noClientIdentity(body), 'שדה זהות מהלקוח');
});

// והשרת אינו מציית ל-uid בגוף הבקשה בשום מקום בנתיב הסידור.
ok('4.3 אין קריאה ל-uid מגוף הבקשה בכל הרנטיים',
  D.noUidFromBody(RUNTIME), 'נמצא שימוש ב-uid מהלקוח');

/* ==================================================================
 * 5 · ⭐ המסך אינו מתיימר
 *
 * זה הלב של ג5. מסך שמסתיר כפתור ומשאיר אותו לחיץ אומר לאדם
 * „אין לך את זה" ואומר לשרת „נסה". שתי האמירות אינן יכולות
 * להיות נכונות, והשרת הוא זה שצודק.
 * ================================================================== */

// היכולת נקבעת ממה שהשרת אמר, ולא מהתפקיד בטוקן ולא מרוחב המסך.
ok('5.1 היכולת נגזרת מתשובת השרת', D.capFromServer(UI));
ok('5.2 ולא מהטוקן', D.notFromClaims(UI));
ok('5.3 ולא מרוחב המסך', D.notFromWidth(UI), 'היכולת תלויה בגודל מסך');

// ⭐ מתג המנוע מוצג רק אם השרת אמר `may_change`, ולא נגזר מתפקיד
// שהדפדפן מכיר.
ok('5.4 מתג המנוע נשען על תשובת השרת', D.modeFromServer(UI));
ok('5.5 והמסך אינו מחשב בעצמו מי מפקד',
  D.uiNoRoleMath(UI), 'המסך מחליט בעצמו מי רשאי');

// אין שום שער שנשען על CSS: אין כלל שמסתיר פעולה לפי רוחב.
ok('5.6 אין שאילתת מדיה שמסתירה פעולה',
  D.noMediaHide(HTML), 'פעולה מוסתרת לפי רוחב מסך');

// ⭐ ובקשה יוצאת רק דרך `call.*` — אין fetch ידני שעוקף את השכבה.
ok('5.7 אין קריאת רשת ידנית שעוקפת את ה-callables', D.noManualFetch(UI));

// ⭐ 5.8–5.10 נוספו אחרי ממצא אמיתי: `#runPlanner` היה הפקד היחיד
// שאינו `disabled` בברירת מחדל, ולוחם ללא מינוי שהסיר `hidden`
// מקונסולת הדפדפן הצליח לגרום למסך לשלוח `runSchedulePlanner`.
// השרת עצר, אבל המסך ניסה — וזה בדיוק מה שסעיף 5 אוסר.
ok('5.8 כל פעולת ניהול עוברת דרך שער אחד', D.gatedListeners(UI));
ok('5.9 מתג המנוע עובר דרך שער הפיקוד', D.modeListenerGated(UI));
ok('5.10 השערים נשענים על תשובת השרת', D.gateAsksServer(UI));

/* ==================================================================
 * 6 · אחסון סגור · הדפדפן אינו יכול לעקוף בכלל
 * ================================================================== */

const scheduleCollections = ['schedule_state', 'schedule_access', 'schedule_policies',
  'schedule_sources', 'schedule_drafts', 'schedule_publications', 'schedule_responses',
  'schedule_audit', 'schedule_policy_operations', 'schedule_policy_audit',
  'schedule_mode_operations', 'schedule_mode_audit',
  'schedule_source_operations', 'schedule_source_audit', 'schedule_preflight'];
scheduleCollections.forEach((name) => {
  ok('6.1 ' + name + ' מוגדר בכללים', RULES.indexOf('match /' + name + '/') > -1);
  ok('6.2 ' + name + ' סגור לדפדפן', D.ruleClosed(RULES, name));
});

// ⭐ המסך אינו נוגע ב-Firestore ישירות בכלל.
ok('6.3 המסך אינו טוען את ערכת Firestore', D.uiNoFirestore(UI));

/* ==================================================================
 * 7 · הסתרה אינה הגנה · והמסך אינו מסתמך עליה
 *
 * לשונית הניהול מוסתרת למי שאינו אחראי סידור, אבל היא נשארת
 * ב-DOM. זה בסדר **בתנאי** שהשרת עוצר — וסעיף 3 מוכיח שהוא עוצר.
 * מה שנבדק כאן הוא שהמסך גם לא מנסה: ניווט ישיר ללשונית ניהול
 * מוחזר לסידור התחנה, ולא נפתח „חלקית".
 * ================================================================== */

ok('7.1 כתובת ניהול ישירה מוחזרת', D.directNavBounced(UI));
ok('7.2 הלשונית מוסתרת לפי תשובת השרת', D.tabHidden(UI));
// ⭐ וגם: מצב off אינו מאפשר ניהול, גם למי שממונה.
// ⭐ 7.3 שינה משמעות ב-P1-1: `off` חוסם הרצה ופרסום, לא הזנה.
ok('7.3 מצב off חוסם הרצה ופרסום גם לממונה', D.offBlocks(UI));

/* ==================================================================
 * 8 · מוטציות · האם הבדיקה הזאת בכלל מסוגלת ליפול
 *
 * ⭐ בדיקה שקוראת טקסט מקור היא הסוג המסוכן ביותר של בדיקה: ביטוי
 * שמפסיק להתאים למקור אינו צועק — הוא פשוט מפסיק לבדוק, וממשיך
 * לדווח „עבר". קרה לי הלילה פעמיים.
 *
 * לכן כל גלאי בסעיף 0 נבדק כאן פעמיים: פעם על מקור שנשבר בכוונה
 * (הגלאי חייב להחזיר false), ופעם על טענה שהשבירה **בוצעה** בפועל.
 * מוטציה שלא נגעה בטקסט היא מוטציה שלא בדקה כלום.
 * ================================================================== */

// מוטציה בתוך גוף פונקציה אחת בלבד. `String.replace` עם מחרוזת
// מחליף את המופע הראשון בקובץ — שהוא לרוב פונקציה אחרת לגמרי,
// והמוטציה „נכשלת" בלי שנגעה במה שהתכוונו לשבור.
function mutateIn(label, name, from, to, detect) {
  const start = RUNTIME.indexOf('async function ' + name + '(req)');
  if (start === -1) {
    fails.push('8 ' + label + ' — לא מצאתי את ' + name + ' במקור');
    return;
  }
  const head = RUNTIME.slice(0, start);
  const rest = RUNTIME.slice(start);
  const cut = rest.indexOf('\n  async function ', 10);
  const body = cut === -1 ? rest : rest.slice(0, cut);
  const tail = cut === -1 ? '' : rest.slice(cut);
  const nextBody = body.replace(from, to);
  if (nextBody === body) {
    fails.push('8 ' + label + ' — דפוס המוטציה לא נמצא בגוף ' + name);
    return;
  }
  ok('8 ' + label, detect(head + nextBody + tail) === false, 'הגלאי לא הבחין בשבירה');
}

function mutate(label, src, from, to, detect) {
  const next = typeof from === 'string' ? src.replace(from, to) : src.replace(from, to);
  if (next === src) {
    fails.push('8 ' + label + ' — דפוס המוטציה לא נמצא במקור; המוטציה לא בדקה כלום');
    return;
  }
  ok('8 ' + label, detect(next) === false, 'הגלאי לא הבחין בשבירה');
}

// --- השרת עוצר ---
mutateIn('8.1 savePolicy בלי requireManager', 'savePolicy',
  'requireManager(ctx);', '',
  (src) => D.mgrGate(methodBody('savePolicy', src)));

mutateIn('8.2 savePolicy מקבל תחנה מהלקוח', 'savePolicy',
  'requireManager(ctx);', 'requireManager(ctx);\n    ctx.sid = req.data.station_id;',
  (src) => D.noClientStation(methodBody('savePolicy', src)));

mutateIn('8.3 setRuntimeMode בלי mayChangeMode', 'setRuntimeMode',
  'modeAuthority.mayChangeMode(actor)', 'true',
  (src) => D.commandGate(methodBody('setRuntimeMode', src)));

// ⭐ המוטציה החשובה ביותר בקובץ: המינוי התפעולי פותח את שער המצב.
// זו בדיוק ההכרעה שאלדד מסר ב-seq316, והיא חייבת להישבר כאן.
mutateIn('8.4 מינוי אחראי סידור פותח את שער המצב', 'setRuntimeMode',
  'const actor = modeActor(ctx);',
  'const actor = modeActor(ctx);\n    requireManager(ctx);',
  (src) => D.commandNotManager(methodBody('setRuntimeMode', src)));

// --- זהות אישית ---
mutateIn('8.5 respond בלי זהות שרת', 'respond',
  'const ctx = await context(req);', 'const ctx = { uid: req.auth.uid };',
  (src) => D.selfIdentity(methodBody('respond', src)));

mutateIn('8.6 respond מקבל זהות מהלקוח', 'respond',
  'const ctx = await context(req);',
  'const ctx = await context(req);\n    ctx.uid = req.data.uid;',
  (src) => D.noClientIdentity(methodBody('respond', src)));

mutateIn('8.7 הרנטיים מציית ל-uid מגוף הבקשה', 'respond',
  'const ctx = await context(req);',
  'const who = req.data.uid;\n    const ctx = await context(req);',
  (src) => D.noUidFromBody(src));

// --- App Check ---
mutate('8.8 publishSchedule בלי App Check',
  INDEX, 'exports.publishSchedule = onCall({\n  enforceAppCheck: true',
  'exports.publishSchedule = onCall({\n  timeoutSeconds: 60',
  (src) => D.appCheck(src, 'publishSchedule'));

// --- כיסוי הרשימה ---
ok('8.9 רשימת ה-callables תופסת פעולה שנשמטה ממנה',
  coverageMissing(INDEX, NAMES.filter((n) => n !== 'publishSchedule')).length === 1,
  'הסרת publishSchedule מהרשימה לא נתפסה');

// --- המסך אינו מתיימר ---
mutate('8.10 היכולת נגזרת ממשהו שאינו תשובת השרת',
  UI, 'state.status.manager === true', 'true',
  (src) => D.capFromServer(src));

mutate('8.11 היכולת נגזרת מהטוקן',
  UI, 'function canManageSchedule() {',
  'function canManageSchedule() {\n  if (claims.manager) return true;',
  (src) => D.notFromClaims(src));

mutate('8.12 היכולת נגזרת מרוחב המסך',
  UI, 'function canManageSchedule() {',
  'function canManageSchedule() {\n  if (window.innerWidth < 700) return false;',
  (src) => D.notFromWidth(src));

mutate('8.13 מתג המנוע מפסיק לשאול את השרת',
  UI, 'view.may_change !== true', 'false',
  (src) => D.modeFromServer(src));

mutate('8.14 המסך מחשב בעצמו מי מפקד',
  UI, 'function canManageSchedule() {',
  "function canManageSchedule() {\n  if (state.role === 'commander') return true;",
  (src) => D.uiNoRoleMath(src));

mutate('8.15 פעולה מוסתרת בשאילתת מדיה',
  HTML, '@media', '@media (max-width: 700px) { #publish { display: none; } }\n@media',
  (src) => D.noMediaHide(src));

mutate('8.16 המסך פותח נתיב רשת ידני',
  UI, 'function canManageSchedule() {',
  "function canManageSchedule() {\n  fetch('/x');",
  (src) => D.noManualFetch(src));

// --- אחסון סגור ---
mutate('8.16b פעולת ניהול נקשרת בלי שער',
  UI, "$('savePolicy').addEventListener('click', managerAction(savePolicy));",
  "$('savePolicy').addEventListener('click', savePolicy);",
  (src) => D.gatedListeners(src));

// ⭐ והמוטציה שהפיצול הופך להכרחית: הרצה שנקשרת לשער החלש. היא
// תיראה תקינה — יש שער — אבל תאפשר הרצה במצב `off`.
mutate('8.16b2 הרצה נקשרת לשער החלש',
  UI, "$('runPlanner').addEventListener('click', runAction(runPlanner));",
  "$('runPlanner').addEventListener('click', managerAction(runPlanner));",
  (src) => D.gatedListeners(src));

mutate('8.16b3 שער ההרצה מפסיק לשאול על המצב',
  UI, 'function runAction(fn) {\n  return function (event) {\n    if (!canRunSchedule()) return;',
  'function runAction(fn) {\n  return function (event) {',
  (src) => D.gateAsksServer(src));

mutate('8.16c מתג המנוע נקשר בלי שער',
  UI, "$('modeApply').addEventListener('click', commandAction(applyModeChange));",
  "$('modeApply').addEventListener('click', applyModeChange);",
  (src) => D.modeListenerGated(src));

// ⭐ המוטציה חייבת לכוון לעטיפה עצמה. `if (!canManageSchedule())`
// מופיע גם ב-`loadSetup`, שקודם לה בקובץ — החלפת המופע הראשון
// הייתה שוברת פונקציה אחרת ומשאירה את השער שלם.
mutate('8.16d השער מפסיק לשאול את השרת',
  UI, 'function managerAction(fn) {\n  return function (event) {\n    if (!canManageSchedule()) return;',
  'function managerAction(fn) {\n  return function (event) {',
  (src) => D.gateAsksServer(src));

// ⭐ הגלאי חייב להתעלם מהערות — בשני הכיוונים. מוטציה שמחליפה
// קריאה אמיתית בהערה בעלת אותו טקסט היא בדיוק התרחיש שבו שער
// נעלם ובדיקה ממשיכה לדווח „מוגן".
// (`publish` אינו מתאים למוטציה הזאת: יש בו **שני** שערים אמיתיים,
// והשני — `requireLiveManagerNow` בנתיב הכפילות — מספק את הגלאי
// בצדק גם אחרי שהראשון בוטל.)
mutateIn('8.16e שער המנהל מוחלף בהערה בלבד', 'savePolicy',
  'requireManager(ctx);', '// requireManager(ctx);',
  (src) => D.mgrGate(methodBody('savePolicy', src)));

mutate('8.17 schedule_access נפתח לדפדפן',
  RULES, 'match /schedule_access/{uid} {\n        allow read, write: if false;',
  'match /schedule_access/{uid} {\n        allow read: if request.auth != null;',
  (src) => D.ruleClosed(src, 'schedule_access'));

mutate('8.18 המסך ניגש ל-Firestore ישירות',
  UI, 'function canManageSchedule() {',
  "function canManageSchedule() {\n  getFirestore();",
  (src) => D.uiNoFirestore(src));

// --- ניווט ---
mutate('8.19 ניווט ישיר ללשונית ניהול אינו מוחזר',
  UI, "if (name === 'manage' && !canManageSchedule()) name = 'station'",
  "if (false) name = 'station'",
  (src) => D.directNavBounced(src));

mutate('8.20 הלשונית אינה מוסתרת לפי תשובת השרת',
  UI, "$('manageTab').hidden = !canManageSchedule()",
  "$('manageTab').hidden = false",
  (src) => D.tabHidden(src));

mutate('8.21 מצב off מפסיק לחסום ניהול',
  UI, "&& ['shadow', 'new'].indexOf(state.status.mode) !== -1", '',
  (src) => D.offBlocks(src));

/* ==================================================================
 * סיכום
 * ================================================================== */

if (fails.length) {
  console.error('schedule-hidden-authority-probe · נכשל');
  for (const f of fails) console.error('  ✗ ' + f);
  console.error('  ' + pass + ' עברו · ' + fails.length + ' נכשלו');
  process.exit(1);
}
console.log('schedule-hidden-authority-probe · ' + pass + '/' + pass + ' עברו');
console.log('  ' + CALLABLES.length + ' callables של סידור מסווגים ונבדקים.');
console.log('  לא נבדק כאן: אכיפת הכללים בפועל — זה דורש אמולטור.');
