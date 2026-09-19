// לוח מדדים תפעוליים — ציור DOM טהור. textContent בלבד, ללא HTML ממחרוזות.
// "לא זמין" לעולם אינו מוצג כ-0. דגלי חלקי/ישן מוצגים ליד כל מדד.
// מצב הגיבוב מוצג בכנות: ללא מפתח — "פסאודונים, הפיך במנייה". לא "אנונימי".

const DERIVED_LABELS = Object.freeze({
  registrations_started: 'הרשמות שהתחילו',
  registrations_completed: 'הרשמות שהושלמו',
  devices_ready: 'מכשירים מוכנים',
  push_success_rate: 'שיעור הצלחת פוש',
  load_time_buckets: 'זמני טעינה (כניסה מוצלחת)',
  schedule_publish_failures: 'כשלי פרסום סידור',
  callouts_opened: 'קריאות שנפתחו',
  callouts_closed: 'קריאות שנסגרו',
  active_users_rate: 'שיעור משתמשים פעילים'
});
const EVENT_LABELS = Object.freeze({
  login_success: 'כניסה מוצלחת', login_failure: 'כניסה שנכשלה',
  onboarding_started: 'קליטה התחילה', onboarding_completed: 'קליטה הושלמה',
  device_readiness_started: 'מוכנות מכשיר התחילה', device_readiness_completed: 'מוכנות מכשיר הושלמה',
  push_queued: 'פוש נכנס לתור', push_delivered: 'פוש נמסר', push_failed: 'פוש נכשל',
  schedule_import_started: 'ייבוא סידור התחיל', schedule_import_completed: 'ייבוא סידור הושלם',
  schedule_publish_completed: 'פרסום סידור הושלם',
  callout_started: 'קריאה נפתחה', callout_closed: 'קריאה נסגרה',
  client_error: 'שגיאת לקוח'
});
const REASON_HE = Object.freeze({
  'no-data': 'אין נתונים בטווח', 'no-source': 'אין מקור למדד בשכבה זו', 'zero-denominator': 'אין מכנה (לא נמסר ולא נכשל)'
});
const HASH_MODE_HE = Object.freeze({
  keyed: 'גיבוב עם מפתח (HMAC) — פסאודונים',
  unkeyed: 'ללא מפתח — פסאודונים, הפיך במנייה',
  none: 'אין נתונים — מצב הגיבוב לא ידוע'
});
const UNAVAILABLE = 'לא זמין';
const DAY_OPTIONS = Object.freeze([1, 7, 14, 30]);

function text(el, value) { if (el) el.textContent = String(value == null ? '' : value); }
function asCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = String(content);
  return node;
}
function dayText(day) {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.slice(8, 10) + '.' + day.slice(5, 7) + '.' + day.slice(0, 4) : '—';
}
function valueText(key, metric) {
  if (!metric || metric.available !== true || metric.value === null || metric.value === undefined) return UNAVAILABLE;
  if (key === 'push_success_rate') {
    return typeof metric.value === 'number' ? Math.round(metric.value * 1000) / 10 + '%' : UNAVAILABLE;
  }
  if (key === 'load_time_buckets') {
    const buckets = metric.value && typeof metric.value === 'object' ? metric.value : {};
    const parts = Object.keys(buckets).map((k) => [Number(k.replace('bucket_', '')), asCount(buckets[k])])
      .filter(([ms, n]) => Number.isFinite(ms) && n !== null).sort((a, b) => a[0] - b[0])
      .map(([ms, n]) => 'עד ' + ms + ' מ״ש: ' + n);
    return parts.length ? parts.join(' · ') : UNAVAILABLE;
  }
  const n = asCount(metric.value);
  return n === null ? UNAVAILABLE : new Intl.NumberFormat('he-IL').format(n);
}
function badgesFor(metric) {
  const out = [];
  if (!metric || metric.available !== true) out.push(['unavailable', UNAVAILABLE]);
  if (metric && metric.partial === true) out.push(['partial', 'חלקי']);
  if (metric && metric.stale === true) out.push(['stale', 'ישן']);
  if (metric && metric.available !== true && REASON_HE[metric.reason]) out.push(['reason', REASON_HE[metric.reason]]);
  return out;
}

export function createMetricsUi({ elements, call, currentIdentity, onIdentityLost }) {
  if (!elements || typeof call !== 'function' || typeof currentIdentity !== 'function') throw new TypeError('metrics ui dependencies required');
  let generation = 0;
  let busy = false;
  let days = 7;
  function sameIdentity(before) {
    const now = currentIdentity();
    return !!before && !!now && before.uid === now.uid && before.epoch === now.epoch && before.super === true && now.super === true;
  }
  function setBusy(value) {
    busy = value === true;
    [elements.refresh, elements.range].forEach((control) => { if (control) control.disabled = busy; });
  }
  function message(value, kind) {
    if (!elements.message) return;
    elements.message.className = 'metrics-note ' + (kind || '');
    text(elements.message, value);
  }
  function invalidate() {
    generation += 1;
    setBusy(false);
    text(elements.hashMode, '—'); text(elements.asOf, '—'); text(elements.rangeLabel, '—');
    if (elements.flags) elements.flags.replaceChildren();
    if (elements.derived) elements.derived.replaceChildren();
    if (elements.events) elements.events.replaceChildren();
    message('', '');
  }
  function row(key, label, metric) {
    const item = el('article', 'metrics-row');
    item.dataset.metric = key;
    item.dataset.available = metric && metric.available === true ? 'true' : 'false';
    const head = el('div', 'metrics-row-head');
    head.appendChild(el('span', 'metrics-label', label));
    const badges = el('span', 'metrics-badges');
    for (const [kind, label2] of badgesFor(metric)) badges.appendChild(el('span', 'metrics-badge ' + kind, label2));
    head.appendChild(badges);
    const value = el('strong', 'metrics-value', valueText(key, metric));
    const meta = el('div', 'metrics-meta');
    const parts = [];
    if (metric && metric.available === true && metric.as_of_day) parts.push('נכון ליום ' + dayText(metric.as_of_day));
    if (metric && Number.isSafeInteger(metric.ok) && Number.isSafeInteger(metric.fail)) parts.push('תקין: ' + metric.ok + ' · נכשל: ' + metric.fail);
    if (metric && Number.isSafeInteger(metric.total)) parts.push('סה״כ: ' + metric.total);
    if (metric && Number.isSafeInteger(metric.delivered) && Number.isSafeInteger(metric.failed)) parts.push('נמסרו: ' + metric.delivered + ' · נכשלו: ' + metric.failed);
    meta.textContent = parts.join(' · ');
    item.append(head, value, meta);
    return item;
  }
  function render(dto) {
    const d = dto && typeof dto === 'object' ? dto : {};
    const mode = HASH_MODE_HE[d.hash_mode] ? d.hash_mode : 'none';
    text(elements.hashMode, HASH_MODE_HE[mode]);
    if (elements.hashMode) elements.hashMode.dataset.mode = mode;
    text(elements.asOf, d.as_of_day ? dayText(d.as_of_day) : 'אין עדיין');
    text(elements.rangeLabel, Number.isSafeInteger(d.days) ? (dayText(d.from_day) + ' – ' + dayText(d.to_day)) : '—');
    if (elements.flags) {
      elements.flags.replaceChildren();
      if (d.partial === true) elements.flags.appendChild(el('span', 'metrics-badge partial', 'חלקי — ' + (Array.isArray(d.failed_days) ? d.failed_days.length : 0) + ' ימים לא נקראו'));
      if (d.stale === true) elements.flags.appendChild(el('span', 'metrics-badge stale', 'ישן — אין נתונים מהיום או מאתמול'));
      if (mode === 'unkeyed') elements.flags.appendChild(el('span', 'metrics-badge unkeyed', 'ללא מפתח גיבוב'));
    }
    const derived = d.derived && typeof d.derived === 'object' ? d.derived : {};
    const events = d.events && typeof d.events === 'object' ? d.events : {};
    if (elements.derived) {
      elements.derived.replaceChildren();
      for (const key of Object.keys(DERIVED_LABELS)) elements.derived.appendChild(row(key, DERIVED_LABELS[key], derived[key]));
    }
    if (elements.events) {
      elements.events.replaceChildren();
      for (const key of Object.keys(EVENT_LABELS)) elements.events.appendChild(row(key, EVENT_LABELS[key], events[key]));
    }
  }
  async function refresh() {
    if (busy) return;
    const before = currentIdentity(); const mine = ++generation; setBusy(true);
    try {
      const result = await call('getMetricsDashboard', { days });
      if (mine !== generation) return;
      if (!sameIdentity(before)) { onIdentityLost(); return; }
      render(result || {});
      message('הנתונים עודכנו. מונים בלבד — ללא זהות, ללא טקסט חופשי.', 'safe');
    } catch (error) {
      if (mine !== generation) return;
      if (!sameIdentity(before)) { onIdentityLost(); return; }
      const code = String(error && error.code || '');
      message(code.includes('permission-denied') ? 'השרת דחה את הפעולה: נדרשת הרשאת מנהל־על חיה.' : 'הטעינה נכשלה. ' + (code || 'שגיאה'), 'warn');
    } finally { if (mine === generation) setBusy(false); }
  }
  function setDays(value) {
    const n = Number(value);
    days = DAY_OPTIONS.includes(n) ? n : 7;
    return days;
  }
  return Object.freeze({ render, invalidate, refresh, setDays, days: () => days });
}

export const METRICS_DERIVED_LABELS = DERIVED_LABELS;
export const METRICS_EVENT_LABELS = EVENT_LABELS;
export const METRICS_DAY_OPTIONS = DAY_OPTIONS;
export const METRICS_UNAVAILABLE_TEXT = UNAVAILABLE;
