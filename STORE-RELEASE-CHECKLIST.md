# STORE-RELEASE-CHECKLIST.md — רשימת מוכנות לחנויות (מעטפת ResQ)

**סיווג הסעיף:**

```
STORE_SCAFFOLD_ONLY
```

אין אפליקציית Android או iOS שניתנת לבנייה. `appId` הוא placeholder,
גשר הפוש הנייטיבי זורק `not-implemented-requires-store-account`, אין
APNs/FCM נייטיבי, ולא בוצע אף build. **אסור לסמן את הסעיף כמוכן
לפרסום.** מה שקיים הוא תשתית תצורה בלבד, לסקירה — לא לשחרור.

```
iOS BUILD NOT RUN — requires macOS/Xcode
ANDROID BUILD NOT RUN — SDK not available; not installed without approval
```

הכרעה סגורה שחלה גם כאן: **1.9 אינו Go-Live**. מעטפת חנות אינה משנה את זה.
פרסום בחנות הוא ערוץ הפצה למוצר שכבר אושר להפעלה — לא דרך לעקוף את שער
המוכנות ל-1,000+ משתמשים.

---

## 1. מה קיים (הכול תחת `apps/mobile/`, תבניות)

| קובץ | מצב |
|---|---|
| `capacitor.config.json` | קיים. `server.url = https://station-102.web.app`, `allowNavigation = [station-102.web.app]`, `cleartext:false`, `allowMixedContent:false`, `limitsNavigationsToAppBoundDomains:true`. `appId = il.resq.station102` הוא **placeholder** |
| `deep-links.json` | קיים. שלושה מסלולים: join / readiness / alerts |
| `src/navigation-policy.js` | קיים, מודול טהור, נבדק ב-`tests/mobile-shell.mjs` |
| `src/push-bridge.js` | קיים. `createFakePushBridge` עובד; `createNativePushBridge` **זורק** `not-implemented-requires-store-account` |
| `android/*.template.*` | תבניות בלבד. `assetlinks.template.json` עם טביעת אצבע לא-תקינה בכוונה |
| `ios/*.template.*` | תבניות בלבד. AASA עם `REPLACE_ME` במקום TEAMID |
| `README.md` (בכל תיקייה) | מכיל את הצהרת NOT RUN |

## 2. מה **לא** נעשה

- **לא** הורץ `npx cap add android` / `npx cap add ios`. אין `build.gradle`,
  אין `.xcodeproj`, אין `Podfile`, אין `node_modules` תחת `apps/mobile`.
- **לא** בוצע build. **לא** נוצר APK / AAB / IPA.
- **לא** נוצר מפתח חתימה. אין keystore, `.jks`, `.p12`, `.mobileprovision`,
  `.cer` בריפו — ולא יהיו.
- **לא** הותקן Android SDK, Xcode, CocoaPods, Gradle. לא הותקנה שום תלות.
- **לא** נפתח חשבון Google Play Console ולא חשבון Apple Developer.
- **לא** הועלה דבר לשום חנות.
- **לא** הוזנו `google-services.json` / `GoogleService-Info.plist` (נחסמים
  ב-`.gitignore`, ראה `MOBILE-WIRING.md`).
- **לא** נוצר חשבון בודק (reviewer). §8 מתאר את הנוהל, לא מבצע אותו.
- **לא** פורסמו `/.well-known/assetlinks.json` ו-`/.well-known/apple-app-site-association`
  על המארח.

## 3. תנאים מוקדמים (כולם דורשים אדם; אף אחד לא מתבצע מהריפו)

| # | תנאי | בעלים | הערה |
|---|---|---|---|
| P1 | **אישור אנושי על מזהה האפליקציה** (`appId` / bundle id) | בעל המערכת | לא ניתן לשינוי אחרי פרסום ראשון. `il.resq.station102` הוא הצעה בלבד |
| P2 | חשבון Google Play Console **בבעלות הארגון** | ארגון | לא חשבון של מפתח יחיד. דורש אימות ארגוני ו-D-U-N-S לפי מדיניות Google הנוכחית — **לא נבדק** מול הדרישות העדכניות |
| P3 | חשבון Apple Developer Program **בבעלות הארגון** (TEAMID) | ארגון | כנ"ל |
| P4 | מפתח upload (Android) — נוצר ונשמר מחוץ לריפו | בעל החשבון | §7 |
| P5 | מפתח APNs `.p8` — נשמר במנהל סודות של Firebase בלבד | בעל החשבון | §7 |
| P6 | `google-services.json` + `GoogleService-Info.plist` מפרויקט `station-102` | בעל פרויקט Firebase | נשמרים מחוץ לריפו; ל-Firebase Console יש רישום אפליקציה Android/iOS נפרד — **טרם נוצר** |
| P7 | תחנת עבודה עם Android SDK מאושר | מפתח + אישור | `ANDROID BUILD NOT RUN — SDK not available; not installed without approval` |
| P8 | macOS עם Xcode | מפתח | `iOS BUILD NOT RUN — requires macOS/Xcode` |
| P9 | כתובת URL ציבורית של מדיניות פרטיות | ארגון | שתי החנויות דורשות. **לא קיים** (`PRIVACY-DATA-MAP.md` §5) |
| P10 | מסלול מחיקת חשבון שיזם המשתמש | מוצר + Codex | שתי החנויות דורשות. **לא הוכרע** |
| P11 | הכרעה על זמני שמירה (`retention`) | בעל המערכת | `backup-policy.js` — רוב הנתיבים `*_policy_required` |
| P12 | `tests/mobile-shell.mjs` ירוק על ה-SHA שממנו בונים | CI | ראה `MOBILE-WIRING.md` |
| P13 | `firebase.json` → `hosting.ignore` כולל `apps/**` | Codex | אחרת `capacitor.config.json` עולה ל-Hosting הציבורי. **לא בוצע** |

## 4. שלבי הבנייה — **לא הורצו**, לתיעוד הסדר בלבד

```
# מחוץ לריפו, בתיקייה זמנית, אחרי P1–P8:
# 1. npm init -y && npm i @capacitor/core @capacitor/cli      (NOT RUN)
# 2. העתקת apps/mobile/capacitor.config.json                    (NOT RUN)
# 3. npx cap add android   /   npx cap add ios                  (NOT RUN)
# 4. מיזוג ידני של התבניות לתוך הפרויקט שנוצר (README בכל תיקייה) (NOT RUN)
# 5. הכנסת google-services.json / GoogleService-Info.plist     (NOT RUN)
# 6. Android: ./gradlew bundleRelease עם upload key            (NOT RUN)
# 7. iOS: Xcode Archive → App Store Connect                    (NOT RUN)
```

אף שורה למעלה לא תורץ מתוך הריפו ולא על ידי סוכן. הריפו נשאר config-only.

## 5. פריטי דף החנות (listing) — טיוטה, לא הוגשה

| פריט | ערך מוצע | מקור |
|---|---|---|
| שם | ResQ | `manifest.json` → `short_name` |
| שם מלא | ResQ · תחנה 102 | `manifest.json` → `name` |
| תיאור קצר | ניהול כוח אדם, ציוות וכשירות לתחנת כיבוי אש | `manifest.json` → `description` |
| קטגוריה | Productivity / Business | `manifest.json` → `categories` |
| שפה ראשית | עברית (he), RTL | `manifest.json` → `lang`, `dir` |
| אייקון 512 / 1024 | `resq-512.png`, `resq-maskable.png` | `apps/mobile/*/icons/README.md` |
| צבעים | `#0f1b33` (theme), `#15171a` (background) | `manifest.json` |
| צילומי מסך | **לא קיימים.** יש להפיק ממכשיר אמיתי/סימולטור אחרי build. `tests/screenshots-out/` הוא ב-`.gitignore` ואינו מקור לחנות | — |
| קהל יעד | פנימי — עובדי תחנת כיבוי. **לא לילדים**. ב-Play: "Private app" דרך Managed Google Play אם הארגון עובד עם EMM — **לא הוכרע**; ב-App Store: Unlisted App Distribution או Custom Apps (Apple Business Manager) — **לא הוכרע** | — |
| דירוג תוכן | שאלון IARC — למלא ידנית | — |
| פרטי קשר לתמיכה | **לא ידוע** | — |
| מדיניות פרטיות (URL) | **חסר** (P9) | — |

## 6. הצהרות פרטיות — Play Data safety / App Store Privacy

**המקור היחיד:** `PRIVACY-DATA-MAP.md` §4. אין להעתיק ערכים ממקום אחר.

תמצית לרשימה (הפירוט והנימוקים שם):

- נאסף: שם, אימייל, טלפון (רשות), מזהי משתמש (UID, מספר עובד), תחנה/תפקיד,
  טוקן פוש, תוכן משתמש (טפסים, מסמכי HR, צילומים, חתימות), אבחון בקטגוריות
  סגורות.
- לא נאסף: מיקום, אנשי קשר, מזהי פרסום, דפדוף, כספים.
- לא משותף עם צד שלישי. אין מעקב. אין SDK אנליטיקה/פרסום.
- הצפנה במעבר: כן. מחיקה ביוזמת המשתמש: **לא הוכרע** (P10).
- `PrivacyInfo.template.xcprivacy` כבר מיושר למפה (OtherDiagnosticData, לא CrashData).
- פריטים ב-**לא הוכרע** במפה חוסמים הגשה. אין לסמן "לא נאסף" רק כי לא הוכרע.

## 7. משמורת מפתחות חתימה — **לעולם לא בריפו**

| פריט | היכן נשמר | היכן **אסור** |
|---|---|---|
| Android upload key (`.jks`/`.keystore`) + סיסמאות | מנהל סודות ארגוני / כספת של בעל החשבון; גיבוי offline נפרד | ריפו, OneDrive של מפתח, צ'אט, חדר המלחמה, `_דיונים` |
| Play App Signing key | Google מחזיקה (Play App Signing). הארגון מחזיק רק upload key | — |
| Apple Distribution certificate (`.p12`) + סיסמה | Keychain של בעל החשבון + מנהל סודות | ריפו |
| Provisioning profiles (`.mobileprovision`) | App Store Connect / Xcode של בעל החשבון | ריפו |
| APNs key (`.p8`) + Key ID + Team ID | Firebase Console → Cloud Messaging (מוזן פעם אחת), מנהל סודות | ריפו, `functions/` |
| `google-services.json`, `GoogleService-Info.plist` | תיקיית הפרויקט המקומי שנוצר מחוץ לריפו | ריפו — חסום ב-`.gitignore` (`MOBILE-WIRING.md`) |

`.gitignore` ו-`hosting.ignore` הם **הגנה שנייה**. ההגנה הראשונה היא שהקבצים
לא נכנסים לעץ העבודה של הריפו בכלל. `tests/mobile-shell.mjs` נופל אם אחד
מהם מופיע תחת `apps/mobile`.

אובדן upload key של Android = בקשת reset מ-Google (ימים). אובדן מפתח ללא Play
App Signing = **לא ניתן לעדכן את האפליקציה לעולם**. לכן Play App Signing חובה.

## 8. חשבון בודק (reviewer test account) — נוהל, **לא נוצר**

הבודקים של שתי החנויות חייבים להיכנס לאפליקציה. ResQ דורשת חשבון מאושר עם
שיוך תחנה. הנוהל:

1. **תחנת בדיקה נפרדת**, לא תחנה 102 ולא תחנת ייצור. הכרעה סגורה: אין תחנה
   שנייה בייצור לפני 42A–42C — לכן תחנת הבודק היא תחנת **staging** בפרויקט
   Firebase שאינו `station-102`, או תחנה מסומנת בבירור כבדיקה **רק אחרי
   שההכרעה הזאת נפתחת מחדש בכתב**. **לא הוכרע.**
2. **זהות בדויה** — לא שם של עובד אמיתי, לא מספר עובד תפוס. מספר העובד
   מוקצה בשרת (`identity-coordinator`) ואינו ממוחזר; חשבון בודק צורך מספר
   לצמיתות. לתעד זאת.
3. **תפקיד מינימלי** — כבאי רגיל. לא סגל, לא HR, לא מנהל-על.
4. **ללא נתונים אמיתיים** בתחנת הבדיקה: אין מסמכי HR אמיתיים, אין נוכחות
   אמיתית.
5. **סיסמה** נמסרת רק בטופס הבודק של החנות, לא בריפו, לא בחדר המלחמה.
6. **ביטול** — החשבון מושבת (`is_active=false` על ידי מנהל-על) מיד אחרי
   אישור הביקורת, ומופעל מחדש לכל הגשה.
7. **App Check** — הבודק עובר reCAPTCHA Enterprise כמו כולם. אם יש
   debug token, הוא לא נכנס לבינארי שמוגש.
8. הוראות לבודק (באנגלית, בטופס החנות): איך להתחבר, איזה מסך לפתוח, שאין
   תוכן ציבורי, ושהאפליקציה מיועדת לעובדי הארגון בלבד.

## 9. חזרה לאחור (rollback)

| שכבה | איך חוזרים | הערה |
|---|---|---|
| **חנות** | **rollback בחנות = build חדש.** אי אפשר "לבטל" גרסה שהופצה: Play מאפשר halt של rollout מדורג; App Store מאפשר הסרה מהחנות ו-Expedited Review לתיקון. בשני המקרים משתמשים שכבר התקינו נשארים עם הגרסה שהותקנה עד שיקבלו build חדש עם מספר גרסה גבוה יותר | לכן: rollout מדורג (Play), Phased Release (App Store) |
| **תוכן (ה-PWA)** | rollback של Hosting לפי `README-פריסה.md` (`hosting:clone` לגרסה קודמת). המעטפת טוענת את המקור החי, ולכן rollback של Hosting מתקן את כל המשתמשים מיד, כולל משתמשי המעטפת | זה היתרון המרכזי של config-only |
| **הגנות שרת** | **ללא שינוי.** `firestore.rules`, App Check, callables — לא נגעה בהם המעטפת ולא נוגע בהם rollback של המעטפת | הכרעה: הרשאות רגישות נאכפות בשרת |
| **פוש** | נשאר ב-`firebase-messaging-sw.js`. אין גשר נייטיב, אין מה להחזיר | `createNativePushBridge` זורק |
| **קישורים עמוקים** | הסרת `assetlinks.json`/AASA מהמארח מבטלת את האימות; הקישורים נפתחים בדפדפן במקום באפליקציה — ה-PWA ממשיכה לעבוד | — |

## 10. שערים לפני הגשה (כולם NOT RUN כרגע)

```
cd tests
npm run mobile:test            # tests/mobile-shell.mjs — ראה MOBILE-WIRING.md
npm run all                    # שער הריפו המלא; המעטפת לא נוגעת בו אבל בונים מ-SHA ירוק
node hosting-privacy.mjs       # אחרי הוספת apps/** ל-hosting.ignore — 404 על capacitor.config.json
```

בנוסף, ידנית ועל מכשיר אמיתי אחרי build (NOT RUN):

- `https://station-102.web.app/login.html?join=<token>` נפתח באפליקציה ולא בדפדפן.
- `https://station-102.web.app@evil.com/` **אינו** נפתח באפליקציה.
- ניווט לקישור חיצוני מתוך ה-PWA פותח את דפדפן המערכת.
- `http://station-102.web.app` נחסם.
- התראת פוש מגיעה דרך ה-Service Worker של ה-PWA בתוך ה-WebView — **לא ידוע**
  אם WKWebView ב-iOS תומך ב-Web Push בתוך אפליקציה; אם לא, iOS נשאר בלי
  התראות עד לגשר נייטיב (P5). **זו נקודת סיכון מוצרית שדורשת בדיקה בפועל.**

## 11. מה הרשימה הזאת איננה

היא לא אישור פרסום, לא אישור מיזוג, ולא הוכחה שהמעטפת עובדת. היא רשימת
הדברים שאדם צריך לעשות, בסדר, עם מה שכבר קיים. **לפני פריסה: אישור אנושי
מפורש הכולל commit, תוצאות בדיקות, סיכון ותוכנית חזרה לאחור** (תדריך §11).
