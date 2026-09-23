# DR-WIRING · קטעי חיבור לצינור ההתאוששות

קבצים חדשים בחבילה (לא נוגעים בקבצים משותפים):

| קובץ | יעד במאגר | תפקיד |
|---|---|---|
| `ops-disaster-restore.mjs` | שורש | הצינור: backup / verify / plan / restore / report |
| `ops-disaster-restore.ps1` | שורש | עטיפת Windows (PowerShell 5.1 + 7) |
| `tests/ops-disaster-restore.test.mjs` | `tests/` | 24 בדיקות, Node מובנה בלבד |
| `DISASTER-RECOVERY-RUNBOOK.md` | שורש | ספר הפעלה |

אין תלות חדשה. `functions/backup-policy.js` נטען ב-`require('./functions/backup-policy.js')`
יחסית לשורש המאגר (`RESQ_REPO_ROOT` דורס; ברירת המחדל תיקיית הסקריפט).
`firebase-admin` נטען בעצלנות מ-`functions/node_modules` רק בריצה אמיתית.

כל הקטעים להלן הם **הדבקה ידנית**. לא הרצתי אותם על הקבצים המשותפים.

---

## 1 · `tests/package.json`

### 1a · סקריפט ייעודי (להוסיף ל-`scripts`)

```json
"dr:test": "node ops-disaster-restore.test.mjs"
```

### 1b · הוספה ל-`static` — בסוף השרשרת, אחרי `node ops-restore-drill-test.mjs`

```
&& node ops-disaster-restore.test.mjs
```

כלומר הקטע `... && node ops-backup-test.mjs && node ops-restore-drill-test.mjs && node load-modules.mjs ...`
הופך ל-
`... && node ops-backup-test.mjs && node ops-restore-drill-test.mjs && node ops-disaster-restore.test.mjs && node load-modules.mjs ...`.

הבדיקה רצה מתוך `tests/` (כמו שאר הסקריפטים) ומאתרת את הסקריפט ב-`../ops-disaster-restore.mjs`
ואת המדיניות ב-`../functions/backup-policy.js`.

---

## 2 · `.gitignore`

הסטים נכתבים תחת `_גיבוי/` (כבר מוחרג). נוספו גם `resq-fs-*/`, `documents.jsonl(.enc)`,
ותבניות יעד Storage מוצעות — ראו `.gitignore`. תוצרי הריצות (`restore-runs/`) בתוך הסט.
אין קובץ מפתח במאגר: `RESQ_RESTORE_SIGNING_KEY` ו-`RESQ_BACKUP_SEAL_PASSPHRASE` מהסביבה בלבד.

מפת גיבוי אחידה: `BACKUP-MAP.md`.

---

## 3 · `firebase.json` (Hosting `ignore`)

אין שינוי נדרש — אימתתי ב-`firebase.json` הנוכחי: `_גיבוי/**`, `**/_גיבוי/**`, `*.mjs`
ו-`*.ps1` כבר ברשימת ה-ignore. `DISASTER-RECOVERY-RUNBOOK.md` מטופל כמו שאר קובצי
ה-README בשורש; אם רוצים למנוע גם את פרסומו, להוסיף:

```json
"DISASTER-RECOVERY-RUNBOOK.md"
```

---

## 4 · `README-ניטור-וגיבוי.md`

להוסיף בסוף §4 שורה:

```
שחזור מסמכי Firestore לפרויקט מבודד: ראו DISASTER-RECOVERY-RUNBOOK.md
(`ops-disaster-restore.mjs`). station-102 חסום כיעד בקוד.
```

---

## 5 · משתני סביבה (לא בקובץ, לא בקומיט)

| משתנה | מתי נדרש | משמעות |
|---|---|---|
| `RESQ_RESTORE_TARGET_ALLOWLIST` | `restore --execute` בלבד | יעדים מותרים, מופרדים בפסיקים |
| `RESQ_RESTORE_SIGNING_KEY` | חובה ב-`restore --execute` (≥32); אופציונלי ב-dry-run | מפתח HMAC לחתימת `restore-manifest.json`; ב-execute בלעדיו — סירוב לפני קנרית. dry-run בלי מפתח מסומן `unsigned: true` |
| `RESQ_BACKUP_SEAL_PASSPHRASE` | חובה ב-`backup --execute` (≥20) | מפתח חותם AES-256-GCM; לעולם לא בקומיט/מניפסט/לוג |
| `RESQ_BACKUP_ALLOW_PROD_SOURCE` | ריצה ידנית מאושרת בלבד (`=1`) | מתיר מקור `station-102`/default לגיבוי אמיתי; בדיקות אוטומטיות לא מגדירות |
| `RESQ_REPO_ROOT` | רק כשהסקריפט אינו בשורש המאגר | מיקום `functions/backup-policy.js` ו-`.firebaserc` |
| `GOOGLE_APPLICATION_CREDENTIALS` | ריצה אמיתית | כמו `ops-export.mjs` |

---

## 6 · מה לא הורץ

- `npm run static` המלא אחרי ההוספה — לא הורץ (אין עותק עבודה עם `tests/node_modules`).
- שום ריצה מול Firebase, אמולטור או `station-102` — NOT RUN.
- `ops-disaster-restore.ps1` לא הורץ ב-PowerShell (אין PowerShell בסביבה); נבדק סטטית בלבד.

## RESQ_RESTORE_SIGNING_KEY (execute)

`RESQ_RESTORE_SIGNING_KEY` is **required** for `restore --execute` (minimum 32 characters). Without it the restore adapter refuses before any canary write. Dry-run / verify-only may proceed unsigned (`unsigned: true`). Never commit the key.
