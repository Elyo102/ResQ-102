'use strict';
/* שכבת SaaS מסחרית — חוזה טהור (ללא Firebase, ללא UI, ללא רשת).
 *
 * מגדיר ארגון, מנוי, קטלוג תוכניות, טבלת מעברי סטטוס, בדיקת מכסה,
 * טביעות כוונה ל-replay, ומיפוי אירועי webhook לסטטוס. כל פונקציה כאן
 * דטרמיניסטית וניתנת לבדיקה ביחידה.
 *
 * עקרונות סגורים:
 * - ארגון מפנה לתחנות קיימות לפי מזהה בלבד; הוא אינו מקור הרשאה ואינו
 *   מעתיק נתוני תחנה.
 * - הלקוח שולח plan_id בלבד. סכום, מחיר, הנחה, מטבע או מצב תשלום מהלקוח
 *   נדחים בשמם.
 * - קטלוג התוכניות הוא placeholder שלא סוכם מסחרית (placeholder_not_agreed).
 */

const ORG_SCHEMA = 'saas-organization-v1';
const SUBSCRIPTION_SCHEMA = 'saas-subscription-v1';
const USAGE_SCHEMA = 'saas-usage-v1';
const AUDIT_SCHEMA = 'saas-audit-v1';
const OPERATION_SCHEMA = 'saas-operation-v1';
const INDEX_SCHEMA = 'saas-station-index-v1';

const STATUSES = Object.freeze(['evaluation', 'active', 'suspended', 'cancelled']);
const METRICS = Object.freeze(['stations', 'active_users', 'storage_mb', 'pushes_per_month']);
const PLAN_IDS = Object.freeze(['evaluation', 'station', 'district', 'enterprise']);

/* קטלוג התוכניות. המספרים אינם הסכם מסחרי — הם מקום שמור בלבד. */
const plan = (id, stations, users, storage, pushes) => Object.freeze({
  plan_id: id, stations, active_users: users, storage_mb: storage, pushes_per_month: pushes, placeholder_not_agreed: true
});
const PLANS = Object.freeze({
  evaluation: plan('evaluation', 1, 60, 512, 5000),
  station: plan('station', 1, 400, 4096, 50000),
  district: plan('district', 12, 4000, 65536, 600000),
  enterprise: plan('enterprise', 100, 30000, 1048576, 6000000)
});

/* פעולות סטטוס ניהוליות (סימולציה של מנהל-על) — מקור → יעד. */
const STATUS_ACTIONS = Object.freeze(['activate', 'suspend', 'cancel', 'reactivate']);
const TRANSITIONS = Object.freeze({
  activate: Object.freeze({ from: Object.freeze(['evaluation']), to: 'active' }),
  suspend: Object.freeze({ from: Object.freeze(['evaluation', 'active']), to: 'suspended' }),
  cancel: Object.freeze({ from: Object.freeze(['evaluation', 'active', 'suspended']), to: 'cancelled' }),
  /* חזרה מביטול — מנהל-על בלבד (נאכף ב-applyStatusAction דרך ctx.is_super). */
  reactivate: Object.freeze({ from: Object.freeze(['suspended', 'cancelled']), to: 'active' })
});

/* אירועי webhook מוכרים → סטטוס. מיפוי בשרת בלבד; ה-payload לעולם אינו
 * קובע גבולות תוכנית, ולעולם אינו מחזיר מנוי מבוטל לפעילות. */
const WEBHOOK_EVENTS = Object.freeze(['checkout.completed', 'payment.failed', 'payment.recovered', 'subscription.cancelled']);
const WEBHOOK_STATUS = Object.freeze({
  'checkout.completed': Object.freeze({ from: Object.freeze(['evaluation', 'active']), to: 'active' }),
  'payment.failed': Object.freeze({ from: Object.freeze(['evaluation', 'active']), to: 'suspended' }),
  'payment.recovered': Object.freeze({ from: Object.freeze(['suspended']), to: 'active' }),
  'subscription.cancelled': Object.freeze({ from: Object.freeze(['evaluation', 'active', 'suspended']), to: 'cancelled' })
});

/* שדות מסחריים שהלקוח לעולם אינו שולח. */
const FORBIDDEN_CLIENT_KEYS = Object.freeze(['amount', 'price', 'discount', 'currency', 'payment_status', 'paid', 'total',
  'coupon', 'invoice', 'limits', 'quota', 'quotas', 'status', 'provider_subscription_id', 'provider_customer_id', 'revision']);
const UNSAFE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

const MAX_NAME = 80;
const MAX_AUDIT = 50;
const LIST_LIMIT = 50;
const MAX_USAGE_AMOUNT = 1000000;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,100}$/;
const ORG_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const STATION_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const DISTRICT_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const HEX64_RE = /^[a-f0-9]{64}$/;

class SaasError extends Error {
  constructor(code, message, httpCode) {
    super(message);
    this.name = 'SaasError';
    this.code = code;
    this.httpCode = httpCode || 'failed-precondition';
  }
}
function fail(code, message, httpCode) { throw new SaasError(code, message, httpCode); }

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (o, k) => plain(o) && Object.prototype.hasOwnProperty.call(o, k);

/** דוחה מפתחות מסוכנים בכל עומק (עד 6). */
function assertSafeKeys(value, where) {
  const walk = (v, depth) => {
    if (depth > 6 || !v || typeof v !== 'object') return;
    for (const k of Object.keys(v)) {
      if (UNSAFE_KEYS.indexOf(k) !== -1) fail('input', 'מפתח אסור בקלט של ' + where + '.', 'invalid-argument');
      walk(v[k], depth + 1);
    }
  };
  walk(value, 0);
}
/** דוחה שדות מסחריים שהלקוח אינו רשאי לשלוח — לפני כל בדיקת צורה. */
function assertNoCommercialKeys(input) {
  if (!plain(input)) fail('input', 'קלט חסר.', 'invalid-argument');
  assertSafeKeys(input, 'הפעולה');
  for (const k of Object.keys(input)) {
    if (FORBIDDEN_CLIENT_KEYS.indexOf(k) !== -1) fail('input', 'השדה ' + k + ' נקבע בשרת ואינו מתקבל מהלקוח.', 'invalid-argument');
  }
}
function exactKeys(value, keys, optional) {
  if (!plain(value)) return false;
  const opt = Array.isArray(optional) ? optional : [];
  return keys.every((k) => own(value, k)) && Object.keys(value).every((k) => keys.includes(k) || opt.includes(k));
}
function requireShape(input, keys, optional, label) {
  assertNoCommercialKeys(input);
  if (!exactKeys(input, keys, optional)) fail('input', 'מתקבלים ' + label + ' בלבד.', 'invalid-argument');
}
function text(value, max, code, label) {
  if (typeof value !== 'string') fail(code, label + ' חסר.', 'invalid-argument');
  const out = value.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!out || out.length > max) fail(code, label + ' אינו תקין.', 'invalid-argument');
  return out;
}
function requestId(value) {
  if (typeof value !== 'string' || !REQUEST_ID_RE.test(value)) fail('request-id', 'מזהה הפעולה אינו תקין.', 'invalid-argument');
  return value;
}
function organizationId(value) {
  if (typeof value !== 'string' || !ORG_ID_RE.test(value)) fail('organization-id', 'מזהה הארגון אינו תקין.', 'invalid-argument');
  return value;
}
function stationId(value) {
  if (typeof value !== 'string' || !STATION_RE.test(value)) fail('station-id', 'מזהה התחנה אינו תקין.', 'invalid-argument');
  return value;
}
function planId(value) {
  if (typeof value !== 'string' || PLAN_IDS.indexOf(value) === -1 || !own(PLANS, value)) fail('plan', 'התוכנית אינה מוכרת.', 'invalid-argument');
  return value;
}
function expectedRevision(value) {
  if (!Number.isInteger(value) || value < 1) fail('revision', 'גרסה צפויה חסרה.', 'invalid-argument');
  return value;
}

/* ---------- תקופה ---------- */

/** תקופת שימוש YYYY-MM לפי UTC — דטרמיניסטי ואחיד בין אזורי הפונקציות. */
function usagePeriod(nowMs) {
  if (!Number.isSafeInteger(nowMs)) throw new TypeError('nowMs is required');
  const d = new Date(nowMs);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

/* ---------- קלט ---------- */

/** קלט יצירת ארגון. מזהה, שם, מחוז ותוכנית. תחנות מצורפות בפעולה נפרדת. */
function validateOrganizationInput(input) {
  requireShape(input, ['request_id', 'organization_id', 'name', 'district_id', 'plan_id'], [], 'מזהה פעולה, מזהה ארגון, שם, מחוז ותוכנית');
  const district = typeof input.district_id === 'string' ? input.district_id.trim() : '';
  if (!DISTRICT_RE.test(district)) fail('district', 'מזהה המחוז אינו תקין.', 'invalid-argument');
  return Object.freeze({ request_id: requestId(input.request_id), organization_id: organizationId(input.organization_id),
    name: text(input.name, MAX_NAME, 'name', 'שם הארגון'), district_id: district, plan_id: planId(input.plan_id) });
}
function validateAttachInput(input) {
  requireShape(input, ['request_id', 'organization_id', 'station_id'], [], 'מזהה פעולה, מזהה ארגון ומזהה תחנה');
  return Object.freeze({ request_id: requestId(input.request_id), organization_id: organizationId(input.organization_id), station_id: stationId(input.station_id) });
}
function validatePlanChangeInput(input) {
  requireShape(input, ['request_id', 'organization_id', 'plan_id', 'expected_revision'], [], 'מזהה פעולה, מזהה ארגון, תוכנית וגרסה צפויה');
  return Object.freeze({ request_id: requestId(input.request_id), organization_id: organizationId(input.organization_id),
    plan_id: planId(input.plan_id), expected_revision: expectedRevision(input.expected_revision) });
}
function validateStatusInput(input) {
  requireShape(input, ['request_id', 'organization_id', 'action', 'expected_revision'], [], 'מזהה פעולה, מזהה ארגון, פעולה וגרסה צפויה');
  if (STATUS_ACTIONS.indexOf(input.action) === -1) fail('action', 'פעולה אינה מוכרת.', 'invalid-argument');
  return Object.freeze({ request_id: requestId(input.request_id), organization_id: organizationId(input.organization_id),
    action: input.action, expected_revision: expectedRevision(input.expected_revision) });
}
function validateOverviewInput(input) {
  requireShape(input, ['organization_id'], [], 'מזהה ארגון');
  return Object.freeze({ organization_id: organizationId(input.organization_id) });
}
function validateListInput(input) {
  const i = input === undefined || input === null ? {} : input;
  requireShape(i, [], ['limit', 'cursor'], 'גבול וסמן');
  const limit = Number.isInteger(i.limit) && i.limit > 0 ? Math.min(i.limit, LIST_LIMIT) : LIST_LIMIT;
  const cursor = i.cursor === undefined || i.cursor === null || i.cursor === '' ? null : organizationId(i.cursor);
  return Object.freeze({ limit, cursor });
}
/** שתי צורות: גולמית (payload+signature כפי שהגיעו מהספק) או מורכבת בשרת
 *  (event_type בלבד — לסימולציה של מנהל-על; השרת מרכיב וחותם ואז מאמת). */
function validateWebhookInput(input) {
  assertNoCommercialKeys(input);
  if (exactKeys(input, ['request_id', 'organization_id', 'event_type'])) {
    if (WEBHOOK_EVENTS.indexOf(input.event_type) === -1) fail('webhook-event', 'אירוע webhook אינו מוכר.', 'invalid-argument');
    return Object.freeze({ mode: 'composed', request_id: requestId(input.request_id), organization_id: organizationId(input.organization_id), event_type: input.event_type });
  }
  if (!exactKeys(input, ['request_id', 'organization_id', 'payload', 'signature'])) fail('input', 'מתקבלים מזהה פעולה, מזהה ארגון ו-payload+חתימה או event_type בלבד.', 'invalid-argument');
  if (typeof input.payload !== 'string' || !input.payload || input.payload.length > 4096) fail('webhook-payload', 'ה-payload אינו תקין.', 'invalid-argument');
  if (typeof input.signature !== 'string' || !HEX64_RE.test(input.signature)) fail('webhook-signature', 'החתימה אינה תקינה.', 'invalid-argument');
  return Object.freeze({ mode: 'raw', request_id: requestId(input.request_id), organization_id: organizationId(input.organization_id),
    payload: input.payload, signature: input.signature });
}
/** קלט שימוש פנימי (לא callable). */
function validateUsageInput(input) {
  if (!plain(input)) fail('input', 'קלט חסר.', 'invalid-argument');
  assertSafeKeys(input, 'השימוש');
  if (!exactKeys(input, ['request_id', 'station_id', 'metric', 'amount'])) fail('input', 'מתקבלים מזהה פעולה, תחנה, מדד וכמות בלבד.', 'invalid-argument');
  if (METRICS.indexOf(input.metric) === -1 || input.metric === 'stations') fail('metric', 'המדד אינו נצבר דרך שימוש.', 'invalid-argument');
  if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > MAX_USAGE_AMOUNT) fail('amount', 'הכמות אינה תקינה.', 'invalid-argument');
  return Object.freeze({ request_id: requestId(input.request_id), station_id: stationId(input.station_id), metric: input.metric, amount: input.amount });
}

/* ---------- מסמכים ---------- */

function buildOrganizationDoc(created, actorUid, subscriptionId, nowMs) {
  const doc = {
    schema: ORG_SCHEMA, organization_id: created.organization_id, name: created.name, district_id: created.district_id,
    station_ids: [], current_subscription_id: subscriptionId, created_by: actorUid, revision: 1,
    created_at_ms: nowMs, updated_at_ms: nowMs
  };
  assertSafeKeys(doc, 'מסמך הארגון');
  return doc;
}
function buildSubscriptionDoc(created, subscriptionId, providerCustomerId, nowMs) {
  return {
    schema: SUBSCRIPTION_SCHEMA, subscription_id: subscriptionId, organization_id: created.organization_id,
    plan_id: created.plan_id, status: 'evaluation',
    provider_customer_id: providerCustomerId || null, provider_subscription_id: null,
    revision: 1, created_at_ms: nowMs, updated_at_ms: nowMs
  };
}
function emptyUsage(organizationId_, period) {
  const doc = { schema: USAGE_SCHEMA, organization_id: organizationId_, period, revision: 0, updated_at_ms: 0 };
  METRICS.forEach((m) => { doc[m] = 0; });
  return doc;
}

/* ---------- מכסות ---------- */

/** בודקת אם delta (מפה מדד→כמות) נכנס בתוך התוכנית, מול השימוש הנוכחי. */
function quotaCheck(planDoc, usage, delta) {
  if (!plain(planDoc)) throw new TypeError('plan is required');
  const u = plain(usage) ? usage : {};
  const d = plain(delta) ? delta : {};
  const violations = [];
  for (const metric of METRICS) {
    const limit = Number.isInteger(planDoc[metric]) ? planDoc[metric] : 0;
    const current = Number.isInteger(u[metric]) && u[metric] >= 0 ? u[metric] : 0;
    const requested = Number.isInteger(d[metric]) ? d[metric] : 0;
    if (requested < 0) fail('delta', 'כמות שלילית אינה מתקבלת.', 'invalid-argument');
    if (current + requested > limit) violations.push(Object.freeze({ metric, limit, current, requested }));
  }
  return Object.freeze({ ok: violations.length === 0, violations: Object.freeze(violations) });
}
/** תוכנית "גדולה יותר" = לפחות גבול אחד עולה. מנוי מושהה/מבוטל אינו רשאי לעלות. */
function isUpgrade(fromPlan, toPlan) {
  return METRICS.some((m) => Number(toPlan[m]) > Number(fromPlan[m]));
}
function quotaView(planDoc, usage, stationCount) {
  const u = plain(usage) ? usage : {};
  return Object.freeze(METRICS.map((metric) => {
    const used = metric === 'stations' ? (Number.isInteger(stationCount) ? stationCount : 0) : (Number.isInteger(u[metric]) ? u[metric] : 0);
    const limit = Number(planDoc[metric]) || 0;
    return Object.freeze({ metric, limit, used, remaining: Math.max(0, limit - used), over: used > limit });
  }));
}

/* ---------- מעברים ---------- */

function assertRevision(doc, expected) {
  if (!plain(doc) || !Number.isInteger(doc.revision) || doc.revision !== expected) {
    fail('revision-mismatch', 'המנוי השתנה בינתיים. רענן ונסה שוב.', 'failed-precondition');
  }
}
/** מעבר סטטוס ניהולי. חזרה מביטול — רק ctx.is_super. */
function applyStatusAction(subscription, action, expected, nowMs, ctx) {
  if (!plain(subscription) || subscription.schema !== SUBSCRIPTION_SCHEMA) fail('subscription-missing', 'המנוי אינו קיים.', 'not-found');
  assertRevision(subscription, expected);
  const rule = TRANSITIONS[action];
  if (!rule || STATUS_ACTIONS.indexOf(action) === -1) fail('action', 'פעולה אינה מוכרת.', 'invalid-argument');
  if (rule.from.indexOf(subscription.status) === -1) fail('transition', 'המעבר ' + subscription.status + ' → ' + rule.to + ' אינו מותר.');
  if (subscription.status === 'cancelled' && !(ctx && ctx.is_super === true)) fail('cancelled-reactivation', 'החזרת מנוי מבוטל מותרת למנהל-על בלבד.', 'permission-denied');
  return Object.freeze({ status: rule.to, revision: subscription.revision + 1, updated_at_ms: nowMs });
}
/** שינוי תוכנית עם גרסה צפויה; מושהה/מבוטל אינו יכול לעלות; חייב להכיל את התחנות המצורפות. */
function applyPlanChange(subscription, toPlanId, expected, stationCount, nowMs) {
  if (!plain(subscription) || subscription.schema !== SUBSCRIPTION_SCHEMA) fail('subscription-missing', 'המנוי אינו קיים.', 'not-found');
  assertRevision(subscription, expected);
  const from = PLANS[planId(subscription.plan_id)], to = PLANS[planId(toPlanId)];
  if (from.plan_id === to.plan_id) fail('plan-unchanged', 'זו כבר התוכנית הנוכחית.');
  if ((subscription.status === 'suspended' || subscription.status === 'cancelled') && isUpgrade(from, to)) {
    fail('subscription-' + subscription.status, 'מנוי ' + (subscription.status === 'suspended' ? 'מושהה' : 'מבוטל') + ' אינו יכול לעלות תוכנית.');
  }
  const q = quotaCheck(to, {}, { stations: Number.isInteger(stationCount) ? stationCount : 0 });
  if (!q.ok) fail('quota-exceeded', 'התוכנית המבוקשת קטנה ממספר התחנות המצורפות.', 'resource-exhausted');
  return Object.freeze({ plan_id: to.plan_id, revision: subscription.revision + 1, updated_at_ms: nowMs, upgrade: isUpgrade(from, to) });
}
/** מיפוי אירוע webhook לסטטוס. null = אין שינוי (אירוע לא רלוונטי למצב). */
function webhookStatusFor(eventType, currentStatus) {
  const rule = own(WEBHOOK_STATUS, eventType) ? WEBHOOK_STATUS[eventType] : null;
  if (!rule) fail('webhook-event', 'אירוע webhook אינו מוכר.', 'invalid-argument');
  if (STATUSES.indexOf(currentStatus) === -1) fail('subscription-status', 'סטטוס המנוי אינו תקין.', 'internal');
  if (rule.from.indexOf(currentStatus) === -1) return null;
  return rule.to;
}
/** חוסם יצירת משאבים מסחריים חדשים במנוי מושהה/מבוטל. אינו נוגע בתפעול. */
function assertCanCreateCommercialResource(subscription) {
  if (!plain(subscription)) fail('subscription-missing', 'המנוי אינו קיים.', 'not-found');
  if (subscription.status === 'suspended') fail('subscription-suspended', 'המנוי מושהה; אין להוסיף משאבים חדשים.');
  if (subscription.status === 'cancelled') fail('subscription-cancelled', 'המנוי בוטל; אין להוסיף משאבים חדשים.');
}

/* ---------- טביעות כוונה ---------- */

function intent(kind, fields, hash) {
  if (typeof hash !== 'function') throw new TypeError('hash is required');
  const out = hash(JSON.stringify([kind].concat(fields.map((f) => (f === undefined ? null : f)))));
  if (!HEX64_RE.test(String(out || ''))) fail('hash', 'פונקציית הגיבוב אינה מחזירה sha256 hex.', 'internal');
  return out;
}
function createIntentFingerprint(created, actorUid, hash) {
  return intent('saas-create-v1', [created.organization_id, created.name, created.district_id, created.plan_id, String(actorUid || '')], hash);
}
function attachIntentFingerprint(attach, actorUid, hash) {
  return intent('saas-attach-v1', [attach.organization_id, attach.station_id, String(actorUid || '')], hash);
}
function planChangeIntentFingerprint(change, actorUid, hash) {
  return intent('saas-plan-v1', [change.organization_id, change.plan_id, change.expected_revision, String(actorUid || '')], hash);
}
function statusIntentFingerprint(change, actorUid, hash) {
  return intent('saas-status-v1', [change.organization_id, change.action, change.expected_revision, String(actorUid || '')], hash);
}
function webhookIntentFingerprint(input, hash) {
  if (input.mode === 'composed') return intent('saas-webhook-composed-v1', [input.organization_id, input.event_type], hash);
  return intent('saas-webhook-v1', [input.organization_id, hash(input.payload), input.signature], hash);
}
function usageIntentFingerprint(usage, hash) {
  return intent('saas-usage-v1', [usage.station_id, usage.metric, usage.amount], hash);
}

/* ---------- תצוגות ---------- */

function subscriptionView(sub) {
  return Object.freeze({ subscription_id: sub.subscription_id, plan_id: sub.plan_id, status: sub.status, revision: sub.revision,
    provider_linked: !!sub.provider_subscription_id, created_at_ms: sub.created_at_ms, updated_at_ms: sub.updated_at_ms });
}
function organizationView(org) {
  return Object.freeze({ organization_id: org.organization_id, name: org.name, district_id: org.district_id,
    station_ids: Array.isArray(org.station_ids) ? org.station_ids.slice() : [], revision: org.revision,
    created_at_ms: org.created_at_ms, updated_at_ms: org.updated_at_ms });
}
/** רשומת ביקורת ארגונית — ללא PII, ללא טקסט שגיאה של ספק, קוד בלבד. */
function buildAuditEvent(params) {
  const p = params || {};
  const details = plain(p.details) ? p.details : {};
  assertSafeKeys(details, 'רשומת הביקורת');
  const safe = Object.create(null);
  for (const k of Object.keys(details)) {
    const v = details[k];
    if (['string', 'number', 'boolean'].indexOf(typeof v) !== -1 || v === null) safe[k] = typeof v === 'string' ? v.slice(0, 120) : v;
  }
  return { schema: AUDIT_SCHEMA, event_id: p.event_id, organization_id: p.organization_id, action: String(p.action || ''),
    actor_uid: String(p.actor_uid || 'server'), request_id: p.request_id || null, details: Object.assign({}, safe), at_ms: p.now_ms };
}

module.exports = Object.freeze({
  SaasError, ORG_SCHEMA, SUBSCRIPTION_SCHEMA, USAGE_SCHEMA, AUDIT_SCHEMA, OPERATION_SCHEMA, INDEX_SCHEMA,
  STATUSES, METRICS, PLAN_IDS, PLANS, STATUS_ACTIONS, TRANSITIONS, WEBHOOK_EVENTS, WEBHOOK_STATUS,
  FORBIDDEN_CLIENT_KEYS, UNSAFE_KEYS, MAX_AUDIT, LIST_LIMIT, MAX_USAGE_AMOUNT, REQUEST_ID_RE, ORG_ID_RE, STATION_RE, PERIOD_RE,
  assertSafeKeys, assertNoCommercialKeys, usagePeriod,
  validateOrganizationInput, validateAttachInput, validatePlanChangeInput, validateStatusInput, validateOverviewInput,
  validateListInput, validateWebhookInput, validateUsageInput,
  buildOrganizationDoc, buildSubscriptionDoc, emptyUsage, quotaCheck, isUpgrade, quotaView,
  applyStatusAction, applyPlanChange, webhookStatusFor, assertCanCreateCommercialResource,
  createIntentFingerprint, attachIntentFingerprint, planChangeIntentFingerprint, statusIntentFingerprint,
  webhookIntentFingerprint, usageIntentFingerprint, subscriptionView, organizationView, buildAuditEvent
});
