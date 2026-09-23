# ResQ · תוכנית גיבוי ושחזור לפני פיילוט

סטטוס המסמך: תוכנית הפעלה. הוא אינו הוכחה שגיבויי הייצור הופעלו.

## יעדים

- `RPO` רגיל: עד 24 שעות; ב-Firestore עם PITR: עד דקה בתוך חלון שבעת הימים.
- `RTO`: חזרה לשירות בתוך ארבע שעות מתרגיל מאושר.
- כל שחזור נבחן קודם בבסיס נתונים או בפרויקט מבודד. `station-102` חסום כיעד בכלי השחזור.

## שכבות ההגנה

1. Firestore PITR לשבעה ימים. מתחיל לצבור היסטוריה רק מרגע ההפעלה ודורש Billing.
2. גיבוי Firestore מנוהל יומי ושבועי, שמירה 98 ימים (14 שבועות).
3. ייצוא חודשי ל-Cloud Storage עם retention ו-IAM מוגבלים לצוות השחזור.
4. Firebase Auth: ייצוא מוצפן מחוץ למאגר באמצעות `ops-auth-backup.mjs`; פרמטרי SCRYPT נשמרים כסוד נפרד.
5. Cloud Storage: inventory וגיבוי של מדיה ומסמכים רלוונטיים; טוקנים, outbox, leases ומכסות אינם משוחזרים.
6. תרגיל רבעוני עם ספירות, SHA-256, התאמת UID↔users↔roster↔emp_index↔claims ו-RPO/RTO מדודים.

## פקודות תכנון בטוחות

הפקודות הבאות הן dry-run ואינן פונות לייצור:

```powershell
node ops-auth-backup.mjs export --project station-102 --out D:\ResQ-Encrypted-Backups
node ops-disaster-restore.mjs backup --source station-102 --dry-run
```

## שער הפעלה בייצור

לפני הפעלה יש לקבל פלט read-only של מצב PITR, schedules, backup READY אחרון ו-Billing,
ולצרף הערכת עלות. לאחר אישור מפורש בלבד:

1. הפעלת PITR ב-`station-102`.
2. schedule יומי + שבועי, retention ‏98 ימים.
3. ייצוא Auth מוצפן לתיקייה ארגונית מוצפנת מחוץ ל-OneDrive ולמאגר.
4. אימות manifest, ספירת משתמשים ו-SHA-256.
5. שחזור Firestore ו-Auth ליעד מבודד עם פוש, מיילים וטריגרים יוצאים חסומים.
6. אימות נתונים, תיעוד RPO/RTO ומחיקת סביבת התרגיל לפי תוכנית מאושרת.

## סודות ופרטיות

- `RESQ_AUTH_BACKUP_PASSPHRASE`, `RESQ_AUTH_HASH_KEY` ו-`RESQ_AUTH_SALT_SEPARATOR`
  קיימים רק בסביבת המפעיל ואינם נכתבים למאגר, למניפסט או ללוג.
- קובץ Auth המוצפן כולל hashes/salts ולכן עדיין מסווג סודי.
- custom claims אינם כלולים ב-`auth:export`; הם משוחזרים רק לאחר התאמה לנתוני הזהות ב-Firestore.
- גיבוי אינו משמש כארכיון דפדפן ואינו מאפשר שמירת HR/רפואי ב-localStorage.

## Rollback

- ביטול schedule עוצר גיבויים עתידיים ואינו מוחק אוטומטית עותקים קיימים.
- כיבוי PITR אינו rollback ומבטל את יכולת הקריאה מהיסטוריה לאחר התפוגגותה.
- שחזור נתונים אינו מתבטל באמצעות revert לקוד; יעד תרגיל נכשל נמחק ונבנה מחדש.
