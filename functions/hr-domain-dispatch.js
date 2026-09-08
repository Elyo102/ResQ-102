'use strict';

// Internal request/document worker only. No SDK initialization, exports,
// scheduler, logging or browser work. All transport is outside retryable DB work.
const { createHash, randomBytes } = require('node:crypto');
const access = require('./schedule-access');
const { createOpsMemberIdentity, MEMBER_ROLES } = require('./ops-member-identity');
const { decideNotification, notificationIntent } = require('./hr-notification-policy');
const LIMITS = Object.freeze({ candidates: 25, pageSize: 25, jobPages: 25, perJob: 5,
  intents: 25, concurrency: 5, devices: 500, startBudgetMs: 60000, leaseMs: 600000,
  routineMs: 86400000, nudgeMs: 3600000, consentMs: 3600000 });
const COLLECTIONS = Object.freeze({ request: 'hr_request_notification_jobs', document: 'hr_document_notification_jobs' });
const INTENTS = 'hr_domain_notification_intents';
const ACTIVE = ['discovering', 'queued', 'processing', 'deferred', 'blocked'];
const READY = ['queued', 'blocked', 'deferred'];
const FAILED = new Set(['messaging/invalid-argument', 'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered', 'messaging/mismatched-credential', 'messaging/sender-id-mismatch']);
const TITLES = Object.freeze({ hr_request: 'יש עדכון בפניית עובד', hr_reply: 'יש עדכון בפנייה שלך',
  hr_document: 'יש עדכון במסמך ברסקיו', hr_procedure: 'יש עדכון בנוהל ברסקיו', hr_nudge: 'ממתינה תזכורת לטיפול' });
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const key = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const safeTime = v => Number.isSafeInteger(v) && v >= 0 && Number.isFinite(new Date(v).getTime());
const integer = v => Number.isSafeInteger(v) && v >= 0;
const hash = v => createHash('sha256').update(v).digest('hex');
const codeOf = e => typeof e?.code === 'string' ? e.code : '';
const isActive = v => v === 'policy_pending' || ACTIVE.includes(v);

function createHrDomainDispatch({ db, auth, messaging, HttpsError, clock = Date.now, hooks = {} }) {
  if (!db || typeof auth?.getUser !== 'function' || typeof messaging?.sendEachForMulticast !== 'function'
    || typeof HttpsError !== 'function') throw new TypeError('Dispatcher dependencies are required.');
  const identity = createOpsMemberIdentity({ db, HttpsError });
  const now = () => { const value = clock(); if (!safeTime(value)) throw new TypeError('Invalid clock.'); return value; };
  const fault = (reason, terminal = false) => Object.assign(new Error(reason), { dispatchReason: reason, terminal });
  const hook = async (name, value) => { if (typeof hooks[name] === 'function') await hooks[name](value); };
  const backoff = n => [60000, 120000, 240000, 480000, 900000][Math.min(Math.max(n - 1, 0), 4)];
  const station = sid => db.collection('stations').doc(sid);
  function locate(ref, collection) {
    const p = ref.path.split('/');
    if (p.length !== 4 || p[0] !== 'stations' || p[2] !== collection || !access.validId(p[1]) || !key(p[3])) throw fault('invalid-path', true);
    return { sid: p[1], id: p[3] };
  }
  function jobRef(input) {
    if (!plain(input) || !own(COLLECTIONS, input.family) || !access.validId(input.stationId) || !key(input.job_id)) throw fault('invalid-job-input', true);
    return station(input.stationId).collection(COLLECTIONS[input.family]).doc(input.job_id);
  }
  function basis(j, family) {
    return hash(JSON.stringify([family, j.schema, j.event_id, j.station_id, j.actor_uid, j.actor_auth_time,
      j.case_id ?? null, j.document_id ?? null, j.revision ?? null, j.audience, j.recipient_uid ?? null,
      j.type, j.created_at_ms, j.send_now, j.consent_expires_at_ms, j.routine_after_quiet, j.exclude_actor]));
  }
  function job(value, loc, family) {
    const j = value, schema = family === 'request' ? 'hr-request-notification-v1' : 'hr-document-notification-v1';
    if (!plain(j) || j.schema !== schema || j.event_id !== loc.id || j.station_id !== loc.sid
      || !access.validUid(j.actor_uid) || !integer(j.actor_auth_time) || !Number.isSafeInteger(j.actor_auth_time * 1000)
      || !safeTime(j.created_at_ms) || typeof j.send_now !== 'boolean' || typeof j.routine_after_quiet !== 'boolean'
      || j.exclude_actor !== true || !own(TITLES, j.type) || j.routine_after_quiet !== (j.type !== 'hr_nudge')
      || j.consent_expires_at_ms !== (j.send_now ? j.created_at_ms + LIMITS.consentMs : 0)
      || (j.audience === 'person' ? !access.validUid(j.recipient_uid) : own(j, 'recipient_uid'))
      || !(family === 'request' ? ['person', 'station_hr'] : ['person', 'station_members']).includes(j.audience)
      || (family === 'request' ? !key(j.case_id) : !key(j.document_id) || !integer(j.revision) || j.revision < 1)) throw fault('invalid-job', true);
    const expires = j.created_at_ms + (j.routine_after_quiet ? LIMITS.routineMs : LIMITS.nudgeMs);
    if (!safeTime(expires)) throw fault('invalid-job', true);
    if (own(j, 'dispatch_schema')) {
      if (j.dispatch_schema !== 'hr-domain-job-v1' || j.source_digest !== basis(j, family) || j.expires_at_ms !== expires
        || !['discover', 'enqueue'].includes(j.phase) || !plain(j.counts)
        || ['scanned', 'eligible', 'skipped', 'intents'].some(k => !integer(j.counts[k]))
        || !integer(j.discovery_scanned) || ![j.discovery_cursor, j.max_uid, j.cursor].every(v => v === null || access.validUid(v))) throw fault('invalid-job-state', true);
      return { ...j, counts: { ...j.counts } };
    }
    return { ...j, dispatch_schema: 'hr-domain-job-v1', source_digest: basis(j, family), expires_at_ms: expires,
      phase: j.audience === 'person' ? 'enqueue' : 'discover', discovery_cursor: null, discovery_scanned: 0,
      max_uid: null, cursor: null, counts: { scanned: 0, eligible: 0, skipped: 0, intents: 0 },
      updated_at_ms: j.created_at_ms, next_check_ms: 0, not_before_ms: 0, dispatch_check_count: 0 };
  }
  function progress(j) {
    return { dispatch_schema: j.dispatch_schema, source_digest: j.source_digest, expires_at_ms: j.expires_at_ms,
      phase: j.phase, discovery_cursor: j.discovery_cursor, discovery_scanned: j.discovery_scanned,
      max_uid: j.max_uid, cursor: j.cursor, counts: j.counts };
  }
  const dto = (j, progressed = false) => ({ status: j.status, phase: j.phase, counts: j.counts,
    discovery_scanned: j.discovery_scanned, delivery_status: 'intent_only', progressed });
  async function freshUser(uid) {
    try {
      const user = await auth.getUser(uid);
      if (!user || user.uid !== uid || user.disabled !== false || !plain(user.customClaims)) throw fault('identity-invalid', true);
      return user;
    } catch (e) {
      if (e.dispatchReason) throw e;
      throw fault(codeOf(e) === 'auth/user-not-found' ? 'identity-missing' : 'auth-unavailable', codeOf(e) === 'auth/user-not-found');
    }
  }
  async function actor(tx, j, source) {
    const user = await freshUser(j.actor_uid), c = user.customClaims;
    if (user.tokensValidAfterTime !== undefined) {
      const after = typeof user.tokensValidAfterTime === 'string' && user.tokensValidAfterTime.trim() ? Date.parse(user.tokensValidAfterTime) : NaN;
      if (!Number.isFinite(after)) throw fault('auth-validity-unavailable');
      if (j.actor_auth_time * 1000 < after) throw fault('actor-revoked', true);
    }
    if (c.stationId !== j.station_id) throw fault('actor-moved', true);
    let ctx;
    try {
      ctx = identity.context({ auth: { uid: j.actor_uid, token: c } });
      await identity.requireLive(tx, ctx);
    } catch (e) { throw fault('actor-profile-unavailable', ['permission-denied', 'failed-precondition', 'unauthenticated'].includes(codeOf(e))); }
    if (source.family === 'document' || source.event.kind === 'setStatus' || j.actor_uid !== source.parent.owner_uid) {
      if (!ctx.super && ctx.role !== 'hr_coordinator') throw fault('actor-role-changed', true);
    }
  }
  async function sourceOf(tx, j, family) {
    if (family === 'request') {
      const ref = station(j.station_id).collection('hr_requests').doc(j.case_id);
      const [parentSnap, eventSnap] = await Promise.all([tx.get(ref), tx.get(ref.collection('events').doc(j.event_id))]);
      const p = parentSnap.exists ? parentSnap.data() : null, e = eventSnap.exists ? eventSnap.data() : null;
      if (!plain(p) || p.schema !== 'hr-request-v1' || p.case_id !== j.case_id || p.station_id !== j.station_id
        || !access.validUid(p.owner_uid) || !['open', 'in_progress', 'waiting_employee', 'closed'].includes(p.status)
        || !integer(p.revision) || p.revision < 1 || !plain(e) || e.schema !== 'hr-request-event-v1'
        || e.event_id !== j.event_id || e.case_id !== j.case_id || e.station_id !== j.station_id
        || e.actor_uid !== j.actor_uid || e.created_at_ms !== j.created_at_ms || !integer(e.revision)
        || e.revision < 1 || e.revision > p.revision || !['create', 'reply', 'setStatus', 'nudge', 'attachment'].includes(e.kind)
        || (e.kind === 'attachment' && (typeof e.attachment_id !== 'string' || !/^[a-f0-9]{64}$/.test(e.attachment_id)))) throw fault('source-invalid', true);
      const ownerSide = j.actor_uid === p.owner_uid, personal = e.kind === 'setStatus' || !ownerSide;
      const type = e.kind === 'nudge' ? 'hr_nudge' : personal ? 'hr_reply' : 'hr_request';
      if (j.type !== type || j.audience !== (personal ? 'person' : 'station_hr')
        || (personal && (j.recipient_uid !== p.owner_uid || j.recipient_uid === j.actor_uid))
        || (e.kind === 'create' && (!ownerSide || e.revision !== 1))) throw fault('source-audience-invalid', true);
      if (e.kind === 'nudge' && (e.revision !== p.revision
        || !(ownerSide ? ['open', 'in_progress'].includes(p.status) : p.status === 'waiting_employee'))) throw fault('nudge-no-longer-outstanding', true);
      return { family, parent: p, event: e };
    }
    const ref = station(j.station_id).collection('hr_documents').doc(j.document_id);
    const [parentSnap, revisionSnap] = await Promise.all([tx.get(ref), tx.get(ref.collection('revisions').doc(String(j.revision)))]);
    const p = parentSnap.exists ? parentSnap.data() : null, v = revisionSnap.exists ? revisionSnap.data() : null;
    if (!plain(p) || p.schema !== 'hr-document-v1' || p.document_id !== j.document_id || p.station_id !== j.station_id
      || !['document', 'procedure'].includes(p.kind) || !integer(p.current_revision) || p.current_revision < j.revision
      || (p.kind === 'document' ? !access.validUid(p.target_uid) : own(p, 'target_uid'))
      || !plain(v) || v.schema !== 'hr-document-revision-v1' || v.document_id !== j.document_id
      || v.station_id !== j.station_id || v.revision !== j.revision || typeof v.requires_ack !== 'boolean'
      || !access.validUid(v.author_uid) || !safeTime(v.created_at_ms)) throw fault('source-invalid', true);
    const nudge = j.type === 'hr_nudge', personal = nudge || p.kind === 'document';
    if (j.audience !== (personal ? 'person' : 'station_members') || (personal && j.recipient_uid === j.actor_uid)
      || (p.kind === 'document' && j.recipient_uid !== p.target_uid)
      || (!nudge && (j.type !== (personal ? 'hr_document' : 'hr_procedure') || j.actor_uid !== v.author_uid || j.created_at_ms !== v.created_at_ms))) throw fault('source-audience-invalid', true);
    if (nudge && p.current_revision !== j.revision) throw fault('nudge-revision-changed', true);
    return { family, parent: p, revision: v };
  }
  async function recipient(tx, j, source, uid) {
    if (!access.validUid(uid) || uid === j.actor_uid || (j.audience === 'person' && uid !== j.recipient_uid)) throw fault('recipient-outside-audience', true);
    const snap = await tx.get(station(j.station_id).collection('users').doc(uid)), p = snap.exists ? snap.data() : null;
    if (!plain(p) || !access.activeMember(p, j.station_id) || !MEMBER_ROLES.includes(p.role)) throw fault('recipient-inactive', true);
    const user = await freshUser(uid), c = user.customClaims;
    if (c.stationId !== j.station_id || (c.super !== true && c.role !== p.role)) throw fault('recipient-binding-changed', true);
    if (j.audience === 'station_hr' && c.super !== true && p.role !== 'hr_coordinator') throw fault('recipient-not-hr', true);
    if (source.family === 'document' && j.type === 'hr_nudge') {
      const snap = await tx.get(station(j.station_id).collection('hr_documents').doc(j.document_id)
        .collection('revisions').doc(String(j.revision)).collection('receipts').doc(uid));
      const r = snap.exists ? snap.data() : null;
      if (r !== null && (!plain(r) || r.schema !== 'hr-document-recipient-v1' || r.document_id !== j.document_id
        || r.station_id !== j.station_id || r.revision !== j.revision || r.recipient_uid !== uid
        || ![r.opened_at_ms, r.acknowledged_at_ms].every(t => t === null || safeTime(t)))) throw fault('receipt-invalid', true);
      if (source.revision.requires_ack ? r?.acknowledged_at_ms != null : r?.opened_at_ms != null) throw fault('nudge-no-longer-outstanding', true);
    }
  }
  async function runtime(tx) {
    const snap = await tx.get(db.doc('config/runtime')), rt = snap.exists ? snap.data() : null;
    if (!plain(rt) || typeof rt.silent !== 'boolean') throw fault('silent-state-unavailable');
    return rt;
  }
  function policy(j, rt, at) {
    // Deliberately strict global silent for these domains, matching producers.
    // Neither consent nor runtime.silent_allow bypasses it.
    return decideNotification({ now_ms: at, mode: 'manual', silent: rt.silent ? 'on' : 'off',
      send_now: j.send_now === true && at < j.consent_expires_at_ms });
  }
  function note(j, family, uid) {
    return notificationIntent({ station_id: j.station_id, recipient_uid: uid, type: j.type, event_id: family + ':' + j.event_id });
  }
  async function jobFailure(ref, family, reason, terminal) {
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref); if (!snap.exists || !isActive(snap.data().status)) return;
      const at = now(); let j;
      try { j = job(snap.data(), locate(ref, COLLECTIONS[family]), family); }
      catch (_) { tx.update(ref, { status: 'cancelled', dispatch_reason: 'invalid-job', updated_at_ms: at }); return; }
      const n = integer(j.dispatch_check_count) ? j.dispatch_check_count + 1 : 1;
      tx.update(ref, { ...progress(j), status: terminal ? 'cancelled' : 'blocked', dispatch_reason: reason,
        dispatch_check_count: n, next_check_ms: terminal ? null : Math.min(at + backoff(n), j.expires_at_ms), updated_at_ms: at });
    });
  }
  // Trusted server/test interface, not a callable and never invokes transport.
  // Transient errors persist guarded backoff and reject; no cursor/intent commit.
  async function processJob(input) {
    const ref = jobRef(input), family = input.family, loc = locate(ref, COLLECTIONS[family]);
    try {
      return await db.runTransaction(async tx => {
        const snap = await tx.get(ref); if (!snap.exists) throw fault('job-missing', true);
        if (!isActive(snap.data().status)) return { status: snap.data().status, progressed: false, delivery_status: 'intent_only' };
        const j = job(snap.data(), loc, family), source = await sourceOf(tx, j, family);
        await actor(tx, j, source);
        const firstAt = now();
        if (firstAt >= j.expires_at_ms) {
          tx.update(ref, { ...progress(j), status: 'expired', dispatch_reason: 'expired', updated_at_ms: firstAt });
          return dto({ ...j, status: 'expired' });
        }
        if (j.next_check_ms > firstAt || (j.status === 'deferred' && j.not_before_ms > firstAt)) {
          tx.update(ref, { ...progress(j), updated_at_ms: firstAt }); return dto(j);
        }
        const rt = await runtime(tx), initialPolicy = policy(j, rt, firstAt);
        let page = [], eligible = [], existing = [], done = true;
        if (initialPolicy.decision === 'queue') {
          if (j.audience === 'person') page = [{ id: j.recipient_uid }];
          else {
            let query = station(loc.sid).collection('users').orderBy('__name__').limit(LIMITS.pageSize);
            const cursor = j.phase === 'discover' ? j.discovery_cursor : j.cursor;
            if (cursor !== null) query = query.startAfter(cursor);
            if (j.phase === 'enqueue') {
              if (j.max_uid === null) throw fault('invalid-discovery-bound', true);
              query = query.endAt(j.max_uid);
            }
            page = (await tx.get(query)).docs;
            done = page.length < LIMITS.pageSize;
          }
          if (j.phase === 'enqueue') {
            for (const d of page) {
              try { await recipient(tx, j, source, d.id); eligible.push(d.id); }
              catch (e) { if (e.terminal !== true) throw e; }
            }
            existing = await Promise.all(eligible.map(uid => tx.get(station(loc.sid).collection(INTENTS).doc(note(j, family, uid).id))));
          }
        }
        await hook('beforeJobWrites', { path: ref.path, phase: j.phase });
        await actor(tx, j, source);
        const confirmed = [], confirmedExisting = [];
        for (let i = 0; i < eligible.length; ++i) {
          try {
            await recipient(tx, j, source, eligible[i]);
            confirmed.push(eligible[i]); confirmedExisting.push(existing[i]);
          } catch (e) { if (e.terminal !== true) throw e; }
        }
        // Preserve the snapshot paired with its recipient. One newly ineligible
        // person is skipped; a failed read still aborts the entire page.
        eligible = confirmed; existing = confirmedExisting;
        const at = now(), decision = policy(j, rt, at);
        if (at >= j.expires_at_ms) {
          tx.update(ref, { ...progress(j), status: 'expired', dispatch_reason: 'expired', updated_at_ms: at }); return dto({ ...j, status: 'expired' });
        }
        if (decision.decision !== 'queue') {
          const status = decision.decision === 'suppressed' ? 'suppressed' : 'deferred';
          tx.update(ref, { ...progress(j), status, dispatch_reason: decision.reason, not_before_ms: decision.not_before_ms,
            next_check_ms: 0, updated_at_ms: at }); return dto({ ...j, status });
        }
        // If a held operation crossed out of quiet hours, retry on the next page
        // call; an unperformed read is never treated as a completed empty scan.
        if (initialPolicy.decision !== 'queue') {
          const status = j.phase === 'discover' ? 'discovering' : 'queued';
          tx.update(ref, { ...progress(j), status, next_check_ms: 0, updated_at_ms: at }); return dto({ ...j, status }, true);
        }
        if (j.phase === 'discover') {
          j.discovery_scanned += page.length;
          if (page.length) { j.discovery_cursor = page.at(-1).id; j.max_uid = j.discovery_cursor; }
          const status = done ? j.max_uid === null ? 'no_recipient' : 'queued' : 'discovering';
          if (done) j.phase = 'enqueue';
          tx.update(ref, { ...progress(j), status, dispatch_reason: status === 'no_recipient' ? 'no-current-recipient' : null,
            next_check_ms: 0, not_before_ms: 0, updated_at_ms: at }); return dto({ ...j, status }, true);
        }
        for (let i = 0; i < eligible.length; ++i) {
          const uid = eligible[i], n = note(j, family, uid), prior = existing[i];
          if (prior.exists) {
            const v = prior.data();
            if (v.source_digest !== j.source_digest || v.recipient_uid !== uid || v.job_id !== j.event_id || v.family !== family) throw fault('intent-collision', true);
          } else tx.create(prior.ref, { schema: 'hr-domain-intent-v1', id: n.id, family, job_id: j.event_id,
            event_id: j.event_id, station_id: loc.sid, actor_uid: j.actor_uid, recipient_uid: uid, type: j.type,
            source_digest: j.source_digest, transport_type: 'hr_private', status: 'queued', delivery_status: 'intent_only',
            created_at_ms: j.created_at_ms, expires_at_ms: j.expires_at_ms, updated_at_ms: at });
        }
        j.counts.scanned += page.length; j.counts.eligible += eligible.length;
        j.counts.skipped += page.length - eligible.length; j.counts.intents += existing.filter(v => !v.exists).length;
        if (page.length) j.cursor = page.at(-1).id;
        const status = done ? j.counts.eligible ? 'completed' : 'no_recipient' : 'processing';
        tx.update(ref, { ...progress(j), status, dispatch_reason: status === 'no_recipient' ? 'no-current-recipient' : null,
          next_check_ms: 0, not_before_ms: 0, updated_at_ms: at }); return dto({ ...j, status }, true);
      });
    } catch (e) {
      await jobFailure(ref, family, e.dispatchReason || 'preflight-unavailable', e.terminal === true);
      throw e;
    }
  }
  function validateIntent(v, loc) {
    if (!plain(v) || v.schema !== 'hr-domain-intent-v1' || v.id !== loc.id || v.station_id !== loc.sid
      || !own(COLLECTIONS, v.family) || !key(v.job_id) || v.event_id !== v.job_id || !access.validUid(v.actor_uid)
      || !access.validUid(v.recipient_uid) || !own(TITLES, v.type) || v.transport_type !== 'hr_private'
      || !key(v.source_digest) || !safeTime(v.created_at_ms) || !safeTime(v.expires_at_ms)) throw fault('invalid-intent', true);
    const n = notificationIntent({ station_id: loc.sid, recipient_uid: v.recipient_uid, type: v.type, event_id: v.family + ':' + v.event_id });
    if (n.id !== loc.id) throw fault('invalid-intent', true);
  }
  async function recordBlocked(ref, reason, terminal) {
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref); if (!snap.exists || !READY.includes(snap.data().status) || snap.data().terminal === true) return;
      const v = snap.data(), at = now(), n = integer(v.dispatch_check_count) ? v.dispatch_check_count + 1 : 1;
      tx.update(ref, { status: terminal ? 'cancelled' : 'blocked', reason, dispatch_check_count: n,
        next_check_ms: terminal ? null : Math.min(at + backoff(n), v.expires_at_ms), updated_at_ms: at });
    });
  }
  async function claim(ref, reserve) {
    const loc = locate(ref, INTENTS), attempt = randomBytes(16).toString('hex');
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref); if (!snap.exists) return null;
      const v = snap.data(); if (!READY.includes(v.status) || v.terminal === true) return null;
      validateIntent(v, loc);
      const parentRef = station(loc.sid).collection(COLLECTIONS[v.family]).doc(v.job_id), parent = await tx.get(parentRef);
      if (!parent.exists) throw fault('parent-missing', true);
      const j = job(parent.data(), { sid: loc.sid, id: v.job_id }, v.family);
      if (v.source_digest !== j.source_digest || v.actor_uid !== j.actor_uid || v.type !== j.type
        || v.created_at_ms !== j.created_at_ms || v.expires_at_ms !== j.expires_at_ms
        || !['completed', ...ACTIVE].includes(j.status)) throw fault('parent-invalid', true);
      const source = await sourceOf(tx, j, v.family);
      await actor(tx, j, source); await recipient(tx, j, source, v.recipient_uid);
      const rt = await runtime(tx), tokenDoc = await tx.get(station(loc.sid).collection('push_tokens').doc(v.recipient_uid));
      const stored = tokenDoc.exists ? tokenDoc.data() : null;
      if (stored !== null && (!plain(stored) || !Array.isArray(stored.tokens))) throw fault('tokens-invalid');
      const list = stored?.tokens || [];
      if (list.some(t => !plain(t) || typeof t.token !== 'string' || !t.token.trim() || t.token.length > 4096)) throw fault('tokens-invalid');
      const tokens = [...new Set(list.map(t => t.token))];
      await hook('beforeClaim', { path: ref.path });
      await actor(tx, j, source); await recipient(tx, j, source, v.recipient_uid);
      const at = now();
      if (at >= j.expires_at_ms) { tx.update(ref, { status: 'cancelled', reason: 'expired', updated_at_ms: at }); return null; }
      if ((v.status === 'blocked' && v.next_check_ms > at) || (v.status === 'deferred' && v.not_before_ms > at)) return null;
      const decision = policy(j, rt, at);
      if (decision.decision === 'suppressed') { tx.update(ref, { status: 'suppressed', reason: decision.reason, updated_at_ms: at }); return null; }
      if (decision.decision !== 'queue') { tx.update(ref, { status: 'deferred', reason: decision.reason, not_before_ms: decision.not_before_ms, updated_at_ms: at }); return null; }
      if (!tokens.length) { tx.update(ref, { status: 'no_device', reason: 'no-current-token', updated_at_ms: at }); return null; }
      if (tokens.length > LIMITS.devices) { tx.update(ref, { status: 'blocked', terminal: true, reason: 'token-limit', updated_at_ms: at }); return null; }
      if (!reserve(tokens.length)) return null;
      const n = note(j, v.family, v.recipient_uid);
      tx.update(ref, { status: 'attempting', reason: null, attempt_id: attempt, lease_until_ms: at + LIMITS.leaseMs,
        dispatch_started_at_ms: at, token_count: tokens.length, updated_at_ms: at });
      return { attempt, tokens, expires: j.expires_at_ms, sendNow: j.send_now, consentExpires: j.consent_expires_at_ms,
        payload: { tokens, data: { title: TITLES[j.type], body: n.body,
          url: v.family === 'request' ? './hr-requests.html' : './hr-documents.html', tag: 'hr-domain-' + v.id, important: '0' },
        webpush: { headers: { Urgency: 'normal' } } } };
    });
  }
  function outcomes(result, tokens) {
    const valid = result && Array.isArray(result.responses) && result.responses.length === tokens.length;
    return tokens.map((token, i) => {
      const r = valid ? result.responses[i] : null, code = codeOf(r?.error);
      const status = r?.success === true && typeof r.messageId === 'string' && r.messageId ? 'accepted'
        : r?.success === false && FAILED.has(code) ? 'failed' : 'outcome_unknown';
      return { token_hash: hash(token), status, code: status === 'failed' ? code : status === 'outcome_unknown' ? 'unconfirmed-outcome' : null };
    });
  }
  async function finalize(ref, sent, result) {
    const devices = outcomes(result, sent.tokens), counts = { accepted: 0, failed: 0, outcome_unknown: 0 };
    devices.forEach(d => ++counts[d.status]);
    const status = counts.outcome_unknown ? 'outcome_unknown' : counts.accepted === devices.length ? 'accepted'
      : counts.failed === devices.length ? 'failed' : 'partial';
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref); if (!snap.exists || snap.data().status !== 'attempting' || snap.data().attempt_id !== sent.attempt) return;
      tx.update(ref, { status, device_outcomes: devices, outcome_counts: counts, finished_at_ms: now(),
        delivery_status: 'provider_outcome_only', reason: counts.outcome_unknown ? 'unconfirmed-outcome' : null });
    });
  }
  async function retire(ref) {
    locate(ref, INTENTS);
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref); if (!snap.exists) return;
      const v = snap.data(), at = now();
      if (v.status === 'attempting' && (v.lease_until_ms <= at || v.expires_at_ms <= at)) {
        tx.update(ref, { status: 'outcome_unknown', reason: 'attempt-expired', finished_at_ms: at, delivery_status: 'provider_outcome_only' });
      } else if (READY.includes(v.status) && v.expires_at_ms <= at) tx.update(ref, { status: 'cancelled', reason: 'expired', updated_at_ms: at });
    });
  }
  function interleave(groups) {
    const out = [], seen = new Set();
    for (let i = 0; i < LIMITS.candidates; ++i) for (const docs of groups) {
      const d = docs[i]; if (d && !seen.has(d.ref.path)) { seen.add(d.ref.path); out.push(d); }
    }
    return out;
  }
  async function run() {
    const began = now(), within = () => now() < began + LIMITS.startBudgetMs;
    const stats = { job_pages: 0, intents_checked: 0, transport_calls: 0, device_starts: 0, errors: 0 };
    // Four indexed bounded families per source collection. The initial family
    // deliberately uses existing fields so old policy_pending jobs are visible.
    const queries = Object.values(COLLECTIONS).flatMap(name => {
      const c = db.collectionGroup(name);
      return [c.where('status', '==', 'policy_pending').orderBy('created_at_ms'),
        c.where('status', 'in', ACTIVE).where('expires_at_ms', '<=', began).orderBy('expires_at_ms'),
        c.where('status', '==', 'deferred').where('not_before_ms', '<=', began).orderBy('not_before_ms'),
        c.where('status', 'in', ACTIVE).orderBy('updated_at_ms')];
    });
    const jobs = interleave(await Promise.all(queries.map(async q => (await q.limit(LIMITS.candidates).get()).docs))), pages = new Map();
    async function advance(max) {
      let calls = 0;
      while (jobs.length && calls < max && stats.job_pages < LIMITS.jobPages && within()) {
        const d = jobs.shift(), count = pages.get(d.ref.path) || 0; if (count >= LIMITS.perJob) continue;
        const family = Object.keys(COLLECTIONS).find(k => COLLECTIONS[k] === d.ref.parent.id);
        ++calls; ++stats.job_pages; pages.set(d.ref.path, count + 1);
        try {
          const loc = locate(d.ref, COLLECTIONS[family]);
          const result = await processJob({ stationId: loc.sid, family, job_id: loc.id });
          if (result.progressed && ['discovering', 'queued', 'processing'].includes(result.status)) jobs.push(d);
        } catch (_) { ++stats.errors; }
      }
    }
    await advance(5);
    const at = now(), c = db.collectionGroup(INTENTS);
    const intentQueries = [c.where('status', 'in', [...READY, 'attempting']).where('expires_at_ms', '<=', at).orderBy('expires_at_ms'),
      c.where('status', '==', 'attempting').where('lease_until_ms', '<=', at).orderBy('lease_until_ms'),
      c.where('status', '==', 'deferred').where('not_before_ms', '<=', at).orderBy('not_before_ms'),
      c.where('status', '==', 'blocked').where('next_check_ms', '<=', at).orderBy('next_check_ms'),
      c.where('status', '==', 'queued').orderBy('created_at_ms')];
    const intents = interleave(await Promise.all(intentQueries.map(async q => (await q.limit(LIMITS.candidates).get()).docs)));
    let reserved = 0;
    async function consume() {
      while (intents.length && stats.intents_checked < LIMITS.intents && within()) {
        const d = intents.shift(); ++stats.intents_checked;
        let held = 0, sent;
        const reserve = n => { if (!within() || reserved - held + n > LIMITS.devices) return false; reserved += n - held; held = n; return true; };
        try {
          await retire(d.ref); sent = await claim(d.ref, reserve);
          if (!sent) { reserved -= held; continue; }
        } catch (e) {
          reserved -= held; ++stats.errors;
          try { await recordBlocked(d.ref, e.dispatchReason || 'preflight-unavailable', e.terminal === true); } catch (_) { ++stats.errors; }
          continue;
        }
        try {
          await hook('afterClaim', { path: d.ref.path, attempt_id: sent.attempt });
          const start = now(), decision = decideNotification({ now_ms: start, mode: 'manual', silent: 'off', send_now: sent.sendNow && start < sent.consentExpires });
          if (!within() || start >= sent.expires || decision.decision !== 'queue') {
            const defer = within() && start < sent.expires && decision.decision !== 'queue';
            await db.runTransaction(async tx => {
              const latest = await tx.get(d.ref);
              if (latest.exists && latest.data().status === 'attempting' && latest.data().attempt_id === sent.attempt) {
                // This branch is provably before SDK entry. It may defer the
                // same unsent intent; unknown/sent attempts never take it.
                tx.update(d.ref, defer
                  ? { status: 'deferred', reason: decision.reason, not_before_ms: decision.not_before_ms, updated_at_ms: start }
                  : { status: 'cancelled', reason: 'dispatch-window-closed', finished_at_ms: start });
              }
            });
            continue;
          }
          ++stats.transport_calls; stats.device_starts += held;
          let result; try { result = await messaging.sendEachForMulticast(sent.payload); } catch (_) { result = null; }
          await hook('afterSend', { path: d.ref.path, attempt_id: sent.attempt });
          await finalize(d.ref, sent, result);
        } catch (_) { ++stats.errors; } // Durable attempting is recovered as unknown, never resent.
      }
    }
    await Promise.all(Array.from({ length: LIMITS.concurrency }, () => consume()));
    await advance(LIMITS.jobPages - stats.job_pages);
    return Object.freeze({ ...stats, delivery_status: 'provider_outcome_only' });
  }
  return Object.freeze({ run, processJob });
}
module.exports = Object.freeze({ createHrDomainDispatch, LIMITS });
