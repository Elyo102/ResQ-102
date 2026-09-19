'use strict';
/* שירות SaaS מסחרי — Firestore + ספק חיוב מוזרק.
 *
 * ארגונים, מנויים, מכסות ושימוש. מנהל-על בלבד (claims חיים), כל פעולה
 * משנה נושאת request_id + טביעת כוונה ונרשמת ברשומת פעולה:
 * replay זהה מחזיר את הקבלה הקודמת בלי כתיבה; אותו מזהה עם כוונה אחרת
 * נדחה. השירות אינו נוגע בקריאות, בהתראות, בסידור או בהתחברות — ואינו
 * מקור הרשאה: ארגון מפנה לתחנות לפי מזהה בלבד.
 *
 * כישלון ספק לעולם אינו מעניק מנוי פעיל: הסטטוס נשאר, הביקורת מקבלת
 * קוד שגיאה בלבד (ללא טקסט הודעה).
 *
 * שער הפעלה — fail-closed. השכבה כבויה כברירת מחדל ונפתחת רק כאשר
 * `enabled === true` (ב-index.js: `RESQ_SAAS_ENABLED === 'true'`).
 * הסיבה אינה זהירות כללית: הספק היחיד שקיים כאן הוא מזויף ושומר את
 * מצבו ב-Map בזיכרון התהליך. cold start או מופע אחר של הפונקציה
 * מאבדים לקוחות ומנויים, ולכן הפעלה וביטול היו נכשלים באופן לא עקבי
 * ובלתי ניתן לשחזור. כבוי = אין יצירה, אין שינוי תוכנית, אין סימולציית
 * webhook, אין קריאה — לא "כפתור מוסתר" אלא סירוב בשרת.
 */

const AUDIT_LIMIT = 50;

function createSaasService(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  for (const name of ['db', 'contract', 'billing', 'fail', 'requireAuth', 'getAuthUser', 'openAudit', 'sealAudit', 'now', 'hash',
    'serverTimestamp', 'randomId']) {
    if (d[name] === undefined || d[name] === null) throw new TypeError('saas dependency is required: ' + name);
  }
  const { db, contract, billing, fail, requireAuth, getAuthUser, openAudit, sealAudit, now, hash, serverTimestamp, randomId } = d;
  /* ברירת המחדל כבויה בכוונה: `enabled` חייב להיות בדיוק true. כל ערך
   * אחר — undefined, 'false', 1, null — משאיר את השכבה כבויה. */
  const enabled = d.enabled === true;
  for (const m of ['createCustomer', 'createCheckout', 'getSubscription', 'cancelSubscription', 'verifyWebhook']) {
    if (typeof billing[m] !== 'function') throw new TypeError('saas billing method is required: ' + m);
  }

  const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const dataOf = (snap) => (snap && snap.exists ? (snap.data() || null) : null);
  const orgRef = (oid) => db.doc('organizations/' + oid);
  const subRef = (oid, sid) => db.doc('organizations/' + oid + '/subscriptions/' + sid);
  const usageRef = (oid, period) => db.doc('organizations/' + oid + '/usage/' + period);
  const auditRef = (oid, eid) => db.doc('organizations/' + oid + '/audit/' + eid);
  const indexRef = (station) => db.doc('organization_station_index/' + station);
  const operationRef = (oid, rid) => db.doc('saas_operations/' + oid + '_' + rid);
  const stationRef = (station) => db.doc('stations/' + station);
  const eventId = (oid, rid, action) => 'ev_' + hash(oid + '|' + rid + '|' + action).slice(0, 40);

  function contractFail(error) {
    if (error && error.name === 'SaasError') fail(error.httpCode || 'failed-precondition', error.message, error.code);
    throw error;
  }
  function guard(fn) { try { return fn(); } catch (error) { return contractFail(error); } }
  async function seal(ref, extra) { if (ref) await sealAudit(ref, extra); }

  /* ---------- מי רשאי: מנהל-על בלבד, מאומת מול claims חיים ---------- */

  /** השער הראשון בכל קריאה, לפני האימות ולפני כל קריאה ל-Firestore. */
  function requireEnabled() {
    if (!enabled) {
      fail('failed-precondition',
        'שכבת הארגונים והמנויים כבויה בשרת. היא נפתחת רק עם ספק חיוב מתמשך ובהחלטה מפורשת.',
        'saas-disabled');
    }
  }

  async function superActor(req) {
    requireEnabled();
    const signed = requireAuth(req);
    const token = plain(signed.token) ? signed.token : {};
    if (token.super !== true) fail('permission-denied', 'ניהול ארגונים ומנויים מותר למנהל-על בלבד.', 'saas-actor');
    const current = await getAuthUser(signed.uid);
    const live = plain(current && current.customClaims) ? current.customClaims : {};
    if (!current || current.uid !== signed.uid || current.disabled !== false || live.super !== true) {
      fail('permission-denied', 'הרשאת מנהל-העל אינה עדכנית.', 'saas-actor-stale');
    }
    return Object.freeze({ uid: signed.uid, role: 'super', auth: signed });
  }

  /* ---------- קריאות בתוך טרנזקציה ---------- */

  async function loadOrg(tx, oid) {
    const org = dataOf(await tx.get(orgRef(oid)));
    if (!org || org.schema !== contract.ORG_SCHEMA) fail('not-found', 'הארגון אינו קיים.', 'organization-missing');
    return org;
  }
  async function loadSub(tx, org) {
    const sub = dataOf(await tx.get(subRef(org.organization_id, org.current_subscription_id)));
    if (!sub || sub.schema !== contract.SUBSCRIPTION_SCHEMA) fail('failed-precondition', 'המנוי אינו קיים.', 'subscription-missing');
    return sub;
  }

  /** רשומת פעולה: replay זהה → הקבלה הקודמת; כוונה אחרת → התנגשות. */
  async function priorOperation(tx, oid, requestId, fingerprint) {
    const op = dataOf(await tx.get(operationRef(oid, requestId)));
    if (!op) return null;
    if (op.schema !== contract.OPERATION_SCHEMA || op.intent_fingerprint !== fingerprint) {
      fail('already-exists', 'אותו מזהה פעולה כבר שימש לכוונה אחרת.', 'request-conflict');
    }
    return Object.freeze(Object.assign({}, op.receipt, { duplicate: true }));
  }
  function commitOperation(tx, params) {
    const { oid, requestId, fingerprint, action, actorUid, receipt, details, nowMs } = params;
    tx.create(operationRef(oid, requestId), { schema: contract.OPERATION_SCHEMA, organization_id: oid, request_id: requestId,
      intent_fingerprint: fingerprint, action, receipt: Object.assign({}, receipt), created_at_ms: nowMs, created_at: serverTimestamp() });
    const eid = eventId(oid, requestId, action);
    tx.set(auditRef(oid, eid), Object.assign(contract.buildAuditEvent({ event_id: eid, organization_id: oid, action, actor_uid: actorUid,
      request_id: requestId, details, now_ms: nowMs }), { at: serverTimestamp() }));
  }
  /** רשומת ביקורת מחוץ לטרנזקציה — לכשלי ספק ולדחיות webhook. קוד בלבד. */
  async function auditOutside(oid, action, actorUid, requestId, details, nowMs) {
    const eid = eventId(oid, requestId, action + '|' + nowMs);
    await auditRef(oid, eid).set(Object.assign(contract.buildAuditEvent({ event_id: eid, organization_id: oid, action, actor_uid: actorUid,
      request_id: requestId, details, now_ms: nowMs }), { at: serverTimestamp() }));
  }
  function providerCode(error) {
    const code = error && typeof error.code === 'string' ? error.code : 'provider_error';
    return /^[A-Za-z0-9_.-]{1,60}$/.test(code) ? code : 'provider_error';
  }

  /* ---------- יצירת ארגון ---------- */

  async function createOrganization(req) {
    const actor = await superActor(req);
    const created = guard(() => contract.validateOrganizationInput(req.data));
    const nowMs = now();
    const fingerprint = contract.createIntentFingerprint(created, actor.uid, hash);
    const oid = created.organization_id;
    const auditRow = await openAudit(actor.auth, 'saas_create_organization', null, { organization_id: oid, plan_id: created.plan_id });
    /* replay נבדק לפני פניית הספק — אין ליצור לקוח ספק פעמיים. */
    const prior = await db.runTransaction((tx) => priorOperation(tx, oid, created.request_id, fingerprint));
    if (prior) { await seal(auditRow, { duplicate: true }); return prior; }
    let customer = null;
    try { customer = await billing.createCustomer({ organization_id: oid }); }
    catch (error) {
      const code = providerCode(error);
      await auditOutside(oid, 'provider_error', actor.uid, created.request_id, { method: 'createCustomer', provider_error: code }, nowMs);
      await seal(auditRow, { provider_error: code });
      fail('unavailable', 'ספק החיוב אינו זמין כרגע. הארגון לא נוצר.', 'provider');
    }
    const subscriptionId = 'sub_' + String(randomId());
    const result = await db.runTransaction(async (tx) => {
      const replay = await priorOperation(tx, oid, created.request_id, fingerprint);
      if (replay) return replay;
      const existing = dataOf(await tx.get(orgRef(oid)));
      if (existing) fail('already-exists', 'ארגון עם המזהה הזה כבר קיים.', 'organization-exists');
      const orgDoc = guard(() => contract.buildOrganizationDoc(created, actor.uid, subscriptionId, nowMs));
      const subDoc = contract.buildSubscriptionDoc(created, subscriptionId, customer && customer.provider_customer_id, nowMs);
      tx.create(orgRef(oid), Object.assign({}, orgDoc, { created_at: serverTimestamp(), updated_at: serverTimestamp() }));
      tx.create(subRef(oid, subscriptionId), Object.assign({}, subDoc, { created_at: serverTimestamp(), updated_at: serverTimestamp() }));
      const receipt = { ok: true, duplicate: false, organization_id: oid, subscription_id: subscriptionId, plan_id: created.plan_id, status: 'evaluation', revision: 1 };
      commitOperation(tx, { oid, requestId: created.request_id, fingerprint, action: 'create_organization', actorUid: actor.uid, receipt,
        details: { plan_id: created.plan_id, district_id: created.district_id }, nowMs });
      return Object.freeze(receipt);
    });
    await seal(auditRow, { duplicate: result.duplicate === true });
    return result;
  }

  /* ---------- צירוף תחנה ---------- */

  async function attachStationToOrganization(req) {
    const actor = await superActor(req);
    const attach = guard(() => contract.validateAttachInput(req.data));
    const nowMs = now();
    const fingerprint = contract.attachIntentFingerprint(attach, actor.uid, hash);
    const oid = attach.organization_id;
    const auditRow = await openAudit(actor.auth, 'saas_attach_station', null, { organization_id: oid, station_id: attach.station_id });
    const result = await db.runTransaction(async (tx) => {
      const replay = await priorOperation(tx, oid, attach.request_id, fingerprint);
      if (replay) return replay;
      const org = await loadOrg(tx, oid);
      const [sub, station, index] = await Promise.all([loadSub(tx, org), tx.get(stationRef(attach.station_id)).then(dataOf), tx.get(indexRef(attach.station_id)).then(dataOf)]);
      if (!station || station.active !== true) fail('failed-precondition', 'התחנה אינה קיימת או אינה פעילה.', 'station-inactive');
      if (String(station.districtId || '') !== org.district_id) fail('failed-precondition', 'התחנה שייכת למחוז אחר מזה של הארגון.', 'station-district');
      /* תחנה שייכת לארגון אחד. האינדקס בשרת הוא המקור — לא הלקוח. */
      if (index && index.organization_id !== oid) fail('failed-precondition', 'התחנה כבר משויכת לארגון אחר.', 'station-owned-elsewhere');
      const stations = Array.isArray(org.station_ids) ? org.station_ids.slice() : [];
      if (stations.indexOf(attach.station_id) !== -1 || (index && index.organization_id === oid)) fail('already-exists', 'התחנה כבר מצורפת לארגון.', 'station-attached');
      guard(() => contract.assertCanCreateCommercialResource(sub));
      const q = contract.quotaCheck(contract.PLANS[sub.plan_id], { stations: stations.length }, { stations: 1 });
      if (!q.ok) fail('resource-exhausted', 'מכסת התחנות של התוכנית מלאה.', 'quota-exceeded');
      stations.push(attach.station_id);
      tx.update(orgRef(oid), { station_ids: stations, revision: org.revision + 1, updated_at_ms: nowMs, updated_at: serverTimestamp() });
      tx.create(indexRef(attach.station_id), { schema: contract.INDEX_SCHEMA, station_id: attach.station_id, organization_id: oid, created_at_ms: nowMs, created_at: serverTimestamp() });
      const receipt = { ok: true, duplicate: false, organization_id: oid, station_id: attach.station_id, station_count: stations.length, revision: org.revision + 1 };
      commitOperation(tx, { oid, requestId: attach.request_id, fingerprint, action: 'attach_station', actorUid: actor.uid, receipt,
        details: { station_id: attach.station_id, station_count: stations.length }, nowMs });
      return Object.freeze(receipt);
    });
    await seal(auditRow, { duplicate: result.duplicate === true });
    return result;
  }

  /* ---------- שינוי תוכנית ---------- */

  async function changeSubscriptionPlan(req) {
    const actor = await superActor(req);
    const change = guard(() => contract.validatePlanChangeInput(req.data));
    const nowMs = now();
    const fingerprint = contract.planChangeIntentFingerprint(change, actor.uid, hash);
    const oid = change.organization_id;
    const auditRow = await openAudit(actor.auth, 'saas_change_plan', null, { organization_id: oid, plan_id: change.plan_id });
    const result = await db.runTransaction(async (tx) => {
      const replay = await priorOperation(tx, oid, change.request_id, fingerprint);
      if (replay) return replay;
      const org = await loadOrg(tx, oid);
      const sub = await loadSub(tx, org);
      const stationCount = Array.isArray(org.station_ids) ? org.station_ids.length : 0;
      const next = guard(() => contract.applyPlanChange(sub, change.plan_id, change.expected_revision, stationCount, nowMs));
      tx.update(subRef(oid, sub.subscription_id), { plan_id: next.plan_id, revision: next.revision, updated_at_ms: nowMs, updated_at: serverTimestamp() });
      const receipt = { ok: true, duplicate: false, organization_id: oid, subscription_id: sub.subscription_id, plan_id: next.plan_id, status: sub.status, revision: next.revision };
      commitOperation(tx, { oid, requestId: change.request_id, fingerprint, action: 'change_plan', actorUid: actor.uid, receipt,
        details: { from_plan_id: sub.plan_id, plan_id: next.plan_id, upgrade: next.upgrade }, nowMs });
      return Object.freeze(receipt);
    });
    await seal(auditRow, { duplicate: result.duplicate === true, plan_id: result.plan_id });
    return result;
  }

  /* ---------- סטטוס (סימולציית מנהל-על) ---------- */

  async function setSubscriptionStatus(req) {
    const actor = await superActor(req);
    const change = guard(() => contract.validateStatusInput(req.data));
    const nowMs = now();
    const fingerprint = contract.statusIntentFingerprint(change, actor.uid, hash);
    const oid = change.organization_id;
    const auditRow = await openAudit(actor.auth, 'saas_set_status', null, { organization_id: oid, action: change.action });
    /* שלב א' — קריאה בלבד: replay, ואימות שהמעבר חוקי לפני כל פנייה לספק. */
    const pre = await db.runTransaction(async (tx) => {
      const replay = await priorOperation(tx, oid, change.request_id, fingerprint);
      if (replay) return { replay };
      const org = await loadOrg(tx, oid);
      const sub = await loadSub(tx, org);
      guard(() => contract.applyStatusAction(sub, change.action, change.expected_revision, nowMs, { is_super: actor.role === 'super' }));
      return { sub };
    });
    if (pre.replay) { await seal(auditRow, { duplicate: true }); return pre.replay; }
    /* שלב ב' — ספק: הפעלה יוצרת checkout, ביטול מבטל אצל הספק. כישלון = אין שינוי סטטוס. */
    let providerSubscriptionId = pre.sub.provider_subscription_id || null;
    const method = change.action === 'activate' ? 'createCheckout' : change.action === 'cancel' && providerSubscriptionId ? 'cancelSubscription' : null;
    if (method) {
      try {
        if (method === 'createCheckout') {
          const out = await billing.createCheckout({ organization_id: oid, plan_id: pre.sub.plan_id });
          if (!out || typeof out.provider_subscription_id !== 'string' || !out.provider_subscription_id) throw Object.assign(new Error('bad'), { code: 'provider_bad_checkout' });
          providerSubscriptionId = out.provider_subscription_id;
        } else {
          await billing.cancelSubscription({ provider_subscription_id: providerSubscriptionId });
        }
      } catch (error) {
        const code = providerCode(error);
        await auditOutside(oid, 'provider_error', actor.uid, change.request_id, { method, action: change.action, provider_error: code, status: pre.sub.status }, nowMs);
        await seal(auditRow, { provider_error: code, status: pre.sub.status });
        fail('unavailable', 'ספק החיוב אינו זמין כרגע. סטטוס המנוי לא השתנה.', 'provider');
      }
    }
    /* שלב ג' — כתיבה: אותה גרסה צפויה נבדקת שוב בתוך הטרנזקציה. */
    const result = await db.runTransaction(async (tx) => {
      const replay = await priorOperation(tx, oid, change.request_id, fingerprint);
      if (replay) return replay;
      const org = await loadOrg(tx, oid);
      const sub = await loadSub(tx, org);
      const next = guard(() => contract.applyStatusAction(sub, change.action, change.expected_revision, nowMs, { is_super: actor.role === 'super' }));
      tx.update(subRef(oid, sub.subscription_id), { status: next.status, revision: next.revision, updated_at_ms: nowMs, updated_at: serverTimestamp(),
        provider_subscription_id: providerSubscriptionId });
      const receipt = { ok: true, duplicate: false, organization_id: oid, subscription_id: sub.subscription_id, plan_id: sub.plan_id, status: next.status, revision: next.revision, simulated: true };
      commitOperation(tx, { oid, requestId: change.request_id, fingerprint, action: 'set_status', actorUid: actor.uid, receipt,
        details: { action: change.action, from_status: sub.status, status: next.status, simulated: true }, nowMs });
      return Object.freeze(receipt);
    });
    await seal(auditRow, { duplicate: result.duplicate === true, status: result.status });
    return result;
  }

  /* ---------- webhook (סימולציה, מנהל-על בלבד) ---------- */

  async function simulateBillingWebhook(req) {
    const actor = await superActor(req);
    const input = guard(() => contract.validateWebhookInput(req.data));
    const nowMs = now();
    const oid = input.organization_id;
    const fingerprint = contract.webhookIntentFingerprint(input, hash);
    const auditRow = await openAudit(actor.auth, 'saas_simulate_webhook', null, { organization_id: oid, mode: input.mode });
    let payload = input.payload, signature = input.signature;
    if (input.mode === 'composed') {
      /* סימולציה: השרת מרכיב את האירוע למנוי של הארגון וחותם בעזרת הספק המזויף.
       * ספק אמיתי אינו חושף signWebhook — ואז הצורה הזו נדחית. */
      if (typeof billing.signWebhook !== 'function') { await seal(auditRow, { rejected: 'sign-unavailable' }); fail('failed-precondition', 'הרכבת אירוע בשרת זמינה רק מול ספק מזויף.', 'webhook-sign-unavailable'); }
      const org = dataOf(await orgRef(oid).get());
      const sub = org && org.schema === contract.ORG_SCHEMA ? dataOf(await subRef(oid, org.current_subscription_id).get()) : null;
      if (!sub) { await seal(auditRow, { rejected: 'missing' }); fail('not-found', 'הארגון או המנוי אינם קיימים.', 'organization-missing'); }
      if (!sub.provider_subscription_id) { await seal(auditRow, { rejected: 'unlinked' }); fail('failed-precondition', 'למנוי אין עדיין מזהה אצל הספק (הפעל קודם).', 'webhook-unlinked'); }
      payload = JSON.stringify({ type: input.event_type, provider_subscription_id: sub.provider_subscription_id });
      signature = billing.signWebhook(payload);
    }
    const verified = await billing.verifyWebhook({ payload, signature });
    if (!verified || verified.verified !== true || !plain(verified.event)) {
      await auditOutside(oid, 'webhook_rejected', actor.uid, input.request_id, { reason: 'signature' }, nowMs);
      await seal(auditRow, { rejected: 'signature' });
      fail('permission-denied', 'חתימת ה-webhook אינה תקפה. לא בוצע שינוי.', 'webhook-signature');
    }
    const event = verified.event;
    const result = await db.runTransaction(async (tx) => {
      const replay = await priorOperation(tx, oid, input.request_id, fingerprint);
      if (replay) return replay;
      const org = await loadOrg(tx, oid);
      const sub = await loadSub(tx, org);
      if (!sub.provider_subscription_id || sub.provider_subscription_id !== event.provider_subscription_id) {
        fail('failed-precondition', 'האירוע אינו שייך למנוי של הארגון.', 'webhook-mismatch');
      }
      /* ה-payload קובע אירוע בלבד; הסטטוס נגזר מהמיפוי בשרת, התוכנית והגבולות אינם נוגעים בו. */
      const nextStatus = guard(() => contract.webhookStatusFor(event.type, sub.status));
      const changed = nextStatus !== null && nextStatus !== sub.status;
      if (changed) tx.update(subRef(oid, sub.subscription_id), { status: nextStatus, revision: sub.revision + 1, updated_at_ms: nowMs, updated_at: serverTimestamp() });
      const receipt = { ok: true, duplicate: false, organization_id: oid, event_type: event.type, status: changed ? nextStatus : sub.status,
        changed, plan_id: sub.plan_id, revision: changed ? sub.revision + 1 : sub.revision };
      commitOperation(tx, { oid, requestId: input.request_id, fingerprint, action: 'webhook', actorUid: actor.uid, receipt,
        details: { event_type: event.type, from_status: sub.status, status: receipt.status, changed }, nowMs });
      return Object.freeze(receipt);
    });
    await seal(auditRow, { duplicate: result.duplicate === true, status: result.status });
    return result;
  }

  /* ---------- קריאה ---------- */

  async function getOrganizationOverview(req) {
    await superActor(req);
    const input = guard(() => contract.validateOverviewInput(req.data));
    const oid = input.organization_id;
    const org = dataOf(await orgRef(oid).get());
    if (!org || org.schema !== contract.ORG_SCHEMA) fail('not-found', 'הארגון אינו קיים.', 'organization-missing');
    const nowMs = now();
    const period = contract.usagePeriod(nowMs);
    const [subSnap, usageSnap, auditSnap] = await Promise.all([
      subRef(oid, org.current_subscription_id).get(), usageRef(oid, period).get(),
      db.collection('organizations/' + oid + '/audit').orderBy('at_ms', 'desc').limit(AUDIT_LIMIT).get()
    ]);
    const sub = dataOf(subSnap);
    if (!sub) fail('failed-precondition', 'המנוי אינו קיים.', 'subscription-missing');
    const usage = dataOf(usageSnap) || contract.emptyUsage(oid, period);
    const planDoc = contract.PLANS[sub.plan_id];
    const stationCount = Array.isArray(org.station_ids) ? org.station_ids.length : 0;
    return Object.freeze({
      ok: true, organization: contract.organizationView(org), subscription: contract.subscriptionView(sub),
      plan: planDoc, quotas: contract.quotaView(planDoc, usage, stationCount),
      usage: Object.freeze({ period, stations: stationCount, active_users: usage.active_users || 0, storage_mb: usage.storage_mb || 0, pushes_per_month: usage.pushes_per_month || 0 }),
      audit: auditSnap.docs.map((s) => s.data()).filter((e) => plain(e) && e.schema === contract.AUDIT_SCHEMA).slice(0, AUDIT_LIMIT)
        .map((e) => Object.freeze({ event_id: e.event_id, action: e.action, actor_uid: e.actor_uid, request_id: e.request_id, details: Object.assign({}, e.details || {}), at_ms: e.at_ms }))
    });
  }

  async function listOrganizations(req) {
    await superActor(req);
    const input = guard(() => contract.validateListInput(req && req.data));
    let q = db.collection('organizations').orderBy('organization_id', 'asc');
    if (input.cursor) q = q.startAfter(input.cursor);
    const snap = await q.limit(input.limit).get();
    const rows = snap.docs.map((s) => s.data()).filter((o) => plain(o) && o.schema === contract.ORG_SCHEMA).map(contract.organizationView);
    return Object.freeze({ ok: true, organizations: rows, next_cursor: rows.length === input.limit ? rows[rows.length - 1].organization_id : null });
  }

  /* ---------- שימוש — עזר פנימי לשרת (לא callable) ---------- */

  /** מוסיף שימוש למדד של הארגון שאליו התחנה משויכת. הארגון נפתר מהאינדקס
   *  בשרת בלבד; תחנה שאינה משויכת אינה צורכת מכסה של אף ארגון. */
  async function addUsage(params) {
    // גם המסלול הפנימי חסום כשהשכבה כבויה: אין מוני שימוש בלי מנוי.
    requireEnabled();
    const usage = guard(() => contract.validateUsageInput(params));
    const nowMs = now();
    const period = contract.usagePeriod(nowMs);
    const fingerprint = contract.usageIntentFingerprint(usage, hash);
    return db.runTransaction(async (tx) => {
      const index = dataOf(await tx.get(indexRef(usage.station_id)));
      if (!index || index.schema !== contract.INDEX_SCHEMA || !contract.ORG_ID_RE.test(String(index.organization_id || ''))) {
        fail('not-found', 'התחנה אינה משויכת לארגון.', 'station-unindexed');
      }
      const oid = index.organization_id;
      const replay = await priorOperation(tx, oid, usage.request_id, fingerprint);
      if (replay) return replay;
      const org = await loadOrg(tx, oid);
      const sub = await loadSub(tx, org);
      const current = dataOf(await tx.get(usageRef(oid, period))) || contract.emptyUsage(oid, period);
      const total = (Number.isInteger(current[usage.metric]) ? current[usage.metric] : 0) + usage.amount;
      const q = contract.quotaCheck(contract.PLANS[sub.plan_id], current, { [usage.metric]: usage.amount });
      const patch = Object.assign({}, current, { [usage.metric]: total, revision: (current.revision || 0) + 1, updated_at_ms: nowMs, updated_at: serverTimestamp() });
      tx.set(usageRef(oid, period), patch);
      const receipt = { ok: true, duplicate: false, organization_id: oid, station_id: usage.station_id, period, metric: usage.metric, total, over_quota: !q.ok };
      commitOperation(tx, { oid, requestId: usage.request_id, fingerprint, action: 'usage', actorUid: 'server', receipt,
        details: { station_id: usage.station_id, metric: usage.metric, amount: usage.amount, over_quota: !q.ok }, nowMs });
      return Object.freeze(receipt);
    });
  }

  return Object.freeze({ createOrganization, attachStationToOrganization, changeSubscriptionPlan, setSubscriptionStatus,
    simulateBillingWebhook, getOrganizationOverview, listOrganizations, addUsage, enabled, _superActor: superActor });
}

module.exports = Object.freeze({ createSaasService, AUDIT_LIMIT });
