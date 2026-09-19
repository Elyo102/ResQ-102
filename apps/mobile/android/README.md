# apps/mobile/android — תבניות בלבד

**תבנית — לא נוצר פרויקט; `npx cap add` לא הורץ; build NOT RUN.**

`ANDROID BUILD NOT RUN — SDK not available; not installed without approval`

אין כאן `build.gradle`, אין `settings.gradle`, אין `gradlew`, אין `google-services.json`
ואין keystore. התיקייה מכילה רק קבצים שאדם מעתיק ידנית לתוך פרויקט Capacitor
שייווצר מחוץ לריפו, אחרי אישור.

| קובץ | מה הוא | לאן מעתיקים |
|---|---|---|
| `app-manifest.template.xml` | AndroidManifest מינימלי: INTERNET + POST_NOTIFICATIONS, `usesCleartextTraffic="false"`, App Links לשלושת המסלולים | `android/app/src/main/AndroidManifest.xml` |
| `assetlinks.template.json` | Digital Asset Links עם טביעת אצבע **לא תקינה בכוונה** | `/.well-known/assetlinks.json` על המארח המאושר — רק אחרי חתימה |
| `strings.template.xml` | `app_name` = ResQ | `android/app/src/main/res/values/strings.xml` |
| `icons/README.md` | אילו PNG מהריפו לשמש כאייקונים | — |

## מה חייב לקרות לפני שהתבניות הופכות לפרויקט

1. אישור אנושי על `appId` (`il.resq.station102` הוא placeholder).
2. חשבון Google Play Console בבעלות התחנה/הארגון — לא של מפתח.
3. מפתח חתימה (upload key) שנוצר ונשמר מחוץ לריפו; ראה `STORE-RELEASE-CHECKLIST.md`.
4. `google-services.json` מפרויקט Firebase `station-102` — לעולם לא בריפו (`.gitignore`).
5. רק אז: `npx cap add android` בסביבה עם Android SDK מאושר.

## מה המעטפת אינה עושה

- אינה מכילה עותק של ה-PWA; היא טוענת `https://station-102.web.app` ב-WebView.
- אינה מבקשת מיקום, מצלמה, אנשי קשר או אחסון.
- אינה מאפשרת cleartext ואינה מאפשרת mixed content.
