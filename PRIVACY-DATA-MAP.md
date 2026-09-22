# PRIVACY-DATA-MAP.md — מפת נתונים לפרטיות (מעטפת חנות)

**מצב:** מסמך עובדתי לשימוש בהצהרות הפרטיות של החנויות (Play Data safety,
App Store Privacy Nutrition Labels, `PrivacyInfo.xcprivacy`). הוא אינו מדיניות
פרטיות למשתמש הקצה ואינו מחליף ייעוץ משפטי.

**סיווג המעטפת: `STORE_SCAFFOLD_ONLY`.** המפה נכונה למה שה-PWA עושה
היום; היא אינה מתארת אפליקציה שנבנתה, כי לא נבנתה אחת.

**עיקרון:** המעטפת (Capacitor) טוענת את ה-PWA ב-WebView ואינה מוסיפה איסוף
נתונים משלה. כל מה שרשום כאן הוא מה שה-PWA כבר עושה היום, נגזר מקוד המקור.
המעטפת אינה מבקשת הרשאת מיקום, מצלמה, אנשי קשר, מיקרופון או אחסון
(`android/app-manifest.template.xml`, `ios/Info.template.plist`).

**מקורות שנקראו:** `firestore.rules`, `functions/backup-policy.js`
(שדה `retention` בכל `policy(...)`), `incident-client.js`, `appcheck.js`,
`firebase-config.js`, `push.js`, `functions/metrics-service.js` (חבילת המדדים,
טרם מחוברת). כל מה שלא נקרא — מסומן **לא ידוע**.

**אמנת סימון:**
- "רשומה בקוד" = ערך `retention` כפי שמופיע ב-`backup-policy.js`. ערכים כמו
  `policy_required_before_wiring` / `legal_retention_policy_required` /
  `ttl_policy_required` הם **הצהרה שהמדיניות טרם הוכרעה**, לא זמן שמירה.
- "לא הוכרע" = אין רשומת `retention` לנתיב, או שהערך עצמו אומר שנדרשת הכרעה.
- "לא ידוע" = לא נבדק במסמך זה.

---

## 1. טבלת קטגוריות נתונים

| # | קטגוריה | שדות | נתיב Firestore (מ-`firestore.rules`) | מי קורא (סיכום כללים) | `retention` (מ-`backup-policy.js`) | רגישות (`sensitivity`) |
|---|---|---|---|---|---|---|
| 1 | **זהות — אימייל** | `email` (Firebase Auth + מסמך משתמש) | `registration_requests/{uid}` (יצירה: רק המבקש, `email` חייב להתאים ל-`request.auth.token.email`) · `stations/{sid}/users/{uid}` | `users`: `staff(sid)` או המשתמש עצמו עם זהות תחנה חיה. `registration_requests`: יצירה עצמית בלבד; קריאה — לא נבדק כאן | `registration_requests`: `policy_required_before_wiring` → **לא הוכרע** · `users`: `policy_required_before_wiring` → **לא הוכרע** | `restricted_identity` |
| 2 | **זהות — מספר עובד** | `employee_number` (מפתח, נכתב בשרת בלבד) | `emp_index/{emp}` · `emp_reservations/{emp}` · `meta/{docId}` · `stations/{sid}/users/{uid}` · `stations/{sid}/roster/{uid}` | `emp_index`/`emp_reservations`: `allow read, write: if false` (שרת בלבד). `roster`: `member(sid)` קורא, אין כתיבה מהדפדפן | `emp_index`/`meta`: `policy_required_before_wiring` → **לא הוכרע** · `emp_reservations`: `ttl_policy_required` → **לא הוכרע** · `roster`: `policy_required_before_wiring` → **לא הוכרע** | `restricted_identity` |
| 3 | **זהות — שם מלא** | `full_name` | `stations/{sid}/users/{uid}` · `stations/{sid}/roster/{uid}` · `directory/{uid}` | `directory`: `approved()` או `isSuper()`; כתיבה `false` (מוקרן בשרת). `users`: המשתמש עצמו רשאי לעדכן `full_name`, `phone`, `email`, `photo_url`; `hr(sid)` גם `crew`/`shift`; `isSuper()` ללא מגבלה | `directory`: `rebuild_not_retain` (נגזר, נבנה מחדש) · `users`/`roster`: **לא הוכרע** | `restricted_identity` |
| 4 | **זהות — טלפון** (רשות) | `phone` | `stations/{sid}/users/{uid}` (בין שדות העדכון העצמי המותרים) | כמו #3 | **לא הוכרע** | `restricted_identity` |
| 5 | **זהות — תחנה** | `station_id` (claim בשרת), `sid` בנתיב | `stations/{sid}` (רישום התחנה) · claims של Firebase Auth | `stations/{sid}`: `retention` = `policy_required_before_wiring`. שיוך תחנה נקבע בשרת בלבד (הכרעה סגורה) | **לא הוכרע** | `confidential` (רישום) / `restricted_identity` (שיוך אדם) |
| 6 | **מכשיר — טוקן פוש (FCM)** | טוקן FCM, `claimPushToken` | `stations/{sid}/push_tokens/{uid}` | `signedIn() && request.auth.uid == uid` — הבעלים בלבד, קריאה וכתיבה | `ttl_policy_required` → **לא הוכרע**; מסווג `secret_token`, `exclude` מגיבוי, `do_not_restore` | `secret` |
| 7 | **מכשיר — מוכנות מכשיר** | hash של טוקן, hash של nonce, מונה ניסיונות | `stations/{sid}/device_readiness/{uid}` | `allow read, write: if false` — שרת בלבד (`getMyReadiness`) | `ttl_policy_required` → **לא הוכרע** | `restricted_identity` |
| 8 | **תפעולי — משמרות וסידור** | שיבוץ, משמרת, אירועים, אישורים | `stations/{sid}/shifts/{crew}` (+ `{document=**}`) · `stations/{sid}/schedule_publications/{publicationId}` (+ `rows`/`events`/`people`) · `stations/{sid}/schedule_responses/{responseId}` | `shifts`: `member(sid) && seesShift(sid, crew)` קורא; `staff(sid)` כותב. `schedule_*`: לא נבדק כאן (שרת/כללים נפרדים) | `shifts`: `policy_required_before_wiring` → **לא הוכרע** · `schedule_publications`/`schedule_responses`: `legal_retention_policy_required` → **לא הוכרע** | `confidential` (shifts) / `restricted_identity` (publications, responses) |
| 9 | **תפעולי — נוכחות ושעות** | `emp_number`, `crew`, שעות, סטטוס | `stations/{sid}/attendance/{docId}` · `stations/{sid}/monthly_reports/{docId}` | `attendance`: `staff(sid) && seesCrewData(...)` או `member(sid)` על רשומה עם `emp_number == myEmp()`; יצירה עצמית לא-מאושרת בלבד | `retain_indefinitely_no_automatic_deletion` — רשומות המקור והדוחות החודשיים נשמרים בשרת וזמינים לפי חודש; תיקונים מתועדים ואינם מוחקים היסטוריה. יכולת שחזור מגיבוי עדיין מוגבלת לחלון הגיבוי המוגדר | `restricted_identity` |
| 10 | **תפעולי — טפסים והגשות** | תוכן טופס, `by_uid`, `crew`, `is_private`, חתימה | `stations/{sid}/submissions/{subId}` · `stations/{sid}/form_submission_operations/{operationId}` · `stations/{sid}/signatures/{uid}` | `submissions`: המגיש (`by_uid`), `staff(sid)` על לא-פרטי לפי crew, `hr(sid)`/`stationCommander(sid)` על פרטי; יצירה `false` (שרת בלבד). `signatures`: הבעלים בלבד, תמונה ≤400KB | `submissions`: `policy_required_before_wiring` → **לא הוכרע** · `signatures`: `legal_retention_policy_required` → **לא הוכרע** | `restricted_identity` / `sensitive_media` (חתימות) |
| 11 | **תפעולי — מסמכי HR וקבצים מצורפים** (**רגיש**) | מסמכים אישיים/רפואיים, נספחים, קבלות צפייה | `stations/{sid}/hr_documents/{documentId}` (+ `revisions`, `receipts`) · `stations/{sid}/hr_attachments/{attachmentId}` · `stations/{sid}/hr_attachment_ledgers/{ledgerId}` · `stations/{sid}/hr_requests/{requestId}` (+ `events`) · `stations/{sid}/hr_workforce_cases/{recordId}` · `stations/{sid}/documents/{docId}` (מורשת) | `hr_documents`/`hr_attachments`/`hr_requests`/`hr_workforce_cases`: `allow read, write: if false` — callable בלבד. `documents` (מורשת): `hr(sid)` או הבעלים לפי `emp_number`; עדכון/מחיקה `hr(sid)` | `hr_*`: `policy_required_before_wiring` → **לא הוכרע** ("prospective classification only") · `documents`: `legal_retention_policy_required` → **לא הוכרע** | `restricted_identity` / `sensitive_media` ("may contain personal or medical information") |
| 12 | **טלמטריית תקלות** (אוצר מילים סגור, ללא PII) | `kind` ∈ 4 ערכים, `screen` ∈ רשימה סגורה, `version` ∈ רשימה סגורה, `code` ∈ רשימה סגורה, שם callable ∈ רשימה סגורה. **לא נשלחים:** טקסט שגיאה, stack, URL, גוף בקשה (`incident-client.js`) | `stations/{sid}/incidents/{fingerprint}` · `stations/{sid}/incident_days/{day}` | `allow read, write: if false` — שרת בלבד | `incidents`: `manual_after_resolution` (רשומה בקוד: מחיקה ידנית אחרי טיפול) · `incident_days`: `ttl_3_days` (רשומה בקוד) | `operational` |
| 13 | **מדדים תפעוליים** (חבילה שטרם חוברה) | מונים יומיים לפי `event_code`/`release`; תחנה כ-`station_hash` | `metrics_daily/{day}__{event_code}__{release}__{station_hash}` (מ-`functions/metrics-sink.js`) | לוח למנהל-על בלבד (`metrics.html`); **לא מחובר לייצור** | `ttl_90_days` (מ-`functions/metrics-backup-policies.js`, מוצע) | `operational` — **הגיבוב פסאודונימי, הפיך במנייה** כשאין `RESQ_METRICS_HASH_KEY` (sha256 של מזהה תחנה ידוע); הלוח מסמן זאת במפורש |
| 14 | **פידבק פרטי** | טקסט חופשי מהמשתמש + זהות | `stations/{sid}/feedback/{feedbackId}` | לא נבדק כאן | `ttl_30_days_or_manual` (רשומה בקוד) | `restricted_identity` |

הערות לטבלה:

- לכל הנתיבים בטבלה יש רשומה ב-`DATA_POLICIES` של `backup-policy.js`, אך ברוב
  המקרים ערך `retention` הוא "נדרשת הכרעה". אין במסמך זה שום זמן שמירה
  שהומצא. **מספר ימי שמירה שאפשר להצהיר עליו בחנות קיים רק ל-#12, #13, #14**
  (וגם #13 הוא מוצע, לא מחובר).
- `hr(sid)`, `staff(sid)`, `member(sid)`, `isSuper()`, `stationCommander(sid)`
  הן פונקציות ב-`firestore.rules` (שורות 81–175). "סגל" = `staff`, "חבר תחנה"
  = `member`. הפירוט המלא של מי נכנס לכל קבוצה — בקובץ הכללים, לא כאן.
- **צילומים:** `stations/{sid}/faults/{faultId}/photos/{photoId}` ו-
  `stations/{sid}/vehicle_views/{viewId}` מסווגים `sensitive_media`
  (`media_retention_policy_required` → לא הוכרע). הם מועלים על ידי המשתמש
  מתוך הדפדפן/WebView; המעטפת אינה מבקשת הרשאת מצלמה, ולכן ההעלאה היא דרך
  בורר הקבצים של המערכת בלבד. האם ה-PWA משתמשת ב-`<input type=file capture>` —
  **לא ידוע** (לא נבדק).

## 2. מה יוצא מהמכשיר, ולאן

| יעד | מה נשלח | למה | מקור בקוד |
|---|---|---|---|
| **Firebase Authentication** (`station-102.firebaseapp.com`) | אימייל + סיסמה בהתחברות; token מזהה (UID) בכל בקשה | זהות. **Firebase UID הוא הזהות** (הכרעה סגורה) | `firebase-config.js` |
| **Cloud Firestore** (פרויקט `station-102`) | כל הקטגוריות #1–#12, #14 לפי הכללים בטבלה | מסד הנתונים של המערכת | `firebase-config.js`, `firestore.rules` |
| **Cloud Functions (callables)** | קלט הפעולות המאומתות (הרשמה, קליטה, HR, סידור, פוש) | פעולות רגישות נאכפות בשרת | `incident-client.js` — רשימת `TELEMETRY_CALLABLES` |
| **Firebase Cloud Messaging** | טוקן FCM (מהמכשיר לשרת דרך `claimPushToken`); התראות data-only (`title/body/url/tag/important/nonce`) מהשרת למכשיר | התראות פוש | `push.js`, `firebase-messaging-sw.js`, `apps/mobile/src/push-bridge.js` |
| **Firebase App Check / reCAPTCHA Enterprise** | אות תקינות של הלקוח (reCAPTCHA Enterprise site key) | הגנת App Check על Firestore/Functions | `appcheck.js` שורה 47: `ReCaptchaEnterpriseProvider` |
| **Cloud Storage for Firebase** (`station-102.firebasestorage.app`) | **לא ידוע** האם ה-PWA מעלה קבצים ל-Storage ישירות או דרך Firestore/callables; ה-bucket מוגדר ב-`firebase-config.js` | — | `firebase-config.js` שורה 10 |

## 3. מה **אינו** יוצא מהמכשיר

נבדק ב-`grep` על כל `*.js`/`*.html` בריפו (ללא `node_modules`):

- **אין ספק אנליטיקה** — אין `gtag`, Google Analytics, Firebase Analytics,
  Sentry, Crashlytics. תוצאה: 0 התאמות.
- **אין פרסומות** ואין SDK פרסום.
- **אין מיקום** — אין `geolocation` / `getCurrentPosition`; אין `NSLocation*`
  ב-`Info.template.plist`; אין `ACCESS_*_LOCATION` בתבנית ה-manifest.
- **אין מזהה פרסום** (IDFA / GAID) ואין מעקב חוצה-אפליקציות:
  `NSPrivacyTracking = false`, `NSPrivacyTrackingDomains = []`.
- **אין אנשי קשר, מצלמה ישירה, מיקרופון.**
- **אין stack traces או טקסט שגיאה** בטלמטריה (#12).

## 4. מיפוי להצהרות החנויות

הערכים כאן הם **הצעה נגזרת מהטבלה**, לא הגשה. מי שממלא את הטופס בפועל צריך
לעבור על כל שורה מול הטבלה ולא להעתיק עיוורת.

### 4.1 Google Play — Data safety

| שאלה | תשובה מוצעת | נימוק |
|---|---|---|
| האם האפליקציה אוספת או משתפת נתוני משתמש? | **כן, אוספת. לא משתפת** עם צד שלישי (Firebase = מעבד מטעם המפעיל) | #1–#12 |
| הצפנה במעבר | **כן** — HTTPS בלבד (`cleartext:false`, `NSAllowsArbitraryLoads=false`) | `capacitor.config.json`, `Info.template.plist` |
| מנגנון בקשת מחיקה | **לא הוכרע** — אין כיום מסלול מחיקה עצמית; מחיקת חשבון היא פעולת מנהל-על (`is_active`, `firestore.rules`). חייב להיות מוגדר לפני הגשה | §1 |
| Personal info → Name | נאסף, נדרש, לפונקציונליות | #3 |
| Personal info → Email address | נאסף, נדרש, לפונקציונליות + ניהול חשבון | #1 |
| Personal info → Phone number | נאסף, **אופציונלי**, לפונקציונליות | #4 |
| Personal info → User IDs | נאסף (UID, מספר עובד), נדרש | #2, #5 |
| Personal info → Other (תחנה, תפקיד, משמרת) | נאסף, נדרש | #5, #8 |
| Health info | **לא הוכרע** — `documents` "may contain personal or medical information" (`backup-policy.js` שורה 493). אם מסמכי HR כוללים אישורי מחלה — יש להצהיר | #11 |
| Files and docs | נאסף (מסמכי HR, צילומי תקלות, חתימות), אופציונלי לפי תפקיד | #10, #11 |
| Photos | נאסף (צילומי תקלות/רכב), אופציונלי, דרך בורר קבצים | הערה בסוף §1 |
| App activity / App info and performance → Diagnostics | נאסף — קטגוריות סגורות בלבד | #12 |
| Device or other IDs | נאסף — טוקן FCM | #6 |
| Location | **לא נאסף** | §3 |
| Financial info, Contacts, Messages (SMS), Calendar, Audio, Web browsing | **לא נאסף** | §3 |

### 4.2 App Store — Privacy Nutrition Labels / `PrivacyInfo.xcprivacy`

| סוג נתון (Apple) | מוצהר ב-`PrivacyInfo.template.xcprivacy` | Linked to user | Used for tracking | מקור |
|---|---|---|---|---|
| Email Address | כן | כן | לא | #1 |
| Name | כן | כן | לא | #3 |
| Phone Number | כן | כן | לא | #4 |
| User ID | כן | כן | לא | #2, #5 |
| Device ID | כן (טוקן FCM) | כן | לא | #6 |
| Other User Content | כן (טפסים, מסמכי HR, צילומים, חתימות) | כן | לא | #10, #11 |
| Other Diagnostic Data | כן (**לא** Crash Data — אין crash logs) | לא | לא | #12 |
| Health & Fitness | **לא הוכרע** — כמו בשאלת Health info של Play | #11 |
| Precise/Coarse Location | לא | — | — | §3 |
| Tracking | `NSPrivacyTracking=false` | — | — | §3 |

`NSPrivacyAccessedAPITypes` ריק: המעטפת אינה קוראת UserDefaults / file
timestamps / disk space / system boot time. **אם תוסף Capacitor שייבחר בעתיד
ניגש לאחד מאלה, יש להוסיף סיבת שימוש לפני הגשה** — Apple דוחה בינארי בלי זה.

## 5. פערים פתוחים (אין להגיש לפני שנסגרו)

1. **זמן שמירה** — כמעט כל הנתיבים ב-`backup-policy.js` הם
   `*_policy_required`. הצהרת "נשמר עד X" בחנות דורשת הכרעה אנושית ועדכון
   הקובץ; מסמך זה לא ימלא את הפער בניחוש.
2. **מסלול מחיקת חשבון** — Play ו-App Store דורשים שניהם דרך למחיקת חשבון
   שיזם המשתמש. לא נמצא במקור. **לא הוכרע.**
3. **מידע בריאותי** במסמכי HR — סיווג `sensitive_media` בלבד; האם זה
   "Health" לפי הגדרות החנויות — **לא הוכרע**.
4. **Cloud Storage** — האם ה-bucket בשימוש בפועל — **לא ידוע**.
5. **מדיניות פרטיות ציבורית (URL)** — שתי החנויות דורשות קישור. **לא קיים
   בריפו** (לא נבדק מחוץ לריפו).
