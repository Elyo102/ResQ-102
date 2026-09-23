# ResQ-102 · ספר הפעלה להתאוששות מאסון (Firestore)

עודכן: 18.9.2026 · קבצים: `ops-disaster-restore.mjs`, `ops-disaster-restore.ps1`, `tests/ops-disaster-restore.test.mjs`

> **מה זה לא.** זה לא אישור פריסה, לא אישור שחזור לייצור, ולא תחליף לגיבוי
> Firestore מנוהל (README-ניטור-וגיבוי.md §5). הצינור משחזר **רק לפרויקט
> Firebase מבודד וחד-פעמי**, ו-`station-102` חסום בקוד כיעד — בלי קשר לדגלים.

## 1. למה יש כאן פורמט תמונת-מצב משלנו

`ops-backup.mjs` (README-ניטור-וגיבוי.md §4) מגבה `repository.bundle` ו-`documents.zip`
של מסמכים פרטיים. **אין בו אף מסמך Firestore**, ואין בפרויקט מייצר ייצוא Firestore.
לכן הצינור מגדיר סכימה `resq-firestore-snapshot-v1`:

```
_גיבוי/resq-fs-<UTC>-<rand16>/
  documents.jsonl          שורה למסמך: {"path":"stations/eilat_102/users/u1","data":{...},"sha256":"<hex>"}
  snapshot-manifest.json   schema, source_project, created_at, head, policy_digest,
                           documents:{count,bytes,sha256}, identity_group:{count,sha256},
                           paths_included, paths_excluded, paths_unclassified, state: complete
  snapshot-manifest.md     אותו מידע לקריאה אנושית
  restore-runs/<run_id>/   תוצרי כל ריצת plan/restore (ראו §6)
```

`sha256` של מסמך = SHA-256 של ה-JSON **הקנוני** של `data`: מפתחות ממוינים רקורסיבית,
בלי רווחים, מספרים סופיים בלבד (`NaN`/`Infinity`/`undefined` נדחים).

קידוד ערכי Firestore בתמונה (המתאם האמיתי מקודד בגיבוי ומפענח בשחזור):

| סוג Firestore | בתמונה |
|---|---|
| Timestamp / Date | `{"__ts":"2026-09-01T00:00:00.000Z"}` ובנוסף `"__nanos"` אם יש שבריר מעבר ל-ms |
| GeoPoint | `{"__geo":{"lat":29.5,"lng":34.9}}` |
| DocumentReference | `{"__ref":"stations/eilat_102"}` |
| Bytes / Buffer | `{"__bytes":"<base64>"}` |

הסט נכתב לתיקיית stage ומועבר בשם הסופי רק אחרי אימות מלא — כמו `ops-backup.mjs`.
היעד חייב להיות בתת-העץ הפרטי `_גיבוי/` (ב-`.gitignore` וב-Hosting ignore). התמונה
מכילה מידע אישי ומזהי זהות: **לא ארטיפקט להפצה**.

## 2. הצינור

```
backup → verify → restore-plan → dry-run → isolated-restore → integrity-report
```

| שלב | פקודה | מה קורה |
|---|---|---|
| backup | `backup --source <project>` | הולך על כל האוספים (כולל תת-אוספים מתחת למסמכי אב חסרים), מסווג כל נתיב לפי `backup-policy.js`, כותב סט |
| verify | `verify --set <dir>` | מחשב מחדש sha256 לכל מסמך, ספירה/בייטים/sha256 של הקובץ, טביעת מדיניות, טביעת קבוצת הזהות |
| plan | `plan --set <dir> --target <project>` | סירובי יעד, אימות, תוכנית כתיבה מסודרת, RPO |
| restore (dry-run) | `restore --set <dir> --target <project>` | **ברירת המחדל.** אפס כתיבות, אפס SDK, אפס רשת. מפיק תוכנית ודוח לא-נמדד |
| restore (execute) | `restore ... --execute --confirm-target <project>` | קנרית, כתיבה ב-create בלבד, קריאה חוזרת של כל מסמך, דוח חתום |
| report | `report --set <dir>` | מסכם את כל הריצות בסט, מאמת טביעת דוח וחתימה |

### POSIX

```bash
node ops-disaster-restore.mjs backup --source station-102 --dry-run
node ops-disaster-restore.mjs backup --source station-102
node ops-disaster-restore.mjs verify  --set "_גיבוי/resq-fs-20260918T100000000Z-0123456789abcdef"
node ops-disaster-restore.mjs plan    --set "_גיבוי/resq-fs-..." --target resq-dr-sandbox
node ops-disaster-restore.mjs restore --set "_גיבוי/resq-fs-..." --target resq-dr-sandbox
RESQ_RESTORE_TARGET_ALLOWLIST=resq-dr-sandbox RESQ_RESTORE_SIGNING_KEY='<key>' \
  node ops-disaster-restore.mjs restore --set "_גיבוי/resq-fs-..." --target resq-dr-sandbox --execute --confirm-target resq-dr-sandbox
node ops-disaster-restore.mjs report  --set "_גיבוי/resq-fs-..."
```

### PowerShell (5.1 ו-7)

```powershell
.\ops-disaster-restore.ps1 -Command backup -Source station-102 -DryRun
.\ops-disaster-restore.ps1 -Command backup -Source station-102
.\ops-disaster-restore.ps1 -Command verify -Set "_גיבוי\resq-fs-..."
.\ops-disaster-restore.ps1 -Command plan -Set "_גיבוי\resq-fs-..." -Target resq-dr-sandbox
.\ops-disaster-restore.ps1 -Command restore -Set "_גיבוי\resq-fs-..." -Target resq-dr-sandbox
$env:RESQ_RESTORE_TARGET_ALLOWLIST = 'resq-dr-sandbox'
$env:RESQ_RESTORE_SIGNING_KEY = '<key>'
.\ops-disaster-restore.ps1 -Command restore -Set "_גיבוי\resq-fs-..." -Target resq-dr-sandbox -Execute -ConfirmTarget resq-dr-sandbox
.\ops-disaster-restore.ps1 -Command report -Set "_גיבוי\resq-fs-..."
```

העטיפה רק מאמתת ארגומנטים ומפעילה את `node`; כל הסירובים נאכפים ב-Node ואי אפשר
לעקוף אותם מהעטיפה. הרשאות: `GOOGLE_APPLICATION_CREDENTIALS` או
`gcloud auth application-default login`, כמו `ops-export.mjs`. ה-SDK נטען מ-`functions/node_modules`.

## 3. כללי הסירוב (נאכפים בקוד, נבדקים בבדיקות)

1. **ברירת מחדל dry-run.** `--execute` דורש `--confirm-target` שווה מחרוזתית ל-`--target`.
2. **רשימת סירוב קשיחה:** `station-102`, וכל מזהה שמופיע כ-`projects.default` ב-`.firebaserc`.
   מסורב גם עם `--execute --confirm-target` וגם כשהוא ב-allowlist.
3. **מקור ≠ יעד:** `source_project` במניפסט חייב להיות שונה מ-`--target`.
4. **allowlist בסביבה:** ביצוע דורש שהיעד יופיע ב-`RESQ_RESTORE_TARGET_ALLOWLIST`
   (מופרד בפסיקים). משתנה חסר → סירוב. dry-run אינו דורש אותו.
5. **אין מחיקה, אין דריסה:** `createDocument` בלבד. מסמך שכבר קיים ביעד → `skipped_exists`
   (לא שגיאה, לא נדרס).
6. **ארגומנט כפול** או פרמטר שאינו שייך לפקודה → סירוב.

## 4. מה לעולם אינו משוחזר, ולמה

המקור היחיד להחרגות הוא `functions/backup-policy.js` (`DATA_POLICIES`, 144 רשומות).
נתיב קונקרטי מותאם לתבנית המדיניות מקטע-אחר-מקטע: `{x}` תופס מקטע אחד,
`{document=**}` תופס את השאר, מקטע מילולי חייב להיות זהה, ותבנית עם יותר מקטעים
מילוליים גוברת (`config/mode` לפני `config/{docId}`).

| סיווג | מחלקות מדיניות | התנהגות | דוגמאות |
|---|---|---|---|
| `skipped_policy` | `backupPolicy: exclude` או `restorePolicy: do_not_restore` / `rebuild` | לא נצלם לסט (רק נספר ב-`paths_excluded`), לא מתוכנן, לא נכתב | `push_tokens`, `guard_outbox`, `device_readiness`, `login_attempts`, `unlock_tokens`, `*_actor_quotas`, `incidents`, `directory`, `health`, `scans`, `schedule_drafts` |
| `manual_required` | `specialized_media_export` או `specialized_restore` | נצלם, מופיע בתוכנית ובדוח, **לעולם לא נכתב אוטומטית** | `signatures`, `documents`, `faults/*/photos`, `vehicle_views`, `hr_attachments`, `hr_workforce_cases`, `hr_hours_reviews`, `attendance_correction_*` |
| `unclassified` | אין מדיניות | לא נצלם, לא נכתב. אוסף חדש בלי מדיניות הוא חוב שצריך לסגור ב-backup-policy.js | — |
| `after_parent` | `restore_after_parent` | נכתב רק אם מסמך האב נמצא ביעד (נכתב בריצה זו או כבר היה שם); אחרת `skipped_parent_not_restored` | `join_campaigns/*/registrants`, `shifts/*/{document=**}`, `hr_documents/*/revisions` |
| `identity` | `restore_with_identity_reconciliation` (= `IDENTITY_POLICY_PATHS`) | קבוצה אחת, הכול-או-כלום (§5) | `emp_index`, `meta`, `registration_requests`, `identity_operations`, `station_transfer_*`, `stations/*/users`, `roster`, `pending_users` |
| `restore` | `managed_export` + `restore` | נכתב בסדר עומק (אב לפני צאצא) | `stations/{sid}`, `config`, `shifts`, `callouts`, `hr_reports` |

למה טוקנים ותורים מוחרגים: הם או סודות (`push_tokens`, `unlock_tokens`), או מצב זמני
שנבנה מחדש מהמקור (תורי פוש, מכסות, health), או מצב שאם ישוחזר יגרום לשליחה כפולה של
התראות. שחזור שלהם היה מפר את „אין סודות ואין מידע אישי בלוגים" ואת „אין כפילויות
בתורי הפוש".

מסמכי `_resq_restore_canary/*` שנמצאו במקור לעולם אינם מועתקים.

## 5. קבוצת העקביות של הזהות (`identity_and_auth`)

Firebase UID הוא הזהות, מספר עובד ייחודי ואינו ממוחזר, ואדם שייך לתחנה אחת. שחזור
חלקי של הקבוצה (למשל `emp_index` בלי `meta/counters`) היה שובר את שלושת העקרונות.
לכן לפני **הכתיבה הראשונה** של מסמך זהות נבדקים שלושה שערים:

1. sha256 של כל מסמך זהות בסט מחושב מחדש ותואם לרשום.
2. טביעת הקבוצה במניפסט (`identity_group.sha256` = SHA-256 של רשימת ה-sha256 הממוינת) תואמת.
3. ביעד **אין** אף מסמך זהות מהסט — מצב זהות חלקי ביעד פירושו שאי אפשר להבטיח עקביות.

כישלון באחד השערים → כל הקבוצה מדולגת, אף מסמך זהות אינו נכתב, והדוח מציין
`identity_group: {status: skipped, reason}`. שאר המסמכים (לא-זהות) ממשיכים כרגיל.

**הכתיבה עצמה אטומית, לא לולאה.** שערים אינם מספיקים: הם נבדקים *לפני* הכתיבה
הראשונה, ולכן אינם מגנים מפני כשל *באמצע*. כתיבה מסמך-אחר-מסמך שנכשלת בשני
משאירה את הראשון ביעד — בדיוק הזהות החלקית שהקבוצה נועדה למנוע. לכן כל הקבוצה
נכתבת ב-`commitAtomic` אחד (batch/transaction של Firestore, הכול-או-כלום):

- כשל בקומיט → **אפס** מסמכי זהות ביעד, `reason: atomic_commit_failed`, והריצה נכשלת.
- קבוצה גדולה מ-`ATOMIC_COMMIT_LIMIT` (500, גבול ה-batch של Firestore) → **סירוב סגור**
  (`group_exceeds_atomic_commit_limit`). לא מפצלים: חצי זהות גרועה מאפס זהות.
- מתאם `firestoreApi` בלי `commitAtomic` → הקבוצה אינה משוחזרת כלל
  (`adapter_has_no_atomic_commit`). אין נפילה אחורה ללולאה.
- אחרי הקומיט כל מסמך נקרא חזרה ונבדק מול ה-sha256 שלו.

כישלון כתיבה במסמך לא-זהות עוצר את הריצה לפני קבוצת הזהות.

**Firebase Auth ו-claims:** `ops-auth-backup.mjs` מוסיף ייצוא מוצפן, אימות וייבוא
לפרויקט מבודד בלבד. פרמטרי SCRYPT נשמרים כסודות נפרדים ואינם נכנסים למניפסט.
`auth:export` אינו כולל custom claims, ולכן אחרי הייבוא יש להתאים UID ל-`users`,
`roster` ו-`emp_index`, ורק אז לבנות מחדש claims. אין להשתמש בסביבה המשוחזרת לפני
שההתאמה הושלמה ותועדה.

## 6. בדיקת שלמות לפני ואחרי

**לפני:** `verify` — כל מסמך, ספירה, בייטים, sha256 של `documents.jsonl`, `policy_digest`
מול `backup-policy.js` הנוכחי (מדיניות שהשתנתה מאז הצילום נחשבת כישלון אימות: מסווגים
מחדש רק אחרי החלטה מודעת), וטביעת קבוצת הזהות. סט שנכשל → אין שחזור, אפס כתיבות.

**קנרית:** הכתיבה הראשונה בריצת ביצוע היא `_resq_restore_canary/<run_id>`. היא נקראת
חזרה ומושווית לפני כל מסמך אמיתי. כישלון → ביטול עם אפס כתיבות נתונים.

**אחרי:** כל מסמך שנכתב נקרא חזרה ב-`getDocument`, מקודד, ומחושב לו sha256 מול הרשום.
אי-התאמה → `mismatch_after_readback[]`, `ok: false`.

תוצרי הריצה ב-`<set>/restore-runs/<run_id>/`:

| קובץ | תוכן |
|---|---|
| `restore-plan.json` / `.md` | התוכנית: `write_order`, `identity_group`, `manual_required`, `skipped_policy`, `unclassified`, `rpo` |
| `integrity-report.json` / `.md` | `written`, `skipped_exists`, `skipped_policy`, `skipped_parent_not_restored`, `manual_required`, `unclassified`, `identity_group`, `mismatch_after_readback`, `canary`, `errors` |
| `restore-manifest.json` | תקציר + `report_sha256` + חתימה |

**חתימה:** HMAC-SHA256 על ה-JSON הקנוני של הדוח, עם מפתח מ-`RESQ_RESTORE_SIGNING_KEY`
בלבד — לעולם לא קובץ במאגר. `report` מאמת `report_sha256` תמיד, ואת החתימה רק
כשהמפתח בסביבה.

**שחזור שבוצע חייב להיות חתום — אין יוצא מן הכלל.** `--execute` בלי מפתח תקין
(ריק או קצר מ-32 תווים) **נכשל לפני הקנרית ולפני כל כתיבה**, עם אפס מסמכים ביעד.
הסיבה: דוח בלי חתימה אינו ראיה — אי אפשר להוכיח מאוחר יותר מה נכתב, מאיזה סט
ועל ידי מי. גם ריצה שנכשלה (אי-התאמה בקריאה חוזרת, קנרית) מפיקה מניפסט **חתום**,
כי היא ריצה שבוצעה.

`--dry-run` מותר בלי מפתח, ואז המניפסט מסומן `signature: null, unsigned: true`
במפורש. dry-run עם מפתח נחתם כרגיל.

## 7. RPO / RTO — נמדדים, לא מומצאים

- `rpo_seconds` = זמן התכנון פחות `created_at` של התמונה. זהו **חלון האובדן בפועל**
  של הריצה הזו, לא יעד. מופיע ב-`plan` (`rpo.measured: true`) ובדוח ריצת ביצוע.
- `rto_seconds` = זמן קיר של ריצת הביצוע (התחלה עד כתיבת הדוח), כולל קריאה חוזרת.
- ב-dry-run שניהם `null` עם `measured: false`. הצינור לא ממציא מספר שלא נמדד.

יעדי RPO/RTO **לא הוכרעו** (README-ניטור-וגיבוי.md §5). המדידות כאן הן חומר לקבלת
ההחלטה, לא ההחלטה עצמה.

## 8. Rollback

יעד השחזור הוא פרויקט **חד-פעמי**. אין „rollback" של שחזור: אם הריצה נכשלה או
הסביבה המשוחזרת אינה תקינה — מוחקים את פרויקט היעד (או את בסיס הנתונים שלו) ומתחילים
מחדש מהסט המאומת. הצינור עצמו אינו מוחק דבר, גם לא ביעד. הסט המקורי ב-`_גיבוי/`
אינו משתנה בשחזור (רק `restore-runs/` נוסף מתחתיו).

Rollback של קוד (README-פריסה.md) אינו קשור לשחזור נתונים ואינו מבטל אותו.

## 9. בדיקות

```bash
node tests/ops-disaster-restore.test.mjs
```

Node מובנה בלבד, `firestoreApi` מזויף בזיכרון. מכסה: פורמט קנוני וקידוד ערכים;
התאמת נתיב לכל 144 רשומות המדיניות; גיבוי + אימות; זיוף JSONL/מניפסט; תוכנית
(החרגות, ידני, סדר אב-צאצא); סירובי יעד (מקור=יעד, `station-102` גם עם דגלים
ו-allowlist, `.firebaserc`); ביצוע ללא אישור / אישור שגוי / allowlist חסר; dry-run
עם אפס כתיבות; ביצוע (קנרית ראשונה, דילוג על קיים, אין דריסה, קריאה חוזרת, RPO/RTO
נמדדים, חתימה); אי-התאמה בקריאה חוזרת; קבוצת זהות הכול-או-כלום; קנרית נכשלת;
כשל באמצע; `report`; CLI בתת-תהליך; sandbox שמוכיח ש-dry-run אינו טוען
`firebase-admin`, אינו פותח רשת ואינו מריץ תת-תהליך; תחביר PowerShell 5.1 בעטיפה;
בלי CRLF/תווי בקרה.

## 10. תרגיל Firebase אמיתי: NOT RUN — requires isolated Firebase project and explicit authorization

לא הורץ `backup` מול `station-102`, לא נוצר פרויקט יעד, ולא הורץ `restore --execute`
מול שום פרויקט או אמולטור. המתאם האמיתי (`listCollections` / `listDocuments` /
`getAll` / `create`) **לא נבדק מול Firestore**. לפני תרגיל אמיתי:

1. פרויקט Firebase מבודד וחד-פעמי, לא `station-102`, לא פרויקט עם משתמשים.
2. אישור אנושי מפורש הכולל: מזהה היעד, הסט, ה-commit, ותוכנית מחיקה של היעד אחרי התרגיל.
3. `RESQ_RESTORE_TARGET_ALLOWLIST` ו-`RESQ_RESTORE_SIGNING_KEY` בסביבה בלבד.
4. סדר: `backup --dry-run` → `backup` → `verify` → `plan` → `restore` (dry-run) → סקירת
   התוכנית → `restore --execute --confirm-target` → `report` → בדיקת Auth ידנית.
5. תוצאות התרגיל (RPO/RTO שנמדדו, ספירות, אי-התאמות) נמסרות עם SHA-256 של הדוח.
