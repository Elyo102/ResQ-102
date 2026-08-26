'use strict';

// Pure validation and idempotency helpers for the station bulletin board.
// This module deliberately has no Firebase dependency so the security-critical
// decisions can be tested with plain Node before a Functions deployment.

const crypto = require('crypto');

const MEMBER_ROLES = Object.freeze([
  'firefighter', 'deputy_team_leader', 'team_leader',
  'deputy', 'commander', 'station_commander', 'hr_coordinator'
]);

const CATEGORIES = Object.freeze([
  'general', 'supplies', 'equipment', 'vehicle', 'maintenance'
]);

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 1000;

class BulletinError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BulletinError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new BulletinError(code, message);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(data, allowed) {
  if (!plainObject(data)) fail('invalid-argument', 'הבקשה אינה תקינה.');
  const extras = Object.keys(data).filter(function (key) {
    return allowed.indexOf(key) === -1;
  });
  if (extras.length) fail('invalid-argument', 'הבקשה מכילה שדות שאינם מותרים.');
}

function stringField(data, key, label) {
  if (typeof data[key] !== 'string') {
    fail('invalid-argument', 'חסר ' + label + ' תקין.');
  }
  return data[key].trim();
}

function safeId(value, label, min, max) {
  if (value.length < min || value.length > max ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    fail('invalid-argument', label + ' אינו תקין.');
  }
  return value;
}

function parsePostInput(data) {
  onlyKeys(data, ['subStationId', 'category', 'text', 'requestId']);

  const subStationId = safeId(
    stringField(data, 'subStationId', 'מזהה תחנת משנה'),
    'מזהה תחנת המשנה', 1, 64
  );
  const category = stringField(data, 'category', 'סוג הודעה');
  if (CATEGORIES.indexOf(category) === -1) {
    fail('invalid-argument', 'סוג ההודעה אינו מוכר.');
  }

  const rawText = stringField(data, 'text', 'תוכן הודעה');
  const text = rawText.normalize('NFC');
  if (!text) fail('invalid-argument', 'צריך לכתוב הודעה.');
  if (text.length > 2000) fail('invalid-argument', 'ההודעה ארוכה מדי.');
  // Keep line breaks and tabs, but reject invisible control bytes that can
  // corrupt rendering, logs, or copied incident records.
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) {
    fail('invalid-argument', 'ההודעה מכילה תווים שאינם נתמכים.');
  }

  const requestId = safeId(
    stringField(data, 'requestId', 'מזהה בקשה'),
    'מזהה הבקשה', 16, 128
  );

  return {
    subStationId: subStationId,
    category: category,
    text: text,
    requestId: requestId
  };
}

function parseHideInput(data) {
  onlyKeys(data, ['sid', 'subStationId', 'messageId']);
  return {
    sid: safeId(stringField(data, 'sid', 'מזהה תחנה'), 'מזהה התחנה', 1, 64),
    subStationId: safeId(
      stringField(data, 'subStationId', 'מזהה תחנת משנה'),
      'מזהה תחנת המשנה', 1, 64
    ),
    messageId: safeId(
      stringField(data, 'messageId', 'מזהה הודעה'),
      'מזהה ההודעה', 1, 128
    )
  };
}

function postingIdentity(auth, options) {
  if (!auth || typeof auth.uid !== 'string' || !auth.uid) {
    fail('unauthenticated', 'צריך להיות מחובר.');
  }
  const opts = plainObject(options) ? options : {};
  const trustedSuper = opts.isSuper === true;
  const token = plainObject(auth.token) ? auth.token : {};
  const uid = auth.uid.trim();
  const sid = String(token.stationId ||
    (trustedSuper ? opts.defaultStationId : '') || '').trim();
  let role = String(token.role || '').trim();
  const crew = String(token.shift || '').trim();

  // UIDs are used as Firestore document IDs elsewhere in ResQ too. Reject a
  // malformed value instead of letting it alter the document path.
  safeId(uid, 'מזהה המשתמש', 1, 128);
  if (MEMBER_ROLES.indexOf(role) === -1 && trustedSuper) role = 'super_admin';
  if (MEMBER_ROLES.indexOf(role) === -1 && !trustedSuper) {
    fail('permission-denied', 'רק חבר תחנה מאושר יכול לפרסם בלוח.');
  }
  safeId(sid, 'מזהה התחנה', 1, 64);
  if (crew.length > 16 || /[\x00-\x1F\x7F]/.test(crew)) {
    fail('failed-precondition', 'שיוך המשמרת בטוקן אינו תקין.');
  }

  return {
    uid: uid, sid: sid, role: role, crew: crew, isSuper: trustedSuper
  };
}

function digest(parts) {
  const hash = crypto.createHash('sha256');
  parts.forEach(function (part) {
    const value = String(part);
    hash.update(String(Buffer.byteLength(value, 'utf8')) + ':');
    hash.update(value, 'utf8');
  });
  return hash.digest('hex');
}

function requestKey(uid, requestId) {
  return 'r_' + digest(['bulletin-request-v1', uid, requestId]);
}

function messageId(uid, requestId) {
  return 'm_' + digest(['bulletin-message-v1', uid, requestId]);
}

function contentHash(identity, input) {
  return digest([
    'bulletin-content-v1', identity.uid, identity.sid,
    input.subStationId, input.category, input.text
  ]);
}

function requestState(receipt, expectedHash, expectedPath) {
  if (!receipt) return 'new';
  if (String(receipt.request_hash || '') !== expectedHash) return 'conflict';
  if (String(receipt.message_path || '') !== expectedPath) return 'conflict';
  return 'duplicate';
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') return Number(value.toMillis());
  if (value instanceof Date) return value.getTime();
  return Number(value || 0);
}

function rateDecision(current, nowMillis) {
  const now = Number(nowMillis);
  if (!Number.isFinite(now) || now < 0) {
    fail('internal', 'חותמת הזמן של השרת אינה תקינה.');
  }

  const data = plainObject(current) ? current : {};
  const started = timestampMillis(data.window_started_at);
  const count = Math.max(0, Math.floor(Number(data.count || 0)));
  const expired = !started || now < started || now - started >= RATE_WINDOW_MS;

  if (expired) {
    return {
      allowed: true,
      count: 1,
      windowStartedMillis: now,
      retryAfterSeconds: 0
    };
  }

  if (count >= RATE_LIMIT) {
    return {
      allowed: false,
      count: count,
      windowStartedMillis: started,
      retryAfterSeconds: Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - started)) / 1000))
    };
  }

  return {
    allowed: true,
    count: count + 1,
    windowStartedMillis: started,
    retryAfterSeconds: 0
  };
}

function subStationAvailable(data) {
  if (!plainObject(data)) return false;
  const state = String(data.status || '').toLowerCase();
  return data.is_active !== false && data.active !== false &&
         data.archived !== true && state !== 'inactive' && state !== 'archived';
}

module.exports = {
  BulletinError: BulletinError,
  MEMBER_ROLES: MEMBER_ROLES,
  CATEGORIES: CATEGORIES,
  RATE_LIMIT: RATE_LIMIT,
  RATE_WINDOW_MS: RATE_WINDOW_MS,
  parsePostInput: parsePostInput,
  parseHideInput: parseHideInput,
  postingIdentity: postingIdentity,
  requestKey: requestKey,
  messageId: messageId,
  contentHash: contentHash,
  requestState: requestState,
  rateDecision: rateDecision,
  subStationAvailable: subStationAvailable
};
