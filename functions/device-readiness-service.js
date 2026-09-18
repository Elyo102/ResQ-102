'use strict';
/* מוכנות מכשיר — בדיקת התראה אישית לעובד מאושר.
 *
 * פעולה אישית יזומה: העובד שולח לעצמו בלבד, לטוקן של המכשיר שממנו
 * הוא לוחץ, ומאשר קבלה עם nonce חד-פעמי. אין כאן שידור תחנתי, אין
 * צליל חירום ואין ניסוח של קריאת פתע. לפי הכרעת המוצר (18.9.2026 §5)
 * הבדיקה עובדת גם כש-`runtime.silent` דולק — אבל גדר המשלוח התחנתית
 * (תחנה פעילה/מוכנה) נשמרת. המוכנות עצמה מחושבת בשרת בלבד.
 */

const TYPE = 'readiness_test';
const TAG = 'readiness-test';

function createDeviceReadinessService(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  for (const name of ['db', 'contract', 'fail', 'requireAuth', 'getAuthUser', 'sendToToken', 'deliveryFence',
    'openAudit', 'sealAudit', 'now', 'randomBytes', 'hash', 'dayKey', 'serverTimestamp']) {
    if (d[name] === undefined || d[name] === null) throw new TypeError('device readiness dependency is required: ' + name);
  }
  const { db, contract, fail, requireAuth, getAuthUser, sendToToken, deliveryFence, openAudit, sealAudit, now,
    randomBytes, hash, dayKey, serverTimestamp } = d;
  const auditEnabled = d.auditEnabled !== false;
  const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const dataOf = (snap) => (snap && snap.exists ? (snap.data() || null) : null);
  const readinessRef = (sid, uid) => db.doc('stations/' + sid + '/device_readiness/' + uid);
  const tokensRef = (sid, uid) => db.doc('stations/' + sid + '/push_tokens/' + uid);
  const liveUserRef = (sid, uid) => db.doc('stations/' + sid + '/users/' + uid);
  const registrantIndexRef = (uid) => db.doc('join_registrant_index/' + uid);

  function guard(fn) {
    try { return fn(); } catch (error) {
      if (error && error.name === 'JoinCampaignError') fail(error.httpCode || 'failed-precondition', error.message, error.code);
      throw error;
    }
  }

  /** עובד מאושר בלבד: claims מלאים + חבר פעיל בתחנה (מסמך חי). */
  async function approvedActor(req) {
    const signed = requireAuth(req);
    const claims = signed.token || {};
    const sid = String(claims.stationId || '');
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(sid) || !claims.role || claims.super === true) {
      fail('failed-precondition', 'בדיקת המכשיר זמינה לעובד מאושר בלבד.', 'readiness-not-approved');
    }
    const [current, live] = await Promise.all([getAuthUser(signed.uid), liveUserRef(sid, signed.uid).get().then(dataOf)]);
    if (!current || current.uid !== signed.uid || current.disabled !== false) fail('permission-denied', 'החשבון אינו פעיל.', 'readiness-account');
    const liveClaims = plain(current.customClaims) ? current.customClaims : {};
    if (liveClaims.stationId !== sid || !live || live.active !== true || live.is_active === false) {
      fail('failed-precondition', 'בדיקת המכשיר זמינה לעובד מאושר בלבד.', 'readiness-not-approved');
    }
    return Object.freeze({ uid: signed.uid, sid, email_verified: current.emailVerified === true, auth: signed });
  }

  function tokenOf(input) {
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    if (token.length < 20 || token.length > 4096) fail('invalid-argument', 'מזהה המכשיר אינו תקין.', 'readiness-token-shape');
    return token;
  }
  function tokenHashes(doc) {
    const list = Array.isArray(doc && doc.tokens) ? doc.tokens : [];
    return list.map((t) => (t && typeof t.token === 'string' && t.token.length >= 20) ? { token_hash: hash(t.token) } : null).filter(Boolean);
  }

  async function sendReadinessTestPush(req) {
    const actor = await approvedActor(req);
    const input = plain(req.data) ? req.data : {};
    const keys = Object.keys(input);
    if (keys.length !== 2 || keys.some((k) => ['request_id', 'token'].indexOf(k) === -1)) fail('invalid-argument', 'מתקבלים מזהה פעולה וטוקן בלבד.', 'input');
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(String(input.request_id || ''))) fail('invalid-argument', 'מזהה הפעולה אינו תקין.', 'request-id');
    const token = tokenOf(input);
    const tokenHash = hash(token);
    const nowMs = now();
    const fence = await deliveryFence.check({ stationId: actor.sid, globalSuppressed: false });
    if (!fence || fence.allowed !== true) fail('failed-precondition', 'התחנה אינה במצב שמאפשר משלוח התראות.', 'station-' + String((fence && fence.reason) || 'fence'));

    const nonce = Buffer.from(randomBytes(16)).toString('hex');
    const nonceHash = hash(nonce);
    const auditRef = auditEnabled ? await openAudit(actor.auth, 'readiness_test_sent', actor.uid, { station_id: actor.sid }) : null;
    await db.runTransaction(async (tx) => {
      const [tokens, device] = await Promise.all([tx.get(tokensRef(actor.sid, actor.uid)).then(dataOf), tx.get(readinessRef(actor.sid, actor.uid)).then(dataOf)]);
      if (!tokenHashes(tokens).some((t) => t.token_hash === tokenHash)) fail('failed-precondition', 'המכשיר הזה עדיין לא רשום להתראות. אשר התראות קודם.', 'readiness-token-unknown');
      if (device && device.request_id === input.request_id && device.challenge_hash) return; /* replay של אותה שליחה */
      const gate = guard(() => contract.readinessSendGate(device, nowMs, dayKey(nowMs)));
      tx.set(readinessRef(actor.sid, actor.uid), {
        schema: contract.READINESS_SCHEMA, uid: actor.uid, status: 'test_sent', token_hash: tokenHash,
        challenge_hash: nonceHash, challenge_expires_at_ms: nowMs + contract.READINESS_CHALLENGE_MS,
        test_sent_at_ms: nowMs, acked_at_ms: null, provider_error_code: null,
        attempts_today: gate.attempts_today, day_key: gate.day_key, last_attempt_at_ms: nowMs,
        request_id: input.request_id, revision: (device && Number.isInteger(device.revision) ? device.revision : 0) + 1,
        updated_at: serverTimestamp()
      }, { merge: true });
    });
    let messageId = '';
    try {
      messageId = await sendToToken({ token, data: {
        type: TYPE, title: 'בדיקת התראות ResQ', body: 'המכשיר מקבל התראות. פתח את ההודעה כדי לאשר.',
        url: './device-readiness.html?readiness_nonce=' + nonce, tag: TAG, important: '0', nonce
      } });
    } catch (error) {
      const code = String((error && error.code) || 'PROVIDER_ERROR').slice(0, 80);
      await readinessRef(actor.sid, actor.uid).set({ status: 'failed', provider_error_code: code, updated_at: serverTimestamp() }, { merge: true });
      if (auditRef) await sealAudit(auditRef, { outcome: 'failed', provider_error_code: code });
      fail('unavailable', 'ספק ההתראות לא קיבל את ההודעה. נסה שוב מאוחר יותר.', 'readiness-provider');
    }
    if (auditRef) await sealAudit(auditRef, { provider_message_id_hash: messageId ? hash(String(messageId)) : '' });
    return Object.freeze({ ok: true, status: 'test_sent', expires_at_ms: nowMs + contract.READINESS_CHALLENGE_MS });
  }

  async function ackReadinessTestPush(req) {
    const actor = await approvedActor(req);
    const input = plain(req.data) ? req.data : {};
    const keys = Object.keys(input);
    if (keys.length !== 2 || keys.some((k) => ['nonce', 'token'].indexOf(k) === -1)) fail('invalid-argument', 'מתקבלים קוד אישור וטוקן בלבד.', 'input');
    const nonce = String(input.nonce || '');
    if (!/^[a-f0-9]{32}$/.test(nonce)) fail('invalid-argument', 'קוד האישור אינו תקין.', 'readiness-nonce-shape');
    const token = tokenOf(input);
    const tokenHash = hash(token), nonceHash = hash(nonce);
    const nowMs = now();
    const result = await db.runTransaction(async (tx) => {
      const [tokens, device] = await Promise.all([tx.get(tokensRef(actor.sid, actor.uid)).then(dataOf), tx.get(readinessRef(actor.sid, actor.uid)).then(dataOf)]);
      const gate = guard(() => contract.readinessAckGate(device, nonceHash, tokenHash, nowMs));
      if (gate.already) return { ok: true, already: true, status: 'ready' };
      if (!tokenHashes(tokens).some((t) => t.token_hash === tokenHash)) fail('failed-precondition', 'הטוקן הוסר מהמכשיר; שלח בדיקה חדשה.', 'readiness-token-unknown');
      tx.set(readinessRef(actor.sid, actor.uid), { status: 'ready', acked_at_ms: nowMs, revision: (device.revision || 0) + 1, updated_at: serverTimestamp() }, { merge: true });
      return { ok: true, already: false, status: 'ready' };
    });
    if (auditEnabled && !result.already) {
      const ref = await openAudit(actor.auth, 'readiness_test_acked', actor.uid, { station_id: actor.sid });
      await sealAudit(ref, {});
    }
    return Object.freeze(result);
  }

  /** האובייקט המחושב. לא נשמר; כל קריאה מחשבת מחדש מהמסמכים החיים. */
  async function getMyReadiness(req) {
    const signed = requireAuth(req);
    const claims = signed.token || {};
    const sid = String(claims.stationId || '');
    const nowMs = now();
    const current = await getAuthUser(signed.uid);
    const emailVerified = !!(current && current.emailVerified === true);
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(sid) || !claims.role) {
      return contract.computeReadiness({ approved: false, email_verified: emailVerified, device: null, tokens: [], declarations: [], now_ms: nowMs });
    }
    const index = dataOf(await registrantIndexRef(signed.uid).get());
    const [live, tokens, device, registrant] = await Promise.all([
      liveUserRef(sid, signed.uid).get().then(dataOf),
      tokensRef(sid, signed.uid).get().then(dataOf),
      readinessRef(sid, signed.uid).get().then(dataOf),
      index ? db.doc('join_campaigns/' + index.campaign_id + '/registrants/' + signed.uid).get().then(dataOf) : Promise.resolve(null)
    ]);
    const approved = !!(live && live.active === true && live.is_active !== false);
    const declarations = registrant ? contract.promoteDeclarations(registrant).declarations : [];
    return contract.computeReadiness({ approved, email_verified: emailVerified, device, tokens: tokenHashes(tokens), declarations, now_ms: nowMs });
  }

  return Object.freeze({ sendReadinessTestPush, ackReadinessTestPush, getMyReadiness, TYPE, TAG });
}

module.exports = Object.freeze({ createDeviceReadinessService, TYPE, TAG });
