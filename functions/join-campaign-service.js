'use strict';
/* שירות קליטה בקישור קבוצתי — Firestore + מנוע ההזמנות הקיים.
 *
 * כל נרשם מקבל **הזמנה אישית חד-פעמית** שנוצרת בשרת בשם יוצר הקמפיין,
 * ומשם ממשיך במסלול הקיים בדיוק: בקשת רישום, פעולת קליטה, רישום קישור
 * מוגן, אישור מנהל-על, זהות ומספר עובד. השירות הזה לא מאשר, לא מעניק
 * הרשאות ולא נוגע במנגנוני הזהות. הסוד של ההזמנה האישית חי בזיכרון
 * של קריאה אחת ואינו נכתב, אינו מוחזר ואינו נרשם.
 */

const OPERATION_SCHEMA = 1;
const STAGE_REQUEST_CREATED = 'request_created';
const INSPECT_CACHE_MS = 30 * 1000;
const PAGE_LIMIT = 50;
const LIST_LIMIT = 50;

function createJoinCampaignService(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  for (const name of ['db', 'contract', 'invitations', 'onboardingContract', 'qualifications', 'serverTimestamp',
    'FieldValue', 'fail', 'requireSuper', 'requireIdentity', 'requireAuth', 'getAuthUser', 'getAuthUsers',
    'resolveStation', 'openAudit', 'sealAudit', 'now', 'randomBytes', 'hash', 'timingSafeEqual',
    'knownDistricts']) {
    if (d[name] === undefined || d[name] === null) throw new TypeError('join campaign dependency is required: ' + name);
  }
  if (!Number.isInteger(d.hrCap) || d.hrCap < 1) throw new TypeError('join campaign dependency is required: hrCap');
  const { db, contract, invitations, onboardingContract, qualifications, serverTimestamp, FieldValue, fail,
    requireSuper, requireIdentity, requireAuth, getAuthUser, getAuthUsers, resolveStation, openAudit, sealAudit,
    now, randomBytes, hash, timingSafeEqual, knownDistricts, hrCap } = d;
  const auditEnabled = d.auditEnabled !== false;

  const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const dataOf = (snap) => (snap && snap.exists ? (snap.data() || null) : null);
  const campaignRef = (cid) => db.doc('join_campaigns/' + cid);
  const registrantRef = (cid, uid) => db.doc('join_campaigns/' + cid + '/registrants/' + uid);
  const registrantIndexRef = (uid) => db.doc('join_registrant_index/' + uid);
  const inviteRef = (id) => db.doc('invitations/' + id);
  const registrationRef = (uid) => db.doc('registration_requests/' + uid);
  const registryRef = (uid) => db.doc('onboarding_assignment_links/' + uid);
  const operationRef = (sid, rid) => db.doc('stations/' + sid + '/onboarding_operations/' + rid);
  const liveUserRef = (sid, uid) => db.doc('stations/' + sid + '/users/' + uid);
  const catalogQuery = (sid) => db.collection('stations/' + sid + '/schedule_qualifications')
    .limit(qualifications.MAX_CUSTOM + qualifications.CANONICAL.length + 1);
  const quotaRef = (cid, hourKey) => db.doc('join_campaign_inspect_quota/' + cid + '_' + hourKey);

  function contractFail(error) {
    if (error && error.name === 'JoinCampaignError') fail(error.httpCode || 'failed-precondition', error.message, error.code);
    if (error && error.name === 'InvitationError') fail('failed-precondition', error.message, error.code);
    if (error && error.name === 'OnboardingContractError') fail('failed-precondition', error.message, error.code);
    if (error && error.name === 'QualificationError') fail('failed-precondition', error.message, error.code);
    throw error;
  }
  function guard(fn) { try { return fn(); } catch (error) { return contractFail(error); } }
  function rejectStationKeys(input) {
    if (plain(input) && (Object.prototype.hasOwnProperty.call(input, 'station_id') || Object.prototype.hasOwnProperty.call(input, 'stationId'))) {
      fail('invalid-argument', 'התחנה נקבעת לפי ההרשאות של החשבון ואינה נשלחת מהלקוח.', 'client-station');
    }
  }
  async function loadCatalog(sid, tx) {
    const snap = tx ? await tx.get(catalogQuery(sid)) : await catalogQuery(sid).get();
    return qualifications.mergeCatalog(snap.docs.map((doc) => Object.assign({}, doc.data() || {}, { key: doc.id })));
  }
  async function audit(auth, action, target, details) {
    if (!auditEnabled) return null;
    return openAudit(auth, action, target, details);
  }
  async function seal(ref, extra) { if (ref) await sealAudit(ref, extra); }

  /* ---------- מי רשאי לנהל קמפיין ---------- */

  /** super (טרי) — לכל תחנה; רכזת כוח אדם — לתחנתה בלבד, מאומתת מול המשתמש החי. */
  async function managementActor(req) {
    const signed = requireAuth(req);
    if (signed.token && signed.token.super === true) {
      const fresh = await requireSuper(req);
      return Object.freeze({ uid: fresh.uid, role: 'super', station_id: '', district_id: '', auth: fresh });
    }
    rejectStationKeys(req && req.data);
    const claims = signed.token || {};
    const sid = String(claims.stationId || '');
    if (claims.role !== 'hr_coordinator' || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(sid)) {
      fail('permission-denied', 'ניהול קמפיין הצטרפות מותר למנהל-על או לרכז/ת כוח אדם של התחנה.', 'campaign-actor');
    }
    const current = await getAuthUser(signed.uid);
    const live = plain(current && current.customClaims) ? current.customClaims : {};
    if (!current || current.uid !== signed.uid || current.disabled !== false || live.role !== 'hr_coordinator' || live.stationId !== sid) {
      fail('permission-denied', 'הרשאת רכז/ת כוח אדם אינה עדכנית.', 'campaign-actor-stale');
    }
    const userSnap = await liveUserRef(sid, signed.uid).get();
    const user = dataOf(userSnap);
    if (!user || user.role !== 'hr_coordinator' || user.active !== true || user.is_active === false || user.stationId !== sid) {
      fail('permission-denied', 'רכז/ת כוח אדם חייב/ת להיות חבר/ת סגל פעיל/ה בתחנה.', 'campaign-actor-inactive');
    }
    return Object.freeze({ uid: signed.uid, role: 'hr_coordinator', station_id: sid,
      district_id: String(live.districtId || user.districtId || ''), auth: signed });
  }

  async function loadCampaignForActor(actor, cid, tx) {
    if (!contract.CAMPAIGN_ID_RE.test(String(cid || ''))) fail('invalid-argument', 'מזהה הקמפיין אינו תקין.', 'campaign-id');
    const snap = tx ? await tx.get(campaignRef(cid)) : await campaignRef(cid).get();
    const campaign = dataOf(snap);
    if (!campaign || campaign.schema !== contract.SCHEMA) fail('not-found', 'הקמפיין אינו קיים.', 'campaign-missing');
    if (actor.role !== 'super' && campaign.station_id !== actor.station_id) fail('not-found', 'הקמפיין אינו קיים.', 'campaign-missing');
    return campaign;
  }

  /* ---------- ניהול ---------- */

  async function createJoinCampaign(req) {
    const actor = await managementActor(req);
    const nowMs = now();
    const created = guard(() => contract.normalizeCreateInput(req.data, { is_super: actor.role === 'super', now_ms: nowMs }));
    const sid = actor.role === 'super' ? created.station_id : actor.station_id;
    const station = await resolveStation(sid, null);
    if (!station || station.active !== true || knownDistricts.indexOf(station.districtId) === -1) {
      fail('failed-precondition', 'התחנה אינה פעילה או אינה מוכרת.', 'campaign-station');
    }
    if (actor.role !== 'super' && actor.district_id && actor.district_id !== station.districtId) {
      fail('permission-denied', 'המחוז בהרשאות אינו תואם לתחנה.', 'campaign-district');
    }
    const token = contract.newCampaignToken({ randomBytes, hash });
    const doc = guard(() => contract.buildCampaignDoc(Object.assign({}, created, { campaign_id: token.campaign_id }), actor, { station_id: sid, district_id: station.districtId }, token.token_hash, nowMs));
    const auditRef = await audit(actor.auth, 'create_join_campaign', null, { campaign_id: token.campaign_id, station_id: sid, max: created.max_registrations });
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(campaignRef(token.campaign_id));
      if (existing.exists) fail('aborted', 'התנגשות מזהים נדירה. נסה שוב.', 'campaign-id-collision');
      tx.create(campaignRef(token.campaign_id), Object.assign({}, doc, { created_at: serverTimestamp(), updated_at: serverTimestamp() }));
    });
    await seal(auditRef, {});
    /* הטוקן הגולמי חוזר כאן פעם אחת בלבד. */
    return Object.freeze({ ok: true, campaign_id: token.campaign_id, token: token.token, revision: 1,
      station_id: sid, station_name: station.name, expires_at_ms: created.expires_at_ms, allowed_shifts: created.allowed_shifts });
  }

  async function setJoinCampaignStatus(req) {
    const actor = await managementActor(req);
    const input = plain(req.data) ? req.data : {};
    const keys = Object.keys(input);
    if (keys.length !== 3 || keys.some((k) => ['campaign_id', 'action', 'expected_revision'].indexOf(k) === -1)) {
      fail('invalid-argument', 'מתקבלים מזהה קמפיין, פעולה וגרסה בלבד.', 'input');
    }
    const nowMs = now();
    const auditRef = await audit(actor.auth, 'set_join_campaign_status', null, { campaign_id: String(input.campaign_id || ''), action: String(input.action || '') });
    const result = await db.runTransaction(async (tx) => {
      const campaign = await loadCampaignForActor(actor, input.campaign_id, tx);
      const change = guard(() => contract.applyStatusAction(campaign, input.action, input.expected_revision, nowMs));
      tx.update(campaignRef(campaign.campaign_id), Object.assign({}, change, { updated_at: serverTimestamp() }));
      return Object.freeze({ ok: true, campaign_id: campaign.campaign_id, status: change.status, revision: change.revision });
    });
    await seal(auditRef, { status: result.status });
    return result;
  }

  async function listJoinCampaigns(req) {
    const actor = await managementActor(req);
    const input = plain(req.data) ? req.data : {};
    let sid = actor.station_id;
    if (actor.role === 'super') {
      sid = typeof input.station_id === 'string' ? input.station_id.trim() : '';
      if (sid && !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(sid)) fail('invalid-argument', 'מזהה התחנה אינו תקין.', 'station');
    }
    let q = db.collection('join_campaigns');
    if (sid) q = q.where('station_id', '==', sid);
    const snap = await q.orderBy('created_at_ms', 'desc').limit(LIST_LIMIT).get();
    const nowMs = now();
    return Object.freeze({ ok: true, campaigns: snap.docs.map((doc) => contract.adminView(doc.data(), nowMs)) });
  }

  /** סטטוס הבקשה כפי שהוא נגזר מהמנגנון הקיים — לא נשמר כפול. */
  function deriveRequestStatus(request, liveUser) {
    if (request) return ['pending', 'processing', 'needs_recovery'].indexOf(request.status) !== -1 ? request.status : 'pending';
    if (liveUser && liveUser.active === true && liveUser.is_active !== false) return 'approved';
    return 'closed';
  }

  async function getJoinCampaignRegistrants(req) {
    const actor = await managementActor(req);
    const input = plain(req.data) ? req.data : {};
    const campaign = await loadCampaignForActor(actor, input.campaign_id, null);
    const limit = Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, PAGE_LIMIT) : PAGE_LIMIT;
    let q = db.collection('join_campaigns/' + campaign.campaign_id + '/registrants').orderBy('created_at_ms', 'asc');
    if (Number.isSafeInteger(input.cursor)) q = q.startAfter(input.cursor);
    const snap = await q.limit(limit).get();
    const rows = snap.docs.map((doc) => doc.data()).filter((r) => plain(r) && r.schema === contract.REGISTRANT_SCHEMA);
    const nowMs = now();
    if (!rows.length) return Object.freeze({ ok: true, campaign: contract.adminView(campaign, nowMs), rows: [], next_cursor: null });
    /* קריאה אחת לכל סוג מסמך — לא N+1: getAll לבקשות, getAll לחברי התחנה, getUsers לאימות מייל. */
    const uids = rows.map((r) => r.uid);
    const [requests, users, authUsers] = await Promise.all([
      db.getAll(...uids.map((u) => registrationRef(u))),
      db.getAll(...uids.map((u) => liveUserRef(campaign.station_id, u))),
      getAuthUsers(uids)
    ]);
    const requestBy = new Map(uids.map((u, i) => [u, dataOf(requests[i])]));
    const userBy = new Map(uids.map((u, i) => [u, dataOf(users[i])]));
    const authBy = new Map((authUsers || []).map((u) => [u.uid, u]));
    const out = rows.map((r) => {
      const request = requestBy.get(r.uid), live = userBy.get(r.uid), a = authBy.get(r.uid);
      const status = deriveRequestStatus(request, live);
      const promoted = status === 'approved' ? contract.promoteDeclarations(r).declarations : r.declarations;
      return Object.freeze({
        uid: r.uid, request_id: r.request_id, shift: r.shift, note: r.note || '',
        full_name: request ? String(request.full_name || '') : (live ? String(live.name || live.full_name || '') : ''),
        email: request ? String(request.email || '') : (a ? String(a.email || '') : ''),
        phone: request ? String(request.phone || '') : '',
        request_status: status,
        request_generation: request ? String(request.server_generation || '') : '',
        email_verified: a ? a.emailVerified === true : null,
        account_disabled: a ? a.disabled === true : null,
        review_state: r.review_state || 'none', review_note: r.review_note || '', review_at_ms: r.review_at_ms || null, reject_reason: r.reject_reason || '',
        declarations: (Array.isArray(promoted) ? promoted : []).map((x) => Object.freeze({
          key: x.key, status: contract.effectiveDeclarationStatus(x, nowMs), valid_until_ms: x.valid_until_ms || null,
          reference: x.reference || null, reject_reason: x.reject_reason || null, revision: x.revision || 1
        })),
        summary: contract.summarizeDeclarations(promoted, nowMs),
        revision: r.revision, created_at_ms: r.created_at_ms, ack: r.ack || null
      });
    });
    const last = rows[rows.length - 1];
    return Object.freeze({ ok: true, campaign: contract.adminView(campaign, nowMs), rows: out,
      next_cursor: out.length === limit ? last.created_at_ms : null });
  }

  async function reviewJoinRegistrant(req) {
    const actor = await managementActor(req);
    const review = guard(() => contract.normalizeReviewAction(req.data));
    const nowMs = now();
    const auditRef = await audit(actor.auth, 'review_join_registrant', review.uid, { campaign_id: review.campaign_id, action: review.action });
    const result = await db.runTransaction(async (tx) => {
      const campaign = await loadCampaignForActor(actor, review.campaign_id, tx);
      const registrant = dataOf(await tx.get(registrantRef(campaign.campaign_id, review.uid)));
      const change = guard(() => contract.applyReviewAction(registrant, review.action, review.expected_revision, review.reason, nowMs));
      tx.update(registrantRef(campaign.campaign_id, review.uid), Object.assign({}, change, { updated_at: serverTimestamp() }));
      return Object.freeze({ ok: true, uid: review.uid, review_state: change.review_state || (registrant.review_state || 'none'), revision: change.revision });
    });
    await seal(auditRef, { review_state: result.review_state });
    return result;
  }

  /* ---------- צפייה ציבורית ---------- */

  const inspectCache = new Map();
  function hourKey(ms) { return String(Math.floor(ms / 3600000)); }

  async function inspectJoinCampaign(req) {
    const input = plain(req && req.data) ? req.data : {};
    const parsed = contract.parseToken(input.token);
    const nowMs = now();
    if (!parsed) return Object.freeze({ state: 'not_found' });
    const cached = inspectCache.get(parsed.campaign_id);
    if (cached && cached.until > nowMs && cached.secret === parsed.secret) return cached.view;
    const quota = quotaRef(parsed.campaign_id, hourKey(nowMs));
    const quotaSnap = await quota.get();
    const count = quotaSnap.exists ? Number((quotaSnap.data() || {}).count || 0) : 0;
    if (count >= contract.INSPECT_PER_HOUR) fail('resource-exhausted', 'הקישור נבדק יותר מדי פעמים. נסה שוב בעוד שעה.', 'inspect-quota');
    await quota.set({ count: FieldValue.increment(1), expires_at_ms: nowMs + 2 * 3600000 }, { merge: true });
    const campaign = dataOf(await campaignRef(parsed.campaign_id).get());
    if (!campaign || !contract.tokenMatches(parsed.secret, campaign, { hash, timingSafeEqual })) {
      const view = Object.freeze({ state: 'not_found' });
      inspectCache.set(parsed.campaign_id, { until: nowMs + INSPECT_CACHE_MS, secret: parsed.secret, view });
      return view;
    }
    const [station, catalog] = await Promise.all([resolveStation(campaign.station_id, null), loadCatalog(campaign.station_id, null)]);
    const view = contract.publicView(campaign, nowMs, station ? station.name : campaign.station_id, catalog);
    inspectCache.set(parsed.campaign_id, { until: nowMs + INSPECT_CACHE_MS, secret: parsed.secret, view });
    return view;
  }

  /* ---------- מימוש ---------- */

  async function issuerLiveness(campaign, tx) {
    const current = await getAuthUser(campaign.created_by);
    if (!current || current.uid !== campaign.created_by || current.disabled !== false) fail('failed-precondition', 'הקישור אינו פעיל עוד. פנה לתחנה.', 'campaign-issuer-inactive');
    const claims = plain(current.customClaims) ? current.customClaims : {};
    if (campaign.created_by_role === 'super') {
      if (claims.super !== true) fail('failed-precondition', 'הקישור אינו פעיל עוד. פנה לתחנה.', 'campaign-issuer-inactive');
      return;
    }
    const live = dataOf(await tx.get(liveUserRef(campaign.station_id, campaign.created_by)));
    if (claims.role !== 'hr_coordinator' || claims.stationId !== campaign.station_id || !live || live.role !== 'hr_coordinator'
        || live.active !== true || live.is_active === false) {
      fail('failed-precondition', 'הקישור אינו פעיל עוד. פנה לתחנה.', 'campaign-issuer-inactive');
    }
  }

  async function redeemJoinCampaign(req) {
    const identity = await requireIdentity(req);
    const input = plain(req && req.data) ? req.data : {};
    const parsed = contract.parseToken(input.token);
    if (!parsed) fail('invalid-argument', 'הקישור אינו תקין.', 'campaign-token');
    const requestId = typeof input.request_id === 'string' ? input.request_id : '';
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) fail('invalid-argument', 'מזהה הפעולה אינו תקין.', 'request-id');
    const uid = identity.uid;
    const nowMs = now();

    return db.runTransaction(async (tx) => {
      /* כל הקריאות לפני הכתיבה הראשונה. */
      const campaign = dataOf(await tx.get(campaignRef(parsed.campaign_id)));
      if (!campaign || !contract.tokenMatches(parsed.secret, campaign, { hash, timingSafeEqual })) {
        fail('not-found', 'הקישור אינו קיים או שפג תוקפו.', 'campaign-missing');
      }
      const sid = campaign.station_id;
      const [opSnap, registrySnap] = await Promise.all([tx.get(operationRef(sid, requestId)), tx.get(registryRef(uid))]);
      const operation = dataOf(opSnap), registry = dataOf(registrySnap);

      /* Replay של הפעולה שלנו — נבדק לפני מצב הקמפיין, כדי שניסיון חוזר
       * אחרי שהמכסה התמלאה יקבל replayed ולא campaign-full. */
      if (operation) {
        const invite = plain(operation) && typeof operation.invite_id === 'string' ? dataOf(await tx.get(inviteRef(operation.invite_id))) : null;
        const ok = contract.replayMatches({ operation, registry, invite, uid, request_id: requestId, campaign,
          stages: onboardingContract.ONBOARDING_STAGES, verifyStoredFingerprint: invitations.verifyStoredFingerprint });
        if (!ok) fail('failed-precondition', 'אותו מזהה פעולה כבר שימש לכוונה אחרת.', 'onboarding-intent-changed');
        await requireIdentity(req);
        return Object.freeze({ ok: true, replayed: true, stage: operation.stage, approved: false, permissions_granted: false,
          station_id: sid, uid, request_id: requestId });
      }
      if (registry) fail('failed-precondition', 'קיים קישור קליטה לחשבון ואין לדרוס אותו.', 'onboarding-registry-exists');

      const state = contract.deriveState(campaign, nowMs);
      if (state !== 'active') {
        const messages = { paused: 'הקישור מושהה זמנית. נסה מאוחר יותר.', revoked: 'הקישור בוטל על ידי התחנה.',
          expired: 'תוקף הקישור פג.', full: 'הקישור הגיע למכסת הנרשמים.' };
        fail('failed-precondition', messages[state] || 'הקישור אינו פעיל.', 'campaign-' + state);
      }
      const [catalog, existingRequestSnap, station] = await Promise.all([loadCatalog(sid, tx), tx.get(registrationRef(uid)), resolveStation(sid, tx)]);
      if (!station || station.active !== true) fail('failed-precondition', 'התחנה אינה פעילה.', 'campaign-station');
      const normalized = guard(() => contract.normalizeRedemptionInput(input, campaign, catalog, nowMs));
      await issuerLiveness(campaign, tx);

      /* ההזמנה האישית — בזיכרון. הסוד נולד ומת בתוך הבלוק הזה. */
      const gate = { auth: { uid: campaign.created_by }, cap: campaign.created_by_role === 'super' ? Infinity : hrCap,
        sid, did: campaign.district_id };
      const candidate = guard(() => invitations.issue(gate, { station_id: sid, district_id: campaign.district_id,
        role: contract.DEFAULT_ROLE, shift: normalized.shift, full_name: normalized.full_name, email: identity.email, phone: normalized.phone }));
      const plan = guard(() => invitations.redeem(candidate.doc, candidate.secret, identity, null, nowMs));
      guard(() => invitations.verifyPlan(candidate.doc, plan));
      const split = guard(() => onboardingContract.splitRedemption({ source: 'server_document', invite: candidate.doc, redeemed: plan,
        recomputed_fingerprint: plan.invite_fingerprint, auth: identity, request_id: requestId }));
      if (split.station_id !== sid || split.uid !== uid) fail('internal', 'תוכנית המימוש אינה תואמת לקמפיין.', 'plan-mismatch');

      const existingRequest = dataOf(existingRequestSnap);
      const permission = guard(() => onboardingContract.mayWriteRegistration(existingRequest, split));
      if (!permission.allowed) fail('failed-precondition', 'קיימת בקשת הרשמה של פעולה אחרת ואין לדרוס אותה.', 'registration-foreign');
      if (existingRequest) guard(() => onboardingContract.assertRequestMatchesLink(existingRequest, split.assignment_ref));
      const registrant = guard(() => contract.buildRegistrant({ uid, request_id: requestId, campaign_id: campaign.campaign_id,
        campaign_revision: campaign.revision, station_id: sid, invite_id: candidate.invite_id, shift: normalized.shift,
        declarations: normalized.declarations, note: normalized.note, ack: normalized.ack, now_ms: nowMs }));
      contract.assertNoSecret(split, 'תוכנית המימוש');
      await requireIdentity(req);

      const expectedRegistry = { schema_version: OPERATION_SCHEMA, uid, station_id: sid, request_id: requestId,
        invite_id: candidate.invite_id, operation_fingerprint: split.operation_fingerprint };
      const nextCount = campaign.accepted_count + 1;

      /* טרנזקציה אחת: הזמנה, בקשה, פעולה, רישום מוגן, נרשם ומונה — או כלום. */
      tx.create(inviteRef(candidate.invite_id), Object.assign({}, candidate.doc,
        { redeemed_by: uid, redeemed_at: serverTimestamp(), redeemed_request_id: requestId }));
      tx.set(registrationRef(uid), Object.assign({}, split.registration_request, { created_at: serverTimestamp() }));
      tx.set(operationRef(sid, requestId), {
        schema_version: OPERATION_SCHEMA, station_id: sid, request_id: requestId, uid, invite_id: candidate.invite_id,
        assignment_ref: split.assignment_ref, operation_fingerprint: split.operation_fingerprint,
        stage: STAGE_REQUEST_CREATED, created_at: serverTimestamp(),
        provenance: { kind: 'join_campaign', campaign_id: campaign.campaign_id, campaign_revision: campaign.revision }
      });
      tx.set(registryRef(uid), expectedRegistry);
      tx.set(registrantRef(campaign.campaign_id, uid), Object.assign({}, registrant, { created_at: serverTimestamp() }));
      tx.set(registrantIndexRef(uid), { uid, campaign_id: campaign.campaign_id, station_id: sid, request_id: requestId, created_at_ms: nowMs });
      tx.update(campaignRef(campaign.campaign_id), {
        accepted_count: nextCount, status: nextCount >= campaign.max_registrations ? 'full' : campaign.status,
        revision: campaign.revision + 1, updated_at_ms: nowMs, updated_at: serverTimestamp()
      });
      return Object.freeze({ ok: true, replayed: false, stage: STAGE_REQUEST_CREATED, approved: false, permissions_granted: false,
        station_id: sid, uid, request_id: requestId });
    });
  }

  /* ---------- העובד רואה את עצמו ---------- */

  async function getMyJoinStatus(req) {
    const signed = requireAuth(req);
    const uid = signed.uid;
    const index = dataOf(await registrantIndexRef(uid).get());
    if (!index) return Object.freeze({ ok: true, found: false });
    const [registrant, request, live] = await Promise.all([
      registrantRef(index.campaign_id, uid).get().then(dataOf),
      registrationRef(uid).get().then(dataOf),
      liveUserRef(index.station_id, uid).get().then(dataOf)
    ]);
    if (!registrant) return Object.freeze({ ok: true, found: false });
    const nowMs = now();
    const status = deriveRequestStatus(request, live);
    const decls = status === 'approved' ? contract.promoteDeclarations(registrant).declarations : registrant.declarations;
    return Object.freeze({
      ok: true, found: true, station_id: index.station_id, shift: registrant.shift, request_status: status,
      review_state: registrant.review_state || 'none', review_note: registrant.review_note || '', reject_reason: registrant.reject_reason || '',
      declarations: (Array.isArray(decls) ? decls : []).map((x) => Object.freeze({
        key: x.key, status: contract.effectiveDeclarationStatus(x, nowMs), valid_until_ms: x.valid_until_ms || null,
        reject_reason: x.reject_reason || null
      })),
      summary: contract.summarizeDeclarations(decls, nowMs), created_at_ms: registrant.created_at_ms
    });
  }

  /* ---------- אימות כשירות — מנהל-על בלבד, טרנזקציה אחת ---------- */

  const holdingsRef = (sid, uid) => db.doc('stations/' + sid + '/schedule_person_qualifications/' + uid);
  const holdingsMetaRef = (sid) => db.doc('stations/' + sid + '/schedule_state/qualifications');
  const catalogEntryRef = (sid, key) => db.doc('stations/' + sid + '/schedule_qualifications/' + key);
  const holdingsAuditRef = (sid, requestId) => db.doc('stations/' + sid + '/schedule_qualification_audit/qa_' + hash(sid + '|' + requestId).slice(0, 40));

  /* ההצהרה וההחזקה בסידור נכתבות באותה טרנזקציה — אין אמת מפוצלת. מסמך
   * ההחזקות נכתב באותה צורה בדיוק שכותב setPersonQualifications של המנוע
   * (qualifications, revision, cleared, updated_by/at, מטא-revision, רשומת
   * ביקורת) ובנוסף `valid_until` — התוקף שהמנוע מסנן לפיו. התחנה נגזרת
   * מהקמפיין בשרת; מנהל-על מאמת לכל תחנה. */
  async function verifyQualificationDeclaration(req) {
    const auth = await requireSuper(req);
    const verify = guard(() => contract.normalizeVerifyInput(req.data));
    const nowMs = now();
    const auditRef = await audit(auth, 'verify_qualification_declaration', verify.uid,
      { campaign_id: verify.campaign_id, key: verify.key, action: verify.action });
    const result = await db.runTransaction(async (tx) => {
      const campaign = await loadCampaignForActor({ role: 'super' }, verify.campaign_id, tx);
      const sid = campaign.station_id;
      const [registrant, live, holdings, meta, catalogEntry, priorAudit] = await Promise.all([
        tx.get(registrantRef(campaign.campaign_id, verify.uid)).then(dataOf),
        tx.get(liveUserRef(sid, verify.uid)).then(dataOf),
        tx.get(holdingsRef(sid, verify.uid)).then(dataOf),
        tx.get(holdingsMetaRef(sid)).then(dataOf),
        tx.get(catalogEntryRef(sid, verify.key)).then(dataOf),
        tx.get(holdingsAuditRef(sid, verify.request_id)).then(dataOf)
      ]);
      /* אותו request_id שכבר הושלם: רק אם הכוונה זהה (קמפיין, עובד, מפתח, פעולה,
       * גרסה צפויה, מאמת) זו תשובה שאבדה ומחזירים את הקבלה. כוונה אחרת = התנגשות. */
      const intent = contract.verificationIntentFingerprint(verify, auth.uid, hash);
      if (priorAudit) {
        if (priorAudit.intent_fingerprint !== intent) fail('already-exists', 'אותו מזהה פעולה כבר שימש לכוונה אחרת.', 'request-conflict');
        return Object.freeze({ ok: true, duplicate: true, uid: verify.uid, key: verify.key, action: verify.action,
          revision: registrant && Number.isInteger(registrant.revision) ? registrant.revision : 0, holdings_written: false, station_id: sid });
      }
      const approved = !!(live && live.active === true && live.is_active !== false);
      const promoted = approved && registrant ? contract.promoteDeclarations(registrant).declarations : (registrant && registrant.declarations);
      const change = guard(() => contract.planDeclarationUpdate(Object.assign({}, registrant, { declarations: promoted }), verify, nowMs, auth.uid));
      const patch = { declarations: change.declarations, revision: change.revision, updated_at_ms: change.updated_at_ms, updated_at: serverTimestamp() };
      if (verify.action === 'reject') {
        /* גם דחייה רושמת רשומת פעולה עם טביעת כוונה — אותו request_id לכשירות אחרת נחסם. */
        tx.create(holdingsAuditRef(sid, verify.request_id), {
          action: 'declaration_reject', source: 'join_campaign_verification', campaign_id: campaign.campaign_id, intent_fingerprint: intent,
          person: verify.uid, request_id: verify.request_id, key: verify.key, reason: verify.reason, by: auth.uid, at: serverTimestamp()
        });
        tx.update(registrantRef(campaign.campaign_id, verify.uid), patch);
        return Object.freeze({ ok: true, uid: verify.uid, key: change.key, action: 'reject', revision: change.revision, holdings_written: false, station_id: sid });
      }
      if (!approved) fail('failed-precondition', 'העובד עדיין לא אושר; ההצהרה אינה ניתנת לאימות.', 'declaration-not-pending');
      const catalog = qualifications.mergeCatalog(catalogEntry ? [Object.assign({}, catalogEntry, { key: verify.key })] : []);
      const decl = (promoted || []).find((x) => x && x.key === verify.key) || {};
      const plan = guard(() => contract.holdingsAfterVerification({ holdings, key: verify.key, valid_until_ms: decl.valid_until_ms || null, catalog }));
      const fingerprint = hash(JSON.stringify({ station_id: sid, uid: auth.uid, requestId: verify.request_id, person: verify.uid, next: plan.qualifications, valid_until: plan.valid_until }));
      tx.set(holdingsRef(sid, verify.uid), {
        station_id: sid, uid: verify.uid, qualifications: plan.qualifications, revision: plan.revision,
        cleared: plan.qualifications.length === 0, valid_until: plan.valid_until,
        updated_by: auth.uid, updated_at: serverTimestamp()
      });
      tx.set(holdingsMetaRef(sid), { station_id: sid, holdings_revision: Number((meta && meta.holdings_revision) || 0) + 1, updated_at: serverTimestamp() }, { merge: true });
      tx.create(holdingsAuditRef(sid, verify.request_id), Object.assign({
        action: 'holdings', source: 'join_campaign_verification', campaign_id: campaign.campaign_id, intent_fingerprint: intent,
        person: verify.uid, request_id: verify.request_id, fingerprint, before: plan.before, after: plan.qualifications,
        valid_until: plan.valid_until, result: { qualifications: plan.qualifications, revision: plan.revision },
        by: auth.uid, at: serverTimestamp()
      }, qualifications.diffHoldings(plan.before, plan.qualifications)));
      tx.update(registrantRef(campaign.campaign_id, verify.uid), patch);
      return Object.freeze({ ok: true, uid: verify.uid, key: change.key, action: 'verify', revision: change.revision,
        holdings_written: true, holdings_revision: plan.revision, station_id: sid });
    });
    await seal(auditRef, { revision: result.revision, holdings_written: result.holdings_written });
    return result;
  }

  return Object.freeze({ createJoinCampaign, setJoinCampaignStatus, listJoinCampaigns, getJoinCampaignRegistrants,
    reviewJoinRegistrant, inspectJoinCampaign, redeemJoinCampaign, getMyJoinStatus, verifyQualificationDeclaration,
    _managementActor: managementActor });
}

module.exports = Object.freeze({ createJoinCampaignService, OPERATION_SCHEMA, STAGE_REQUEST_CREATED, PAGE_LIMIT, LIST_LIMIT });
