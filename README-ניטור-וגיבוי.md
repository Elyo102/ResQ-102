# ניטור, גיבוי וחוות דעת · נוהל עבודה

נכתב: 3.9.2026 · Claude · מבוסס על הכרעות אלדד (3.9): חוות דעת **עם זהות** ·
גיבוי Firestore **מנוהל של Firebase** · ייצוא הלוג **כמשימה במחשב של אלדד**.

מה שלא הורץ מסומן. מה שדורש את Codex (index.js, firestore.rules, firebase.json)
מרוכז בסעיף 6 — הקוד עצמו אינו נוגע בקבצים האלה.

---

## 1 · מה יש

| רכיב | קובץ | מה הוא עושה |
|---|---|---|
| יומן תקלות (שרת) | `functions/incident-log.js` | `reportIncident`: רשומה אחת לכל טביעת-אצבע (תחנה+סוג+מסך+קוד+הודעה מנורמלת) ב-`stations/{sid}/incidents/{fp}`, מונה, ראשון/אחרון, גרסאות, מסכים, דוגמה. **בלי uid/שם/דוא"ל**; ניקוי דפוסים (דוא"ל, טלפון, uid, hex, query). תקרה 500/יום/תחנה (`incident_days`). TTL 90 יום. |
| לכידה בלקוח | `incident-client.js` | `installIncidentReporter({fns, httpsCallable, version})` — מאזין ל-`error`/`unhandledrejection`, `wrapCallable(name, fn)` לפעולות שרת. עד 10 דיווחים לטעינה, אותה תקלה פעם אחת, כישלון דיווח נבלע. |
| חוות דעת (שרת) | `functions/feedback.js` | `submitFeedback`: `stations/{sid}/feedback/{f_…}` עם uid, תפקיד, מספר עובד, מסך, גרסה, קטגוריה, דירוג, טקסט **כפי שנכתב**, „מותר לפנות". מזהה נגזר מבקשה (חזרה = duplicate). 20/יום/משתמש (`feedback_quota`). |
| מסך חוות דעת | `feedback.html`, `feedback.js` | פריט „חוות דעת" בתפריט (`nav.js`). `?from=swaps.html` מסמן את מסך המקור. |
| ייצוא ללוג | `ops-export.mjs` | רץ במחשב של אלדד עם Admin. כותב `_ניטור/incidents.md`, `feedback.md`, `health.md`. פעולות טיפול: `--resolve/--ignore/--reopen <fp> --by codex`, `--mark-read --by claude`. |
| גיבוי מקומי | `ops-backup.mjs` | `git bundle --all` + zip של `_דיונים`, `_מסירה-*`, `_מסירות`, `_ניטור` → `_גיבוי/` + מניפסט SHA-256. שומר 14 אחרונים. |
| בדיקות | `functions/incident-log.test.js` (21) · `functions/feedback.test.js` (11) · `tests/ops-source.mjs` | ב-`npm run static`. |

**אין כאן:** מיזוג, פריסה, נגיעה ב-Production. הפעולות `reportIncident` ו-`submitFeedback`
**אינן מחווטות** עד ש-Codex יוסיף את השורות בסעיף 6.

---

## 2 · ייצוא הלוג — משימה במחשב של אלדד

דרישות: Node 22, `functions/node_modules` מותקן (`npm ci` ב-`functions`), והרשאת Admin:

```powershell
# פעם אחת. מפתח service-account נשמר מחוץ לריפו, ולעולם לא ב-*.json בתוך התיקייה
# (.gitignore חוסם *adminsdk*.json / *service-account*.json — אבל לא לסמוך על זה).
setx GOOGLE_APPLICATION_CREDENTIALS "C:\Users\User\.resq\station-102-ops.json"
```

הרצה ידנית:

```powershell
cd C:\Users\User\OneDrive\Desktop\Station-102\ResQ-102
node ops-export.mjs --project station-102 --station eilat_102
```

משימה יומית (07:30), Codex מגדיר:

```powershell
schtasks /Create /TN "ResQ ops-export" /SC DAILY /ST 07:30 /F ^
  /TR "cmd /c cd /d C:\Users\User\OneDrive\Desktop\Station-102\ResQ-102 && node ops-export.mjs --project station-102 --station eilat_102 >> _ניטור\export.log.md 2>&1"
```

טיפול בתקלה מהתיקייה (Codex או Claude, כשמחובר):

```powershell
node ops-export.mjs --project station-102 --station eilat_102 --resolve <fingerprint> --by codex --note "תוקן ב-42G.1"
```

**מה `_ניטור/` מכיל ומה מותר לו:** `incidents.md` ו-`health.md` — בלי מידע אישי, אפשר
לקומיט. `feedback.md` — uid, מספר עובד, טקסט חופשי: **ב-.gitignore**, לא לקומיט, לא לחדר,
לא להעתיק ממנו שמות לקוד/בדיקות.

**לא הורץ:** הסקריפט לא הורץ מול Firestore אמיתי (אין לי גישת Admin לפרויקט). פונקציות
העיצוב (`renderIncidents/renderFeedback/renderHealth`, `parseArgs`) נבדקות ב-`tests/ops-source.mjs`.
הריצה הראשונה — עם `--dry-run` — היא של Codex.

---

## 3 · גיבוי Firestore — מנוהל של Firebase

הפקודות להלן **אומתו מול התיעוד** (docs.cloud.google.com/firestore/native/docs/backups,
/use-pitr; firebase.google.com/docs/firestore/backups) ב-3.9.2026. **לא הורצו** — אין לי
גישה לפרויקט. דורש Blaze, ותפקידי IAM `roles/datastore.backupsAdmin`,
`roles/datastore.backupSchedulesAdmin`, `roles/datastore.restoreAdmin`.

```powershell
gcloud config set project station-102

# 3.1 · מה יש היום (לפני שמניחים משהו)
gcloud firestore databases describe --database='(default)'
gcloud firestore backups schedules list --database='(default)'
gcloud firestore backups list --format="table(name, database, state)"

# 3.2 · גיבוי יומי, שמירה 14 יום (מקסימום 14 שבועות = 14w). לוח אחד יומי + אחד שבועי לכל היותר.
gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=14d
gcloud firestore backups schedules create --database='(default)' --recurrence=weekly --retention=8w --day-of-week=SUN

# 3.3 · שחזור לנקודת זמן (PITR): חלון 7 ימים, קריאה ברזולוציית דקה
gcloud firestore databases update --database='(default)' --enable-pitr
gcloud firestore databases describe --database='(default)'   # earliestVersionTime, versionRetentionPeriod

# 3.4 · תרגיל שחזור — לבסיס נתונים **חדש**, לא על הייצור
gcloud firestore databases restore --source-backup=projects/station-102/locations/<LOCATION>/backups/<BACKUP_ID> --destination-database='resq-restore-drill'
# ייצוא מנקודת זמן (למשל לפני תקלה):
gcloud firestore export gs://<BUCKET> --snapshot-time=<YYYY-MM-DDTHH:MM:00Z>
```

**יעדים שאלדד צריך להכריע** (לא מוכרעים כאן):

| שאלה | הצעה לדיון | הערה |
|---|---|---|
| RPO — כמה מותר לאבד | 24 שעות (גיבוי יומי) · **דקה** עם PITR | PITR מכסה 7 ימים אחורה |
| RTO — כמה זמן מותר להיות מושבת | 4 שעות | שחזור יוצר DB חדש; צריך גם להפנות אליו את הפונקציות — זה עוד צעד |
| תרגיל | רבעוני | `resq-restore-drill` + `ops-export --project … --station …` עליו, ואז מחיקה |

**מה גיבוי DB אינו מכסה:** משתמשי Auth (הרשאות התחברות). בזמן שחזור צריך התאמה בין
`stations/*/users` ל-Auth — זה ה-identity-coordinator, וזה נושא לתרגיל, לא לנוהל הזה.

---

## 4 · גיבוי מקומי (ריפו + מסמכים)

```powershell
node ops-backup.mjs                 # → _גיבוי\resq-YYYY-MM-DD_HHMM.{bundle,zip,md}
node ops-backup.mjs --keep 30
```

שחזור ריפו: `git clone C:\...\_גיבוי\resq-2026-09-03_0730.bundle ResQ-102-restored`.
משימה שבועית: `schtasks /Create /TN "ResQ ops-backup" /SC WEEKLY /D SUN /ST 07:45 /F /TR "cmd /c cd /d C:\Users\User\OneDrive\Desktop\Station-102\ResQ-102 && node ops-backup.mjs"`.
`_גיבוי/` ב-.gitignore. **הורץ** בלינוקס (bundle + zip + מניפסט); מסלול Windows
(`Compress-Archive`) — לא הורץ.

---

## 5 · חיבור לכידת התקלות למסכים

כל מסך מכיל כבר IIFE שמציג שגיאות בפס אדום. הלכידה מתווספת בשורה אחת אחרי
`const fns = getFunctions(app, 'europe-west1');`:

```js
import { installIncidentReporter } from './incident-client.js?v=42g0';
import { APP_VERSION } from './version.js?v=42g0';
const incidents = installIncidentReporter({ fns, httpsCallable, version: APP_VERSION });
// לפעולות שרוצים לעקוב אחריהן:
const publish = incidents.wrapCallable('publishSchedule', httpsCallable(fns, 'publishSchedule'));
```

מחובר היום: `feedback.html` בלבד (מסך חדש). שאר המסכים — סבב נפרד, מסך-מסך, כי כל
אחד שייך למישהו. `firebase-messaging-sw.js` מונה נכסים ל-precache — `incident-client.js`
ו-`feedback.*` צריכים להתווסף שם אם רוצים אותם offline (לא נעשה; `tests/uxcheck.mjs`
מגדיר מה חובה).

---

## 6 · מה Codex צריך להוסיף (קבצים שאני לא נוגע בהם)

### 6.1 · `functions/index.js`

```js
const incidentLogModule = require('./incident-log');
const feedbackModule = require('./feedback');
const incidentLog = incidentLogModule.createIncidentLog({
  db, FieldValue: FV, HttpsError,
  hash: (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'),
  clock: () => new Date().toISOString()
});
const feedback = feedbackModule.createFeedback({
  db, FieldValue: FV, HttpsError,
  hash: (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'),
  clock: () => new Date().toISOString()
});
exports.reportIncident = onCall({ enforceAppCheck: true }, async (req) => incidentLog.report(req));
exports.submitFeedback = onCall({ enforceAppCheck: true }, async (req) => feedback.submit(req));
```

ו-`SNAP_COLS` (nightlySnapshot) — להוסיף `'incidents', 'feedback'` כדי שייספרו.

### 6.2 · `firestore.rules` — ארבעה אוספים, כולם שרת בלבד

```
      match /incidents/{fingerprint}  { allow read, write: if false; }
      match /incident_days/{day}      { allow read, write: if false; }
      match /feedback/{feedbackId}    { allow read, write: if false; }
      match /feedback_quota/{quotaId} { allow read, write: if false; }
```

`tests/backup-coverage.mjs` דורש ש-`functions/backup-policy.js` יכיר כל נתיב ב-rules —
ולכן יחד עם ה-rules, ארבע רשומות `policy(...)`: `incidents`/`incident_days` —
sensitivity נמוכה, humanReadable `allowed`; `feedback`/`feedback_quota` — מידע אישי,
`redacted`. (בלי ה-rules — אין לצרף ל-backup-policy, אחרת הבדיקה נופלת בכיוון השני.)

### 6.3 · `firebase.json` → `hosting.ignore`

```
"_ניטור/**", "**/_ניטור/**", "_גיבוי/**", "**/_גיבוי/**"
```

היום `*.md`, `*.zip`, `*.bundle` כבר מסוננים, ולכן הפלט (שכולו `.md`) לא עולה לאתר גם
בלי זה — אבל הגנת עומק על התיקיות עצמן היא הדבר הנכון.

### 6.4 · `firestore.indexes.json` — כבר בקומיט

TTL על `expires_at` ב-`incidents`, `incident_days`, `feedback_quota`. `feedback` — **בלי** TTL
(נשמר; מחיקה היא החלטה, לא תפוגה).

---

## 7 · מה לא נבדק

- שני ה-callables מול Firestore אמיתי/אמולטור (המודולים נבדקו על Firestore מזויף בזיכרון).
- `ops-export.mjs` מול פרויקט חי.
- מסלול Windows של `ops-backup.mjs`.
- פקודות gcloud — אומתו מהתיעוד, לא הורצו.
- מה שאין: ניטור של תורי ההודעות ומשימות שנכשלו בלי רשומה (`systemHealth` שולח דוא"ל
  ואינו כותב) — סבב הבא, אחרי שיוגדר חוזה בריאות למשימות.
