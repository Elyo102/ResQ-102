'use strict';

// Inert policy. No queue, network, database, authorization, or delivery claim.
// Authenticated adapters must supply current silent state and recipient scope.
const { createHash } = require('node:crypto');
const TYPES = Object.freeze({
  hr_message: 'ממתין לך עדכון ממשאבי אנוש',
  hr_request: 'ממתינה פנייה לטיפול',
  hr_reply: 'התקבל עדכון לפנייה שלך',
  hr_document: 'ממתין לך מסמך ברסקיו',
  hr_procedure: 'פורסם נוהל לעיונך',
  hr_nudge: 'ממתינה תזכורת לטיפול',
  report_confirm: 'נדרש אישורך לדוח השעות',
  report_submit: 'נדרשת הגשת דוח השעות',
  report_command: 'ממתין דוח שעות לאישורך',
  schedule_change: 'הסידור שלך עודכן',
  guard_change: 'השיבוץ שלך לאבטחה עודכן'
});
class HrPolicyInputError extends Error {
  constructor(code) { super(code); this.name = 'HrPolicyInputError'; this.code = code; }
}
const fail = code => { throw new HrPolicyInputError(code); };
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
function instant(value) {
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) fail('invalid-instant');
  return value;
}
function localClock(value) {
  const parts = Object.fromEntries(dateFormat.formatToParts(new Date(instant(value)))
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { day: parts.year + '-' + parts.month + '-' + parts.day, hour: Number(parts.hour) };
}
function quietAt(value) { const { hour } = localClock(value); return hour >= 22 || hour < 7; }
function nextMorning(nowMs) {
  // Search real instants, not a guessed UTC offset; handles Israel DST changes.
  const start = Math.floor(nowMs / 60000) * 60000 + 60000;
  for (let value = start; value <= nowMs + 26 * 60 * 60000; value += 60000) {
    if (!quietAt(value)) return value;
  }
  fail('morning-not-found');
}
function decideNotification(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-policy-input');
  const now = instant(input.now_ms);
  if (!['manual', 'automatic', 'operational'].includes(input.mode)) fail('invalid-mode');
  if (!['on', 'off', 'unknown'].includes(input.silent)) fail('invalid-silent-state');
  if (input.silent_allow !== undefined && typeof input.silent_allow !== 'boolean') fail('invalid-silent-allow');
  if (input.send_now !== undefined && typeof input.send_now !== 'boolean') fail('invalid-send-now');
  const result = (decision, reason, notBefore = null) => Object.freeze({
    decision, reason, not_before_ms: notBefore, delivery_status: 'intent_only'
  });
  if (input.silent === 'unknown') return result('blocked', 'silent-state-unavailable');
  if (input.silent === 'on' && input.silent_allow !== true) return result('suppressed', 'system-silent');
  if (input.mode === 'automatic' && input.last_reminder_at_ms != null) {
    const previous = instant(input.last_reminder_at_ms);
    if (previous > now) fail('future-reminder');
    if (localClock(previous).day === localClock(now).day) return result('skip', 'already-reminded-today');
  }
  if (input.mode === 'operational') return result('queue', 'operational');
  if (!quietAt(now)) return result('queue', 'routine');
  if (input.mode === 'automatic') return result('defer', 'quiet-hours', nextMorning(now));
  return input.send_now === true ? result('queue', 'manual-quiet-hours-confirmed')
    : result('confirmation_required', 'manual-quiet-hours-warning', nextMorning(now));
}
function safePart(value, max) {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f/]/.test(value)) fail('invalid-intent-identity');
  return value;
}
function notificationIntent(input) {
  if (!input || typeof input.type !== 'string' || !own(TYPES, input.type)) fail('invalid-notification-type');
  const sid = safePart(input.station_id, 120), uid = safePart(input.recipient_uid, 128);
  const event = safePart(input.event_id, 200);
  const id = createHash('sha256').update(JSON.stringify(['hr-notification-v1', sid, uid, input.type, event])).digest('hex');
  return Object.freeze({ id, station_id: sid, recipient_uid: uid, type: input.type,
    event_id: event, title: TYPES[input.type], body: 'לצפייה בפרטים יש לפתוח את רסקיו.',
    delivery_status: 'intent_only' });
}
module.exports = Object.freeze({ HrPolicyInputError, TYPES, decideNotification, notificationIntent });
