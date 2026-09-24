'use strict';

// Server-only durable handoff for the small, explicit callable allowlist.
// A successful measured read acknowledges only after its metadata is stored.
// No request payload, response, raw UID, medical content, or token is persisted.
const crypto = require('node:crypto');
const { createServerCompletionEvent, CALLABLE_FEATURES } = require('./cost-completion-event');

const OUTBOX_COLLECTION = 'cost_usage_outbox';
const CONFIG_PATH = 'cost_usage_config/settings';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_DRAIN_MS = 240000;
const PERMANENT_INGEST_FAILURES = new Set([
  'completion-schema', 'occurred-at', 'event-age', 'before-measurement-start',
  'event-collision'
]);

function createCostCompletionOutbox({ db, getAuthUser, hashKey, now = Date.now, hasherFactory }) {
  if (!db || typeof db.collection !== 'function' || typeof getAuthUser !== 'function'
      || typeof now !== 'function' || typeof hasherFactory !== 'function') {
    throw new TypeError('outbox dependencies are required');
  }
  const hasher = hasherFactory(hashKey);
  if (!hasher.ready) throw new TypeError('RESQ_COST_USAGE_HASH_KEY is required');

  async function recordCompleted(callable, req) {
    if (!Object.hasOwn(CALLABLE_FEATURES, callable)) throw new TypeError('callable is not measured');
    const configSnap = await db.doc(CONFIG_PATH).get();
    const config = configSnap.exists ? configSnap.data() || {} : {};
    const start = typeof config.measurement_start_at === 'string'
      ? Date.parse(config.measurement_start_at) : NaN;
    if (!Number.isFinite(start) || now() < start) return null;
    const signed = req && req.auth;
    if (!signed || typeof signed.uid !== 'string' || !signed.uid) throw new TypeError('authenticated actor required');
    // This is called only after the business method succeeded. A second live
    // Auth read prevents client-supplied or stale claims becoming attribution.
    const live = await getAuthUser(signed.uid);
    const claims = live && live.customClaims || {};
    const stationId = claims.stationId;
    if (!live || live.disabled || live.uid !== signed.uid || !signed.token
        || signed.token.stationId !== stationId) throw new TypeError('live station identity required');
    const event = createServerCompletionEvent({
      callable,
      actor: { uid: signed.uid, stationId, verification: 'live' },
      invocationId: crypto.randomUUID(), occurredAt: new Date(now()), outcome: 'ok', hasher
    });
    await db.collection(OUTBOX_COLLECTION).doc(event.event_id).create({
      ...event, status: 'pending'
    });
    return event.event_id;
  }

  async function drain(service) {
    if (!service || typeof service.recordServerCompletionEventsBatch !== 'function') {
      throw new TypeError('completion ingester is required');
    }
    let processed = 0;
    let blocked = 0;
    let pageSize = 0;
    const startedAt = now();
    let timeBudgetReached = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (now() - startedAt >= MAX_DRAIN_MS) { timeBudgetReached = true; break; }
      const snapshot = await db.collection(OUTBOX_COLLECTION)
        .where('status', '==', 'pending').limit(PAGE_SIZE).get();
      const docs = snapshot.docs || [];
      pageSize = docs.length;
      for (const doc of docs) {
        if (now() - startedAt >= MAX_DRAIN_MS) { timeBudgetReached = true; break; }
        const row = doc.data() || {};
        const { status, ...event } = row;
        try {
          await service.recordServerCompletionEventsBatch([event]);
          await doc.ref.delete(); // replay after a crash is safe via the ledger
          processed += 1;
        } catch (error) {
          const reason = error && error.details && error.details.reason || error && error.code;
          if (!PERMANENT_INGEST_FAILURES.has(reason)) throw error;
          // Preserve the record for operator review without letting one poison
          // item block all newer completions. Never treat it as ingested.
          await doc.ref.set({ status: 'blocked', blocked_reason: reason,
            blocked_at: new Date(now()).toISOString() }, { merge: true });
          blocked += 1;
        }
      }
      if (timeBudgetReached) break;
      if (pageSize < PAGE_SIZE) break;
    }
    const pendingSnapshot = await db.collection(OUTBOX_COLLECTION)
      .where('status', '==', 'pending').limit(1).get();
    const blockedSnapshot = await db.collection(OUTBOX_COLLECTION)
      .where('status', '==', 'blocked').limit(1).get();
    return Object.freeze({ processed, blocked, has_blocked: (blockedSnapshot.docs || []).length > 0,
      more: (pendingSnapshot.docs || []).length > 0, time_budget_reached: timeBudgetReached,
      elapsed_ms: Math.max(0, now() - startedAt) });
  }

  return Object.freeze({ recordCompleted, drain });
}

module.exports = Object.freeze({ createCostCompletionOutbox, OUTBOX_COLLECTION, PAGE_SIZE, MAX_PAGES, MAX_DRAIN_MS });
