'use strict';

// HR report reads and an unwired inspection-receipt operation. Contents never grant
// identity or authority. Historical reads stay anchored to the old local user.
const access = require('./schedule-access');
const { createOpsMemberIdentity } = require('./ops-member-identity');
const { monthKey, projectEmployeeHours, HrHoursInputError } = require('./hr-hours-model');
const { createMonthRevision } = require('./hr-month-revision');
const { validReview, reviewHash } = require('./hr-hours-review-contract');
const { createHash } = require('node:crypto');
const PAGE_SIZE = 25;
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const text = value => typeof value === 'string' ? value : '';
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));

function createHrHoursService({ db, auth, HttpsError, hooks = {}, serverTimestamp, clock = Date.now }) {
  if (!db || !auth || typeof auth.getUser !== 'function' || typeof HttpsError !== 'function') throw new TypeError('db, auth and HttpsError required');
  const identity = createOpsMemberIdentity({ db, HttpsError });
  const error = (code, message) => new HttpsError(code, message);
  function request(req, keys) {
    const ctx = identity.context(req);
    if (!ctx.super && ctx.role !== 'hr_coordinator') throw error('permission-denied', 'נדרשת הרשאת משאבי אנוש.');
    const data = req.data;
    if (!plain(data) || Object.keys(data).some(k => !keys.includes(k))) throw error('invalid-argument', 'בקשה לא תקינה.');
    try { monthKey(data.month); } catch (_) { throw error('invalid-argument', 'חודש לא תקין.'); }
    const authTime = req.auth.token.auth_time;
    if (!Number.isSafeInteger(authTime) || authTime < 0 || !Number.isSafeInteger(authTime * 1000)) throw error('unauthenticated', 'Refresh your sign-in.');
    return { ctx, data, authTime };
  }
  async function live(tx, requestContext) {
    const { ctx, authTime } = requestContext;
    let record;
    try { record = await auth.getUser(ctx.uid); }
    catch (e) {
      if (e && e.code === 'auth/user-not-found') throw error('permission-denied', 'The current account is unavailable.');
      throw error('unavailable', 'Current authentication could not be verified.');
    }
    const claims = record && record.customClaims;
    if (!record || record.uid !== ctx.uid || record.disabled === true || !plain(claims)
      || claims.stationId !== ctx.sid || (claims.super === true) !== ctx.super
      || (!ctx.super && claims.role !== ctx.role)) throw error('permission-denied', 'Your role or station changed. Refresh your sign-in.');
    if (record.tokensValidAfterTime !== undefined) {
      const validAfter = typeof record.tokensValidAfterTime === 'string' ? Date.parse(record.tokensValidAfterTime) : NaN;
      if (!Number.isFinite(validAfter)) throw error('unavailable', 'Authentication validity is unavailable.');
      if (authTime * 1000 < validAfter) throw error('permission-denied', 'Your sign-in was revoked.');
    }
    return identity.requireLive(tx, ctx);
  }
  function stamp(snap) {
    if (!snap.exists) return 'missing';
    if (!snap.updateTime) throw error('internal', 'לא ניתן לאמת את גרסת הנתונים.');
    return snap.updateTime.seconds + ':' + snap.updateTime.nanoseconds;
  }
  function remember(fences, snap) { fences.set(snap.ref.path, { ref: snap.ref, version: stamp(snap) }); }
  function person(snap, sid) {
    const value = snap.exists ? snap.data() : null;
    if (!plain(value) || !access.validUid(snap.id) || !access.liveStation(value).ok
      || access.liveStation(value).stationId !== sid) throw new HrHoursInputError('local-person-invalid');
    const n = value.employee_number;
    if (!['string', 'number'].includes(typeof n) || (typeof n === 'number' && !Number.isFinite(n))) throw new HrHoursInputError('employee-number-invalid');
    const emp = String(n);
    if (!emp || emp.length > 64 || /[\u0000-\u001f\u007f/]/.test(emp)) throw new HrHoursInputError('employee-number-invalid');
    return { uid: snap.id, employee_number: emp, full_name: text(value.full_name),
      crew: text(value.crew), historical: value.active === false || value.is_active === false };
  }
  async function binding(tx, fences, snap, ctx) {
    remember(fences, snap);
    const p = person(snap, ctx.sid);
    if (!p.historical) {
      const [index, directory] = await Promise.all([
        tx.get(db.collection('emp_index').doc(p.employee_number)),
        tx.get(db.collection('directory').doc(p.uid))
      ]);
      remember(fences, index); remember(fences, directory);
      const i = index.exists ? index.data() : null, d = directory.exists ? directory.data() : null;
      if (!plain(i) || i.uid !== p.uid || i.stationId !== ctx.sid || i.active === false
        || i.retired === true || i.status === 'retired' || !access.activeMember(d, ctx.sid)) {
        throw new HrHoursInputError('person-binding-unavailable');
      }
      // Name/crew can be updated locally without synchronizing directory.
    }
    return p;
  }
  async function finalize(requestContext, fences) {
    if (typeof hooks.beforeFinalize === 'function') await hooks.beforeFinalize();
    // A fresh read after the data transaction detects revocation/transfer during
    // loading. No claim that a read can prevent changes after this boundary.
    await db.runTransaction(async tx => {
      await live(tx, requestContext);
      const entries = [...fences.values()];
      const current = await Promise.all(entries.map(f => tx.get(f.ref)));
      if (current.some((snap, i) => stamp(snap) !== entries[i].version)) {
        throw error('aborted', 'פרטי העובדים השתנו בזמן הטעינה. יש לרענן את הדוח.');
      }
    });
  }
  function unavailable(snap, issue) {
    const v = snap.data() || {};
    return { uid: snap.id, full_name: text(v.full_name), crew: text(v.crew),
      historical: v.active === false || v.is_active === false,
      state: 'unavailable', issue, reminder_eligible: false };
  }
  async function reviewMetadata(tx, ctx, p, month, revision = null) {
    const ref=db.collection('stations').doc(ctx.sid).collection('hr_hours_reviews').doc(reviewHash(['hr-review-summary-v1',p.uid,month]));
    const snap=await tx.get(ref);
    if(!snap.exists)return {review:null,review_unavailable:false};
    const v=snap.data();
    if(!validReview(v)||v.station_id!==ctx.sid||v.owner_uid!==p.uid||v.employee_number!==p.employee_number||v.month!==month)return {review:null,review_unavailable:true};
    return {review:{review_id:v.review_id,actor_uid:v.actor_uid,reviewed_revision:v.reviewed_revision,
      reviewed_at:{seconds:v.reviewed_at.seconds,nanoseconds:v.reviewed_at.nanoseconds},
      current:revision===null?null:revision===v.reviewed_revision},review_unavailable:false};
  }
  async function listMonth(req) {
    const requestContext = request(req, ['month', 'cursor']);
    const { ctx, data } = requestContext;
    if (own(data, 'cursor') && !access.validUid(data.cursor)) throw error('invalid-argument', 'סמן עמוד לא תקין.');
    const root = db.collection('stations').doc(ctx.sid), fences = new Map();
    const response = await db.runTransaction(async tx => {
      // SDK retry must not keep versions from a previous attempt.
      fences.clear();
      await live(tx, requestContext);
      let query = root.collection('users').orderBy('__name__').limit(PAGE_SIZE + 1);
      if (data.cursor) query = query.startAfter(data.cursor);
      const page = await tx.get(query), scanned = page.docs.slice(0, PAGE_SIZE);
      const items = await Promise.all(scanned.map(async snap => {
        try {
          const p = await binding(tx, fences, snap, ctx);
          const report = await tx.get(root.collection('monthly_reports').doc(p.employee_number + '_' + data.month));
          const value = projectEmployeeHours({ month: data.month, employee: p,
            report: report.exists ? report.data() : null, attendance: [] });
          const review = await reviewMetadata(tx, ctx, p, data.month);
          return { ...review, uid: p.uid, employee_number: p.employee_number, full_name: p.full_name,
            crew: p.crew, historical: p.historical, state: value.state, label: value.label,
            stored_total_hours: value.stored_total_hours,
            declared_days: value.declared_day_keys === null ? null : value.declared_day_keys.length,
            reminder_eligible: !p.historical && ['missing', 'draft'].includes(value.state) };
        } catch (e) {
          if (e instanceof HrHoursInputError) return unavailable(snap, e.code);
          throw e; // Failed reads and authorization are never missing reports.
        }
      }));
      return { month: data.month, items,
        next_cursor: page.docs.length > PAGE_SIZE ? scanned[scanned.length - 1].id : null };
    });
    await finalize(requestContext, fences);
    return response;
  }
  async function getEmployeeMonth(req) {
    const requestContext = request(req, ['month', 'uid']);
    const { ctx, data } = requestContext;
    if (!access.validUid(data.uid)) throw error('invalid-argument', 'משתמש לא תקין.');
    const root = db.collection('stations').doc(ctx.sid), fences = new Map();
    let response;
    try {
      response = await db.runTransaction(async tx => {
        fences.clear();
        await live(tx, requestContext);
        const snap = await tx.get(root.collection('users').doc(data.uid));
        if (!snap.exists) throw error('not-found', 'העובד אינו מופיע ברישומי התחנה.');
        const p = await binding(tx, fences, snap, ctx);
        const [report, attendance] = await Promise.all([
          tx.get(root.collection('monthly_reports').doc(p.employee_number + '_' + data.month)),
          tx.get(root.collection('attendance').where('emp_number', '==', p.employee_number)
            .where('month', '==', data.month).limit(32))
        ]);
        if (attendance.docs.length > 31) throw error('failed-precondition', 'נמצאו יותר מדי רשומות לחודש; נדרשת בדיקת הנתונים.');
        const value = projectEmployeeHours({ month: data.month, employee: p,
          report: report.exists ? report.data() : null, attendance: attendance.docs.map(d => d.data()) });
        const tuple = snap => ({ id: snap.id, version: snap.updateTime
          ? { seconds: snap.updateTime.seconds, nanoseconds: snap.updateTime.nanoseconds } : null });
        let revision = null;
        try {
          revision = createMonthRevision({ stationId: ctx.sid, uid: p.uid,
            employeeNumber: p.employee_number, month: data.month,
            report: report.exists ? tuple(report) : null, attendance: attendance.docs.map(tuple) });
        } catch (e) {
          // Legacy noncanonical IDs remain readable, but cannot grant a revision.
          if (!(e instanceof TypeError)) throw e;
        }
        const review = await reviewMetadata(tx, ctx, p, data.month, report.exists ? revision : null);
        return { ...value, ...review, historical: p.historical, snapshot_revision: revision,
          revision_unavailable: revision === null,
          reminder_eligible: !p.historical && ['missing', 'draft'].includes(value.state) };
      });
    } catch (e) {
      if (e instanceof HrHoursInputError) throw error('failed-precondition', 'נתוני הדוח דורשים בדיקה (' + e.code + ').');
      throw e;
    }
    await finalize(requestContext, fences);
    return response;
  }
  // Inert until explicitly wired to a callable with notification/quota gates.
  // Records inspection only; never modifies employee or command approval.
  async function reviewEmployeeMonth(req) {
    const context = request(req, ['month', 'uid', 'expected_revision', 'request_id']);
    const { ctx, data } = context;
    if (!access.validUid(data.uid) || typeof data.request_id !== 'string'
        || !/^[A-Za-z0-9_-]{8,120}$/.test(data.request_id)
        || typeof data.expected_revision !== 'string' || !/^[a-f0-9]{64}$/.test(data.expected_revision)) throw error('invalid-argument', 'פרטי העיון אינם תקינים.');
    if (typeof serverTimestamp !== 'function') throw error('failed-precondition', 'שמירת עיון אינה מחוברת.');
    const hash = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    const eventId = hash(['hr-review-event-v1', ctx.uid, data.request_id]);
    const fingerprint = hash(['hr-review-intent-v1', ctx.sid, ctx.uid, data.uid, data.month, data.expected_revision]);
    const root = db.collection('stations').doc(ctx.sid);
    const eventRef = root.collection('hr_hours_review_events').doc(eventId);
    const summaryRef = root.collection('hr_hours_reviews').doc(hash(['hr-review-summary-v1', data.uid, data.month]));
    const quotaRef = db.collection('hr_hours_review_actor_quotas').doc(hash(['hr-review-quota-v1', ctx.uid]));
    return db.runTransaction(async tx => {
      await live(tx, context);
      const target = await tx.get(root.collection('users').doc(data.uid));
      if (!target.exists) throw error('not-found', 'העובד אינו מופיע ברישומי התחנה.');
      let p;
      try { p = await binding(tx, new Map(), target, ctx); }
      catch (e) { if (e instanceof HrHoursInputError) throw error('failed-precondition', 'שיוך העובד דורש בדיקה.'); throw e; }
      const event = await tx.get(eventRef);
      let prior = null;
      if (event.exists) {
        prior = event.data();
        if (!validReview(prior) || prior.review_id !== eventId
            || prior.station_id !== ctx.sid || prior.actor_uid !== ctx.uid || prior.request_id !== data.request_id
            ) throw error('failed-precondition', 'רישום העיון אינו תקין.');
        if (prior.fingerprint !== fingerprint || prior.owner_uid !== data.uid || prior.month !== data.month
            || prior.reviewed_revision !== data.expected_revision || prior.employee_number !== p.employee_number) throw error('already-exists', 'מזהה הבקשה שייך לעיון אחר.');
      }
      const [report, rows] = await Promise.all([
        tx.get(root.collection('monthly_reports').doc(p.employee_number + '_' + data.month)),
        tx.get(root.collection('attendance').where('emp_number', '==', p.employee_number).where('month', '==', data.month).limit(32))
      ]);
      let revision = null;
      if (report.exists && rows.docs.length <= 31) {
        try {
          projectEmployeeHours({ month: data.month, employee: p, report: report.data(), attendance: rows.docs.map(s => s.data()) });
          const tuple = s => ({id:s.id,version:s.updateTime ? {seconds:s.updateTime.seconds,nanoseconds:s.updateTime.nanoseconds} : null});
          revision = createMonthRevision({stationId:ctx.sid,uid:p.uid,employeeNumber:p.employee_number,month:data.month,report:tuple(report),attendance:rows.docs.map(tuple)});
        } catch (e) { if (!(e instanceof TypeError) && !(e instanceof HrHoursInputError)) throw e; }
      }
      // Replays retain live authorization but never read or charge the quota.
      const quota = prior ? null : await tx.get(quotaRef);
      // Recheck current authority before either replay or mutation, before writes.
      await live(tx, context);
      if (prior) return {review_id:eventId,reviewed_revision:prior.reviewed_revision,current:revision === null ? null : revision === prior.reviewed_revision,duplicate:true};
      if (revision === null) throw error('failed-precondition', 'אין גרסת דוח תקינה לשמירת עיון.');
      if (revision !== data.expected_revision) throw error('aborted', 'הדוח השתנה. יש לרענן ולעיין בגרסה העדכנית.');
      const at = typeof clock === 'function' ? clock() : NaN;
      if (!Number.isSafeInteger(at) || at < 0 || !Number.isFinite(new Date(at).getTime())
          || !Number.isSafeInteger(at+86400000) || !Number.isFinite(new Date(at+86400000).getTime())) throw error('failed-precondition', 'שעון שמירת העיון אינו תקין.');
      const storedQuota = quota.exists ? quota.data() : {requests_at_ms:[]};
      if (!plain(storedQuota) || Object.keys(storedQuota).join(',') !== 'requests_at_ms'
          || !Array.isArray(storedQuota.requests_at_ms) || storedQuota.requests_at_ms.length > 10
          || storedQuota.requests_at_ms.some(v => !Number.isSafeInteger(v) || v < 0 || v > at)) throw error('failed-precondition', 'נתוני מכסת העיון אינם תקינים.');
      const recent = storedQuota.requests_at_ms.filter(v => v > at - 60000);
      if (recent.length >= 10) throw error('resource-exhausted', 'בוצעו שמירות עיון רבות. ניתן לנסות שוב בעוד זמן קצר.');
      const receipt = {schema:'hr-hours-review-v2',review_id:eventId,station_id:ctx.sid,actor_uid:ctx.uid,
        owner_uid:p.uid,employee_number:p.employee_number,month:data.month,request_id:data.request_id,
        fingerprint,reviewed_revision:revision,reviewed_at:serverTimestamp(),actor_auth_time:context.authTime,created_at_ms:at};
      tx.create(eventRef, receipt);
      tx.set(summaryRef, receipt);
      tx.set(quotaRef, {requests_at_ms:recent.concat(at)});
      // Intent only. Includes self-review, without changing other domains' policy.
      tx.create(root.collection('hr_hours_review_notification_jobs').doc(eventId), {
        schema:'hr-review-notification-v1',event_id:eventId,station_id:ctx.sid,actor_uid:ctx.uid,
        actor_auth_time:context.authTime,recipient_uid:p.uid,employee_number:p.employee_number,
        month:data.month,reviewed_revision:revision,created_at_ms:at,audience:'person',type:'report_reviewed',
        status:'policy_pending',delivery_status:'intent_only',send_now:false,consent_expires_at_ms:0,
        routine_after_quiet:true,exclude_actor:false
      });
      return {review_id:eventId,reviewed_revision:revision,current:true,duplicate:false};
    });
  }
  return Object.freeze({ listMonth, getEmployeeMonth, reviewEmployeeMonth });
}
module.exports = Object.freeze({ createHrHoursService, PAGE_SIZE });
