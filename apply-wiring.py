#!/usr/bin/env python3
"""מחיל את קטעי החיבור של החבילה על הקבצים המשותפים.

הסקריפט הזה הוא כלי מסירה: הוא מריץ בדיוק את מה שכתוב ב-*-WIRING.md,
כדי שההחלה תהיה זהה בארגז הבדיקות ובעותק העבודה, ולא "הדבקה ידנית
שאולי שונה". כל החלה היא idempotent: אם הקטע כבר שם, היא מדלגת.
"""
import json, re, sys, pathlib

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/resq-saas')
changed = []

def read(p):
    return (root / p).read_text(encoding='utf-8')

def write(p, s):
    (root / p).write_text(s, encoding='utf-8')
    changed.append(p)

def insert_after(path, anchor, block, marker):
    s = read(path)
    if marker in s:
        print('skip (already wired):', path, marker[:40]); return
    assert s.count(anchor) == 1, (path, anchor[:60], s.count(anchor))
    s = s.replace(anchor, anchor + block)
    write(path, s)

# ---------- 1. functions/index.js ----------
idx = read('functions/index.js')
if 'saas-service' not in idx:
    anchor = "const deviceReadinessModule = require('./device-readiness-service');"
    assert idx.count(anchor) == 1
    idx = idx.replace(anchor, anchor + """
const saasContract = require('./saas-contract');
const saasServiceModule = require('./saas-service');
const saasBillingModule = require('./saas-billing-provider');
const metricsSinkModule = require('./metrics-sink');
const metricsServiceModule = require('./metrics-service');""")

    tail_anchor = "exports.getMyReadiness = onCall({ enforceAppCheck: true }, req => deviceReadinessService.getMyReadiness(req));"
    assert idx.count(tail_anchor) == 1
    idx = idx.replace(tail_anchor, tail_anchor + """

// ---------- שכבת SaaS מסחרית ----------
//
// ארגונים, מנויים, מכסות ושימוש. מנהל-על בלבד, לפי claims חיים. הארגון
// מפנה לתחנות לפי מזהה בלבד ואינו מקור הרשאה: ההרשאות נשארות claims
// ומסמכי stations/{sid}/users. ספק החיוב כאן **מזויף** — אין חיוב אמיתי,
// אין ספק אמיתי, אין סוד ספק בקוד. מצב suspended חוסם יצירת משאב מסחרי
// חדש בלבד; הוא אינו מוחק דבר ואינו נקרא משום מסלול תפעולי.
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
exports.createOrganization = onCall({ enforceAppCheck: true }, req => saasService.createOrganization(req));
exports.attachStationToOrganization = onCall({ enforceAppCheck: true }, req => saasService.attachStationToOrganization(req));
exports.changeSubscriptionPlan = onCall({ enforceAppCheck: true }, req => saasService.changeSubscriptionPlan(req));
exports.setSubscriptionStatus = onCall({ enforceAppCheck: true, timeoutSeconds: 60 }, req => saasService.setSubscriptionStatus(req));
exports.getOrganizationOverview = onCall({ enforceAppCheck: true }, req => saasService.getOrganizationOverview(req));
exports.simulateBillingWebhook = onCall({ enforceAppCheck: true }, req => saasService.simulateBillingWebhook(req));
exports.listOrganizations = onCall({ enforceAppCheck: true }, req => saasService.listOrganizations(req));

// ---------- מדדים תפעוליים ----------
//
// מונים יומיים בלבד, קטלוג אירועים סגור, בלי טקסט חופשי ובלי מזהה אישי.
// תחנה/ארגון/UID נשמרים כגיבוב; בלי RESQ_METRICS_HASH_KEY הגיבוב הוא
// sha256 רגיל, והלוח מסמן במפורש "פסאודונים, הפיך במנייה".
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
exports.getMetricsDashboard = onCall({ enforceAppCheck: true }, req => metricsService.getMetricsDashboard(req));""")
    write('functions/index.js', idx)

# ---------- 2. firestore.rules ----------
rules = read('firestore.rules')
if 'organization_station_index' not in rules:
    m = re.search(r"    match /join_campaign_inspect_quota/\{quotaId\} \{\n(?:.*\n)*?    \}\n", rules)
    assert m, 'join_campaign_inspect_quota block not found'
    block = """
    // ---------- שכבת SaaS מסחרית ----------
    //
    // ארגון, מנוי, שימוש וביקורת ארגונית מנוהלים רק דרך Callables מאומתים
    // (App Check + מנהל-על חי בשרת). הדפדפן — גם של מנהל-על — אינו קורא
    // ואינו כותב אותם ישירות. האינדקס תחנה→ארגון ורשומות ה-replay סגורים
    // מאותה סיבה. הארגון אינו מקור הרשאה בשום מסלול.
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

    // ---------- מדדים תפעוליים ----------
    //
    // מונים מצטברים בלבד, בלי מזהה אישי ובלי טקסט חופשי. הדיווח והקריאה
    // עוברים callables; הדפדפן אינו נוגע במסמכים האלה.
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
"""
    rules = rules[:m.end()] + block + rules[m.end():]
    write('firestore.rules', rules)

# ---------- 3. functions/backup-policy.js ----------
bp = read('functions/backup-policy.js')
if "'organizations/{organizationId}'" not in bp:
    m = re.search(r"  policy\('join_campaign_inspect_quota/\{quotaId\}'(?:.*\n)*?\n", bp)
    assert m, 'join_campaign_inspect_quota policy not found'
    end = bp.index('\n', bp.index('join_campaign_inspect_quota'))
    # find the end of that policy call: the line ending with '}),' or '),'
    start = bp.index("  policy('join_campaign_inspect_quota/{quotaId}'")
    close = bp.index('\n', bp.index('),', start) + 1)
    block = """  // שכבת SaaS מסחרית. ארגון = הפניות למזהי תחנות בלבד (לא נתוני תחנה);
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
  // מדדים תפעוליים. מונים בלבד, ללא זהות וללא טקסט חופשי.
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
"""
    bp = bp[:close] + block + bp[close:]
    write('functions/backup-policy.js', bp)

# ---------- 4. nav.js ----------
nav = read('nav.js')
if 'saas-admin.html' not in nav:
    anchor = "  { href: 'maintenance.html', label: 'תחזוקת מערכת', who: 'super', dot: '#00a884', group: 'admin' }"
    assert nav.count(anchor) == 1
    nav = nav.replace(anchor, anchor + """,
  { href: 'saas-admin.html', label: 'ארגונים ומנויים', who: 'super', dot: '#5c6bc0', group: 'admin' },
  { href: 'metrics.html', label: 'מדדים תפעוליים', who: 'super', dot: '#7e57c2', group: 'admin' }""")
    write('nav.js', nav)

# ---------- 5. tests/nav-groups.mjs ----------
ng = read('tests/nav-groups.mjs')
if 'saas-admin.html' not in ng:
    anchor = "const all = audit.concat(['hr.html', 'import.html', 'check.html', 'maintenance.html', 'callout.html']);"
    assert ng.count(anchor) == 1
    ng = ng.replace(anchor, "const all = audit.concat(['hr.html', 'import.html', 'check.html', 'maintenance.html', 'callout.html', 'saas-admin.html', 'metrics.html']);")
    write('tests/nav-groups.mjs', ng)

# ---------- 5b. tests/role.mjs — מלאי התפריט של מנהל-על ----------
# שני מסכי super חדשים נכנסים לתפריט, ולכן רשימת היעדים המדויקת
# בבדיקת התפקידים גדלה בשניים. זו עדכון מלאי, לא ריכוך של חוזה.
rm = read('tests/role.mjs')
if 'ארגונים ומנויים' not in rm:
    anchor = "'בדיקה','תחזוקת מערכת']"
    assert rm.count(anchor) == 1, rm.count(anchor)
    rm = rm.replace(anchor, "'בדיקה','תחזוקת מערכת','ארגונים ומנויים','מדדים תפעוליים']")
    write('tests/role.mjs', rm)

# ---------- 5c. tests/ops-global-browser.mjs — מלאי מסכי Firebase ----------
# שני מסכים חדשים מאתחלים App Check ומשתמשים בפסאדה של monitored-functions,
# ולכן הם נכנסים לשתי הרשימות המפורשות ולכותרות המונות.
og = read('tests/ops-global-browser.mjs')
if 'saas-admin.html' not in og:
    a1 = "'vehicle.html','device-readiness.html']"
    assert og.count(a1) == 1
    og = og.replace(a1, "'vehicle.html','device-readiness.html','saas-admin.html','metrics.html']")
    a2 = "'hr-documents-client.js','device-readiness.html']"
    assert og.count(a2) == 1
    og = og.replace(a2, "'hr-documents-client.js','device-readiness.html','saas-admin.html','metrics.html']")
    a3 = "assert.equal(consumers.length, 19);"
    assert og.count(a3) == 1
    og = og.replace(a3, "assert.equal(consumers.length, 21);")
    a4 = "'all 27 Firebase screens bootstrap monitoring and all 19 factories use the facade'"
    assert og.count(a4) == 1
    og = og.replace(a4, "'all 29 Firebase screens bootstrap monitoring and all 21 factories use the facade'")
    write('tests/ops-global-browser.mjs', og)

# ---------- 6. tests/public-assets.json ----------
pa = json.loads(read('tests/public-assets.json'))
add = ['saas-admin-ui.js', 'saas-admin.html', 'metrics-client.js', 'metrics-ui.js', 'metrics.html']
if not set(add) <= set(pa):
    pa = sorted(set(pa) | set(add))
    write('tests/public-assets.json', json.dumps(pa, ensure_ascii=False, indent=2) + '\n')

# ---------- 7. telemetry vocabularies ----------
NEW_CALLABLES = ("  'createOrganization', 'attachStationToOrganization', 'changeSubscriptionPlan', 'setSubscriptionStatus',\n"
                 "  'getOrganizationOverview', 'simulateBillingWebhook', 'listOrganizations',\n"
                 "  'recordMetrics', 'getMetricsDashboard',\n")
for path in ('functions/ops-telemetry-contract.js', 'incident-client.js'):
    s = read(path)
    if 'recordMetrics' in s:
        print('skip (already wired):', path); continue
    m = re.search(r"'getMyReadiness',\n", s)
    assert m, path
    s = s[:m.end()] + NEW_CALLABLES + s[m.end():]
    m2 = re.search(r"\n(\s*)'device-readiness\.html'\n", s)
    assert m2, path + ' SCREENS'
    s = s[:m2.start()] + "\n" + m2.group(1) + "'device-readiness.html', 'saas-admin.html', 'metrics.html'\n" + s[m2.end():]
    write(path, s)

# ---------- 8. tests/package.json ----------
pkg = json.loads(read('tests/package.json'))
sc = pkg['scripts']
if 'saas:test' not in sc:
    sc['saas:test'] = 'node ../functions/saas-contract.test.js && node ../functions/saas-service.test.js && node saas-source.mjs && node saas-admin-browser.mjs'
    sc['security:test'] = 'node security-boundaries.mjs && node security-mutations.mjs'
    sc['dr:test'] = 'node ops-disaster-restore.test.mjs'
    sc['metrics:test'] = 'node ../functions/metrics-catalog.test.js && node ../functions/metrics-service.test.js && node metrics-client.test.mjs && node metrics-source.mjs && node metrics-browser.mjs'
    sc['mobile:test'] = 'node mobile-shell.mjs'
    sc['all'] = sc['all'] + ' && npm run saas:test && npm run security:test && npm run dr:test && npm run metrics:test && npm run mobile:test'
    # the non-browser parts also run in static so a plain static run covers them
    sc['static'] = sc['static'] + ' && node ops-disaster-restore.test.mjs && node mobile-shell.mjs && node security-boundaries.mjs && node security-mutations.mjs'
    write('tests/package.json', json.dumps(pkg, ensure_ascii=False, indent=2) + '\n')

# ---------- 9. rules-test/package.json ----------
rt = json.loads(read('rules-test/package.json'))
if 'saas-isolation' not in rt['scripts'].get('test', ''):
    rt['scripts']['test'] = rt['scripts']['test'] + ' && node saas-isolation.test.mjs'
    write('rules-test/package.json', json.dumps(rt, ensure_ascii=False, indent=2) + '\n')

# ---------- 10. firebase.json hosting.ignore ----------
fb = json.loads(read('firebase.json'))
ign = fb['hosting']['ignore']
changed = False
if 'apps/**' not in ign:
    ign.insert(ign.index('functions/**') + 1 if 'functions/**' in ign else len(ign), 'apps/**')
    changed = True
# הקובץ הזה עצמו הוא .py, ו-hosting.public הוא ".". בלי שתי התבניות
# האלה הוא נכלל בארטיפקט של Hosting ומוגש לציבור. זה נתפס בשער
# pages:preview, ולא בשום מקום מוקדם יותר.
for pattern in ('*.py', '**/*.py'):
    if pattern not in ign:
        ign.insert(ign.index('**/*.ps1') + 1 if '**/*.ps1' in ign else len(ign), pattern)
        changed = True
if changed:
    write('firebase.json', json.dumps(fb, ensure_ascii=False, indent=2) + '\n')

# ---------- 11. .gitignore ----------
gi = read('.gitignore')
if 'apps/mobile/**/google-services.json' not in gi:
    gi = gi.rstrip('\n') + """

# מעטפת חנות (apps/mobile) — תצורה סודית ותוצרי בנייה.
# התבניות עצמן נשמרות בגיט; חומר חתימה ותוצרי בנייה — לעולם לא.
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
"""
    write('.gitignore', gi)

print('WIRED FILES:')
for c in changed:
    print('  ' + c)
