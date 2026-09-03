/* ====================================================================
 *  schedule-cutover-probe · P0-2
 *
 *  ----------------------------------------------------------------
 *  מה נבדק כאן, ולמה זה חשוב
 *  ----------------------------------------------------------------
 *
 *  המעבר למנוע החדש הוא הרגע שבו כל התחנה מחליפה מקור אמת. אם הוא
 *  שגוי, כבאי פותח את הסידור ורואה לוח ריק — או, גרוע יותר, לוח
 *  שנראה מלא ושחסר בו בדיוק הוא.
 *
 *  ⭐ שתי טענות שהבדיקה הזאת מתעקשת עליהן:
 *
 *   1. **הכיוון של ה-preflight.** הוא אינו שואל „האם החדש דומה
 *      לישן" אלא **„האם מישהו שהיה משובץ ייעלם"**. זו השאלה שאדם
 *      מרגיש על העור, ולכן היא זו שנבדקת.
 *
 *   2. **הדוח דטרמיניסטי וחתום.** הוא נבדק שוב ברגע המעבר. דוח
 *      שאינו דטרמיניסטי אי אפשר לאמת, ולכן כל מקור אי-דטרמיניזם —
 *      שעון, סדר מפתחות, אקראיות — הוא באג ולא סגנון.
 *
 *  אין כאן Firebase. השעון וה-hash מוזרקים, וכל השמות מומצאים.
 *
 *  יציאה: 0 עבר · 1 נכשל · 2 לא רץ.
 * ==================================================================== */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readSource } from './source-text.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FN = resolve(HERE, '..', 'functions');
const require_ = createRequire(import.meta.url);

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
function caught(fn) {
  try { fn(); return null; } catch (e) { return e; }
}
function throwsCode(name, fn, code) {
  const e = caught(fn);
  ok(name, !!e && e.code === code, e ? 'קוד ' + e.code : 'לא נזרקה שגיאה כלל');
}

let mod, SRC, RUNTIME_SRC;
try {
  SRC = readSource(resolve(FN, 'schedule-cutover.js'));
  RUNTIME_SRC = readSource(resolve(FN, 'schedule-runtime.js'));
  mod = require_(resolve(FN, 'schedule-cutover.js'));
} catch (e) {
  console.error('NOT RUN — לא ניתן לטעון את המודול: ' + e.message);
  process.exit(2);
}

const hash = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
const C = mod.createCutover({ hash, clock: () => '2026-09-03T04:00:00.000Z' });
const CODE = mod.CODE, REASON = mod.REASON;

/* --- מזהים מומצאים. אין כאן איש אמיתי. --- */
const A = 'uid-alef', B = 'uid-bet', G = 'uid-gimel', Z = 'uid-zar';

const BASE = {
  station_id: 'station-102',
  allowed_uids: [A, B, G],
  from: '2026-09-01', to: '2026-09-03',
  legacy_days: [
    { date: '2026-09-01', uids: [A, B] },
    { date: '2026-09-02', uids: [B, G] }
  ],
  next_days: [
    { date: '2026-09-01', uids: [A, B] },
    { date: '2026-09-02', uids: [B, G] }
  ],
  candidate_publication_id: 'p_cand',
  candidate_source_id: 'src_1', candidate_policy_id: 'pol_1',
  policy_digest: 'pd_1', source_digest: 'sd_1', content_hash: 'ch_1'
};
const pre = (over) => C.preflight(Object.assign({}, BASE, over || {}));
const NOW = '2026-09-03T04:30:00.000Z';   // חצי שעה אחרי שעון ה-probe

/* ==================================================================
 * 1 · המקרה הנקי
 * ================================================================== */

const clean = pre();
eq('1.1 סידור זהה אינו חוסם', clean.blocked, false);
eq('1.2 ואין ממצאים', clean.findings, []);
ok('1.3 הדוח חתום', typeof clean.signature === 'string' && clean.signature.length === 64);
ok('1.4 והחתימה מאמתת את עצמה', C.verifyPreflight(clean));

/* ==================================================================
 * 2 · ⭐ הכיוון · מי שהיה משובץ ואיננו
 * ================================================================== */

const missing = pre({ next_days: [
  { date: '2026-09-01', uids: [A] },
  { date: '2026-09-02', uids: [B, G] }
] });
/* ⭐⭐ ההכרעה הזאת **התהפכה במפורש**, ולא כי הבדיקה הפריעה.
 *
 * הגרסה הראשונה חסמה כאן. אבל „אדם שהיה משובץ ביום הזה ואינו
 * משובץ בו בחדש" הוא **מה שמנוע סידור חדש עושה** — ולכן השער הזה
 * חסם תמיד: לא בקצה, אלא במעבר הראשון של כל תחנה. Codex גילה את
 * זה בהרצת אמולטור אמיתית (20 ימים חסומים), ואישר את ההיפוך.
 *
 * מה שלא השתנה: הממצא **נספר, מפורט לפי יום, ודורש אישור מפורש
 * הקשור לחתימת הדוח**. ומה שחוסם — יום ריק, זר, כפילות, מחוץ
 * לטווח — נשאר חוסם, ונבדק בסעיף 3. */
eq('2.1 אדם שנעלם אינו חוסם — הוא שינוי סידור', missing.blocked, false);
eq('2.2 והסיבה היא היעלמות', missing.findings[0].reason, REASON.MISSING);
eq('2.3 והספירה מדויקת', missing.findings[0].count, 1);
eq('2.4 וביום הנכון', missing.findings[0].date, '2026-09-01');

// ⭐ ונספר בנפרד, עם פירוט לפי יום — מספר לבדו אינו אומר למפקד
// אם 20 שינויים מרוכזים ביומיים או פרוסים על חודש.
eq('2.4a השינויים נספרים', missing.changes.count, 1);
eq('2.4b ומפורטים לפי יום', missing.changes.days, [{ date: '2026-09-01', count: 1 }]);
ok('2.4c ואין בפירוט מזהה אדם',
  JSON.stringify(missing.changes).indexOf(A) === -1
  && JSON.stringify(missing.changes).indexOf(B) === -1);

// ⭐ והכיוון ההפוך אינו סימטרי: תוספת אינה כשל.
const added = pre({ next_days: [
  { date: '2026-09-01', uids: [A, B, G] },
  { date: '2026-09-02', uids: [B, G] }
] });
eq('2.5 תוספת אינה חוסמת', added.blocked, false);

/* ==================================================================
 * 3 · זר · כפול · יום ריק · מחוץ לטווח
 * ================================================================== */

/* ⭐ פיקסצ'ר שחוסם **באמת**, ולא בגלל MISSING. אחרי ההיפוך, דוח
 * עם היעלמות בלבד אינו חסום, ולכן בדיקות ה„חסום" חייבות פיקסצ'ר
 * שנשען על סיבה חוסמת. */
const foreign = pre({ next_days: [
  { date: '2026-09-01', uids: [A, B, Z] },
  { date: '2026-09-02', uids: [B, G] }
] });
eq('3.1 שיבוץ למי שאינו במקור חוסם', foreign.blocked, true);
eq('3.2 בקוד זר', foreign.by_reason[REASON.FOREIGN], 1);
const foreignBlocking = foreign;

const dup = pre({ next_days: [
  { date: '2026-09-01', uids: [A, B, B] },
  { date: '2026-09-02', uids: [B, G] }
] });
eq('3.3 כפילות חוסמת', dup.blocked, true);
eq('3.4 בקוד כפילות', dup.by_reason[REASON.DUPLICATE], 1);

const emptyDay = pre({ next_days: [{ date: '2026-09-02', uids: [B, G] }] });
eq('3.5 יום שהתרוקן חוסם', emptyDay.blocked, true);
// ⭐ וזה העיקר בהיפוך: יום ריק חוסם **למרות** ש-MISSING אינו חוסם.
// אם השניים היו נופלים יחד, ההיפוך היה פותח את הלוח הריק.
ok('3.6 ומדווח גם היעלמות וגם יום ריק',
  emptyDay.by_reason[REASON.EMPTY_DAY] === 1
  && emptyDay.by_reason[REASON.MISSING] === 2);

const outside = pre({ next_days: BASE.next_days.concat([{ date: '2026-09-20', uids: [A] }]) });
eq('3.7 יום מחוץ לטווח שנבדק חוסם', outside.blocked, true);
eq('3.8 בקוד מחוץ לטווח', outside.by_reason[REASON.OUT_OF_RANGE], 1);

/* ==================================================================
 * 4 · ⭐ אין מידע אישי בדוח
 *
 * הדוח נשמר, מוצג ונכנס ליומן. שלושה מקומות שבהם uid לא צריך להיות.
 * ================================================================== */

const leaky = JSON.stringify(pre({ next_days: [{ date: '2026-09-02', uids: [Z] }] }));
for (const uid of [A, B, G, Z]) {
  ok('4.1 אין uid בדוח (' + uid + ')', leaky.indexOf(uid) === -1);
}
eq('4.2 לממצא יש תאריך, סיבה ומספר בלבד',
  Object.keys(missing.findings[0]).sort(), ['count', 'date', 'reason']);
ok('4.3 כל הסיבות מהרשימה הסגורה',
  outside.findings.every((f) => Object.values(REASON).indexOf(f.reason) !== -1));

/* ==================================================================
 * 5 · ⭐ דטרמיניזם · אותו קלט, אותה חתימה
 * ================================================================== */

eq('5.1 שתי הרצות נותנות אותה חתימה', pre().signature, pre().signature);

// סדר הימים בקלט אינו משנה את התוצאה.
const reordered = pre({
  legacy_days: BASE.legacy_days.slice().reverse(),
  next_days: BASE.next_days.slice().reverse()
});
eq('5.2 סדר הימים אינו משנה חתימה', reordered.signature, clean.signature);

/* ⭐ 5.3 התהפכה, ובכוונה.
 *
 * קודם הזמן **לא** נכנס לחתימה, ו-5.3 אכפה את זה. Codex הצביע על
 * התוצאה: דוח שאינו נושא את זמנו אי אפשר להחשיב כישן — אפשר לשנות
 * `generated_at` בלי לשבור חתימה, ואז דוח מלפני יומיים נראה טרי.
 *
 * לכן הזמן והתפוגה נמצאים עכשיו **בתוך** הגוף החתום. המחיר: שתי
 * הרצות בזמנים שונים נותנות חתימות שונות. זה נכון — הן באמת שני
 * דוחות שונים, כי כל אחד מהם מתאר רגע אחר.
 *
 * הדטרמיניזם שנשאר הוא זה שחשוב: **אותו זמן ואותו קלט → אותה
 * חתימה**, וזה מה ש-5.1 ו-5.2 בודקים. */
const other = mod.createCutover({ hash, clock: () => '2030-01-01T00:00:00.000Z' });
ok('5.3 הזמן נכנס לחתימה, ולכן אי אפשר להאריך תוקף בלי לשבור אותה',
  other.preflight(BASE).signature !== clean.signature);
ok('5.4 והזמן והתפוגה נשמרים בדוח',
  other.preflight(BASE).generated_at === '2030-01-01T00:00:00.000Z'
  && typeof other.preflight(BASE).expires_at === 'string');
// שינוי ידני של התפוגה שובר את החתימה — זו כל הנקודה.
const stretched = Object.assign({}, clean, { expires_at: '2099-01-01T00:00:00.000Z' });
ok('5.4b הארכת תוקף ידנית שוברת את החתימה', C.verifyPreflight(stretched) === false);

// חתימה שנגעו בה אינה מאמתת.
const tampered = Object.assign({}, foreignBlocking, { blocked: false });
ok('5.5 שינוי blocked שובר את החתימה', C.verifyPreflight(tampered) === false);
// ⭐ וגם הספירה שהמפקד אישר לפיה מוגנת: 20 אינו 200.
ok('5.5b שינוי ספירת השינויים שובר את החתימה',
  C.verifyPreflight(Object.assign({}, missing,
    { changes: { count: 999, days: [] } })) === false);
const tampered2 = Object.assign({}, clean, { findings: [{ date: 'x', reason: 'y', count: 1 }] });
ok('5.6 שתילת ממצא שוברת את החתימה', C.verifyPreflight(tampered2) === false);

/* ==================================================================
 * 6 · המעבר · מה מותר
 * ================================================================== */

const candidate = { publication_id: 'p_cand', status: 'prepared', snapshot_complete: true };
const promo = (over) => C.decidePromotion(Object.assign({
  from_mode: 'shadow', to_mode: 'new', expected_mode: 'shadow',
  candidate, expected_candidate_id: 'p_cand', preflight: clean,
  candidate_source_id: 'src_1', candidate_policy_id: 'pol_1',
  now: NOW,
  policy_digest: 'pd_1', source_digest: 'sd_1', content_hash: 'ch_1'
}, over || {}));

eq('6.1 shadow→new עם הכול תקין עובר', promo().publication_id, 'p_cand');

// ⭐ off→new אינו מותר. מעבר ישיר מכבוי לחי מדלג על השלב שבו
// בכלל אפשר לבדוק משהו.
throwsCode('6.2 off→new אסור',
  () => promo({ from_mode: 'off', expected_mode: 'off' }), CODE.TRANSITION_FORBIDDEN);
eq('6.3 off→shadow מותר',
  promo({ from_mode: 'off', to_mode: 'shadow', expected_mode: 'off' }).allowed, true);
eq('6.4 shadow→off מותר תמיד',
  promo({ to_mode: 'off' }).allowed, true);

// ⭐ כיבוי לעולם אינו דורש מועמד ואינו נחסם. זה שסתום הביטחון:
// אם המנוע החדש מתנהג רע, חייבת להיות דרך אחת לכבות אותו מיד.
eq('6.5 כיבוי אינו דורש מועמד',
  promo({ to_mode: 'off', candidate: null, preflight: null,
    expected_candidate_id: null }).requires_candidate, false);
eq('6.6 גם new→off אינו נחסם',
  promo({ from_mode: 'new', to_mode: 'off', expected_mode: 'new',
    candidate: null, preflight: null }).allowed, true);

throwsCode('6.7 מצב שאינו מוכר נדחה',
  () => promo({ to_mode: 'live' }), CODE.MODE_UNKNOWN);
throwsCode('6.8 מעבר לאותו מצב נדחה',
  () => promo({ to_mode: 'shadow' }), CODE.TRANSITION_FORBIDDEN);

/* ==================================================================
 * 7 · ⭐ מה חייב להיות נכון ברגע ההחלטה
 * ================================================================== */

throwsCode('7.1 בלי expected_mode נדחה',
  () => promo({ expected_mode: undefined }), CODE.EXPECTED_MODE);
throwsCode('7.2 expected_mode שאינו תואם נדחה',
  () => promo({ expected_mode: 'off' }), CODE.EXPECTED_MODE);

throwsCode('7.3 מעבר ל-new בלי מועמד נדחה',
  () => promo({ candidate: null }), CODE.CANDIDATE_REQUIRED);
throwsCode('7.4 מועמד שאינו „מוכן" נדחה',
  () => promo({ candidate: { publication_id: 'p_cand', status: 'staging', snapshot_complete: true } }),
  CODE.CANDIDATE_NOT_PREPARED);
throwsCode('7.5 מועמד עם תמונה חלקית נדחה',
  () => promo({ candidate: { publication_id: 'p_cand', status: 'prepared', snapshot_complete: false } }),
  CODE.CANDIDATE_NOT_PREPARED);
throwsCode('7.6 מועמד שאינו זה שאושר נדחה',
  () => promo({ expected_candidate_id: 'p_other' }), CODE.CANDIDATE_MISMATCH);
throwsCode('7.7 פרסום שכבר פעיל נדחה',
  () => promo({ active_publication_id: 'p_cand' }), CODE.ALREADY_ACTIVE);

throwsCode('7.8 בלי preflight נדחה',
  () => promo({ preflight: null }), CODE.PREFLIGHT_REQUIRED);
throwsCode('7.9 preflight חסום נדחה',
  () => promo({ preflight: foreignBlocking }), CODE.PREFLIGHT_FAILED);
throwsCode('7.10 preflight עם חתימה שבורה נדחה',
  () => promo({ preflight: tampered }), CODE.PREFLIGHT_STALE);
throwsCode('7.11 preflight על פרסום אחר נדחה',
  () => promo({ preflight: pre({ candidate_publication_id: 'p_zzz' }) }), CODE.PREFLIGHT_STALE);

// ⭐ ה-digests החיים נבדקים שוב כאן. מדיניות שהשתנתה מאז הבדיקה
// הופכת את הדוח לתיאור של משהו שכבר לא קיים.
/* ⭐ טריות וקשירה למועמד — שניהם נוספו אחרי ביקורת Codex. */
throwsCode('7.11a דוח שפג נדחה',
  () => promo({ now: '2026-09-03T09:00:00.000Z' }), CODE.PREFLIGHT_EXPIRED);
ok('7.11b ורגע לפני התפוגה עדיין עובר',
  !!promo({ now: '2026-09-03T05:59:00.000Z' }).publication_id);
throwsCode('7.11c בלי זמן נוכחי אין דרך לדעת אם פג',
  () => promo({ now: undefined }), CODE.SHAPE);
/* ⭐ הסרת התפוגה נתפסת על ידי **החתימה**, לא על ידי בדיקת הטריות —
 * כי `expires_at` נמצא בתוך הגוף החתום. זה הסדר הנכון: דוח שנגעו בו
 * נדחה כמזויף ולא כישן. בדקתי את הקוד בפועל ולא את מה שציפיתי. */
throwsCode('7.11d דוח שהתפוגה הוסרה ממנו נדחה כמזויף',
  () => promo({ preflight: Object.assign({}, clean, { expires_at: null }) }),
  CODE.PREFLIGHT_STALE);

// מועמד שנבנה על תצורה אחרת מזו שהדוח נבדק עליה.
throwsCode('7.11e מקור אחר מזה שהדוח נבדק עליו',
  () => promo({ candidate_source_id: 'src_2' }), CODE.CANDIDATE_CONFIG);
throwsCode('7.11f מדיניות אחרת מזו שהדוח נבדק עליה',
  () => promo({ candidate_policy_id: 'pol_2' }), CODE.CANDIDATE_CONFIG);
throwsCode('7.11g בלי תצורת המועמד',
  () => promo({ candidate_source_id: undefined }), CODE.CANDIDATE_CONFIG);

throwsCode('7.12 מדיניות שהשתנתה נדחית',
  () => promo({ policy_digest: 'pd_2' }), CODE.DIGEST_MISMATCH);
throwsCode('7.13 מקור שהשתנה נדחה',
  () => promo({ source_digest: 'sd_2' }), CODE.DIGEST_MISMATCH);
throwsCode('7.14 תוכן שהשתנה נדחה',
  () => promo({ content_hash: 'ch_2' }), CODE.DIGEST_MISMATCH);
throwsCode('7.15 חתימה חיה חסרה נדחית',
  () => promo({ policy_digest: undefined }), CODE.DIGEST_MISMATCH);

/* ⭐ שינויי שיבוץ · לא חוסמים, אבל לא עוברים בשקט ═══ */

const changeReport = missing;
throwsCode('7.16 שינויי שיבוץ בלי אישור נדחים',
  () => promo({ preflight: changeReport }), CODE.CHANGES_UNACKNOWLEDGED);
throwsCode('7.17 אישור של דוח אחר נדחה',
  () => promo({ preflight: changeReport, accept_changes: clean.signature }),
  CODE.CHANGES_UNACKNOWLEDGED);
ok('7.18 אישור הקשור לדוח הזה עובר',
  promo({ preflight: changeReport, accept_changes: changeReport.signature })
    .publication_id === 'p_cand');
// ⭐ ודוח בלי שינויים אינו דורש אישור מיותר.
ok('7.19 דוח נקי אינו דורש אישור', !!promo().publication_id);

/* ==================================================================
 * 8 · קלט פגום נופל סגור
 * ================================================================== */

throwsCode('8.1 יום בלי תאריך', () => pre({ next_days: [{ uids: [A] }] }), CODE.SHAPE);
throwsCode('8.2 יום שהשיבוצים בו אינם מערך',
  () => pre({ next_days: [{ date: '2026-09-01', uids: 'A' }] }), CODE.SHAPE);
throwsCode('8.3 שיבוץ בלי מזהה',
  () => pre({ next_days: [{ date: '2026-09-01', uids: [''] }] }), CODE.SHAPE);
throwsCode('8.4 בלי רשימת הרשאה', () => pre({ allowed_uids: undefined }), CODE.SHAPE);
throwsCode('8.5 רשימת הרשאה עם ערך פגום',
  () => pre({ allowed_uids: [A, 42] }), CODE.SHAPE);
throwsCode('8.6 בלי תחנה', () => pre({ station_id: '' }), CODE.SHAPE);
ok('8.7 המודול דורש hash', !!caught(() => mod.createCutover({ clock: () => 'x' })));
ok('8.8 והמודול דורש clock', !!caught(() => mod.createCutover({ hash })));

/* ==================================================================
 * 9 · החוזה מול הרנטיים
 * ================================================================== */

function extractFn(src, signature) {
  const at = src.indexOf(signature);
  if (at === -1) return null;
  const end = src.indexOf('\n}\n', at);
  return end === -1 ? null : src.slice(at, end + 2);
}

const mirror = extractFn(SRC, 'function stable(value) {');
const engine = extractFn(RUNTIME_SRC, 'function stable(value) {');
ok('9.1 המראה של stable() קיימת', !!mirror);
ok('9.2 stable() של הרנטיים אותר', !!engine);
// ⭐ זהות בטקסט, ולא רק תוצאה זהה על הדוגמה הזאת. חתימה שנחתמה
// בקנוניזציה אחרת נכתבת יפה ונדחית בבדיקה — הרבה אחרי המעבר.
ok('9.3 המראה זהה בטקסט לרנטיים',
  !!mirror && !!engine && mirror.split('isPlainObject').join('plain') === engine);

ok('9.4 off→new אינו קיים בטבלת המעברים',
  SRC.indexOf("'off->new'") === -1);
ok('9.5 הטבלה מוקפאת', /TRANSITIONS = Object\.freeze\(/.test(SRC));
ok('9.6 קודי הסיבה מוקפאים', /REASON = Object\.freeze\(/.test(SRC));
ok('9.7 המודול אינו נוגע ב-Firebase',
  !/require\(['"](firebase|@google-cloud)/.test(SRC));
ok('9.8 ואין בו שעון או אקראיות משלו',
  !/Date\.now\(|Math\.random\(|new Date\(\)/.test(SRC));

/* ==================================================================
 * 10 · ⭐ מוטציות · האם הבדיקה הזאת מסוגלת ליפול
 * ================================================================== */

function mutate(label, from, to, check) {
  const next = SRC.replace(from, to);
  if (next === SRC) {
    fails.push('10 ' + label + ' — דפוס המוטציה לא נמצא; המוטציה לא בדקה כלום');
    return;
  }
  let built = null;
  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function('module', 'exports', next + '\nreturn module.exports;');
    const box = { exports: {} };
    const out = factory(box, box.exports);
    built = out.createCutover({ hash, clock: () => '2026-09-03T04:00:00.000Z' });
  } catch (e) {
    ok('10 ' + label, true);
    return;
  }
  let survived = true;
  try { survived = check(built) !== false; } catch (e) { survived = false; }
  ok('10 ' + label, survived === false, 'המוטציה שרדה');
}

// אם ההיעלמות מפסיקה לחסום — אדם נעלם מהלוח ואיש לא יידע.
mutate('10.1 היעלמות מפסיקה לחסום',
  'for (const uid of wasSet) if (!nowSet.has(uid)) missing += 1;',
  'for (const uid of wasSet) if (false) missing += 1;',
  (m) => m.preflight(Object.assign({}, BASE, { next_days: [
    { date: '2026-09-01', uids: [A] }, { date: '2026-09-02', uids: [B, G] }] })).blocked);

mutate('10.2 שיבוץ זר מפסיק לחסום',
  'for (const uid of nowSet) if (!allowed.has(uid)) foreign += 1;',
  'for (const uid of nowSet) if (false) foreign += 1;',
  (m) => m.preflight(Object.assign({}, BASE, { next_days: [
    { date: '2026-09-01', uids: [A, B, Z] }, { date: '2026-09-02', uids: [B, G] }] })).blocked);

/* ⭐ המוטציה הותאמה להיפוך: ה„ממצא שחוסם" הוא עכשיו חברות
 * ב-`BLOCKING`, והתרחיש שנבדק הוא **יום שהתרוקן** — כי היעלמות
 * לבדה כבר אינה אמורה לחסום. */
mutate('10.3 ממצא חוסם מפסיק לחסום',
  'const blocked = findings.some((item) => BLOCKING.indexOf(item.reason) !== -1);',
  'const blocked = false;',
  (m) => m.preflight(Object.assign({}, BASE,
    { next_days: [{ date: '2026-09-02', uids: [B, G] }] })).blocked);

/* ⭐⭐ והמוטציה שההיפוך הזה מחייב: יום ריק **חייב** להישאר חוסם.
 * אם מישהו יעביר גם אותו לצד המדווח, הלוח הריק חוזר בשקט. */
mutate('10.3b יום ריק עובר לצד המדווח',
  'const BLOCKING = Object.freeze([\n  REASON.FOREIGN, REASON.DUPLICATE, REASON.EMPTY_DAY, REASON.OUT_OF_RANGE\n]);',
  'const BLOCKING = Object.freeze([REASON.FOREIGN, REASON.DUPLICATE, REASON.OUT_OF_RANGE]);',
  (m) => m.preflight(Object.assign({}, BASE,
    { next_days: [{ date: '2026-09-02', uids: [B, G] }] })).blocked);

/* ⭐ ואם האישור מפסיק להיקשר לחתימה — אישור לדוח אחד חל על אחר. */
mutate('10.3c האישור מתנתק מהחתימה',
  'if (input.accept_changes !== report.signature) {', 'if (false) {',
  (m) => {
    const rep = m.preflight(Object.assign({}, BASE, { next_days: [
      { date: '2026-09-01', uids: [A] }, { date: '2026-09-02', uids: [B, G] }] }));
    const e = caught(() => m.decidePromotion({
      from_mode: 'shadow', to_mode: 'new', expected_mode: 'shadow',
      candidate, expected_candidate_id: 'p_cand', preflight: rep,
      candidate_source_id: 'src_1', candidate_policy_id: 'pol_1', now: NOW,
      accept_changes: 'חתימה-של-דוח-אחר',
      policy_digest: 'pd_1', source_digest: 'sd_1', content_hash: 'ch_1' }));
    return !!e && e.code === CODE.CHANGES_UNACKNOWLEDGED;
  });

// ⭐ המוטציה החשובה: off→new נפתח.
mutate('10.4 off→new נפתח',
  "  'shadow->new': true,", "  'shadow->new': true,\n  'off->new': true,",
  (m) => {
    const e = caught(() => m.decidePromotion({
      from_mode: 'off', to_mode: 'new', expected_mode: 'off',
      candidate, expected_candidate_id: 'p_cand', preflight: clean,
      candidate_source_id: 'src_1', candidate_policy_id: 'pol_1', now: NOW,
      candidate_source_id: 'src_1', candidate_policy_id: 'pol_1', now: NOW,
      policy_digest: 'pd_1', source_digest: 'sd_1', content_hash: 'ch_1' }));
    return !!e && e.code === CODE.TRANSITION_FORBIDDEN;
  });

mutate('10.5 preflight חסום מפסיק לעצור',
  'if (report.blocked === true) {', 'if (false) {',
  (m) => {
    const e = caught(() => m.decidePromotion({
      from_mode: 'shadow', to_mode: 'new', expected_mode: 'shadow',
      candidate, expected_candidate_id: 'p_cand', preflight: missing,
      candidate_source_id: 'src_1', candidate_policy_id: 'pol_1', now: NOW,
      policy_digest: 'pd_1', source_digest: 'sd_1', content_hash: 'ch_1' }));
    return !!e && e.code === CODE.PREFLIGHT_FAILED;
  });

mutate('10.6 חתימת ה-preflight מפסיקה להיבדק',
  'if (!verifyPreflight(report)) {', 'if (false) {',
  (m) => {
    const e = caught(() => m.decidePromotion({
      from_mode: 'shadow', to_mode: 'new', expected_mode: 'shadow',
      candidate, expected_candidate_id: 'p_cand', preflight: tampered,
      candidate_source_id: 'src_1', candidate_policy_id: 'pol_1', now: NOW,
      policy_digest: 'pd_1', source_digest: 'sd_1', content_hash: 'ch_1' }));
    return !!e && e.code === CODE.PREFLIGHT_STALE;
  });

mutate('10.7 המועמד מפסיק להידרש',
  'if (!isPlainObject(candidate) || !isNonEmptyString(candidate.publication_id)) {',
  'if (false) {',
  (m) => {
    const e = caught(() => m.decidePromotion({
      from_mode: 'shadow', to_mode: 'new', expected_mode: 'shadow',
      candidate: null, expected_candidate_id: 'p_cand', preflight: clean,
      candidate_source_id: 'src_1', candidate_policy_id: 'pol_1', now: NOW,
      policy_digest: 'pd_1', source_digest: 'sd_1', content_hash: 'ch_1' }));
    return !!e && e.code === CODE.CANDIDATE_REQUIRED;
  });

mutate('10.8 expected_mode מפסיק להיבדק',
  'if (input.expected_mode !== from) {', 'if (false) {',
  (m) => {
    const e = caught(() => m.decidePromotion({
      from_mode: 'shadow', to_mode: 'new', expected_mode: 'off',
      candidate, expected_candidate_id: 'p_cand', preflight: clean,
      candidate_source_id: 'src_1', candidate_policy_id: 'pol_1', now: NOW,
      policy_digest: 'pd_1', source_digest: 'sd_1', content_hash: 'ch_1' }));
    return !!e && e.code === CODE.EXPECTED_MODE;
  });

mutate('10.9 ה-digests מפסיקים להיבדק',
  "for (const field of ['policy_digest', 'source_digest', 'content_hash']) {",
  'for (const field of []) {',
  (m) => {
    const e = caught(() => m.decidePromotion({
      from_mode: 'shadow', to_mode: 'new', expected_mode: 'shadow',
      candidate, expected_candidate_id: 'p_cand', preflight: clean,
      candidate_source_id: 'src_1', candidate_policy_id: 'pol_1', now: NOW,
      policy_digest: 'pd_2', source_digest: 'sd_1', content_hash: 'ch_1' }));
    return !!e && e.code === CODE.DIGEST_MISMATCH;
  });

mutate('10.10 הקנוניזציה מוחלפת ב-JSON.stringify',
  "return '{' + Object.keys(value).sort()", "return JSON.stringify(value); // eslint-disable-line",
  (m) => {
    const r = m.preflight(BASE);
    return r.signature === clean.signature;
  });

mutate('10.11 כפילות מפסיקה להיחשב',
  'if (now.length !== nowSet.size) {', 'if (false) {',
  (m) => m.preflight(Object.assign({}, BASE, { next_days: [
    { date: '2026-09-01', uids: [A, B, B] }, { date: '2026-09-02', uids: [B, G] }] })).blocked);

mutate('10.12 מועמד שאינו „מוכן" מתקבל',
  "if (candidate.status !== 'prepared') {", 'if (false) {',
  (m) => {
    const e = caught(() => m.decidePromotion({
      from_mode: 'shadow', to_mode: 'new', expected_mode: 'shadow',
      candidate: { publication_id: 'p_cand', status: 'staging', snapshot_complete: true },
      expected_candidate_id: 'p_cand', preflight: clean,
      candidate_source_id: 'src_1', candidate_policy_id: 'pol_1', now: NOW,
      policy_digest: 'pd_1', source_digest: 'sd_1', content_hash: 'ch_1' }));
    return !!e && e.code === CODE.CANDIDATE_NOT_PREPARED;
  });

/* ==================================================================
 * 11 · ⭐ הגבול שבין החתימה לאחסון
 *
 * הבאג שנמצא רק באמולטור: `expires_at` נחתם כמחרוזת ISO, נשמר
 * כ-`Date`, וחזר כ-`Timestamp`. `stable()` ראה ערך אחר מזה שנחתם,
 * החתימה לא תאמה לעצמה, **וכל מעבר נחסם** — על דוח תקין לחלוטין.
 *
 * שום בדיקה טהורה לא יכלה לראות את זה, כי בזיכרון `Date` נשאר
 * `Date`. הסעיף הזה הוא הניסיון להפוך אותו לכן-ניתן-לראות: הוא
 * מזייף את מסע ההלוך-ושוב במקום להמתין לאמולטור.
 * ================================================================== */

// ⭐ „Timestamp" של Firestore, כפי שהוא חוזר מהדיסק.
function asTimestamp(iso) {
  const ms = Date.parse(iso);
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1e6,
    toDate() { return new Date(ms); }
  };
}
function roundTrip(report, shape) {
  return Object.assign({}, report, {
    generated_at: shape(report.generated_at),
    expires_at: shape(report.expires_at)
  });
}

ok('11.1 דוח שחזר כ-Timestamp מאמת',
  C.verifyPreflight(roundTrip(clean, asTimestamp)),
  'זה בדיוק המצב שחסם כל מעבר: אותו רגע, ייצוג אחר');
ok('11.2 דוח שחזר כ-Date מאמת',
  C.verifyPreflight(roundTrip(clean, (v) => new Date(Date.parse(v)))));
ok('11.3 דוח שחזר כמספר מילישניות מאמת',
  C.verifyPreflight(roundTrip(clean, (v) => Date.parse(v))));

// ⭐ ובכיוון ההפוך: שינוי ה**רגע** עדיין שובר. הנרמול אינו מרכך.
ok('11.4 הזזת הזמן בשנייה אחת שוברת את החתימה',
  !C.verifyPreflight(Object.assign({}, clean,
    { expires_at: new Date(Date.parse(clean.expires_at) + 1000).toISOString() })),
  'אפשר להאריך תוקף בלי לשבור חתימה');

// והמעבר עצמו עובר עם דוח שחזר מהדיסק.
ok('11.5 מעבר מאושר על דוח שחזר כ-Timestamp',
  promo({ preflight: roundTrip(clean, asTimestamp) }).publication_id === 'p_cand');

/* --- העוגנים · מה ש-TTL לבדו אינו סוגר --- */

const anchored = pre({ legacy_revision: 'leg_1', predecessor_publication_id: 'p_prev' });
const withAnchors = (over) => promo(Object.assign({
  preflight: anchored, legacy_revision: 'leg_1', predecessor_publication_id: 'p_prev'
}, over || {}));

ok('11.6 העוגנים בגוף החתום',
  anchored.legacy_revision === 'leg_1'
  && anchored.predecessor_publication_id === 'p_prev');
ok('11.7 ושינוי עוגן שובר את החתימה',
  !C.verifyPreflight(Object.assign({}, anchored, { legacy_revision: 'leg_2' })));
eq('11.8 עם עוגנים תואמים המעבר עובר', withAnchors().publication_id, 'p_cand');

throwsCode('11.9 סידור legacy שפורסם מחדש חוסם',
  () => withAnchors({ legacy_revision: 'leg_2' }), CODE.PREFLIGHT_STALE);
throwsCode('11.10 החלפת הפרסום הפעיל חוסמת',
  () => withAnchors({ predecessor_publication_id: 'p_other' }), CODE.PREFLIGHT_STALE);

/* ⭐ והכיוון החשוב יותר: ערך חי שנשמט אינו „מותר". דוח שנחתם עם
 * עוגן, מול קריאה שלא העבירה אותו, חייב להיחסם — אחרת החוזה נסגר
 * בשקט ברגע שמישהו ישכח שדה. */
throwsCode('11.11 עוגן שנשמט בקריאה חוסם',
  () => withAnchors({ legacy_revision: undefined }), CODE.PREFLIGHT_STALE);
throwsCode('11.12 ודוח בלי עוגן מול עולם שיש בו חוסם',
  () => promo({ legacy_revision: 'leg_1' }), CODE.PREFLIGHT_STALE);

/* ==================================================================
 * 12 · ⭐ מוטציות על מה שנוסף כאן
 * ================================================================== */

/* ⭐ אם הנרמול באימות מבוטל — הבאג המקורי חוזר, ודוח שחזר מהדיסק
 * מפסיק לאמת. המוטציה בונה את הדוח ב**מוטנט עצמו**, כדי שהחתימה
 * תהיה שלו, ואז מעבירה אותו את אותו מסע. */
mutate('12.1 ביטול הנרמול באימות מחזיר את הבאג',
  '? null : canonicalTime(report.expires_at),',
  '? null : report.expires_at,',
  (built) => built.verifyPreflight(roundTrip(built.preflight(BASE), asTimestamp)));

// אם בדיקת העוגנים מפסיקה לחסום — דוח מתאר עולם שכבר זז.
mutate('12.2 העוגנים מפסיקים לחסום',
  'if (live !== atCheck) {', 'if (false) {',
  (M) => {
    const rep = M.preflight(Object.assign({}, BASE,
      { legacy_revision: 'leg_1', predecessor_publication_id: 'p_prev' }));
    const e = caught(() => M.decidePromotion({
      from_mode: 'shadow', to_mode: 'new', expected_mode: 'shadow',
      candidate, expected_candidate_id: 'p_cand', preflight: rep,
      candidate_source_id: 'src_1', candidate_policy_id: 'pol_1', now: NOW,
      legacy_revision: 'leg_CHANGED', predecessor_publication_id: 'p_prev',
      policy_digest: 'pd_1', source_digest: 'sd_1', content_hash: 'ch_1' }));
    return !!e && e.code === CODE.PREFLIGHT_STALE;
  });

/* ==================================================================
 * 13 · החוזה מול הרנטיים · השדה החתום אינו שדה התשתית
 * ================================================================== */

ok('13.1 ה-expires_at החתום אינו נדרס ב-Date',
  !/[^_]expires_at: new Date\(report\.expires_at\)/
    .test(RUNTIME_SRC.split('\n')
      .filter((l) => {
        const t = l.trim();
        return t.indexOf('*') !== 0 && t.indexOf('//') !== 0 && t.indexOf('/*') !== 0;
      }).join('\n')),
  'החתימה לא תשרוד את הדיסק');
ok('13.2 ל-TTL יש שדה נפרד משלו',
  RUNTIME_SRC.indexOf('ttl_expires_at: new Date(report.expires_at)') > -1);
ok('13.3 הרנטיים מזין את שני העוגנים',
  RUNTIME_SRC.indexOf('legacy_revision: legacy.digest') > -1
  && RUNTIME_SRC.indexOf('predecessor_publication_id: predecessorId') > -1);
ok('13.4 ⭐ ובדיקת המעבר היא שער פיקוד, לא שער מנהל',
  RUNTIME_SRC.indexOf('בדיקת המעבר למנוע החדש שמורה לפיקוד התחנה') > -1,
  'המפקד נחסם בשלב הראשון ולא יכול להגיע לאישור');

/* ==================================================================
 * סיכום
 * ================================================================== */

if (fails.length) {
  console.error('schedule-cutover-probe · נכשל');
  for (const f of fails) console.error('  ✗ ' + f);
  console.error('  ' + pass + ' עברו · ' + fails.length + ' נכשלו');
  process.exit(1);
}
console.log('schedule-cutover-probe · ' + pass + '/' + pass + ' עברו');
console.log('  כל המזהים כאן מומצאים. 17 מוטציות.');
console.log('  לא נבדק כאן: המעבר עצמו מול Firestore — הטרנזקציה, שחרור');
console.log('  ה-outbox ושתי הפעלות מתחרות. אלה דורשים אמולטור.');
