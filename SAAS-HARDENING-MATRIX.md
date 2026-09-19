# SAAS-HARDENING-MATRIX · מיפוי הקיים לפני קוד

בסיס: `origin/main` = `233901c0d6327a05b0ac87c103943a512dc9c2c7` (אומת ב-`git fetch` לפני העבודה).
ענף: `codex/saas-hardening` · worktree: `_worktree-claude-saas`.
שיטה: כל שורה נבדקה מול הקוד בפועל (קובץ + שורה), לא מול מסמכים. סטטוסים: `EXISTS_AND_WORKS` (קוד + בדיקה קיימת שמריצה אותו) · `EXISTS_BUT_BROKEN` (קיים אך חסר/שבור/לא מכוסה) · `MISSING` · `OUT_OF_SCOPE_EXTERNAL`.

הכלל שנגזר מהמיפוי: **מרחיבים, לא בונים מחדש.** כל מודול חדש בחבילה הזו הוא טהור (ללא Firebase), נבדק בבידוד, ומתחבר לקיים דרך ההזרקות שכבר משמשות את המנגנונים הקיימים (`createXService({ db, fail, requireAuth, getAuthUser, … })`, `onCall({ enforceAppCheck: true })`, `allow read, write: if false`, `backup-policy.js`, `ops-telemetry-contract.js`).

## §5 · אבטחה

| דרישה | סטטוס | ראיה (קובץ:שורה) | מה נעשה בחבילה |
|---|---|---|---|
| בידוד תחנות בשרת | EXISTS_AND_WORKS | `functions/index.js:1066 callerStation` דוחה `stationId` מהלקוח; `join-campaign-service.js:54` `client-station`; `schedule-runtime.js:378`; `onboarding-station-gates.js:24,76,91`; בדיקות `tests/station-source.mjs`, `station-boundary.mjs`, `join-campaign-source.mjs:62` | לא נוגעים. `tests/security-boundaries.mjs` מוסיף בדיקה חוצת-מודולים (כל שירות חדש דוחה `station_id`/`organization_id`/`uid`/`role`/מחיר מהלקוח). |
| בידוד תחנות ב-Rules | EXISTS_AND_WORKS | `firestore.rules:88 inStation`, `:127 member`, `:97 liveStationIdentity`; ~80 `allow read, write: if false`; `rules-test/*.mjs` (7 קבצים, אמולטור) | `rules-test/saas-isolation.test.mjs` חדש — שני ארגונים × שתי תחנות (NOT RUN — אמולטור). |
| בידוד בין ארגונים | MISSING (אין ישות ארגון) | אין `organization` ב-`firestore.rules` / `functions/` / `stations.js`; המחוז (`districtId`) הוא הרובד היחיד מעל תחנה (`firestore.rules:350-374`) | נבנה ב-§4; Rules סגורים לחלוטין ללקוח; בידוד מוכח ב-`security-boundaries.mjs` (זיכרון) + `rules-test` (NOT RUN). |
| App Check בכל callable | EXISTS_BUT_BROKEN | 152 `onCall(` ב-`index.js`, מהם **31 ללא `enforceAppCheck`** (legacy: `bootstrapSuperAdmin:1269`, `loginWithEmployeeNumber:1850`, `joinWithCode:2118`, 5 bulletin, `bulkImport`, `setSilentMode`, `sendBroadcast:4532`, `claimPushToken:5311`, `backupToSheetNow:5767` …); `tests/appcheck.mjs` בודק לקוח בלבד; `fncheck.mjs` לא בודק options | **לא מדליקים App Check על 31 ה-legacy בחבילה הזו** — זה שינוי התנהגות ייצור (כניסה, פוש) שדורש הכרעה נפרדת. במקום זאת: `tests/security-boundaries.mjs` אוכף **רשימת חריגים קפואה** של 31 השמות; כל callable שאינו ברשימה — כולל כל ה-callables החדשים כאן — חייב `enforceAppCheck: true`. הרשימה מדווחת ל-Codex כחוב פתוח. |
| rate limiting | EXISTS_AND_WORKS (לפי תכונה, אין מגביל גנרי) | `bulletin.js:23-26`, `feedback.js:87`, `hr-*` quotas, `join-campaign-service.js:251`, `join-campaign.js:30` (readiness 3/יום), login lockout `index.js:1871` | שירותים חדשים מקבלים quota משלהם באותו דפוס (`*_quota/{id}` בטרנזקציה): SaaS admin ops, metrics ingest, org audit read. |
| bounded pagination | EXISTS_AND_WORKS | `join-campaign-service.js:14-15,179`; `incident-log.js LIMITS`; `join-campaign-load.mjs:66` | כל רשימה חדשה: `Math.min(limit, CAP)` + cursor; נבדק ב-`security-boundaries.mjs`. |
| replay / idempotency | EXISTS_AND_WORKS | `join-campaign-service.js:350-366,436`, `device-readiness-service.js:75-97`, `station-provision-service.js:221`, `hr-*`, `bulletin.js` | SaaS/metrics משתמשים באותו דפוס: `request_id` + `intent_fingerprint` ברשומת פעולה; replay זהה → קבלה קודמת; שונה → `request-conflict`. |
| claims חיים למנהל-על | EXISTS_AND_WORKS | `admin.auth().getUser` ב-`index.js:455-707`; `identity-coordinator.js:319…`; `device-readiness-service.js` (`liveClaims.super`); `onboarding-station-gates.js:24` | שירותים חדשים: `superActor()` באותו דפוס — claim חתום + claims חיים, אחרת `permission-denied`. |
| PII בלוגים/טלמטריה | EXISTS_AND_WORKS | `ops-telemetry-contract.js` (אוצר מילים סגור, `finite()` → `'unknown'`), `incident-log.js:24,55`, `mail-delivery-guard.js`, `backup-policy.js humanReadable` | קטלוג המדדים (§8) יורש את הדפוס: אוצר מילים סגור, אין שדות חופשיים. |
| CSV/formula injection | EXISTS_AND_WORKS | `join-admin-ui.js:44-56`, `hr-month-archive.js:88 csvCell`, `schedule-file-import.js:332,452`; `join-campaign-browser.mjs:251` | ייצוא SaaS/metrics משתמש באותו `csvCell`-דפוס; נבדק ב-`security-boundaries.mjs`. |
| HTML injection | EXISTS_AND_WORKS | `join-campaign-source.mjs:48` אוסר `innerHTML` בממשק החדש; `esc()` בעמודים ישנים | מסכים חדשים: `textContent`/`createElement` בלבד; בדיקת מקור. |
| prototype pollution | EXISTS_AND_WORKS (לפי מודול) | `schedule-calendar-engine.js:80 RESERVED_KEYS`; `hasOwnProperty.call` ב-`join-campaign-service.js:54`; 7 בדיקות | מודולים חדשים: `Object.create(null)` + דחיית `__proto__`/`constructor`/`prototype`; מוטציה ב-`security-mutations.mjs`. |
| enumeration | EXISTS_AND_WORKS | `index.js:1877-1886` הודעה אחידה; `join-campaign-service.js:102` `not-found` אחיד + quota | ארגונים/מנויים: קריאה רק למנהל-על; `not-found` אחיד; אין רשימות ללקוח לא מורשה. |
| סודות במאגר | EXISTS_AND_WORKS | `.gitignore` (`*.txt`, `*adminsdk*`, `.env*`, `*.key`, `*.pem`), `firebase.json hosting.ignore`, `tests/hosting-privacy.mjs` (מוכיח 404) | `security-boundaries.mjs` מוסיף: `apps/mobile/**` ו-`*.keystore|*.jks|*.p12|*.mobileprovision|google-services.json|GoogleService-Info.plist` ב-`.gitignore` וב-hosting ignore. |
| כשל ספק חיצוני ≠ הרשאה | EXISTS_AND_WORKS (דפוס) | `device-readiness-service.js` `readiness-provider` → `status:'failed'`, לא ready; `station-backup-capability.js` fails closed | `FakeBillingProvider` שנכשל → המנוי נשאר `trial`/הקודם; בדיקת קבלה 5. |
| ביקורת חדירה חיצונית | OUT_OF_SCOPE_EXTERNAL | — | לא בוצעה ולא נטען שבוצעה. |

## §6 · התאוששות מאסון

| דרישה | סטטוס | ראיה | מה נעשה |
|---|---|---|---|
| גיבוי מקומי (קוד + מסמכים) | EXISTS_AND_WORKS | `ops-backup.mjs` (bundle + zip + manifest v2 + prune), `ops-backup-archive.ps1` (5.1-compat), `tests/ops-backup-test.mjs` 12 בדיקות | לא נוגעים. |
| אימות/דריל שחזור | EXISTS_AND_WORKS (קריאה בלבד) | `ops-restore-drill.mjs` (clone+fsck+sha256, tmp נמחק), `tests/ops-restore-drill-test.mjs` | `ops-disaster-restore.mjs` **משתמש ב-`completedSet`** מ-`ops-backup.mjs` כשלב `verify` — לא מאמת שני. |
| מדיניות נתונים לשחזור | EXISTS_AND_WORKS (הצהרתית) | `backup-policy.js`: 144 נתיבים, `backupPolicy`/`restorePolicy`, 43 `exclude` (tokens, outbox, leases, quotas, sessions, readiness), `IDENTITY_POLICY_PATHS` (10) כקבוצת עקביות; `tests/backup-coverage.mjs` שוויון מלא מול `firestore.rules` | **המנוע החדש קורא את המדיניות הזו כמקור אמת יחיד**: `exclude`/`rebuild`/`do_not_restore` לעולם לא משוחזרים; `identity_consistency_export` משוחזר כקבוצה אחת או לא בכלל. |
| כותב שחזור ל-Firestore | MISSING | אין קוד שכותב מסמכים מגיבוי (`ops-restore-drill` קריאה בלבד; `restorePolicy` הצהרה) | `ops-disaster-restore.mjs`: `plan → dry-run (ברירת מחדל) → isolated-restore` דרך `firestoreApi` מוזרק; אין SDK ב-dry-run; יעד ≠ מקור (סירוב קשיח); `--confirm-target` שווה בדיוק ל-project id; `--no-overwrite` תמיד (create-only, אין מחיקה). |
| manifest חתום + checksum לפני/אחרי | EXISTS_BUT_BROKEN (SHA-256 בלי חתימה) | `manifest.json` v2 עם sha256 לכל קובץ; אין HMAC/GPG | `restore-manifest.json` עם HMAC-SHA256 על תקציר הדוח (מפתח מ-`RESQ_RESTORE_SIGNING_KEY` env בלבד, לעולם לא במאגר; בלי מפתח → `unsigned:true` מסומן במפורש). checksum של כל מסמך לפני (מהמקור) ואחרי (קריאה חוזרת מהיעד). |
| RPO/RTO מדידים | MISSING (README: "לא הוכרעו") | `README-ניטור-וגיבוי.md §5` | הדוח מודד: `rpo_seconds` = now − `backup.created_at`; `rto_seconds` = משך הריצה בפועל; שניהם `null` + `measured:false` ב-dry-run. אין יעד מומצא. |
| PowerShell 5.1 + 7 | EXISTS_AND_WORKS (דפוס) | `ops-backup-archive.ps1:5-11` | `ops-disaster-restore.ps1` עוטף את ה-mjs באותו דפוס (`-LiteralPath`, `-Encoding UTF8`, בלי תחביר 7-בלבד), נבדק סטטית. |
| תרגיל Firebase אמיתי | OUT_OF_SCOPE_EXTERNAL / NOT RUN | — | `NOT RUN — requires isolated Firebase project and explicit authorization`. |

## §8 · מדדים תפעוליים

| דרישה | סטטוס | ראיה | מה נעשה |
|---|---|---|---|
| טלמטריה ללא PII | EXISTS_AND_WORKS (לתקריות בלבד) | `ops-telemetry-contract.js` (5 שדות, אוצר מילים סגור), `incident-log.js` (fingerprint, `DAY_CAP 500`, `DAY_TTL 3d`), `incident-client.js` (≤10 לטעינה, dedupe) | לא מוחלף. המדדים הם רובד נפרד לאירועי מוצר, באותו דפוס. |
| קטלוג אירועים סגור | MISSING | אין אירועי מוצר (login_success, onboarding_*, push_*, …) | `functions/metrics-catalog.js`: `EVENT_CODES` קפוא (15), `FIELDS` סגור; אירוע לא מוכר → `invalid-argument`. |
| sink מוזרק / FakeMetricsSink | MISSING | — | `functions/metrics-service.js` `createMetricsService({ sink, … })`; `FakeMetricsSink` בזיכרון; אין ספק אנליטיקה. |
| retention / aggregation / rate / cardinality | MISSING (קיים רק לתקריות) | `incident-log.js DAY_CAP` | אגרגציה יומית לפי `(event_code, release, station_hash)`; מונים בלבד; `RETENTION_DAYS 90`; quota לכל uid/יום; קטלוג קפוא = cardinality מוגבלת בבנייה. |
| לוח מדדים למנהל-על | EXISTS_BUT_BROKEN (יש `maintenance.html` לתקריות/בריאות, אין מדדי מוצר) | `maintenance.html`, `maintenance-service.js` (מסמן `open_count_is_partial`) | `metrics.html` חדש, `who:'super'` ב-`nav.js` באותו דפוס של `maintenance.html`; "לא זמין" כשאין נתון; "חלקי/ישן" מסומן. |

## §4 · שכבת SaaS

| דרישה | סטטוס | ראיה | מה נעשה |
|---|---|---|---|
| ישות ארגון / מנוי / שימוש / ביקורת | MISSING | אין `organizations` באף קובץ | `functions/saas-contract.js` (טהור) + `saas-service.js` + 6 callables (App Check) + Rules סגורים + `backup-policy.js` (4 נתיבים חדשים, `managed_export`/`audit_log`). |
| מודל תחנות/מחוזות | EXISTS_AND_WORKS — **לא משתנה** | `stations.js:15-23`, `stations/{sid}` (`districtId`, `status`), claims `stationId/districtId/role` | הארגון מחזיק `station_ids[]` כהפניה בלבד. ההרשאות נשארות claims + `stations/{sid}/users` — הארגון אינו מקור הרשאות. |
| קטלוג תוכניות בקוד | MISSING | — | `PLANS` קפוא ב-`saas-contract.js`; הלקוח שולח `plan_id` בלבד. |
| optimistic concurrency + replay | EXISTS_AND_WORKS (דפוס) | `expected_revision` ב-`join-campaign-service.js`, `intent_fingerprint` | אותו דפוס. |
| suspended לא מוחק, לא חוסם חירום | MISSING | — | `suspended` חוסם רק `createOrganizationStation`/`issue*` מסחריים; `sendCallout`/פוש/שירות תחנתי לא קוראים את המנוי כלל (מוכח בבדיקת מקור). |
| ספק חיוב | MISSING | — | interface + `FakeBillingProvider` בלבד; כשל ספק → אין מנוי פעיל. |
| מסך ניהול | MISSING | — | `saas-admin.html` מנהל-על בלבד, סימולציה מקומית, בלי "שלם". |

## §7 · מוכנות לחנויות

| דרישה | סטטוס | ראיה | מה נעשה |
|---|---|---|---|
| PWA | EXISTS_AND_WORKS | `manifest.json` (standalone, scope `./`), `pwa.js`, `firebase-messaging-sw.js` (network-first, deep-link ב-`notificationclick`), `tests/pwacheck.mjs`, `service-worker-browser.mjs` | לא משתנה — מקור המוצר. |
| מעטפת Native/Capacitor | MISSING | אין capacitor/cordova/gradle/xcodeproj/assetlinks/AASA | `apps/mobile/` — תצורת Capacitor מינימלית (`capacitor.config.json` עם `server.url` ל-origin המאושר, `allowNavigation` רק אליו), `android/`+`ios/` כתבניות תצורה בלבד (manifest, Info.plist, entitlements, privacy manifest) — **לא פרויקטים שנוצרו על-ידי SDK**. |
| deep links | EXISTS (PWA) / MISSING (native) | `device-readiness.html?readiness_nonce=`, `login.html?join=` | `apps/mobile/deep-links.json` + `assetlinks.json`/AASA **תבניות** עם placeholders (ללא SHA256 של חתימה אמיתית). |
| fake push bridge | MISSING | — | `apps/mobile/src/push-bridge.js` interface + `FakePushBridge`; אין FCM/APNs bridge לייצור. |
| build Android לא חתום | OUT_OF_SCOPE_EXTERNAL בסביבה זו | אין Android SDK בארגז ובלי אישור להתקין | `ANDROID BUILD NOT RUN — SDK not available; not installed without approval`. |
| build iOS | OUT_OF_SCOPE_EXTERNAL | — | `iOS BUILD NOT RUN — requires macOS/Xcode`. |
| העלאה לחנויות | OUT_OF_SCOPE_EXTERNAL | — | לא מבוצע. |

## עומס 3,000

| דרישה | סטטוס | ראיה |
|---|---|---|
| 3,000 משתמשים בגבולות זמן/זיכרון | EXISTS_AND_WORKS | `tests/schedule-load-acceptance.mjs` (`<15000ms`, `<256MB`), `scale-3000-employees.mjs` (`<3000ms`), `join-campaign-load.mjs` (3,000 נרשמים, 61 עמודים), `saas-capacity-3000.mjs` — כולם ב-`npm run all`. החבילה אינה נוגעת בהם; בדיקת קבלה 15 = הרצתם על העץ הסופי. |

## ברירות מחדל שנבחרו (לא הוכרעו על-ידי המשימה)

1. App Check על 31 ה-callables הישנים — **לא מודלק**; רשימת חריגים קפואה + דיווח.
2. `station_hash` במדדים = `sha256('metrics-station-v1|' + station_id).slice(0,16)`; ארגון באותו אופן.
3. Retention מדדים: 90 יום (מונים יומיים); quota: 600 אירועים/uid/יום.
4. HMAC לחתימת manifest השחזור: מפתח מ-env בלבד; בלעדיו — `unsigned`.
5. תוכניות: `trial` (1 תחנה, 60 משתמשים), `station` (1/400), `district` (12/4000), `enterprise` (100/30000) — מספרים לדוגמה בקוד, ניתנים לשינוי בקוד בלבד.
6. Capacitor נבחר כמעטפת (דה-פקטו ל-PWA→חנויות); ללא `npm install @capacitor/*` בארגז — קבצי תצורה + בדיקות סטטיות בלבד.
