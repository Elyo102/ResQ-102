# apps/mobile — מעטפת חנות ל-ResQ (config-only)

**סיווג: `STORE_SCAFFOLD_ONLY`** — תשתית תצורה בלבד. אין אפליקציה
שניתנת לבנייה, אין חתימה, אין APNs/FCM נייטיבי, ולא בוצע build.
הסעיף אינו מוכן לפרסום ואין לסמנו ככזה.


**תבנית — לא נוצר פרויקט; `npx cap add` לא הורץ; build NOT RUN.**

## העיקרון

**ה-PWA היא המוצר.** אין כאן fork לשתי אפליקציות ואין עותק שני של קוד המסכים.
המעטפת (Capacitor) טוענת את מקור ה-Hosting המאושר —
`https://station-102.web.app` — בתוך WebView, ותו לא. כל שינוי במסכים נעשה
ב-PWA ומגיע למעטפת מיד, בלי גרסה חדשה בחנות.

מה שהמעטפת מוסיפה על ה-PWA:

1. אייקון בחנות ומסלול התקנה מוכר (במיוחד ל-iOS, שם "הוסף למסך הבית" נסתר).
2. קישורים עמוקים מאומתים (App Links / Universal Links) לשלושה מסלולים בלבד.
3. בעתיד, ורק אחרי חשבון חנות: פוש נייטיב. כרגע `createNativePushBridge` זורק.

## מבנה

| נתיב | תפקיד |
|---|---|
| `capacitor.config.json` | `server.url` = המקור המאושר, `allowNavigation` = המארח בלבד, `cleartext:false`, `allowMixedContent:false` |
| `deep-links.json` | מקור יחיד לשלושת מסלולי הקישור העמוק (join / readiness / alerts) |
| `src/navigation-policy.js` | מודול טהור: `classifyNavigation`, `deepLinkTarget` |
| `src/push-bridge.js` | ממשק גשר פוש + `createFakePushBridge`; הנייטיב זורק בכוונה |
| `android/` | תבניות בלבד (manifest, assetlinks, strings, אייקונים) |
| `ios/` | תבניות בלבד (Info.plist, PrivacyInfo, entitlements, AASA, אייקונים) |

הבדיקה: `tests/mobile-shell.mjs` (ראה `MOBILE-WIRING.md`).

## מדיניות ניווט

| קישור | סיווג | התנהגות |
|---|---|---|
| `https://station-102.web.app/...` | `internal` | נשאר ב-WebView |
| `https://<מקור אחר>/...` | `external` | נפתח בדפדפן המערכת |
| `http://station-102.web.app/...`, פורט אחר, userinfo לפני `@` | `blocked` | לא נטען כלל |
| `javascript:`, `data:`, `file:`, `intent:`, `blob:`, כל סכמה אחרת | `blocked` | לא נטען כלל |

## קישורים עמוקים

`deepLinkTarget(url, origin)` מחזיר **תמיד** נתיב יחסי בתוך ה-PWA, בנוי מחדש
משדות שעברו regex סגור. שום query string אינו עובר כמו שהוא:

| קלט | יעד |
|---|---|
| `https://station-102.web.app/login.html?join=<token תקין>` או `resq://join?join=<token>` | `./login.html?join=<token>` |
| `https://station-102.web.app/device-readiness.html?readiness_nonce=<32 hex>` | `./device-readiness.html?readiness_nonce=<nonce>` |
| `https://station-102.web.app/alerts.html` | `./alerts.html` |
| כל דבר אחר | `./login.html` (start_url של manifest.json) |

תבנית הטוקן זהה ל-`join-ui.js`: `^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$`.

## מה אין כאן, בכוונה

- אין `google-services.json`, `GoogleService-Info.plist`, keystore, `.p12`, `.mobileprovision`.
- אין `build.gradle`, `.xcodeproj`, `Podfile` — שום דבר שנראה כמו פרויקט שנוצר.
- אין `node_modules`, לא הורץ `npm install`, לא הותקן SDK.
- אין הרשאות מיקום/מצלמה/אנשי קשר.

לפני שמישהו מריץ `npx cap add`: `STORE-RELEASE-CHECKLIST.md`.
