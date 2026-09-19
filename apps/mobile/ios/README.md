# apps/mobile/ios — תבניות בלבד

**תבנית — לא נוצר פרויקט; `npx cap add` לא הורץ; build NOT RUN.**

`iOS BUILD NOT RUN — requires macOS/Xcode`

אין כאן `.xcodeproj`, `.xcworkspace`, `Podfile`, `GoogleService-Info.plist`,
`.mobileprovision` או `.p12`. התיקייה מכילה רק קבצים שאדם מעתיק ידנית לתוך
פרויקט Capacitor שייווצר ב-macOS, אחרי אישור.

| קובץ | מה הוא | לאן מעתיקים |
|---|---|---|
| `Info.template.plist` | `CFBundleDisplayName` ResQ, ATS ללא חריגים, `WKAppBoundDomains`, סכמת `resq`, ללא מפתחות מיקום/מצלמה | `ios/App/App/Info.plist` (מיזוג, לא החלפה עיוורת) |
| `PrivacyInfo.template.xcprivacy` | מניפסט פרטיות: tracking=false, סוגי נתונים לפי `PRIVACY-DATA-MAP.md`, ללא Required-Reason APIs | `ios/App/App/PrivacyInfo.xcprivacy` |
| `App.template.entitlements` | `aps-environment` (placeholder development) + `applinks:station-102.web.app` | `ios/App/App/App.entitlements` |
| `apple-app-site-association.template.json` | AASA עם `REPLACE_ME.il.resq.station102` | `/.well-known/apple-app-site-association` על המארח — רק אחרי שיש TEAMID |
| `icons/README.md` | אילו PNG מהריפו לשמש | — |

## מה חייב לקרות לפני שהתבניות הופכות לפרויקט

1. אישור אנושי על ה-bundle id (`il.resq.station102` הוא placeholder).
2. חשבון Apple Developer בבעלות הארגון (TEAMID), לא של מפתח.
3. מפתח APNs (.p8) שנשמר במנהל סודות של Firebase — לעולם לא בריפו.
4. `GoogleService-Info.plist` מפרויקט `station-102` — לעולם לא בריפו (`.gitignore`).
5. רק אז: `npx cap add ios` על macOS עם Xcode.

## הערה על WKAppBoundDomains

`limitsNavigationsToAppBoundDomains: true` ב-`capacitor.config.json` יחד עם
`WKAppBoundDomains` ב-Info.plist מגבילים את ה-WebView למארח המאושר. ניווט
למקור אחר עובר דרך `src/navigation-policy.js` ונפתח בדפדפן המערכת.
