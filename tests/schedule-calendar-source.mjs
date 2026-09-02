/**
 * בדיקות מקור · schedule-calendar.
 *
 * בודקות מה שבדיקת התנהגות אינה יכולה לתפוס: שהמאפיין נשאר בקוד.
 * כל בדיקה כאן נועדה ליפול כשמסירים את ההגנה שהיא שומרת עליה.
 *
 * מריצים מתוך תיקיית tests/ — בדיוק כמו ב-CI.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const F = (name) => join(here, '..', 'functions', name);

const ENGINE = readFileSync(F('schedule-calendar-engine.js'), 'utf8');
const PUBLICATION = readFileSync(F('schedule-publication.js'), 'utf8');
const SERVICE = readFileSync(F('schedule-service.js'), 'utf8');

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass += 1; }
  catch (e) { fails.push(name + ' → ' + (e && e.message)); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

/** מסיר הערות, כדי שבדיקה לא תעבור בגלל מילה בתוך הערה. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const E = code(ENGINE);
const P = code(PUBLICATION);
const S = code(SERVICE);

/* ================= טוהר ================= */

for (const [name, src] of [['engine', E], ['publication', P], ['service', S]]) {
  t(name + ' · אפס require', () => ok(!/\brequire\s*\(/.test(src), 'יש require'));
  t(name + ' · אפס import', () => ok(!/^\s*import\s/m.test(src), 'יש import'));
  t(name + ' · אפס שעון מערכת', () => ok(!/Date\.now\s*\(|new Date\s*\(\s*\)/.test(src), 'קורא לשעון'));
  t(name + ' · אפס אקראיות', () => ok(!/Math\.random/.test(src), 'יש Math.random'));
  t(name + ' · אפס נגיעה במסד', () =>
    ok(!/firestore|admin\.|\.collection\s*\(|getFirestore/i.test(src), 'נוגע במסד'));
  t(name + ' · אפס רשת ואפס שליחה', () =>
    ok(!/fetch\s*\(|XMLHttpRequest|messaging\s*\(|sendMulticast|sendEachForMulticast/i.test(src), 'שולח או מושך'));
  t(name + ' · אפס console', () => ok(!/console\./.test(src), 'כותב ללוג'));
  t(name + ' · אפס setTimeout', () => ok(!/setTimeout|setInterval/.test(src), 'יש טיימר'));
}

t('המנוע החדש אינו מייבא ואינו דורס את schedule-autofill', () =>
  ok(!/schedule-autofill/.test(E), 'יש הפניה ל-schedule-autofill'));

/* ================= אין ברירות מחדל שקטות ================= */

t('קו המינימום נדרש במפורש', () =>
  ok(/sub-station-minimum/.test(E), 'אין סירוב על קו מינימום חסר'));
t('min_gap_days נדרש במפורש', () =>
  ok(/policy-rest/.test(E) && /min_gap_days/.test(E), 'אין סירוב על מנוחה חסרה'));
t('המחזוריות חייבת להיות מוצהרת, גם כ-null', () =>
  ok(/policy-rotation-missing/.test(E) && /hasOwnProperty\.call\(raw, 'rotation'\)/.test(E),
    'אין אכיפה על הצהרת מחזוריות'));
t('תקרת המשמרות חייבת להיות מוצהרת', () =>
  ok(/policy-limit-missing/.test(E), 'אין אכיפה על הצהרת תקרה'));
t('סימון חובה/רשות חייב להיות מפורש', () =>
  ok(/requirement-required/.test(E) && /typeof row\.required !== 'boolean'/.test(E),
    'ברירת מחדל שקטה לחובה/רשות'));
t('סימון פעיל/לא פעיל חייב להיות מפורש', () =>
  ok(/typeof p\.active !== 'boolean'/.test(E), 'ברירת מחדל שקטה לפעיל'));
t('תכנון חודשי נעול לראש חודש אמיתי', () =>
  ok(/month-start-required/.test(E) && /Date\.UTC\(startYear, startMonth \+ m \+ 1, 1\)/.test(E),
    'החודש אינו מחושב לפי לוח השנה'));
t('אין אופרטור ברירת מחדל על נתון עסקי', () => {
  ok(!/minimum\s*\|\|/.test(E), 'ברירת מחדל על קו מינימום');
  ok(!/min_gap_days\s*\|\|/.test(E), 'ברירת מחדל על מנוחה');
});

/* ================= מקור אחד ================= */

t('נבדקת התאמת תחנה', () => ok(/station-mismatch/.test(E), 'אין בדיקת תחנה'));
t('נבדקת התאמת גרסה', () => ok(/version-mismatch/.test(E), 'אין בדיקת גרסה'));
t('צילום מקור נדרש', () => ok(/snapshot-required/.test(E), 'צילום מקור אינו חובה'));
t('גרסת האדם נבדקת מול גרסת הקלט', () =>
  ok(/person-version-mismatch/.test(E), 'אין בדיקת גרסה לאדם'));
t('assertSameSource נקראת מ-planPeriod', () =>
  ok(/planPeriod[\s\S]{0,400}assertSameSource\(policy, inp\)/.test(E), 'planPeriod אינה מאמתת מקור'));

/* ================= אין העברה בין תחנות קצה ================= */

t('שיוך תחנת הקצה נבדק בשער הכשירות', () =>
  ok(/person\.sub_station !== ctx\.sub/.test(E), 'אין חסימת חציית תחנות קצה'));
t('חסימת חציית תחנות קצה היא הבדיקה הראשונה', () => {
  const body = E.slice(E.indexOf('function blockCode'));
  const first = body.indexOf('person.sub_station !== ctx.sub');
  const active = body.indexOf('person.active !== true');
  ok(first > -1 && first < active, 'סדר הבדיקות השתנה');
});
t('המאגר נבנה לפי תחנת קצה', () =>
  ok(/pools\[sub\]\[role\]/.test(E), 'אין אינדוקס לפי תחנת קצה'));

/* ================= אין דליפת מידע אישי ================= */

t('קודי הסיבה סגורים ואינם מכילים קטגוריית היעדרות', () => {
  const block = E.slice(E.indexOf('const REASON = Object.freeze('), E.indexOf('const PUBLIC_REASONS'));
  ok(block.length > 0, 'לא נמצאה טבלת הסיבות');
  ['sick', 'vacation', 'reserve', 'course', 'medical', 'מחלה', 'חופשה', 'מילואים'].forEach((w) => {
    ok(block.indexOf(w) === -1, 'קטגוריית היעדרות בטבלת הסיבות: ' + w);
  });
});
t('קוד הסיבה אינו נלקח מהקלט', () => {
  const body = E.slice(E.indexOf('function blockCode'), E.indexOf('function rankKey'));
  ok(!/return ctx\.unavailable\b/.test(body), 'הסיבה מהקלט מוחזרת כמות שהיא');
  ok(/return REASON\.NOT_AVAILABLE/.test(body), 'אין המרה לקוד ניטרלי');
});
t('רשימת ההיתר של הפוש קיימת וסגורה', () => {
  ok(/const PUSH_FIELDS = Object\.freeze\(\[/.test(P), 'אין רשימת היתר');
  const m = P.match(/const PUSH_FIELDS = Object\.freeze\(\[([^\]]*)\]/);
  const fields = m[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
  // ⭐ הרשימה מונה את התחנה שאליה **האדם עצמו** שובץ, כדי שההתראה
  // תאמר לאיזה יום ולאיזו תחנה — זה מידע עליו ולא על אף אחד אחר.
  // כל תוספת נוספת חייבת להפיל את הבדיקה הזאת ולהישקל בנפרד.
  const expected = ['kind', 'date', 'sub_station', 'sub_station_label'];
  ok(fields.length === expected.length && expected.every((x) => fields.indexOf(x) > -1),
    'רשימת ההיתר השתנתה: ' + fields.join(','));
  // ואף שדה ברשימה אינו נושא שם של אדם.
  ok(!fields.some((x) => /person|name|crew|uid|full/.test(x)),
    'שדה שמזהה אדם נכנס לרשימת ההיתר: ' + fields.join(','));
});
t('ההתראה אומרת לאיזה תאריך ולאיזו תחנה', () => {
  // „שינוי אחד בסידור שלך" הוא נכון וחסר תועלת: הוא מחייב לפתוח
  // את האפליקציה רק כדי לדעת אם זה נוגע למחר בבוקר.
  ok(/function pushBody\(/.test(P), 'אין בונה נוסח להתראה');
  ok(/function shortDate\(/.test(P), 'אין עיצוב תאריך קצר');
  ok(!/Intl\./.test(P), 'עיצוב תלוי ICU במטען שנחתם ונשמר');
  ok(/sub_station_changed: 'שובצת מחדש'/.test(P), 'שיבוץ מחדש אינו מנוסח');
  const body = P.slice(P.indexOf('function itemText'), P.indexOf('function pushBody'));
  ok(/item\.sub_station_label \|\| item\.sub_station/.test(body),
    'התחנה אינה נאמרת בהתראה');
});
t('בונה הפוש עובר על רשימת ההיתר בלבד', () =>
  ok(/for \(const key of PUSH_FIELDS\)/.test(P), 'המטען אינו מסונן לפי הרשימה'));
t('קיימת רשימת מפתחות אסורים ובדיקה שמפעילה אותה', () => {
  ok(/const FORBIDDEN_KEYS = Object\.freeze\(\[/.test(P), 'אין רשימת מפתחות אסורים');
  ok(/assertNoLeak\(push, 'push'\)/.test(P), 'הבדיקה אינה מופעלת על המטען');
});
t('אין שמות אנשים אחרים במטען הפוש', () => {
  const body = P.slice(P.indexOf('function buildPush'), P.indexOf('function assertNoLeak'));
  ok(!/crew/.test(body), 'הצוות נכנס למטען הפוש');
});

/* ================= פרסום ================= */

t('פרסום ראשון אינו מושתק', () =>
  ok(!/if \(!prev\) continue;/.test(P), 'פרסום ראשון עדיין מושתק'));
t('התראה אחת לאדם ולא אחת לשינוי, עם גיבוב תוכן', () =>
  ok(/dedupe_key: inp\.publication_id \+ ':' \+ person \+ ':' \+ contentHash/.test(P),
    'מפתח הייחוד אינו כולל אדם וגיבוב תוכן'));
t('לחיצה כפולה מזוהה', () =>
  ok(/duplicate: true/.test(P) && /publication-conflict/.test(P), 'אין הגנת לחיצה כפולה'));
t('כשל שליחה אינו מבטל פרסום', () =>
  ok(/publication_still_valid: true/.test(P), 'אין הצהרה שהפרסום נשאר תקף'));
t('אין מחיקה שקטה אחרי מיצוי ניסיונות', () =>
  ok(/status: 'dead_letter'/.test(P), 'אין dead_letter'));
t('הגיבוב מוזרק ואינו מיובא', () =>
  ok(/hash-required/.test(P) && !/createHash/.test(P), 'הגיבוב אינו מוזרק'));

/* ================= הרשאות ================= */

t('קיים שער יחיד', () => ok(/function assertMay\(/.test(S), 'אין assertMay'));
t('כל מסלול ציבורי עובר בשער', () => {
  ['buildMySchedule', 'buildStationSchedule', 'runPlanner', 'publish', 'respond'].forEach((fn) => {
    const start = S.indexOf('function ' + fn + '(');
    ok(start > -1, 'לא נמצאה ' + fn);
    const body = S.slice(start, start + 700);
    ok(/assertMay\(/.test(body), fn + ' אינה עוברת בשער ההרשאות');
  });
});
t('רשימת הפעולות המורשות קיימת ומלאה', () => {
  const m = S.match(/const PRIVILEGED = Object\.freeze\(\[([^\]]*)\]/);
  ok(!!m, 'אין רשימת פעולות מורשות');
  ['EDIT_DRAFT', 'RUN_PLANNER', 'PUBLISH'].forEach((k) =>
    ok(m[1].indexOf(k) > -1, 'חסרה פעולה מורשית: ' + k));
});
t('תגובה נבדקת מול המבצע עצמו', () =>
  ok(/target !== actor\.id/.test(S), 'אין חסימת מענה בשם אחר'));
t('היכולות מגיעות מהכללים ואינן מקודדות', () => {
  ok(/rules-capabilities/.test(S), 'אין דרישת יכולות');
  ok(!/'firefighter'|"firefighter"/.test(S), 'תפקיד מקודד בקוד');
  ok(!/'scheduler'|"scheduler"/.test(S), 'תפקיד מקודד בקוד');
});
t('משתמש לא פעיל נחסם בשער', () =>
  ok(/actor-inactive/.test(S), 'אין חסימת משתמש לא פעיל'));

console.log((fails.length ? '✗' : '✓') + ' schedule-calendar-source: ' + pass + '/' + (pass + fails.length));
if (fails.length) { fails.forEach((f) => console.log('   ✗ ' + f)); process.exit(1); }
