'use strict';
/* ספק חיוב — ממשק מוזרק + מימוש מזויף בלבד.
 *
 * ממשק (כל המתודות אסינכרוניות, מקבלות אובייקט אחד, מחזירות אובייקט קפוא):
 *   createCustomer({ organization_id })            → { provider_customer_id }
 *   createCheckout({ organization_id, plan_id })   → { checkout_id, provider_subscription_id }
 *   getSubscription({ provider_subscription_id })  → { provider_subscription_id, plan_id, status } | null
 *   cancelSubscription({ provider_subscription_id }) → { provider_subscription_id, status: 'cancelled' }
 *   verifyWebhook({ payload, signature })          → { verified: boolean, event: object|null }
 *
 * כישלון ספק = זריקת Error עם `code` קצר (ללא PII). השירות רושם את הקוד
 * בלבד בביקורת ומשאיר את סטטוס המנוי כפי שהיה.
 *
 * כאן אין ספק אמיתי. `createFakeBillingProvider` מחזיק מצב בזיכרון,
 * מזהים דטרמיניסטיים ומצבי כשל ניתנים להגדרה (`failNext('createCheckout')`).
 * שום דבר כאן אינו מחייב כספית.
 */

const crypto = require('node:crypto');

const METHODS = Object.freeze(['createCustomer', 'createCheckout', 'getSubscription', 'cancelSubscription', 'verifyWebhook']);
const EVENT_TYPES = Object.freeze(['checkout.completed', 'payment.failed', 'payment.recovered', 'subscription.cancelled']);
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

class BillingProviderError extends Error {
  constructor(code, message) { super(message || code); this.name = 'BillingProviderError'; this.code = code; }
}

/** מוודא שאובייקט ספק מוזרק מקיים את הממשק. */
function assertBillingProvider(provider) {
  if (!provider || typeof provider !== 'object') throw new TypeError('billing provider is required');
  for (const m of METHODS) if (typeof provider[m] !== 'function') throw new TypeError('billing provider method is required: ' + m);
  return provider;
}

function createFakeBillingProvider(options) {
  const o = options || {};
  const secret = typeof o.webhook_secret === 'string' && o.webhook_secret ? o.webhook_secret : 'fake-webhook-secret';
  const hmac = (payload) => crypto.createHmac('sha256', secret).update(String(payload)).digest('hex');
  const customers = new Map();      // organization_id → provider_customer_id
  const subscriptions = new Map();  // provider_subscription_id → { organization_id, plan_id, status }
  const failures = Object.create(null);
  const calls = [];
  const counters = Object.create(null);
  const nextId = (prefix) => { counters[prefix] = (counters[prefix] || 0) + 1; return prefix + '_' + String(counters[prefix]).padStart(6, '0'); };
  const plainId = (v) => typeof v === 'string' && ID_RE.test(v);

  function gate(method, args) {
    calls.push({ method, args: Object.assign({}, args) });
    const n = failures[method] || 0;
    if (n > 0) { failures[method] = n - 1; throw new BillingProviderError('provider_' + method + '_failed'); }
  }

  async function createCustomer(args) {
    gate('createCustomer', args);
    if (!plainId(args && args.organization_id)) throw new BillingProviderError('provider_bad_organization');
    if (!customers.has(args.organization_id)) customers.set(args.organization_id, nextId('cus'));
    return Object.freeze({ provider_customer_id: customers.get(args.organization_id) });
  }
  async function createCheckout(args) {
    gate('createCheckout', args);
    if (!plainId(args && args.organization_id) || !plainId(args && args.plan_id)) throw new BillingProviderError('provider_bad_checkout');
    if (!customers.has(args.organization_id)) throw new BillingProviderError('provider_customer_missing');
    const provider_subscription_id = nextId('sub');
    subscriptions.set(provider_subscription_id, { organization_id: args.organization_id, plan_id: args.plan_id, status: 'active' });
    return Object.freeze({ checkout_id: nextId('chk'), provider_subscription_id });
  }
  async function getSubscription(args) {
    gate('getSubscription', args);
    const s = subscriptions.get(args && args.provider_subscription_id);
    return s ? Object.freeze(Object.assign({ provider_subscription_id: args.provider_subscription_id }, s)) : null;
  }
  async function cancelSubscription(args) {
    gate('cancelSubscription', args);
    const s = subscriptions.get(args && args.provider_subscription_id);
    if (!s) throw new BillingProviderError('provider_subscription_missing');
    s.status = 'cancelled';
    return Object.freeze({ provider_subscription_id: args.provider_subscription_id, status: 'cancelled' });
  }
  /** אימות חתימה בזמן קבוע; payload הוא JSON של { type, provider_subscription_id }. */
  async function verifyWebhook(args) {
    gate('verifyWebhook', args);
    const payload = args && typeof args.payload === 'string' ? args.payload : '';
    const signature = args && typeof args.signature === 'string' ? args.signature : '';
    const expected = Buffer.from(hmac(payload), 'utf8'), given = Buffer.from(signature, 'utf8');
    if (!payload || expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return Object.freeze({ verified: false, event: null });
    let event = null;
    try { event = JSON.parse(payload); } catch (ignore) { return Object.freeze({ verified: false, event: null }); }
    if (!event || typeof event !== 'object' || Array.isArray(event) || EVENT_TYPES.indexOf(event.type) === -1
        || !plainId(event.provider_subscription_id)) return Object.freeze({ verified: false, event: null });
    return Object.freeze({ verified: true, event: Object.freeze({ type: event.type, provider_subscription_id: event.provider_subscription_id }) });
  }

  return Object.freeze({
    createCustomer, createCheckout, getSubscription, cancelSubscription, verifyWebhook,
    /* עזרי בדיקה/סימולציה — אינם חלק מהממשק המוזרק לשירות. */
    failNext: (method, times) => { if (METHODS.indexOf(method) === -1) throw new TypeError('unknown method ' + method); failures[method] = (failures[method] || 0) + (Number.isInteger(times) && times > 0 ? times : 1); },
    signWebhook: (payload) => hmac(payload),
    _calls: calls, _subscriptions: subscriptions, _customers: customers
  });
}

module.exports = Object.freeze({ METHODS, EVENT_TYPES, BillingProviderError, assertBillingProvider, createFakeBillingProvider });
