# METRICS-WIRING.md — חיבור שכבת המדדים התפעוליים

השכבה נמסרת **בלי לגעת בקבצים משותפים**. כל קטע כאן הוא הדבקה מדויקת
לקובץ הקיים, לביצוע רק אחרי ביקורת. עד שהחיווט מבוצע, `tests/metrics-source.mjs`
מדפיס `NOT WIRED` לכל פריט חסר (ואינו נכשל); עם `RESQ_METRICS_REQUIRE_WIRING=1`
חיווט חסר הופך לכישלון.

## קבצים שנמסרו (כולם חדשים; שום קובץ קיים לא שונה)

| קובץ | תפקיד |
|---|---|
| `functions/metrics-catalog.js` | קטלוג סגור: 15 קודים, `ok|fail`, 5 שדות, מדרגות משך, `assertNoPii`, `normalizeEvent`. משתמש ב-`VERSIONS`/`SCREENS` של `ops-telemetry-contract.js` (אותו אובייקט, לא עותק). |
| `functions/metrics-sink.js` | `createFakeMetricsSink()` (זיכרון) ו-`createFirestoreMetricsSink({db, fieldIncrement, serverTimestamp})`. ממשק: `write / readDaily / listExpired / remove`. אין ספק אנליטיקה. |
| `functions/metrics-service.js` | `createMetricsService(deps)` → `recordMetrics`, `getMetricsDashboard`, `pruneExpired`, `hashScope`, `keyed`. |
| `functions/metrics-backup-policies.js` | ארבע רשומות `DATA_POLICIES` מוצעות, מאומתות מול `validatePolicies` האמיתי. |
| `functions/metrics-test-harness.js` | Firestore מזויף מינימלי (עותק עצמאי, לא מייבא את תשתית הקליטה). |
| `functions/metrics-catalog.test.js` · `functions/metrics-service.test.js` | 11 + 29 בדיקות יחידה. |
| `metrics-client.js` | `createMetricsRecorder({callable, release, screen, isSignedIn})` — מאגר ≤20, שיגור ב-`visibilitychange`/`pagehide`/10 שניות, `request_id` אחד לשיגור. **לא מחובר לשום מסך.** |
| `metrics-ui.js` · `metrics.html` | לוח למנהל-על בלבד, `textContent` בלבד, "לא זמין" במקום 0, תגי חלקי/ישן, תווית מצב גיבוב. |
| `tests/metrics-client.test.mjs` · `tests/metrics-source.mjs` · `tests/metrics-browser.mjs` | 8 בדיקות לקוח, סטטי + 17 מוטציות, 22 בדיקות דפדפן. |

---

## 1. `functions/index.js` — בניית השירות ושני callables

להדביק אחרי בלוק `deviceReadinessService` (או בכל מקום אחרי `db`, `FV`, `HttpsError`, `requireAuth` מוגדרים):

```js
// ---------- מדדים תפעוליים ----------
// מונים יומיים בלבד. תחנה/ארגון/UID נשמרים כגיבוב; בלי RESQ_METRICS_HASH_KEY
// הגיבוב הוא sha256 רגיל והלוח מסמן "פסאודונים, הפיך במנייה".
const metricsSinkModule = require('./metrics-sink');
const metricsServiceModule = require('./metrics-service');
const metricsSink = metricsSinkModule.createFirestoreMetricsSink({
  db, fieldIncrement: n => FV.increment(n), serverTimestamp: () => FV.serverTimestamp()
});
const metricsService = metricsServiceModule.createMetricsService({
  db, sink: metricsSink,
  fail: (status, message, reason) => { throw new HttpsError(status, message, { reason }); },
  requireAuth,
  getAuthUser: uid => admin.auth().getUser(uid),
  now: Date.now,
  serverTimestamp: () => FV.serverTimestamp(),
  hashKey: process.env.RESQ_METRICS_HASH_KEY || ''
});
exports.recordMetrics = onCall({ enforceAppCheck: true }, req => metricsService.recordMetrics(req));
exports.getMetricsDashboard = onCall({ enforceAppCheck: true }, req => metricsService.getMetricsDashboard(req));
```

הערות:
- `requireAuth` הקיים ב-index.js מחזיר את `req.auth` או זורק `unauthenticated` — זה מה שהשירות מצפה לו.
- `pruneExpired` **לא** מחובר. כשיוחלט על משימה מתוזמנת:
  `exports.pruneMetrics = onSchedule('every day 03:30', () => metricsService.pruneExpired({}))` — ≤200 מחיקות לריצה.
- `RESQ_METRICS_HASH_KEY`: מפתח ≥16 תווים (מומלץ 32 בתים hex). מוגדר ב-Secret Manager או ב-`.env` של הפונקציות; לעולם לא בקוד. שינוי מפתח = גיבובים חדשים = היסטוריה ישנה לא מצטרפת (מקובל: הצבירות נגזרות).

## 2. `firestore.rules` — ארבעה בלוקים סגורים

להדביק ליד `join_campaign_inspect_quota`:

```
    match /metrics_daily/{id} {
      allow read, write: if false;
      match /shards/{shard} {
        allow read, write: if false;
      }
    }
    match /metrics_quota/{id} {
      allow read, write: if false;
    }
    match /metrics_operations/{id} {
      allow read, write: if false;
    }
```

הדפדפן אינו קורא ואינו כותב מדדים ישירות; הכול דרך callables. `organization_station_index/{station_id}`
נקרא בשרת בלבד — אם האוסף אינו קיים עדיין, הארגון נרשם `'none'` (אין צורך בכלל חדש; אם ייווצר, לסגור גם אותו).

## 3. `functions/backup-policy.js` — `DATA_POLICIES`

להוסיף לתוך המערך (הרשומות הן בדיוק `METRICS_POLICIES` מ-`functions/metrics-backup-policies.js`,
ואומתו: `validatePolicies(DATA_POLICIES.concat(METRICS_POLICIES))` → `[]`):

```js
  policy('metrics_daily/{id}', 'root', 'derived',
    'none', 'rebuild', 'rebuild', 'operational', 'ttl_90_days',
    'Daily hashed-scope counters (no identity, no free text); rebuilt only from future events, a gap is acceptable.',
    { humanReadable:'allowed' }),
  policy('metrics_daily/{id}/shards/{shard}', 'root', 'derived',
    'none', 'rebuild', 'rebuild', 'operational', 'ttl_90_days_with_parent',
    'Sharded increment counters under the daily aggregate; same lifecycle as the parent.',
    { humanReadable:'allowed' }),
  policy('metrics_quota/{id}', 'root', 'temporary',
    'none', 'exclude', 'do_not_restore', 'operational', 'ttl_2_days',
    'Per-account call quota and per-station cardinality guard keyed by hashes; restoring stale quota would block or unblock reporting incorrectly.',
    { humanReadable:'redacted' }),
  policy('metrics_operations/{id}', 'root', 'temporary',
    'none', 'exclude', 'do_not_restore', 'operational', 'ttl_2_days',
    'Replay records (request fingerprint only); restoring them would misclassify fresh requests as duplicates.',
    { humanReadable:'redacted' }),
```

לאחר ההדבקה אפשר למחוק את `functions/metrics-backup-policies.js` או להשאירו כמקור; `tests/metrics-source.mjs`
בודק את שני המצבים (`backup-policy.js DATA_POLICIES classify the four metrics paths`).
`tests/backup-coverage.mjs` הקיים עשוי לדרוש שכל אוסף חדש יסווג — זו בדיוק הסיבה לרשומות.

## 4. `nav.js` — כניסה לתפריט (קבוצת admin, מנהל-על בלבד)

להוסיף אחרי שורת `maintenance.html`:

```js
  { href: 'metrics.html', label: 'מדדים תפעוליים', who: 'super', dot: '#5c6bc0', group: 'admin' }
```

`tests/nav-groups.mjs` מחזיק רשימה של דפי super (`['hr.html', 'import.html', 'check.html', 'maintenance.html', 'callout.html']`) —
להוסיף `'metrics.html'` שם באותו שינוי.

## 5. `tests/package.json` — סקריפט

```json
    "metrics:test": "node ../functions/metrics-catalog.test.js && node ../functions/metrics-service.test.js && node metrics-client.test.mjs && node metrics-source.mjs && node metrics-browser.mjs",
```

ולהוסיף `&& npm run metrics:test` לסוף `"all"`. (`metrics-browser.mjs` דורש playwright; `RESQ_CHROMIUM` בוחר קובץ הרצה.)

## 6. `tests/public-assets.json` — נכסים ציבוריים

```json
  "metrics-client.js",
  "metrics-ui.js",
  "metrics.html",
```

(בסדר אלפביתי, ליד `manifest.json`/`monitored-functions.js`). ב-`firebase-messaging-sw.js` — **לא** להוסיף ל-SHELL:
לוח מנהל-על אינו נדרש offline, כמו שדפי super אחרים אינם שם. אם `tests/hosting-privacy.mjs` דורש התאמה
בין הרשימה לקבצים בדיסק — הרשימה לעיל מספיקה.

## 7. `functions/ops-telemetry-contract.js` + `incident-client.js` — אוצר הטלמטריה

ב-`CALLABLES` (שני הקבצים, אותה שורה יחסית ל-`getMaintenanceDashboard`):

```js
  'getMaintenanceDashboard', 'setMaintenanceMode', 'runMaintenanceAnalysis',
  'recordMetrics', 'getMetricsDashboard',
```

ב-`SCREENS` (שני הקבצים): להוסיף `'metrics.html'` אחרי `'device-readiness.html'`.
`metrics-client.js` מגביל `screen` לתבנית `^[a-z-]{1,40}\.html$` ומעביר לשרת, שמפיל ל-`unknown` אם אינו ב-`SCREENS`;
לכן ללא ההוספה הזו מאורעות ממסך המדדים יירשמו כ-`unknown` — לא שגיאה, רק פחות מידע.

## 8. TTL — הגדרת קונסולה/CLI, **לא נוצרת כאן**

כל צבירה נושאת `expires_at` (יום + 90). מסמכי מכסה ופעולה נושאים `expires_at` (עכשיו + 2 ימים).
מדיניות TTL ב-Firestore היא הגדרה מחוץ לקוד:

```
gcloud firestore fields ttls update expires_at --collection-group=metrics_daily      --project=station-102
gcloud firestore fields ttls update expires_at --collection-group=metrics_quota      --project=station-102
gcloud firestore fields ttls update expires_at --collection-group=metrics_operations --project=station-102
```

- TTL מוחק את מסמך האב אך **לא** את תת-האוסף `shards` — לכן `pruneExpired` קיים: הוא מוחק אב + shards יחד,
  בקבוצות של ≤200. עד שמחברים אותו למשימה מתוזמנת, shards יתומים אינם נקראים (הלוח קורא לפי מסמכי אב) אך תופסים מקום.
- TTL מוחק תוך ~24 שעות מהתפוגה, לא מיידית.
- הפעלת TTL היא פעולה על פרויקט הייצור — דורשת את אישור האדם לפי כללי הפריסה.

## 9. מודל עלות כתיבה (Firestore)

לכל קריאת `recordMetrics` שהתקבלה (לא replay, לא דחייה):

```
writes = (מספר הצבירות השונות באצווה)          ← shard אחד לכל (יום, קוד, גרסה, תחנה)
       + (מספר הצבירות שנוצרו היום לראשונה)      ← מסמך אב, פעם אחת ביום לכל צבירה
       + 1  metrics_quota/{uid_hash}_{day}       ← מונה קריאות
       + 1  metrics_quota/st_{station_hash}_{day}← מונה קרדינליות + מפת מפתחות
       + 1  metrics_operations/{uid_hash}_{rid}  ← רשומת replay
```

- אצווה של 20 מאורעות מאותו קוד/גרסה = 1 shard + (0|1 אב) + 3 = **4–5 כתיבות**.
- אצווה של 20 מאורעות מ-15 קודים = 15 shards + עד 15 אבות + 3 = **18–33 כתיבות** (המקרה הגרוע, פעם ביום).
- replay זהה: **0 כתיבות** (3 קריאות). דחייה (מכסה/קרדינליות/קלט): 0 כתיבות.
- קריאות לכל קריאה: 1 (`organization_station_index`) + 3 בטרנזקציה.
- תקרה יומית לחשבון: 60 קריאות × ≤33 = ≤1,980 כתיבות; בפועל אצווה טיפוסית היא 4–6.
- לוח: `days` שאילתות `metrics_daily where day==` + קריאת `shards` לכל צבירה (≤8 מסמכים כל אחת). 30 יום × 60 צבירות × 8 = עד 14,400 קריאות במקרה הגרוע לתחנה; ברירת המחדל 7 ימים. הלוח הוא למנהל-על בלבד ואינו נקרא אוטומטית.
- shards: 8, בחירה אקראית לכל כתיבה. הצבירה נקראת כסכום — מגבלת הכתיבה למסמך (1/שנייה) הופכת ל-~8/שנייה לצבירה. אם תחנה אחת תשלח יותר מזה — להגדיל `SHARD_COUNT` (שינוי נתונים-תואם: shards ישנים נשארים ונקראים).

## 10. מה מובטח ומה לא

- **מובטח בקוד:** תחנה מ-claims חיים בלבד; `station_id`/`stationId` בגוף → `invalid-argument client-station`;
  שדה זר במאורע → `invalid-argument input` על כל הקריאה; קוד לא מוכר → `invalid-argument event-code`;
  `duration_bucket_ms` מעוגל למעלה, לעולם לא גולמי; 60 קריאות/חשבון/יום; 60 צבירות חדשות/תחנה/יום;
  replay זהה ללא כתיבה; גוף שונה → `already-exists request-conflict`; לוח למנהל-על עם קריאה חוזרת של claims חיים;
  `active_users_rate` תמיד `available:false reason:'no-source'`; מכנה 0 → `available:false`, לא 0.
- **לא מובטח / לא נבדק כאן:** אמולטור Firestore (הבדיקות על Firestore מזויף בזיכרון); ביצועי `readDaily` ב-30 יום על נתונים אמיתיים;
  `organization_station_index` — אוסף שאינו קיים עדיין במאגר, נקרא כקיים-או-`none`; חיבור `metrics-client.js` למסכים (החלטה נפרדת).
- **הגיבוב אינו אנונימיזציה.** מרחב התחנות קטן; בלי מפתח, כל מי שמכיר את מזהי התחנות משחזר אותם ב-sha256 של `metrics-scope-v1|<id>`.
  עם מפתח, השחזור דורש את המפתח. הלוח אומר את זה במפורש.
