// מצב הצי — מקור אמת אחד לשאלה „אילו רכבים קיימים בתחנה".
//
// לתחנה שני סוגי רכבים, והם יושבים בשני מקומות שונים:
//
//   · **רכב מבצעי** — אובייקט בתוך המערך `vehicles` שבמסמך
//     `stations/{sid}/config/board`. הוא נושא משבצות שיבוץ, ולכן
//     הוא חייב לחיות לצד שרשרת הפיקוד באותו מסמך.
//   · **רכב לוגיסטי** („רכב עיגון") — מסמך באוסף
//     `stations/{sid}/vehicles`. אין לו משבצות; יש לו שם ומספר רישוי.
//
// שישה מסכים ושירות שרת אחד שואלים „מי בצי". כשכל אחד מהם סינן
// בעצמו, הסרת רכב הופיעה במסך אחד ונשארה בשני — והמשתמש רואה
// שני צווים סותרים על אותו רכב ולא יודע לאיזה להאמין.
//
// **הסרה היא השבתה ולא מחיקה.** רכב שמוסר נושא היסטוריית תקלות
// ופגיעות שנכתבה עליו בשם, ומחיקה הייתה הופכת כל דיווח כזה
// ל„רכב לא ידוע" בדיעבד. לכן ההסרה מסמנת `active:false`,
// הרשומה נשארת, ההיסטוריה נשארת קריאה, והפעולה הפיכה.
//
// הקובץ הזה טהור בכוונה: הוא לא מכיר את Firebase ולא קורא כלום.
// כל מסך טוען את הנתונים בעצמו ומעביר אותם לכאן.

/* ---------- מי רשאי לערוך את הצי ----------
 *
 * הכרעת אלדד (6.9): מפקד משמרת, סגן מפקד משמרת, מפקד תחנה
 * ומנהל-על. **רכזת כוח אדם אינה בקבוצה הזאת** — היא כן `staff`
 * לכל דבר אחר, אבל הרכבים אינם תחומה.
 *
 * חייב להיות זהה ל-`fleetManager()` בכללי האבטחה. אם הם ייפרדו,
 * המסך יציע פעולה שהשרת יחסום — וזה נראה כמו תקלה ולא כמו גבול. */
export const FLEET_ROLES = Object.freeze(['commander', 'deputy', 'station_commander']);

export function managesFleet(claims) {
  const c = claims || {};
  if (c.super === true) return true;
  return FLEET_ROLES.indexOf(c.role) !== -1;
}

/* ---------- פעיל / מושבת ----------
 *
 * רכב **בלי** השדה `active` הוא רכב פעיל. כל הרכבים שקיימים היום
 * נכתבו לפני שהשדה היה קיים, ואם היעדר השדה היה נקרא כ„מושבת"
 * הצי כולו היה נעלם מהמסך ברגע הפריסה. רק `active === false`
 * מסתיר רכב — ערך אחר, שגוי או חסר, אינו מסתיר. */
export function isActiveVehicle(vehicle) {
  return !!vehicle && vehicle.active !== false;
}

export function activeVehicles(list) {
  return (Array.isArray(list) ? list : []).filter(isActiveVehicle);
}

export function inactiveVehicles(list) {
  return (Array.isArray(list) ? list : []).filter(function (v) {
    return !!v && v.active === false;
  });
}

/* מערך `vehicles` של מסמך הלוח, מסונן. שומר על שאר המסמך כפי שהוא. */
export function activeBoardVehicles(board) {
  return activeVehicles((board || {}).vehicles);
}

/* ---------- שינויים (טהורים — מחזירים אובייקט, לא כותבים) ---------- */

export const NAME_MAX  = 50;
export const PLATE_MAX = 20;
export const ROLE_MAX  = 20;

/** גוזם ומגביל שדה טקסט של רכב. מחזיר מחרוזת תמיד. */
export function cleanField(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

/**
 * ולידציה של עריכת רכב. מחזיר `{ ok, error, patch }`.
 * שם ריק הוא השגיאה היחידה שחוסמת — מספר רישוי וייעוד רשאים
 * להיות ריקים, כי לא לכל רכב בתחנה יש אותם.
 */
export function vehicleEdit(input) {
  const src = input && typeof input === 'object' ? input : {};
  const name = cleanField(src.name, NAME_MAX);
  if (!name) return { ok: false, error: 'name-required', patch: null };
  const patch = { name: name, plate: cleanField(src.plate, PLATE_MAX) };
  if (src.role !== undefined) patch.role = cleanField(src.role, ROLE_MAX);
  return { ok: true, error: '', patch: patch };
}

/**
 * הפיכת רכב למושבת. `meta = { uid, at }` — `at` מוזרק כדי שהמודול
 * יישאר טהור ולא יקרא לשעון בעצמו (בדיקות דטרמיניסטיות).
 *
 * ⚠ **`at` של רכב מבצעי חייב להיות ערך רגיל, לא `serverTimestamp()`.**
 * רכב מבצעי הוא אובייקט **בתוך מערך**, ו-Firebase דוחה שם חותמת שרת:
 * „serverTimestamp() is not currently supported inside arrays". רכב
 * לוגיסטי הוא מסמך משלו, ושם חותמת שרת חוקית ועדיפה — היא נקבעת
 * בשרת ולא בשעון של הטלפון. `boardStamp()` מחזיר את הצורה המותרת
 * במערך, ו-`atFor(kind, serverStamp)` בוחר לפי סוג הרכב.
 */
export function deactivationPatch(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  return {
    active: false,
    deactivated_at: m.at || null,
    deactivated_by: String(m.uid || '')
  };
}

/** חותמת זמן שמותר לכתוב **בתוך מערך**: מחרוזת ISO, לא sentinel. */
export function boardStamp(now) {
  return new Date(now === undefined ? Date.now() : now).toISOString();
}

/**
 * החותמת המתאימה לסוג הרכב: רכב לוגיסטי הוא מסמך ולכן מקבל את חותמת
 * השרת שנמסרה; רכב מבצעי יושב במערך ולכן מקבל מחרוזת ISO.
 */
export function atFor(kind, serverStamp, now) {
  return kind === 'anchor' ? serverStamp : boardStamp(now);
}

/** החזרת רכב לצי. מנקה את שדות ההשבתה כדי שלא יישארו שאריות מטעות. */
export function reactivationPatch() {
  return { active: true, deactivated_at: null, deactivated_by: '' };
}

/**
 * החלת שינוי על רכב בתוך מערך הלוח, לפי מזהה. מחזיר **מערך חדש**;
 * לא משנה את המקור, כדי ששמירה שנכשלה לא תשאיר את המסך במצב
 * שאינו קיים בשרת.
 */
export function applyToBoardVehicle(list, vehicleId, patch) {
  return (Array.isArray(list) ? list : []).map(function (v) {
    if (!v || v.id !== vehicleId) return v;
    return Object.assign({}, v, patch || {});
  });
}
