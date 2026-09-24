'use strict';

// Cloud Billing Export reports project usage, not a user's invoice. The
// reader is deliberately dormant until an owner configures one exact table.
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 30;
const DEFAULT_MAX_BYTES_BILLED = 100 * 1024 * 1024;
const MAX_CONFIGURED_BYTES = 1024 * 1024 * 1024;
const SUCCESS_CACHE_MS = 15 * 60 * 1000;
const FAILURE_CACHE_MS = 60 * 1000;

function validTable(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  return parts.length === 3
    && /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(parts[0])
    // The runtime identity may read only this project-filtered authorized view,
    // never the account-wide raw Billing Export table.
    && parts[1] === 'resq_billing_views'
    && parts[2] === 'resq_station102_usage_cost';
}

function unavailable(reason, note) {
  return Object.freeze({
    id: 'actual_cost', title_he: 'עלות בפועל', source: 'billing',
    badge: 'אין מקור', available: false, value: null, currency: null,
    reason, by_service: Object.freeze([]), by_day: Object.freeze([]),
    as_of: null,
    note_he: note || 'ייצוא Billing לא חובר או אינו זמין. אין כאן אפס או אומדן.'
  });
}

function parseNumeric(value) {
  if (typeof value !== 'string' || !/^-?\d{1,29}(?:\.\d{1,9})?$/.test(value)) return null;
  const negative = value.startsWith('-');
  const clean = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = clean.split('.');
  const nanos = BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0'));
  return negative ? -nanos : nanos;
}

function formatNumeric(nanos) {
  const negative = nanos < 0n;
  const absolute = negative ? -nanos : nanos;
  const whole = absolute / 1000000000n;
  const fractional = String(absolute % 1000000000n).padStart(9, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + String(whole) + (fractional ? '.' + fractional : '');
}

function createCostBillingReader(options) {
  const o = options || {};
  const configured = o.enabled === true;
  const table = o.table;
  const projectId = o.projectId;
  const jobProject = o.jobProject;
  const location = o.location;
  const maxBytesBilled = o.maxBytesBilled === undefined
    ? DEFAULT_MAX_BYTES_BILLED : o.maxBytesBilled;
  const cache = new Map();
  const valid = configured && validTable(table)
    && projectId === 'station-102'
    && typeof jobProject === 'string' && /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(jobProject)
    && typeof location === 'string' && /^(EU|US|[a-z]+-[a-z]+\d)$/.test(location)
    && Number.isSafeInteger(maxBytesBilled)
    && maxBytesBilled > 0 && maxBytesBilled <= MAX_CONFIGURED_BYTES
    && typeof o.query === 'function' && typeof o.now === 'function';

  async function fetch(days) {
    if (!configured) return unavailable('billing_not_connected');
    if (!valid) return unavailable('billing_configuration_invalid');
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      return unavailable('billing_range_invalid');
    }
    const endMs = o.now();
    if (!Number.isFinite(endMs)) return unavailable('billing_clock_invalid');
    const start = new Date(endMs - days * DAY_MS).toISOString();
    const end = new Date(endMs).toISOString();
    // Identifiers cannot be query parameters. The one owner-configured table
    // is validated above; all variable data is passed as typed parameters.
    const sql = `SELECT DATE(usage_start_time, 'UTC') AS day,\n`
      + `  service.description AS service, currency,\n`
      + `  SUM(CAST(cost AS NUMERIC) + COALESCE((SELECT SUM(CAST(c.amount AS NUMERIC))\n`
      + `    FROM UNNEST(credits) AS c), 0)) AS net_cost,\n`
      + `  UNIX_MILLIS(MAX(export_time)) AS last_export_ms\n`
      + `FROM \`${table}\`\n`
      + `WHERE project.id = @project_id AND cost_type = 'regular'\n`
      + `  AND usage_start_time >= @start_at AND usage_start_time < @end_at\n`
      + `GROUP BY day, service, currency ORDER BY day DESC, service`;
    const request = Object.freeze({ sql, projectId: jobProject, location,
      maxBytesBilled, parameters: Object.freeze({
        project_id: projectId, start_at: start, end_at: end
      }) });
    try {
      const preview = await o.query({ ...request, dryRun: true });
      const estimated = Number(preview && preview.totalBytesProcessed);
      if (!Number.isSafeInteger(estimated) || estimated < 0 || estimated > maxBytesBilled) {
        return unavailable('billing_query_over_budget');
      }
      const response = await o.query({ ...request, dryRun: false });
      if (!response || response.complete !== true || response.pageToken
          || !Array.isArray(response.rows) || response.rows.length === 0
          || response.rows.length > 1000) {
        return unavailable('billing_export_empty_or_incomplete');
      }
      const byService = new Map();
      const byDay = new Map();
      const currencies = new Set();
      let asOf = 0;
      let total = 0n;
      for (const row of response.rows) {
        const amount = parseNumeric(row.net_cost);
        const exported = Date.parse(row.last_export);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day)
            || typeof row.service !== 'string' || !row.service || row.service.length > 160
            || typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)
            || amount === null || !Number.isFinite(exported)) {
          return unavailable('billing_export_invalid');
        }
        currencies.add(row.currency);
        asOf = Math.max(asOf, exported);
        total += amount;
        byService.set(row.service, (byService.get(row.service) || 0n) + amount);
        byDay.set(row.day, (byDay.get(row.day) || 0n) + amount);
      }
      if (currencies.size !== 1) return unavailable('billing_multiple_currencies',
        'הייצוא כולל יותר ממטבע אחד; אין סכום מאוחד מטעה.');
      const currency = [...currencies][0];
      return Object.freeze({
        id: 'actual_cost', title_he: 'עלות שימוש מדווחת', source: 'billing_export',
        badge: 'BILLING REPORTED', available: true, value: formatNumeric(total),
        currency, as_of: new Date(asOf).toISOString(), period_start: start,
        period_end: end, days, cost_definition: 'regular_usage_net_of_credits_excludes_tax_and_adjustments',
        by_service: Object.freeze([...byService].map(([service, value]) => Object.freeze({
          service, value: formatNumeric(value), currency
        }))),
        by_day: Object.freeze([...byDay].map(([day, value]) => Object.freeze({
          day, value: formatNumeric(value), currency
        }))),
        note_he: 'עלות שימוש מדווחת לאחר זיכויים, ללא מסים והתאמות. הייצוא עשוי להתעכב ולהשתנות; זו אינה חשבונית סופית או עלות לפי משתמש.'
      });
    } catch (_) {
      return unavailable('billing_query_unavailable');
    }
  }

  function read(days) {
    if (!configured || !valid || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      return fetch(days);
    }
    const nowMs = o.now();
    if (!Number.isFinite(nowMs)) return fetch(days);
    const existing = cache.get(days);
    if (existing && (existing.pending || nowMs < existing.expiresAt)) return existing.promise;
    const entry = { pending: true, expiresAt: 0, promise: null };
    entry.promise = fetch(days).then((result) => {
      entry.pending = false;
      entry.expiresAt = o.now() + (result.available ? SUCCESS_CACHE_MS : FAILURE_CACHE_MS);
      return result;
    }, (error) => {
      if (cache.get(days) === entry) cache.delete(days);
      throw error;
    });
    cache.set(days, entry);
    return entry.promise;
  }

  return Object.freeze({ read, configured, valid });
}

module.exports = Object.freeze({
  createCostBillingReader, validTable, parseNumeric, formatNumeric,
  DEFAULT_MAX_BYTES_BILLED, MAX_CONFIGURED_BYTES
});
