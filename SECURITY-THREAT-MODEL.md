# SECURITY-THREAT-MODEL · ResQ-102

בסיס: `origin/main` = `233901c0d6327a05b0ac87c103943a512dc9c2c7` + חבילת ההקשחה שבענף `codex/saas-hardening`.
נכתב מקריאת הקוד בפועל, לא ממסמכי תכנון. כל טענה כאן מקושרת לקובץ ולבדיקה שמכסה אותה, או מסומנת במפורש כלא מכוסה.

**מה המסמך הזה אינו:** הוא אינו ביקורת חדירה, אינו בדיקת תצורה של פרויקט Firebase חי, ואינו מכסה את שכבת התשתית (IAM, App Check בקונסולה, מפתחות reCAPTCHA, הגדרות רשת). אלה `OUT_OF_SCOPE_EXTERNAL`.

---

## 1 · נכסים

| נכס | היכן | אם נפגע |
|---|---|---|
| זהות ותפקיד | Firebase Auth custom claims (`super`, `role`, `stationId`, `districtId`, `emp`) | השתלטות על תחנה; הרשאות סידור, שכר וכוח אדם |
| מסמכי תחנה | `stations/{sid}/**` | חשיפת נוכחות, שעות, מסמכי כוח אדם, כשירויות |
| טוקני פוש | `stations/{sid}/push_tokens/{uid}` | התראות מזויפות למכשיר עובד; איתור מכשיר |
| מסמכי HR רגישים | `stations/{sid}/hr_*`, קבצים ב-Storage | מידע אישי מוגן |
| הזמנות וקמפיינים | `invitations/**`, `join_campaigns/**` | קליטת אדם לא מורשה לתחנה |
| שכבה מסחרית (חדש) | `organizations/**`, `saas_operations/**` | שינוי מכסות, חשיפת מבנה לקוחות |
| מדדים (חדש) | `metrics_daily/**` | מידע תפעולי מצרפי; **לא** מידע אישי |
| גיבויים ותצלומי שחזור | `_גיבוי/**`, תצלומי Firestore | חשיפה היסטורית רחבה יותר מהייצור |
| חומר חתימה לחנויות | מחוץ למאגר | זיוף גרסת אפליקציה |

## 2 · תוקפים והנחות

| # | תוקף | יכולת מונחת |
|---|---|---|
| A1 | אדם אקראי ברשת | שולח בקשות ל-Functions וקורא Hosting |
| A2 | עובד מאושר בתחנה | טוקן חתום תקף, יכול לשנות כל גוף בקשה |
| A3 | בעל תפקיד תחנתי (מפקד/רכזת) | כנ״ל + הרשאות תחנתיות רחבות |
| A4 | מנהל-על שה-claim שלו בוטל זה עתה | טוקן חתום ישן שעדיין לא פג |
| A5 | עובד בתחנה א׳ שמנסה לגעת בתחנה ב׳ | claims תקפים לתחנה שלו |
| A6 | ארגון א׳ מול ארגון ב׳ (חדש) | מנהל-על של הפריסה; אין "מנהל ארגון" כרשות נפרדת |
| A7 | מי שמחזיק גיבוי | קובץ גיבוי מלא |
| A8 | מפתח/סוכן שמוסיף קוד | יכול להוסיף callable או כלל Rules |

**הנחה שנבדקה ולא התאמתה:** אין "מנהל ארגון" נפרד. השכבה המסחרית היא מנהל-על בלבד, ולכן A6 אינו תוקף מורשה־חלקית אלא תרחיש בידוד נתונים.

## 3 · גבולות אמון

1. **הדפדפן אינו נאמן לעולם.** כל שדה בגוף הבקשה הוא קלט עוין.
2. **הטוקן החתום נאמן לזהות, לא למצב.** `super`/`role` נבדקים מחדש מול `admin.auth().getUser` בכל מסלול רגיש (`identity-coordinator.js`, `device-readiness-service.js`, `saas-service.js:53`, `metrics-service.js`).
3. **Firestore Rules הן קו הגנה שני, לא ראשון.** כל אוסף חדש בחבילה סגור לחלוטין (`allow read, write: if false`) והגישה עוברת callables בלבד.
4. **ספק חיצוני אינו מקור סמכות.** כשל ספק אינו מעניק הרשאה ואינו משנה סטטוס.
5. **מנוי מסחרי אינו שער תפעולי.** אין מסלול קריאת פתע/פוש/סידור/כניסה שקורא מנוי.

## 4 · איומים, הגנה, ראיה

| # | איום | תוקף | הגנה (קובץ) | בדיקה |
|---|---|---|---|---|
| T1 | לקוח בוחר תחנה בגוף הבקשה | A2 | `callerStation` (`index.js:1066`), `client-station` (`join-campaign-service.js:54`, `metrics-service.js:89`), `stationOf(claims)` (`device-readiness-service.js`) | `station-source.mjs`, `security-boundaries.mjs` §2, מוטציה |
| T2 | לקוח בוחר uid/תפקיד/מחיר | A2 | `FORBIDDEN_CLIENT_KEYS` + `exactKeys` (`saas-contract.js:59,103`) | `security-boundaries.mjs` §3 (10 שדות), מוטציה |
| T3 | claim ישן של מנהל-על | A4 | קריאה חוזרת של claims חיים (`saas-service.js:53`, `metrics-service.js`, `device-readiness-service.js`) | `security-boundaries.mjs` §3, 2 מוטציות |
| T4 | תחנה א׳ קוראת תחנה ב׳ | A5 | `inStation`/`member`/`liveStationIdentity` ב-Rules; sid מפורש בכל קריאת מנוע | `rules-test/*` (עברו אצל Codex: 768 + 2,574 + 580), `station-boundary.mjs` |
| T5 | ארגון א׳ רואה ארגון ב׳ | A6 | ארגון נקרא רק במנהל-על; `station-owned-elsewhere` מונע חטיפת תחנה | `security-boundaries.mjs` §3, `rules-test/saas-isolation.test.mjs` (עברה אצל Codex: 792 דחיות, 12/12), מוטציה |
| T6 | replay: אותו `request_id` לכוונה אחרת | A2 | `intent_fingerprint` ברשומת פעולה (`saas-service.js:77`, `join-campaign-service.js`, `device-readiness-service.js`) | בדיקות שירות + מוטציה |
| T7 | הצפה / DoS מדווח | A2 | מכסות: `metrics_quota` (60 קריאות/חשבון/יום), `cardinality` (60 צבירות/תחנה/יום), bulletin/feedback/hr quotas, נעילת כניסה | `metrics-service.test.js`, 2 מוטציות |
| T8 | enumeration של משתמשים/ארגונים | A1 | הודעה אחידה בכניסה (`index.js:1877`), `not-found` אחיד, quota לשעה בבדיקת קמפיין | `security-boundaries.mjs` §6 |
| T9 | דליפת PII ללוגים/טלמטריה | A8 | אוצר מילים סגור (`ops-telemetry-contract.js`), קטלוג מדדים סגור (15 קודים), `assertNoPii` | `security-boundaries.mjs` §5, מוטציה |
| T10 | CSV/formula injection בייצוא | A2 | `csvSafe`/`csvCell` (`join-admin-ui.js:44`, `hr-month-archive.js:88`) | `join-campaign-browser.mjs` |
| T11 | HTML injection במסך חדש | A8 | `textContent`/`createElement` בלבד | `security-boundaries.mjs` §6, מוטציה |
| T12 | prototype pollution | A2 | `UNSAFE_KEYS` (`saas-contract.js:61`), קטלוג סגור, `Object.create(null)` | `security-boundaries.mjs` §6 (התנהגותי) |
| T13 | כתיבה ישירה ל-Firestore מהדפדפן | A2 | 6 אוספים חדשים סגורים לחלוטין | `security-boundaries.mjs` §10, 2 מוטציות, `rulecheck.mjs` |
| T14 | callable חדש בלי App Check | A8 | שמורה: שוויון מדויק מול רשימת חריגים קפואה | `security-boundaries.mjs` §1, 2 מוטציות |
| T15 | כשל ספק הופך להרשאה | A1 | סטטוס לא משתנה, קוד שגיאה בלבד ביומן | `security-boundaries.mjs` §3, מוטציה |
| T16 | מנוי חוסם חירום | A8 | אין הפניה מסחרית בשום מסלול תפעולי | `security-boundaries.mjs` §9, מוטציה |
| T17 | סוד/מפתח נכנס למאגר או ל-Hosting | A8 | `.gitignore` + `hosting.ignore` (`apps/**`), סריקת עץ | `security-boundaries.mjs` §8, `hosting-privacy.mjs`, 2 מוטציות |
| T18 | שחזור גיבוי לייצור | A7/A8 | רשימת סירוב קשיחה ל-`station-102`, מקור≠יעד, allowlist, canary, create-only | `ops-disaster-restore.test.mjs` (24) |
| T19 | שחזור מחזיר טוקנים/תורים | A7 | `backup-policy.js`: 43 `exclude` לעולם לא נכנסים לתצלום | `ops-disaster-restore.test.mjs` |
| T21 | **זהות חלקית אחרי כשל באמצע השחזור** | A7/A8 | קבוצת הזהות נכתבת ב-`commitAtomic` אחד; כשל → אפס מסמכים; קבוצה מעל 500 → סירוב סגור; מתאם בלי קומיט אטומי → אין שחזור זהות | 4 בדיקות; הבדיקה נופלת על הקוד הקודם |
| T22 | **שחזור חי בלי ראיה** (מניפסט לא חתום) | A7/A8 | `--execute` דורש מפתח ≥32 תווים; הסירוב לפני הקנרית ולפני כל כתיבה | בדיקה עם מפתח ריק וקצר, אפס כתיבות |
| T23 | **שכבה מסחרית פעילה על ספק שמאבד מצב** | A8 | `RESQ_SAAS_ENABLED` fail-closed; כבוי = סירוב בשרת בכל הקריאות ובמסלול הפנימי | מטריצת ערכים + cold start + 2 מוטציות |
| T20 | מעטפת חנות מנווטת ל-origin זר | A1 | `classifyNavigation` — origin מדויק, חסימת `javascript:`/`data:`/userinfo/port | `mobile-shell.mjs` (12+ מקרים) |

## 5 · חולשות פתוחות שלא נסגרו בחבילה הזו

| # | ממצא | חומרה | למה לא נסגר כאן | מה נדרש |
|---|---|---|---|---|
| O1 | **31 callables ישנים ללא App Check**, ובהם `loginWithEmployeeNumber`, `claimPushToken`, `joinWithCode`, `sendBroadcast`, `bootstrapSuperAdmin` | גבוהה | הדלקה משנה התנהגות ייצור בכניסה ובפוש; זו הכרעת מוצר ולא תיקון אגב | הכרעת בעל המוצר + בדיקה מול לקוח אמיתי; הרשימה קפואה בבדיקה כדי שהחוב לא יגדל |
| O2 | ~~אין בדיקת Rules שרצה~~ — **נסגר**: `rules-test` רצו אצל Codex מול `demo-resq` ועברו (768 · 2,574 · 580 · 792, 12/12) | — | נותר NOT RUN בארגז בלבד (אין אמולטור) | הרצה חוזרת בכל שינוי ב-`firestore.rules` |
| O3 | `station_hash` במדדים הוא **פסאודונים הפיך במנייה** (מספר תחנות קטן) | בינונית | גיבוב אמיתי דורש מפתח שרת | `RESQ_METRICS_HASH_KEY`; בלעדיו הלוח מסמן זאת במפורש |
| O4 | שני מסרי שגיאה מבחינים בכניסה (`index.js:1891`, `:1919`) | נמוכה | מחוץ להיקף החבילה | איחוד מסר |
| O5 | ~~חתימת manifest אופציונלית גם בביצוע~~ — **נסגר**: `--execute` בלי מפתח תקין נכשל לפני הקנרית, אפס כתיבות | — | תוקן בסבב הביקורת | `RESQ_RESTORE_SIGNING_KEY` (≥32 תווים) נדרש לכל ביצוע |
| O6 | ביקורת חדירה חיצונית | — | `OUT_OF_SCOPE_EXTERNAL` | גורם חיצוני; לא נטען שבוצעה |

## 6 · מה נבדק בפועל בסבב הזה

`tests/security-boundaries.mjs` — 91 בדיקות · `tests/security-mutations.mjs` — 18 מוטציות, כולן נתפסו · `rules-test/saas-isolation.test.mjs` — נכתבה; **NOT RUN בארגז** (אין אמולטור), **הורצה אצל Codex ועברה**: 792 דחיות, 12/12.
