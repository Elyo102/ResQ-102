'use strict';
/* מדיניות גיבוי לאוספי המדדים — רשומות מוצעות ל-DATA_POLICIES ב-backup-policy.js.
 *
 * הקובץ אינו משנה את backup-policy.js. הוא מייצא את הרשומות בדיוק בצורה
 * שהמודול הקיים מאמת (validatePolicies), ובדיקת המקור מאמתת אותן יחד עם
 * DATA_POLICIES הקיימות. החיבור בפועל: העתקה ל-DATA_POLICIES לפי METRICS-WIRING.md.
 *
 * הנימוק: הצבירות היומיות נגזרות ממאורעות שכבר אבדו (אין מקור גולמי), אך
 * אינן נתון עסקי — אובדן שלהן פירושו חור בגרף, לא נזק. לכן derived/rebuild
 * (rebuild = מהמאורעות העתידיים בלבד). המכסות ורשומות הפעולה הן מצב זמני
 * שאסור לשחזר: שחזור מכסה ישנה יחסום או יפתח דיווח בטעות, ושחזור רשומת
 * פעולה יגרום ל-replay שגוי. */

const policy = (path, scope, classification, monitorPolicy, backupPolicy, restorePolicy, sensitivity, retention, reason, extra) =>
  Object.freeze(Object.assign({ path, scope, classification, monitorPolicy, backupPolicy, restorePolicy, sensitivity, retention, reason }, extra || {}));

const METRICS_POLICIES = Object.freeze([
  policy('metrics_daily/{id}', 'root', 'derived',
    'none', 'rebuild', 'rebuild', 'operational', 'ttl_90_days',
    'Daily hashed-scope counters (no identity, no free text); rebuilt only from future events, a gap is acceptable.',
    { humanReadable: 'allowed' }),
  policy('metrics_daily/{id}/shards/{shard}', 'root', 'derived',
    'none', 'rebuild', 'rebuild', 'operational', 'ttl_90_days_with_parent',
    'Sharded increment counters under the daily aggregate; same lifecycle as the parent.',
    { humanReadable: 'allowed' }),
  policy('metrics_quota/{id}', 'root', 'temporary',
    'none', 'exclude', 'do_not_restore', 'operational', 'ttl_2_days',
    'Per-account call quota and per-station cardinality guard keyed by hashes; restoring stale quota would block or unblock reporting incorrectly.',
    { humanReadable: 'redacted' }),
  policy('metrics_operations/{id}', 'root', 'temporary',
    'none', 'exclude', 'do_not_restore', 'operational', 'ttl_2_days',
    'Replay records (request fingerprint only); restoring them would misclassify fresh requests as duplicates.',
    { humanReadable: 'redacted' })
]);

module.exports = Object.freeze({ METRICS_POLICIES });
