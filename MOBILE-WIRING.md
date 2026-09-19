# MOBILE-WIRING.md — חיבור מעטפת החנות לקבצים המשותפים

הקבצים תחת `apps/mobile/**` עומדים בפני עצמם ואינם מיובאים על-ידי שום קובץ
ב-PWA. עם זאת, שלוש נקודות חיבור **חייבות** להיכנס יחד עם החבילה, אחרת קבצי
תצורה של המעטפת ייחשפו ב-Hosting או ייכנסו ל-Git עם חומר חתימה.

סדר החלה: 1 → 2 → 3 → 4. אחרי כל אחד, `node tests/mobile-shell.mjs` מדווח
`WIRED` במקום `NOT WIRED` בשורה המתאימה.

---

## 1. `firebase.json` — hosting.ignore (חובה לפני פריסה)

`hosting.public` הוא `"."`, כלומר כל מה שאינו ברשימת ה-ignore מוגש לציבור.
`apps/**` אינו ברשימה היום, ולכן `capacitor.config.json` וכל תבנית תחת
`apps/mobile/` היו נפרסים כקובץ סטטי בפריסה הבאה.

בתוך `"hosting"` → `"ignore"`, להוסיף כערך נוסף במערך (מיד אחרי `"functions/**"`):

```json
    "apps/**",
```

## 2. `.gitignore` — חומר חתימה ותוצרי בנייה

להוסיף בסוף הקובץ:

```gitignore
# מעטפת חנות (apps/mobile) — תצורה סודית ותוצרי בנייה.
# התבניות עצמן כן נשמרות בגיט; מה שלמטה לעולם לא.
apps/mobile/**/google-services.json
apps/mobile/**/GoogleService-Info.plist
*.keystore
*.jks
*.p12
*.mobileprovision
*.cer
apps/mobile/android/app/build/
apps/mobile/ios/App/Pods/
apps/mobile/**/node_modules/
```

הערה: `.gitignore` כבר חוסם `*.key`, `*.pem`, `.env*` ו-`*adminsdk*.json`;
השורות שלמעלה מוסיפות רק את מה שייחודי לחנויות.

## 3. `tests/package.json` — סקריפט

בתוך `"scripts"`:

```json
    "mobile:test": "node mobile-shell.mjs",
```

ולשרשר ל-`all` (לא ל-`static`: הבדיקה קוראת קבצים מחוץ ל-`tests/`, ו-`all`
הוא המקום שבו כבר רצות בדיקות רוחב כאלה). ב-`"all"`, לפני `npm run static`:

```
npm run mobile:test &&
```

## 4. `tests/hosting-privacy.mjs` — הוכחת 404

הבדיקה כבר מרימה שרת מקומי ומוכיחה שקבצים מוחרגים מחזירים 404. להוסיף
`apps/mobile/capacitor.config.json` לרשימת הנתיבים שנבדקים שם, באותו דפוס
שבו נבדק `roster-import.js`:

```js
// מעטפת החנות אינה חלק מהאתר. capacitor.config.json מכיל את מזהה
// האפליקציה ואת מקור ה-Hosting המאושר — אין סיבה שיוגש לדפדפן.
await expect404('apps/mobile/capacitor.config.json');
```

(שם הפונקציה המדויק נגזר מהקובץ הקיים; הכוונה היא אותה בדיקה שכבר קיימת
עבור הקבצים המוחרגים, לא מנגנון חדש.)

---

## מה **לא** משתנה

- `manifest.json`, `pwa.js`, `firebase-messaging-sw.js`, `version.js`,
  `release-manifest.json` — ללא שינוי. ה-PWA נשארת מקור המוצר, והמעטפת
  טוענת אותה מה-Hosting המאושר.
- `tests/public-assets.json` — `apps/` אינו ברמת השורש של האתר ואינו נכנס
  לרשימת הנכסים הציבוריים.
- `tests/pwacheck.mjs`, `tests/service-worker-browser.mjs` — ללא שינוי;
  `tests/mobile-shell.mjs` מאמת שה-SHELL של ה-Service Worker אינו מזכיר
  `apps/` בכלל.
- אין תלות npm חדשה. `apps/mobile` אינו package ואין בו `package.json`.

## אזהרת רצף

אם `apps/**` נכנס ל-`.gitignore` במקום ל-`hosting.ignore` — התבניות ייעלמו
מהמאגר ותאבד הסקירה. אם הוא נכנס רק ל-`.gitignore` ולא ל-`hosting.ignore`,
הקבצים ייפרסו. שתי הנקודות נפרדות ושתיהן נדרשות.
