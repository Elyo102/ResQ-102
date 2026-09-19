# SAAS-WIRING · קטעי חיבור לקבצים המשותפים

הקבצים החדשים בחבילה (כולם תחת `src/`, לא נוגעים בקבצים משותפים):

| קובץ | תפקיד |
|---|---|
| `functions/saas-contract.js` | חוזה טהור: `PLANS`, `STATUSES`, `TRANSITIONS`, `WEBHOOK_STATUS`, `quotaCheck`, `validate*Input`, טביעות כוונה, `SaasError` |
| `functions/saas-billing-provider.js` | ממשק ספק חיוב + `createFakeBillingProvider()` (בזיכרון, `failNext`) |
| `functions/saas-service.js` | `createSaasService(deps)` — 7 callables + `addUsage` פנימי |
| `functions/saas-test-harness.js` | Firestore מזויף + ספק מזויף לבדיקות |
| `functions/saas-contract.test.js` · `functions/saas-service.test.js` | בדיקות יחידה ושירות |
| `tests/saas-source.mjs` | בדיקות מקור + 14 מוטציות |
| `saas-admin.html` · `saas-admin-ui.js` · `tests/saas-admin-browser.mjs` | מסך מנהל-על + בדיקת דפדפן |
| `rules-test/saas-isolation.test.mjs` | בידוד Rules באמולטור — **NOT RUN** |

כל הקטעים להלן הם **הדבקה ידנית**. לא הרצתי אותם על הקבצים המשותפים.

---

## 1 · `functions/index.js`

### 1a · טעינת מודולים (ליד `const joinCampaignServiceModule = require('./join-campaign-service');`, שורה ~67)

```js
const saasContract = require('./saas-contract');
const saasServiceModule = require('./saas-service');
const saasBillingModule = require('./saas-billing-provider');
```

### 1b · בניית השירות (אחרי בלוק `deviceReadinessService`, לפני `// -----` שסוגר את קטע 42H.21)

```js
// ---------- שכבת SaaS מסחרית ----------
//
// ארגונים, מנויים, מכסות ושימוש. מנהל-על בלבד (claims חיים). הארגון מפנה
// לתחנות לפי מזהה ואינו מקור הרשאה. ספק החיוב כאן הוא **מזויף בלבד** —
// אין חיוב אמיתי, אין ספק אמיתי, אין סוד ספק בקוד.
// שער fail-closed. הספק היחיד כאן מזויף ושומר מצב בזיכרון התהליך, ולכן
// cold start מאבד לקוחות ומנויים. כבוי = סירוב בשרת בכל קריאה, כולל
// addUsage הפנימי, וללא מסך ניהול. נפתח רק בהחלטה מפורשת ועם ספק מתמשך.
const SAAS_ENABLED = process.env.RESQ_SAAS_ENABLED === 'true';
const saasBilling = saasBillingModule.createFakeBillingProvider();
const saasService = saasServiceModule.createSaasService({
  enabled: SAAS_ENABLED,
  db, contract: saasContract, billing: saasBilling,
  fail: (status, message, reason) => { throw new HttpsError(status, message, { reason }); },
  requireAuth,
  getAuthUser: uid => admin.auth().getUser(uid),
  openAudit, sealAudit,
  now: Date.now,
  hash: value => crypto.createHash('sha256').update(String(value)).digest('hex'),
  serverTimestamp: () => FV.serverTimestamp(),
  randomId: () => crypto.randomBytes(12).toString('hex')
});
```

### 1c · Callables (אחרי `exports.getMyReadiness`, שורה ~540). כולם עם App Check.

```js
exports.createOrganization = onCall({ enforceAppCheck: true }, req => saasService.createOrganization(req));
exports.attachStationToOrganization = onCall({ enforceAppCheck: true }, req => saasService.attachStationToOrganization(req));
exports.changeSubscriptionPlan = onCall({ enforceAppCheck: true }, req => saasService.changeSubscriptionPlan(req));
exports.setSubscriptionStatus = onCall({ enforceAppCheck: true, timeoutSeconds: 60 }, req => saasService.setSubscriptionStatus(req));
exports.getOrganizationOverview = onCall({ enforceAppCheck: true }, req => saasService.getOrganizationOverview(req));
exports.simulateBillingWebhook = onCall({ enforceAppCheck: true }, req => saasService.simulateBillingWebhook(req));
exports.listOrganizations = onCall({ enforceAppCheck: true }, req => saasService.listOrganizations(req));
```

`saasService.addUsage({ request_id, station_id, metric, amount })` **אינו** callable. הוא מיוצא על השירות לחיבור עתידי בשרת בלבד (למשל אחרי שליחת התראה). בחבילה הזו אין אף קריאה אליו מקוד תפעולי.

---

## 2 · `firestore.rules`

להדביק אחרי בלוק `join_campaign_inspect_quota` (שורה ~514), לפני `// ---------- חיפוש עובד ----------`.

```
    // ---------- שכבת SaaS מסחרית ----------
    //
    // ארגון, מנוי, שימוש וביקורת ארגונית מנוהלים רק דרך Callables
    // מאומתים (App Check + מנהל-על חי בשרת). הדפדפן — גם מנהל-על — לא
    // קורא ולא כותב אותם ישירות. האינדקס תחנה→ארגון ורשומות הפעולה
    // (replay) סגורים מאותה סיבה. הארגון אינו מקור הרשאה.
    match /organizations/{organizationId} {
      allow read, write: if false;
      match /subscriptions/{subscriptionId} {
        allow read, write: if false;
      }
      match /usage/{period} {
        allow read, write: if false;
      }
      match /audit/{eventId} {
        allow read, write: if false;
      }
    }
    match /organization_station_index/{stationId} {
      allow read, write: if false;
    }
    match /saas_operations/{operationId} {
      allow read, write: if false;
    }
```

---

## 3 · `functions/backup-policy.js` — `DATA_POLICIES`

להדביק אחרי `policy('join_campaign_inspect_quota/{quotaId}', …)` (שורה ~166). כל הערכים לקוחים מ-`ALLOWED` הקיים.

```js
  // שכבת SaaS מסחרית. ארגון = הפניות למזהי תחנות בלבד (לא נתוני תחנה);
  // מנוי = תוכנית וסטטוס; שימוש = מונים נגזרים; ביקורת = יומן פעולות.
  policy('organizations/{organizationId}', 'root', 'source_of_truth',
    'count_any_loss', 'managed_export', 'restore', 'confidential',
    'policy_required_before_wiring',
    'Commercial organization: name, district, station id references, current subscription pointer.',
    { humanReadable:'redacted' }),
  policy('organizations/{organizationId}/subscriptions/{subscriptionId}', 'root', 'source_of_truth',
    'count_any_loss', 'managed_export', 'restore_after_parent', 'confidential',
    'policy_required_before_wiring',
    'Subscription plan id, status, revision and opaque provider ids (no amounts, no card data).',
    { humanReadable:'redacted' }),
  policy('organizations/{organizationId}/usage/{period}', 'root', 'derived',
    'count_drop', 'rebuild', 'rebuild', 'operational', 'rebuild_not_retain',
    'Monthly server-computed usage counters; rebuildable from operation records.',
    { humanReadable:'redacted' }),
  policy('organizations/{organizationId}/audit/{eventId}', 'root', 'audit_log',
    'activity', 'managed_export', 'restore', 'confidential',
    'audit_retention_policy_required',
    'Per-organization commercial change history (codes only, no provider text, no PII).',
    { humanReadable:'redacted' }),
  policy('organization_station_index/{stationId}', 'root', 'derived',
    'count_drop', 'rebuild', 'rebuild', 'operational', 'rebuild_not_retain',
    'Pointer from a station id to its organization; rebuildable from organizations.station_ids.',
    { humanReadable:'redacted' }),
  policy('saas_operations/{operationId}', 'root', 'temporary', 'none', 'exclude',
    'do_not_restore', 'operational', 'ttl_policy_required',
    'Replay records (request_id + intent fingerprint + receipt) for SaaS mutations.',
    { humanReadable:'redacted' }),
```

`tests/backup-coverage.mjs` דורש שוויון מלא בין `firestore.rules` ל-`DATA_POLICIES` — לכן קטע 2 וקטע 3 חייבים להיכנס יחד.

---

## 4 · `nav.js` — ליד `maintenance.html` (שורה ~38)

```js
  { href: 'saas-admin.html', label: 'ארגונים ומנויים', who: 'super', dot: '#5c6bc0', group: 'admin' }
```

---

## 5 · `tests/package.json`

סקריפט חדש:

```json
    "saas:test": "node ../functions/saas-contract.test.js && node ../functions/saas-service.test.js && node saas-source.mjs && node saas-admin-browser.mjs",
```

ולהוסיף ל-`all`: `&& npm run saas:test` (אחרי `npm run saas:capacity`).

`tests/saas-admin-browser.mjs` מכבד `RESQ_CHROMIUM` ו-`RESQ_REPO` (ברירת מחדל `/tmp/resq-join`; בתוך המאגר `theme.css` נמצא ליד הדף ואין צורך במשתנה).

---

## 6 · `tests/public-assets.json`

להוסיף (בסדר אלפביתי, ליד `"roles.js"` / `"rotation.js"`):

```json
  "saas-admin-ui.js",
  "saas-admin.html",
```

---

## 7 · אוצר הטלמטריה

### 7a · `functions/ops-telemetry-contract.js` — `CALLABLES` (אחרי `'getMyReadiness',`)

```js
  'createOrganization', 'attachStationToOrganization', 'changeSubscriptionPlan', 'setSubscriptionStatus',
  'getOrganizationOverview', 'simulateBillingWebhook', 'listOrganizations',
```

וב-`SCREENS` (אחרי `'device-readiness.html'`): `'saas-admin.html'`.

### 7b · `incident-client.js` — `TELEMETRY_CALLABLES` (אותו מקום, אותה רשימה)

```js
  'createOrganization', 'attachStationToOrganization', 'changeSubscriptionPlan', 'setSubscriptionStatus',
  'getOrganizationOverview', 'simulateBillingWebhook', 'listOrganizations',
```

ואם יש רשימת מסכים בצד הלקוח — `'saas-admin.html'`.

---

## 8 · `rules-test/package.json`

להוסיף ל-`test`: `&& node saas-isolation.test.mjs`. **NOT RUN** בסביבה הזו (אין אמולטור).

---

## 8ב · `RESQ_SAAS_ENABLED` — שער fail-closed

ברירת המחדל **כבויה**. בלי המשתנה, או עם כל ערך שאינו המחרוזת `'true'`,
כל שבע ה-callables מחזירות `failed-precondition` עם `reason: 'saas-disabled'`,
`addUsage` הפנימי חסום גם הוא, ומסך הניהול מציג הסבר במקום ממשק.

הסיבה אינה זהירות כללית: `createFakeBillingProvider` שומר לקוחות ומנויים
ב-`Map` בזיכרון התהליך. מופע אחר של הפונקציה, או cold start, מתחיל ריק
בעוד Firestore זוכר את הארגון — ולכן הפעלה או ביטול היו נכשלים באופן לא
עקבי. ההדלקה מחייבת ספק חיוב מתמשך (עם מפתחות idempotency, לא מצב
בזיכרון) ואישור מפורש.

## 9 · מה לא מחובר בכוונה

- `addUsage` — אין קריאה מקוד תפעולי. השירות אינו מוזכר בקריאות, בהתראות, בסידור או בהתחברות.
- ספק חיוב אמיתי — אין. `createFakeBillingProvider` בלבד; החלפה בספק אמיתי דורשת הכרעה נפרדת (סוד webhook, אחסון, PCI).
- `simulateBillingWebhook` בצורת `event_type` (מה שהמסך שולח) עובד רק מול הספק המזויף (`signWebhook`); מול ספק אמיתי הצורה הזו נדחית (`webhook-sign-unavailable`) והשרת מקבל רק `payload+signature`.
- `PLANS` — placeholder_not_agreed. המספרים אינם הסכם מסחרי.
