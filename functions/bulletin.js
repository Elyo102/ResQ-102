'use strict';

// Pure validation and idempotency helpers for the station bulletin board.
// This module deliberately has no Firebase dependency so the security-critical
// decisions can be tested with plain Node before a Functions deployment.

const crypto = require('crypto');

const MEMBER_ROLES = Object.freeze([
  'firefighter', 'deputy_team_leader', 'team_leader',
  'deputy', 'commander', 'station_commander', 'hr_coordinator'
]);

// הרשאה ייעודית ולא נגזרת מ"סגל": מפקד התחנה ורכזת משאבי
// אנוש הם סגל, אך אלדד ביקש את פעולות ההפצה והתגובה רק מראש
// המשמרת ומסגנו. מנהל-על נבדק בנפרד דרך identity.isSuper.
const SHIFT_COMMAND_ROLES = Object.freeze(['deputy', 'commander']);

const CATEGORIES = Object.freeze([
  'general', 'supplies', 'equipment', 'vehicle', 'maintenance'
]);

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 1000;
const REPLY_RATE_LIMIT = 10;
const BROADCAST_RATE_LIMIT = 2;
const MAX_BROADCAST_BOARDS = 100;
const MAX_REPLY_TEXT = 1000;

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

function parseBroadcastInput(data) {
  onlyKeys(data, ['category', 'text', 'requestId']);
  const category = stringField(data, 'category', 'סוג הודעה');
  if (CATEGORIES.indexOf(category) === -1) {
    fail('invalid-argument', 'סוג ההודעה אינו מוכר.');
  }
  const text = stringField(data, 'text', 'תוכן הודעה').normalize('NFC');
  if (!text) fail('invalid-argument', 'צריך לכתוב הודעה.');
  if (text.length > 2000) fail('invalid-argument', 'ההודעה ארוכה מדי.');
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) {
    fail('invalid-argument', 'ההודעה מכילה תווים שאינם נתמכים.');
  }
  const requestId = safeId(
    stringField(data, 'requestId', 'מזהה בקשה'),
    'מזהה הבקשה', 16, 128
  );
  return { category: category, text: text, requestId: requestId };
}

function parseReplyInput(data) {
  onlyKeys(data, ['subStationId', 'messageId', 'text', 'requestId']);
  const subStationId = safeId(
    stringField(data, 'subStationId', 'מזהה תחנת משנה'),
    'מזהה תחנת המשנה', 1, 64
  );
  const messageIdValue = safeId(
    stringField(data, 'messageId', 'מזהה הודעה'),
    'מזהה ההודעה', 1, 128
  );
  const text = stringField(data, 'text', 'תוכן תגובה').normalize('NFC');
  if (!text) fail('invalid-argument', 'צריך לכתוב תגובה.');
  if (text.length > MAX_REPLY_TEXT) fail('invalid-argument', 'התגובה ארוכה מדי.');
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) {
    fail('invalid-argument', 'התגובה מכילה תווים שאינם נתמכים.');
  }
  const requestId = safeId(
    stringField(data, 'requestId', 'מזהה בקשה'),
    'מזהה הבקשה', 16, 128
  );
  return {
    subStationId: subStationId,
    messageId: messageIdValue,
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

function parseHideReplyInput(data) {
  onlyKeys(data, ['sid', 'subStationId', 'messageId', 'replyId']);
  const base = parseHideInput({
    sid: data && data.sid,
    subStationId: data && data.subStationId,
    messageId: data && data.messageId
  });
  base.replyId = safeId(
    stringField(data, 'replyId', 'מזהה תגובה'),
    'מזהה התגובה', 1, 128
  );
  return base;
}

function hideTargetIds(subStationId, messageIdValue, message) {
  const selectedId = safeId(String(subStationId || ''),
    'מזהה תחנת המשנה', 1, 64);
  const selectedMessageId = safeId(String(messageIdValue || ''),
    'מזהה ההודעה', 1, 128);
  const source = plainObject(message) ? message : {};
  if (source.audience !== 'all_sub_stations') return [selectedId];
  if (String(source.broadcast_id || '') !== selectedMessageId) {
    fail('failed-precondition', 'מזהה ההפצה הרחבה אינו תקין.');
  }
  if (!Array.isArray(source.sub_station_ids) ||
      !source.sub_station_ids.length ||
      source.sub_station_ids.length > MAX_BROADCAST_BOARDS) {
    fail('failed-precondition', 'רשימת יעדי ההפצה הרחבה אינה תקינה.');
  }
  const ids = Array.from(new Set(source.sub_station_ids.map(function (value) {
    return safeId(String(value || ''), 'מזהה תחנת המשנה', 1, 64);
  }))).sort();
  if (ids.length !== source.sub_station_ids.length ||
      ids.indexOf(selectedId) === -1) {
    fail('failed-precondition', 'רשימת יעדי ההפצה הרחבה אינה עקבית.');
  }
  return ids;
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

function mayUseShiftCommandActions(identity) {
  return !!identity && (identity.isSuper === true ||
    SHIFT_COMMAND_ROLES.indexOf(identity.role) !== -1);
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

function broadcastRequestKey(uid, requestId) {
  return 'b_' + digest(['bulletin-broadcast-request-v1', uid, requestId]);
}

function replyRequestKey(uid, requestId) {
  return 'p_' + digest(['bulletin-reply-request-v1', uid, requestId]);
}

function messageId(uid, requestId) {
  return 'm_' + digest(['bulletin-message-v1', uid, requestId]);
}

function broadcastMessageId(uid, requestId) {
  return 'b_' + digest(['bulletin-broadcast-message-v1', uid, requestId]);
}

function replyId(uid, requestId) {
  return 'p_' + digest(['bulletin-reply-v1', uid, requestId]);
}

function contentHash(identity, input) {
  return digest([
    'bulletin-content-v1', identity.uid, identity.sid,
    input.subStationId, input.category, input.text
  ]);
}

function broadcastContentHash(identity, input, boardIds) {
  const targets = Array.from(Array.isArray(boardIds) ? boardIds : [])
    .map(String).sort();
  return digest([
    'bulletin-broadcast-content-v1', identity.uid, identity.sid,
    input.category, input.text, targets.join('\n')
  ]);
}

function replyContentHash(identity, input) {
  return digest([
    'bulletin-reply-content-v1', identity.uid, identity.sid,
    input.subStationId, input.messageId, input.text
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

function limitedRateDecision(current, nowMillis, limit, windowMillis) {
  const now = Number(nowMillis);
  if (!Number.isFinite(now) || now < 0) {
    fail('internal', 'חותמת הזמן של השרת אינה תקינה.');
  }

  const data = plainObject(current) ? current : {};
  const started = timestampMillis(data.window_started_at);
  const count = Math.max(0, Math.floor(Number(data.count || 0)));
  const safeLimit = Math.max(1, Math.floor(Number(limit || RATE_LIMIT)));
  const safeWindow = Math.max(1000, Math.floor(Number(windowMillis || RATE_WINDOW_MS)));
  const expired = !started || now < started || now - started >= safeWindow;

  if (expired) {
    return {
      allowed: true,
      count: 1,
      windowStartedMillis: now,
      retryAfterSeconds: 0
    };
  }

  if (count >= safeLimit) {
    return {
      allowed: false,
      count: count,
      windowStartedMillis: started,
      retryAfterSeconds: Math.max(1, Math.ceil((safeWindow - (now - started)) / 1000))
    };
  }

  return {
    allowed: true,
    count: count + 1,
    windowStartedMillis: started,
    retryAfterSeconds: 0
  };
}

function rateDecision(current, nowMillis) {
  return limitedRateDecision(current, nowMillis, RATE_LIMIT, RATE_WINDOW_MS);
}

function replyRateDecision(current, nowMillis) {
  return limitedRateDecision(current, nowMillis, REPLY_RATE_LIMIT, RATE_WINDOW_MS);
}

function broadcastRateDecision(current, nowMillis) {
  return limitedRateDecision(current, nowMillis, BROADCAST_RATE_LIMIT, RATE_WINDOW_MS);
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
  SHIFT_COMMAND_ROLES: SHIFT_COMMAND_ROLES,
  CATEGORIES: CATEGORIES,
  RATE_LIMIT: RATE_LIMIT,
  RATE_WINDOW_MS: RATE_WINDOW_MS,
  REPLY_RATE_LIMIT: REPLY_RATE_LIMIT,
  BROADCAST_RATE_LIMIT: BROADCAST_RATE_LIMIT,
  MAX_BROADCAST_BOARDS: MAX_BROADCAST_BOARDS,
  MAX_REPLY_TEXT: MAX_REPLY_TEXT,
  parsePostInput: parsePostInput,
  parseBroadcastInput: parseBroadcastInput,
  parseReplyInput: parseReplyInput,
  parseHideInput: parseHideInput,
  parseHideReplyInput: parseHideReplyInput,
  hideTargetIds: hideTargetIds,
  postingIdentity: postingIdentity,
  mayUseShiftCommandActions: mayUseShiftCommandActions,
  requestKey: requestKey,
  broadcastRequestKey: broadcastRequestKey,
  replyRequestKey: replyRequestKey,
  messageId: messageId,
  broadcastMessageId: broadcastMessageId,
  replyId: replyId,
  contentHash: contentHash,
  broadcastContentHash: broadcastContentHash,
  replyContentHash: replyContentHash,
  requestState: requestState,
  rateDecision: rateDecision,
  replyRateDecision: replyRateDecision,
  broadcastRateDecision: broadcastRateDecision,
  subStationAvailable: subStationAvailable
};
