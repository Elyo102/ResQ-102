'use strict';

const crypto = require('crypto');

const REQUEST_RE = /^[A-Za-z0-9_-]{16,96}$/;
const LAB_SCHEMA = 'personal-live-lab-v2';

function digest(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function createPersonalLiveLab(deps) {
  if (!deps || typeof deps.freshActor !== 'function' ||
      typeof deps.readConfig !== 'function' || typeof deps.activate !== 'function' ||
      typeof deps.hasToken !== 'function' || typeof deps.isSilent !== 'function' ||
      typeof deps.assertStationDelivery !== 'function' ||
      typeof deps.reserve !== 'function' || typeof deps.sendExact !== 'function' ||
      typeof deps.finish !== 'function' || typeof deps.ack !== 'function' ||
      !deps.HttpsError) throw new TypeError('personal live lab dependencies are required');

  const HttpsError = deps.HttpsError;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;

  function fail(code, message) { throw new HttpsError(code, message); }

  async function actor(req) {
    const value = await deps.freshActor(req);
    if (!value || !value.uid || !value.sid || value.super !== true
        || value.personal_lab_control !== true
        || !Number.isSafeInteger(value.activation_auth_time_ms)
        || value.activation_auth_time_ms <= 0) {
      fail('permission-denied', 'המעבדה זמינה למנהל המערכת המאומת בלבד.');
    }
    return value;
  }

  async function assertActive(a) {
    const cfg = await deps.readConfig(a.sid);
    if (!cfg || cfg.schema !== LAB_SCHEMA || cfg.enabled !== true || cfg.allowed_uid !== a.uid ||
        !Number.isSafeInteger(Number(cfg.generation)) || Number(cfg.generation) < 1 ||
        !Number.isSafeInteger(Number(cfg.activation_auth_time_ms)) ||
        Number(cfg.activation_auth_time_ms) !== a.activation_auth_time_ms ||
        Number(cfg.expires_at_ms || 0) <= now()) {
      fail('failed-precondition', 'מעבדת המכשיר אינה פעילה לחשבון הזה.');
    }
    return cfg;
  }

  async function status(req) {
    const a = await actor(req);
    const cfg = await deps.readConfig(a.sid);
    const active = !!(cfg && cfg.schema === LAB_SCHEMA && cfg.enabled === true
      && cfg.allowed_uid === a.uid
      && Number.isSafeInteger(Number(cfg.generation)) && Number(cfg.generation) >= 1
      && Number.isSafeInteger(Number(cfg.activation_auth_time_ms))
      && Number(cfg.activation_auth_time_ms) === a.activation_auth_time_ms &&
      Number(cfg.expires_at_ms || 0) > now());
    return { active, expires_at_ms: active ? Number(cfg.expires_at_ms) : 0 };
  }

  async function enable(req) {
    const a = await actor(req);
    const expires = now() + 24 * 60 * 60 * 1000;
    await deps.activate(a.sid, a.uid, expires, now(), a.activation_auth_time_ms);
    return { active: true, expires_at_ms: expires };
  }

  async function send(req) {
    const data = (req && req.data) || {};
    const requestId = String(data.request_id || '').trim();
    const token = String(data.token || '').trim();
    if (!REQUEST_RE.test(requestId)) fail('invalid-argument', 'מזהה בדיקה אינו תקין.');
    if (token.length < 20 || token.length > 4096) fail('invalid-argument', 'מזהה המכשיר אינו תקין.');

    const a = await actor(req);
    const cfg = await assertActive(a);
    if (!(await deps.hasToken(a.sid, a.uid, token))) {
      fail('failed-precondition', 'המכשיר הנוכחי אינו רשום עוד לחשבון.');
    }
    if (await deps.isSilent(a.uid)) {
      fail('failed-precondition', 'מצב שקט פעיל; בדיקת הפוש לא תעקוף אותו.');
    }

    const fingerprint = digest([a.sid, a.uid, requestId, digest(token)].join('|'));
    await deps.assertStationDelivery({ sid: a.sid, uid: a.uid });
    const reserved = await deps.reserve({
      sid: a.sid, uid: a.uid, requestId, fingerprint, token_hash: digest(token), now_ms: now(),
      generation: Number(cfg.generation), activation_auth_time_ms: a.activation_auth_time_ms
    });
    if (reserved && reserved.duplicate && String(reserved.state || '') !== 'reserved') {
      return { probe_id: requestId, state: String(reserved.state || 'unknown'), duplicate: true };
    }

    const current = await actor(req);
    if (current.uid !== a.uid || current.sid !== a.sid) fail('permission-denied', 'זהות המעבדה השתנתה.');
    if (current.activation_auth_time_ms !== a.activation_auth_time_ms) {
      fail('permission-denied', 'הפעלת המעבדה השתנתה.');
    }
    const currentCfg = await assertActive(current);
    if (Number(currentCfg.generation) !== Number(cfg.generation)) {
      fail('failed-precondition', 'הפעלת המעבדה התחלפה לפני השליחה.');
    }
    if (!(await deps.hasToken(a.sid, a.uid, token))) {
      fail('failed-precondition', 'המכשיר הוסר לפני השליחה.');
    }
    if (await deps.isSilent(a.uid)) fail('failed-precondition', 'מצב שקט הופעל לפני השליחה.');

    // Auth is the last reversible fence before the provider boundary.  The
    // earlier check protects reservation; this one closes revocation that
    // happens while token/config/silent state is being re-read.
    const sendActor = await actor(req);
    if (sendActor.uid !== a.uid || sendActor.sid !== a.sid
        || sendActor.activation_auth_time_ms !== a.activation_auth_time_ms) {
      fail('permission-denied', 'זהות המעבדה השתנתה לפני השליחה.');
    }
    const sendCfg = await assertActive(sendActor);
    if (Number(sendCfg.generation) !== Number(cfg.generation)) {
      fail('failed-precondition', 'הפעלת המעבדה התחלפה לפני השליחה.');
    }
    // Known pre-provider policy/read failures must not become unknown delivery.
    // Keep the final fresh Auth check after this additional asynchronous read.
    await deps.assertStationDelivery({ sid: a.sid, uid: a.uid });
    const finalActor = await actor(req);
    if (finalActor.uid !== a.uid || finalActor.sid !== a.sid
        || finalActor.activation_auth_time_ms !== a.activation_auth_time_ms) {
      fail('permission-denied', 'הרשאת המעבדה השתנתה לפני השליחה.');
    }

    try {
      const messageId = await deps.sendExact({
        token,
        title: 'בדיקת ResQ אישית',
        body: 'בדיקת פוש למכשיר שלך בלבד. אין צורך לבצע פעולה מבצעית.',
        url: './alerts.html?lab_probe=' + encodeURIComponent(requestId),
        tag: 'personal_live_lab',
        probe_id: requestId
      });
      await deps.finish(a.sid, requestId, 'accepted', String(messageId || ''), now());
      return { probe_id: requestId, state: 'accepted', duplicate: false };
    } catch (error) {
      await deps.finish(a.sid, requestId, 'unknown', '', now());
      fail('unavailable', 'תוצאת השליחה אינה ידועה; הבדיקה לא תישלח שוב אוטומטית.');
    }
  }

  async function acknowledge(req) {
    const a = await actor(req);
    await assertActive(a);
    const data = (req && req.data) || {};
    const probeId = String(data.probe_id || '').trim();
    const stage = String(data.stage || '').trim();
    if (!REQUEST_RE.test(probeId) || ['foreground', 'opened'].indexOf(stage) === -1) {
      fail('invalid-argument', 'אישור הבדיקה אינו תקין.');
    }
    await deps.ack(a.sid, a.uid, probeId, stage, now());
    return { ok: true };
  }

  return { status, enable, send, acknowledge };
}

module.exports = { createPersonalLiveLab, digest };
