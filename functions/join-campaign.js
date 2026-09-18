'use strict';
/* קליטת עובדים בקישור קבוצתי — חוזה טהור (ללא Firebase, ללא UI).
 *
 * מגדיר את מסמך הקמפיין, את הטוקן שבקישור, את קלט המימוש, את רשומת
 * הנרשם, את הצהרות הכשירות ואת חישוב המוכנות. כל פונקציה כאן היא
 * דטרמיניסטית וניתנת לבדיקה ביחידה. הסוד של הקמפיין מיוצג כאן רק
 * כ-hash; הפונקציה היחידה שרואה סוד גולמי היא `newCampaignToken`,
 * והיא מחזירה אותו לקורא פעם אחת בלבד.
 */

const SCHEMA = 'join-campaign-v1';
const REGISTRANT_SCHEMA = 'join-registrant-v1';
const READINESS_SCHEMA = 'device-readiness-v1';
const DEFAULT_ROLE = 'firefighter';
const VALID_SHIFTS = Object.freeze(['A', 'B', 'C']);
const STATUSES = Object.freeze(['active', 'paused', 'revoked', 'expired', 'full']);
const DECLARATION_STATUSES = Object.freeze(['declared', 'pending_verification', 'verified', 'rejected', 'expired', 'superseded']);
const REVIEW_STATES = Object.freeze(['none', 'returned', 'reminded']);
const READINESS_STATUSES = Object.freeze(['not_started', 'token_registered', 'test_sent', 'ready', 'failed']);
const MAX_REGISTRATIONS = 500;
const MAX_CAMPAIGN_DAYS = 30;
const MAX_LABEL = 60;
const MAX_NOTE = 300;
const MAX_NAME = 160;
const MAX_PHONE = 40;
const MAX_REFERENCE = 80;
const MAX_DECLARATIONS = 20;
const MAX_REASON = 300;
const INSPECT_PER_HOUR = 300;
const READINESS_PER_DAY = 3;
const READINESS_COOLDOWN_MS = 60 * 1000;
const READINESS_CHALLENGE_MS = 10 * 60 * 1000;
const CAMPAIGN_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_RE = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,100}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const STATION_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;
const SECRET_FIELDS = Object.freeze(['secret', 'token', 'raw_token', 'campaign_token']);

class JoinCampaignError extends Error {
  constructor(code, message, httpCode) {
    super(message);
    this.name = 'JoinCampaignError';
    this.code = code;
    this.httpCode = httpCode || 'failed-precondition';
  }
}
function fail(code, message, httpCode) { throw new JoinCampaignError(code, message, httpCode); }

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (o, k) => plain(o) && Object.prototype.hasOwnProperty.call(o, k);
function exactKeys(value, keys, optional) {
  if (!plain(value)) return false;
  const opt = Array.isArray(optional) ? optional : [];
  return keys.every((k) => own(value, k)) && Object.keys(value).every((k) => keys.includes(k) || opt.includes(k));
}
function text(value, max, code, label) {
  if (typeof value !== 'string') fail(code, label + ' חסר.', 'invalid-argument');
  const out = value.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!out || out.length > max) fail(code, label + ' אינו תקין.', 'invalid-argument');
  return out;
}
function optionalText(value, max, code, label) {
  if (value === undefined || value === null || value === '') return '';
  return text(value, max, code, label);
}
function toMillis(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.seconds === 'number') return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  return NaN;
}
function base64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function assertNoSecret(doc, where) {
  const walk = (v, depth) => {
    if (depth > 6 || !v || typeof v !== 'object') return;
    for (const k of Object.keys(v)) {
      if (SECRET_FIELDS.includes(k)) fail('secret-leak', 'סוד גולמי הגיע ל' + where + ': ' + k, 'internal');
      walk(v[k], depth + 1);
    }
  };
  walk(doc, 0);
}

/* ---------- טוקן ---------- */

/** מייצר קמפיין חדש. הסוד חוזר פעם אחת — לקורא בלבד. */
function newCampaignToken(deps) {
  if (!deps || typeof deps.randomBytes !== 'function' || typeof deps.hash !== 'function') {
    throw new TypeError('randomBytes and hash are required');
  }
  const campaignId = base64url(deps.randomBytes(12));
  const secret = base64url(deps.randomBytes(32));
  if (!CAMPAIGN_ID_RE.test(campaignId) || !SECRET_RE.test(secret)) fail('random', 'פלט אקראי קצר מדי.', 'internal');
  const tokenHash = deps.hash(secret);
  if (!HEX64_RE.test(tokenHash)) fail('hash', 'פונקציית הגיבוב אינה מחזירה sha256 hex.', 'internal');
  return Object.freeze({ campaign_id: campaignId, secret, token: campaignId + '.' + secret, token_hash: tokenHash });
}

/** מפרק טוקן מהקישור. null אם הצורה אינה תקינה (אין הבדל בין "לא קיים" ל"לא תקין" כלפי הלקוח). */
function parseToken(token) {
  if (typeof token !== 'string' || token.length !== 60) return null;
  const m = TOKEN_RE.exec(token);
  return m ? Object.freeze({ campaign_id: m[1], secret: m[2] }) : null;
}

/** השוואת סוד מול hash שמור — בזמן קבוע דרך timingSafeEqual המוזרק. */
function tokenMatches(secret, campaign, deps) {
  if (!SECRET_RE.test(String(secret || '')) || !plain(campaign) || !HEX64_RE.test(String(campaign.token_hash || ''))) return false;
  const a = Buffer.from(deps.hash(secret), 'utf8');
  const b = Buffer.from(campaign.token_hash, 'utf8');
  return a.length === b.length && deps.timingSafeEqual(a, b);
}

/* ---------- קמפיין ---------- */

function normalizeShifts(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > VALID_SHIFTS.length) fail('shifts', 'יש לבחור לפחות משמרת אחת.', 'invalid-argument');
  const out = [];
  raw.forEach((s) => {
    if (VALID_SHIFTS.indexOf(s) === -1 || out.indexOf(s) !== -1) fail('shifts', 'משמרת אינה תקינה או כפולה.', 'invalid-argument');
    out.push(s);
  });
  return VALID_SHIFTS.filter((s) => out.indexOf(s) !== -1);
}

/** קלט יצירה. `station_id` מותר רק ל-super; לרכזת התחנה נקבעת מהשרת. */
function normalizeCreateInput(input, ctx) {
  if (!ctx || typeof ctx.now_ms !== 'number') throw new TypeError('ctx.now_ms is required');
  const keys = ['label', 'allowed_shifts', 'max_registrations', 'expires_at_ms'];
  if (!exactKeys(input, keys, ctx.is_super ? ['station_id'] : [])) {
    fail('input', ctx.is_super ? 'מתקבלים תווית, משמרות, מכסה, תפוגה ותחנה בלבד.'
      : 'התחנה נקבעת לפי ההרשאות של החשבון ואינה נשלחת מהלקוח.', 'invalid-argument');
  }
  const label = text(input.label, MAX_LABEL, 'label', 'תווית הקמפיין');
  const allowedShifts = normalizeShifts(input.allowed_shifts);
  const max = input.max_registrations;
  if (!Number.isInteger(max) || max < 1 || max > MAX_REGISTRATIONS) fail('max', 'המכסה חייבת להיות בין 1 ל-' + MAX_REGISTRATIONS + '.', 'invalid-argument');
  const expires = input.expires_at_ms;
  if (!Number.isSafeInteger(expires) || expires <= ctx.now_ms + 60 * 1000) fail('expires', 'מועד התפוגה חייב להיות בעתיד.', 'invalid-argument');
  if (expires > ctx.now_ms + MAX_CAMPAIGN_DAYS * 24 * 3600 * 1000) fail('expires', 'קמפיין תקף עד ' + MAX_CAMPAIGN_DAYS + ' יום.', 'invalid-argument');
  let stationId = '';
  if (ctx.is_super) {
    stationId = typeof input.station_id === 'string' ? input.station_id.trim() : '';
    if (!STATION_RE.test(stationId)) fail('station', 'מזהה התחנה חסר או אינו תקין.', 'invalid-argument');
  }
  return Object.freeze({ label, allowed_shifts: allowedShifts, max_registrations: max, expires_at_ms: expires, station_id: stationId });
}

/** בונה את מסמך הקמפיין. אין בו סוד. */
function buildCampaignDoc(created, actor, station, tokenHash, nowMs) {
  if (!plain(actor) || !UID_RE.test(String(actor.uid || '')) || ['super', 'hr_coordinator'].indexOf(actor.role) === -1) {
    fail('actor', 'יוצר הקמפיין אינו תקין.', 'internal');
  }
  if (!plain(station) || !STATION_RE.test(String(station.station_id || '')) || !station.district_id) fail('station', 'התחנה אינה תקינה.', 'internal');
  if (!HEX64_RE.test(String(tokenHash || ''))) fail('hash', 'hash הטוקן אינו תקין.', 'internal');
  const doc = {
    schema: SCHEMA,
    campaign_id: created.campaign_id,
    token_hash: tokenHash,
    station_id: station.station_id,
    district_id: station.district_id,
    created_by: actor.uid,
    created_by_role: actor.role,
    default_role: DEFAULT_ROLE,
    allowed_shifts: created.allowed_shifts.slice(),
    max_registrations: created.max_registrations,
    accepted_count: 0,
    status: 'active',
    expires_at_ms: created.expires_at_ms,
    label: created.label,
    revision: 1,
    created_at_ms: nowMs,
    updated_at_ms: nowMs
  };
  assertNoSecret(doc, 'מסמך הקמפיין');
  return doc;
}

/** המצב האפקטיבי — נגזר, לא סומכים על השדה השמור בלבד. */
function deriveState(campaign, nowMs) {
  if (!plain(campaign) || campaign.schema !== SCHEMA) return 'not_found';
  if (campaign.status === 'revoked') return 'revoked';
  if (!Number.isSafeInteger(campaign.expires_at_ms) || campaign.expires_at_ms <= nowMs) return 'expired';
  if (!Number.isInteger(campaign.accepted_count) || !Number.isInteger(campaign.max_registrations)
      || campaign.accepted_count >= campaign.max_registrations) return 'full';
  if (campaign.status === 'paused') return 'paused';
  if (campaign.status !== 'active') return 'revoked';
  return 'active';
}

/** מה שעובד רואה לפני שנרשם. ללא מונים, ללא תווית, ללא מזהי אנשים. */
function publicView(campaign, nowMs, stationName, catalog) {
  const state = deriveState(campaign, nowMs);
  if (state === 'not_found') return Object.freeze({ state });
  const quals = (Array.isArray(catalog) ? catalog : []).filter((q) => q && q.active !== false)
    .map((q) => Object.freeze({ key: q.key, label: q.label }));
  return Object.freeze({
    state,
    station_name: String(stationName || campaign.station_id || ''),
    allowed_shifts: state === 'active' ? campaign.allowed_shifts.slice() : [],
    qualification_catalog: state === 'active' ? quals : []
  });
}

/** מעבר סטטוס ניהולי. revoke בלתי הפיך; resume רק מ-paused. */
function applyStatusAction(campaign, action, expectedRevision, nowMs) {
  if (!plain(campaign) || campaign.schema !== SCHEMA) fail('campaign-missing', 'הקמפיין אינו קיים.', 'not-found');
  if (!Number.isInteger(expectedRevision) || expectedRevision !== campaign.revision) fail('revision', 'הקמפיין השתנה בינתיים. רענן ונסה שוב.', 'aborted');
  if (campaign.status === 'revoked') fail('campaign-revoked', 'קמפיין שבוטל אינו ניתן לשינוי.');
  let status;
  if (action === 'pause') { if (campaign.status !== 'active') fail('transition', 'אפשר להשהות רק קמפיין פעיל.'); status = 'paused'; }
  else if (action === 'resume') { if (campaign.status !== 'paused') fail('transition', 'אפשר לחדש רק קמפיין מושהה.'); status = 'active'; }
  else if (action === 'revoke') status = 'revoked';
  else fail('action', 'פעולה אינה מוכרת.', 'invalid-argument');
  return Object.freeze({ status, revision: campaign.revision + 1, updated_at_ms: nowMs });
}

/** תצוגה למנהל — ללא hash. */
function adminView(campaign, nowMs) {
  const c = campaign;
  return Object.freeze({
    campaign_id: c.campaign_id, station_id: c.station_id, district_id: c.district_id,
    label: c.label, allowed_shifts: c.allowed_shifts.slice(), max_registrations: c.max_registrations,
    accepted_count: c.accepted_count, status: c.status, state: deriveState(c, nowMs),
    expires_at_ms: c.expires_at_ms, revision: c.revision, created_by_role: c.created_by_role,
    created_at_ms: c.created_at_ms, updated_at_ms: c.updated_at_ms
  });
}

/* ---------- מימוש ---------- */

const REDEEM_KEYS = Object.freeze(['request_id', 'token', 'full_name', 'phone', 'shift', 'qualifications', 'ack']);
const REDEEM_OPTIONAL = Object.freeze(['note']);
const REDEEM_FORBIDDEN = Object.freeze(['role', 'station_id', 'stationId', 'district_id', 'districtId', 'invite_id',
  'secret', 'source', 'uid', 'email', 'plan', 'invite', 'assignment_ref', 'campaign_id']);

function normalizeDeclarations(raw, catalog, nowMs) {
  if (!Array.isArray(raw)) fail('qualifications', 'רשימת הכשירויות אינה מערך.', 'invalid-argument');
  if (raw.length > MAX_DECLARATIONS) fail('qualifications', 'יותר מדי כשירויות (עד ' + MAX_DECLARATIONS + ').', 'invalid-argument');
  const known = new Map((Array.isArray(catalog) ? catalog : []).filter((q) => q && q.active !== false).map((q) => [q.key, q]));
  const seen = new Set();
  return raw.map((item) => {
    if (!exactKeys(item, ['key'], ['valid_until_ms', 'reference'])) fail('qualification-shape', 'הצהרת כשירות אינה תקינה.', 'invalid-argument');
    const key = String(item.key || '');
    if (!KEY_RE.test(key) || !known.has(key)) fail('qualification-unknown', 'כשירות לא מוכרת בתחנה.', 'invalid-argument');
    if (seen.has(key)) fail('qualification-duplicate', 'כשירות כפולה.', 'invalid-argument');
    seen.add(key);
    let validUntil = null;
    if (item.valid_until_ms !== undefined && item.valid_until_ms !== null) {
      if (!Number.isSafeInteger(item.valid_until_ms) || item.valid_until_ms <= nowMs) fail('qualification-expired', 'תוקף הכשירות חייב להיות בעתיד.', 'invalid-argument');
      validUntil = item.valid_until_ms;
    }
    const reference = optionalText(item.reference, MAX_REFERENCE, 'qualification-reference', 'אסמכתא');
    return Object.freeze({ key, declared_at_ms: nowMs, valid_until_ms: validUntil, reference: reference || null,
      status: 'declared', verified_by: null, verified_at_ms: null, reject_reason: null, revision: 1 });
  });
}

function normalizeAck(raw) {
  if (!exactKeys(raw, ['correctness', 'terms_version', 'privacy_version'])) fail('ack', 'חסר אישור נכונות הפרטים ותנאי השימוש.', 'invalid-argument');
  if (raw.correctness !== true) fail('ack', 'יש לאשר את נכונות הפרטים.', 'invalid-argument');
  const terms = String(raw.terms_version || ''), privacy = String(raw.privacy_version || '');
  if (!VERSION_RE.test(terms) || !VERSION_RE.test(privacy)) fail('ack', 'גרסת תנאי השימוש חסרה.', 'invalid-argument');
  return Object.freeze({ correctness: true, terms_version: terms, privacy_version: privacy });
}

/** קלט המימוש. מפתחות מדויקים; כל שדה שיוך נדחה בשמו. */
function normalizeRedemptionInput(input, campaign, catalog, nowMs) {
  if (!plain(input)) fail('input', 'קלט חסר.', 'invalid-argument');
  for (const k of REDEEM_FORBIDDEN) {
    if (own(input, k)) fail('client-supplied-plan', 'השדה ' + k + ' נקבע בשרת ואינו מתקבל מהקורא.', 'invalid-argument');
  }
  if (!exactKeys(input, REDEEM_KEYS, REDEEM_OPTIONAL)) fail('input', 'מתקבלים מזהה פעולה, טוקן, שם, טלפון, משמרת, כשירויות ואישור בלבד.', 'invalid-argument');
  const requestId = typeof input.request_id === 'string' ? input.request_id : '';
  if (!REQUEST_ID_RE.test(requestId)) fail('request-id', 'מזהה הפעולה אינו תקין.', 'invalid-argument');
  const parsed = parseToken(input.token);
  if (!parsed) fail('campaign-token', 'הקישור אינו תקין.', 'invalid-argument');
  const fullName = text(input.full_name, MAX_NAME, 'full-name', 'שם מלא');
  const phone = text(input.phone, MAX_PHONE, 'phone', 'טלפון');
  if (!/^[+0-9][0-9 -]{6,}$/.test(phone)) fail('phone', 'מספר הטלפון אינו תקין.', 'invalid-argument');
  const shift = typeof input.shift === 'string' ? input.shift : '';
  if (!plain(campaign) || !Array.isArray(campaign.allowed_shifts) || campaign.allowed_shifts.indexOf(shift) === -1) {
    fail('shift', 'המשמרת אינה מוצעת בקישור הזה.', 'invalid-argument');
  }
  const declarations = normalizeDeclarations(input.qualifications, catalog, nowMs);
  const note = optionalText(input.note, MAX_NOTE, 'note', 'הערה');
  const ack = normalizeAck(input.ack);
  return Object.freeze({ request_id: requestId, campaign_id: parsed.campaign_id, secret: parsed.secret,
    full_name: fullName, phone, shift, declarations, note, ack });
}

/** רשומת הנרשם. ללא סוד, ללא hash, ללא תפקיד. */
function buildRegistrant(params) {
  const p = params || {};
  if (!UID_RE.test(String(p.uid || '')) || !REQUEST_ID_RE.test(String(p.request_id || ''))
      || !CAMPAIGN_ID_RE.test(String(p.campaign_id || '')) || !STATION_RE.test(String(p.station_id || ''))
      || !UID_RE.test(String(p.invite_id || '')) || VALID_SHIFTS.indexOf(p.shift) === -1
      || !Array.isArray(p.declarations) || !plain(p.ack) || typeof p.now_ms !== 'number') {
    fail('registrant', 'רשומת הנרשם חסרה שדות.', 'internal');
  }
  const doc = {
    schema: REGISTRANT_SCHEMA,
    uid: p.uid, campaign_id: p.campaign_id, campaign_revision: Number.isInteger(p.campaign_revision) ? p.campaign_revision : 0,
    station_id: p.station_id, request_id: p.request_id, invite_id: p.invite_id, shift: p.shift,
    note: String(p.note || ''),
    ack: { correctness: true, terms_version: p.ack.terms_version, privacy_version: p.ack.privacy_version, at_ms: p.now_ms },
    declarations: p.declarations.map((d) => Object.assign({}, d)),
    review_state: 'none', review_note: '', review_at_ms: null,
    revision: 1, created_at_ms: p.now_ms, updated_at_ms: p.now_ms
  };
  assertNoSecret(doc, 'רשומת הנרשם');
  return doc;
}

/** תנאי replay במסלול הקמפיין (ללא סוד): כל הראיות מהמסמכים השמורים בלבד. */
function replayMatches(params) {
  const { operation, registry, invite, uid, request_id: requestId, campaign, stages, verifyStoredFingerprint } = params;
  if (!plain(operation) || !plain(registry) || !plain(invite) || !plain(campaign)) return false;
  if (typeof verifyStoredFingerprint !== 'function' || !Array.isArray(stages)) return false;
  const prov = operation.provenance;
  if (operation.schema_version !== 1 || operation.uid !== uid || operation.request_id !== requestId
      || operation.station_id !== campaign.station_id || stages.indexOf(operation.stage) === -1
      || !plain(prov) || prov.kind !== 'join_campaign' || prov.campaign_id !== campaign.campaign_id) return false;
  const expected = { schema_version: 1, uid, station_id: operation.station_id, request_id: requestId,
    invite_id: operation.invite_id, operation_fingerprint: operation.operation_fingerprint };
  const rk = Object.keys(registry);
  if (rk.length !== 6 || Object.keys(expected).some((k) => registry[k] !== expected[k])) return false;
  if (invite.invite_id !== operation.invite_id || invite.redeemed_by !== uid || invite.redeemed_request_id !== requestId) return false;
  const link = operation.assignment_ref;
  if (!plain(link) || !HEX64_RE.test(String(link.invite_fingerprint || ''))) return false;
  try { verifyStoredFingerprint(invite, link.invite_fingerprint); } catch (ignore) { return false; }
  return true;
}

/* ---------- ביקורת נרשם ---------- */

function normalizeReviewAction(input) {
  if (!exactKeys(input, ['campaign_id', 'uid', 'action', 'expected_revision'], ['reason'])) fail('input', 'קלט הביקורת אינו תקין.', 'invalid-argument');
  if (!CAMPAIGN_ID_RE.test(String(input.campaign_id || '')) || !UID_RE.test(String(input.uid || ''))) fail('input', 'מזהה חסר.', 'invalid-argument');
  if (['return', 'remind', 'clear', 'reject_note'].indexOf(input.action) === -1) fail('action', 'פעולה אינה מוכרת.', 'invalid-argument');
  if (!Number.isInteger(input.expected_revision)) fail('revision', 'גרסה חסרה.', 'invalid-argument');
  const reason = input.action === 'return' || input.action === 'reject_note' ? text(input.reason, MAX_REASON, 'reason', 'נימוק') : optionalText(input.reason, MAX_REASON, 'reason', 'נימוק');
  return Object.freeze({ campaign_id: input.campaign_id, uid: input.uid, action: input.action, expected_revision: input.expected_revision, reason });
}

function applyReviewAction(registrant, action, expectedRevision, reason, nowMs) {
  if (!plain(registrant) || registrant.schema !== REGISTRANT_SCHEMA) fail('registrant-missing', 'הנרשם אינו קיים.', 'not-found');
  if (registrant.revision !== expectedRevision) fail('revision', 'הרשומה השתנתה בינתיים. רענן ונסה שוב.', 'aborted');
  /* reject_note — נימוק הדחייה נשמר על הנרשם לפני הקריאה ל-rejectRegistration הקיים (שאינו מקבל נימוק). */
  if (action === 'reject_note') {
    return Object.freeze({ reject_reason: reason, reject_noted_at_ms: nowMs, revision: registrant.revision + 1, updated_at_ms: nowMs });
  }
  const state = action === 'return' ? 'returned' : action === 'remind' ? 'reminded' : 'none';
  return Object.freeze({ review_state: state, review_note: action === 'clear' ? '' : reason, review_at_ms: nowMs, revision: registrant.revision + 1, updated_at_ms: nowMs });
}

/* ---------- אימות כשירות ---------- */

function normalizeVerifyInput(input) {
  if (!exactKeys(input, ['campaign_id', 'uid', 'key', 'action', 'expected_revision', 'request_id'], ['reason'])) {
    fail('input', 'קלט האימות אינו תקין.', 'invalid-argument');
  }
  if (!CAMPAIGN_ID_RE.test(String(input.campaign_id || '')) || !UID_RE.test(String(input.uid || ''))
      || !KEY_RE.test(String(input.key || '')) || !REQUEST_ID_RE.test(String(input.request_id || ''))) fail('input', 'מזהה חסר.', 'invalid-argument');
  if (['verify', 'reject'].indexOf(input.action) === -1) fail('action', 'פעולה אינה מוכרת.', 'invalid-argument');
  if (!Number.isInteger(input.expected_revision)) fail('revision', 'גרסה חסרה.', 'invalid-argument');
  const reason = input.action === 'reject' ? text(input.reason, MAX_REASON, 'reason', 'נימוק הדחייה') : '';
  if (input.action === 'reject' && reason.length < 3) fail('reason', 'נימוק הדחייה קצר מדי.', 'invalid-argument');
  return Object.freeze({ campaign_id: input.campaign_id, uid: input.uid, key: input.key, action: input.action,
    expected_revision: input.expected_revision, request_id: input.request_id, reason });
}

/** סטטוס אפקטיבי של הצהרה — תוקף שפג נגזר, לא נכתב ע"י הלקוח. */
function effectiveDeclarationStatus(decl, nowMs) {
  if (!plain(decl)) return 'rejected';
  if (decl.status === 'verified' && Number.isSafeInteger(decl.valid_until_ms) && decl.valid_until_ms <= nowMs) return 'expired';
  return DECLARATION_STATUSES.indexOf(decl.status) === -1 ? 'rejected' : decl.status;
}

/** מכין את הצהרה לאימות/דחייה. verify מותר רק מ-pending_verification ובתוקף. */
function planDeclarationUpdate(registrant, verify, nowMs, actorUid) {
  if (!plain(registrant) || registrant.schema !== REGISTRANT_SCHEMA) fail('registrant-missing', 'הנרשם אינו קיים.', 'not-found');
  if (registrant.revision !== verify.expected_revision) fail('revision', 'הרשומה השתנתה בינתיים. רענן ונסה שוב.', 'aborted');
  const list = Array.isArray(registrant.declarations) ? registrant.declarations : [];
  const index = list.findIndex((d) => plain(d) && d.key === verify.key && ['pending_verification', 'declared'].indexOf(d.status) !== -1);
  if (index === -1) fail('declaration-missing', 'אין הצהרה ממתינה לכשירות הזו.', 'not-found');
  const decl = list[index];
  if (verify.action === 'verify') {
    if (decl.status !== 'pending_verification') fail('declaration-not-pending', 'ההצהרה עדיין לא הועברה לאימות (העובד טרם אושר).');
    if (Number.isSafeInteger(decl.valid_until_ms) && decl.valid_until_ms <= nowMs) fail('declaration-expired', 'תוקף הכשירות פג; אין לאמת.');
  }
  const next = list.map((d, i) => i === index
    ? Object.assign({}, d, verify.action === 'verify'
      ? { status: 'verified', verified_by: actorUid, verified_at_ms: nowMs, reject_reason: null, revision: (d.revision || 0) + 1 }
      : { status: 'rejected', verified_by: actorUid, verified_at_ms: nowMs, reject_reason: verify.reason, revision: (d.revision || 0) + 1 })
    : d);
  return Object.freeze({ declarations: next, revision: registrant.revision + 1, updated_at_ms: nowMs, key: decl.key });
}

/** מעביר הצהרות declared → pending_verification (אחרי אישור החשבון). */
function promoteDeclarations(registrant) {
  const list = Array.isArray(registrant && registrant.declarations) ? registrant.declarations : [];
  let changed = false;
  const next = list.map((d) => {
    if (plain(d) && d.status === 'declared') { changed = true; return Object.assign({}, d, { status: 'pending_verification' }); }
    return d;
  });
  return Object.freeze({ changed, declarations: next });
}

/* ---------- מוכנות ---------- */

function summarizeDeclarations(declarations, nowMs) {
  const out = { verified: 0, pending: 0, rejected: 0, expired: 0, declared: 0 };
  (Array.isArray(declarations) ? declarations : []).forEach((d) => {
    const s = effectiveDeclarationStatus(d, nowMs);
    if (s === 'verified') out.verified++;
    else if (s === 'pending_verification') out.pending++;
    else if (s === 'rejected') out.rejected++;
    else if (s === 'expired') out.expired++;
    else if (s === 'declared') out.declared++;
  });
  return Object.freeze(out);
}

/** אובייקט המוכנות — מחושב בשרת בלבד. */
function computeReadiness(params) {
  const p = params || {};
  const nowMs = typeof p.now_ms === 'number' ? p.now_ms : Date.now();
  const device = plain(p.device) ? p.device : null;
  const tokens = Array.isArray(p.tokens) ? p.tokens : [];
  const hashes = tokens.map((t) => t && t.token_hash).filter((h) => HEX64_RE.test(String(h || '')));
  const tokenPresent = hashes.length > 0;
  const status = device && READINESS_STATUSES.indexOf(device.status) !== -1 ? device.status : 'not_started';
  const tokenFresh = !!(device && HEX64_RE.test(String(device.token_hash || '')) && hashes.indexOf(device.token_hash) !== -1);
  const blockers = [];
  if (p.approved !== true) blockers.push('account_not_approved');
  if (p.email_verified !== true) blockers.push('email_not_verified');
  if (!tokenPresent) blockers.push('no_push_token');
  if (status !== 'ready') blockers.push('device_not_ready');
  else if (!tokenFresh) blockers.push('push_token_changed');
  const quals = summarizeDeclarations(p.declarations, nowMs);
  /* כשירות שהעובד הצהיר עליה ועדיין לא אומתה — או שפג תוקפה — חוסמת מוכנות.
   * הצהרה שנדחתה אינה חוסמת: היא פשוט אינה החזקה. */
  if (quals.pending + quals.declared > 0) blockers.push('qualifications_unverified');
  if (quals.expired > 0) blockers.push('qualifications_expired');
  return Object.freeze({
    schema: READINESS_SCHEMA,
    operational_ready: blockers.length === 0,
    blockers: Object.freeze(blockers),
    account: Object.freeze({ approved: p.approved === true, email_verified: p.email_verified === true }),
    device: Object.freeze({ status, token_present: tokenPresent, token_fresh: tokenFresh,
      test_sent_at_ms: device && Number.isSafeInteger(device.test_sent_at_ms) ? device.test_sent_at_ms : null,
      acked_at_ms: device && Number.isSafeInteger(device.acked_at_ms) ? device.acked_at_ms : null,
      attempts_today: device && Number.isInteger(device.attempts_today) ? device.attempts_today : 0 }),
    qualifications: quals,
    ready_at_ms: status === 'ready' && tokenFresh && device && Number.isSafeInteger(device.acked_at_ms) ? device.acked_at_ms : null
  });
}

/** החלטת שליחה אידמפוטנטית: אותו request_id שכבר נשלח (ולא נכשל אצל הספק)
 *  אינו שולח שוב ואינו מחליף את קוד האישור — התשובה שאבדה משוחזרת מהמסמך. */
function readinessSendDecision(device, requestId, tokenHash, nowMs, dayKey) {
  const d = plain(device) ? device : null;
  if (d && d.request_id === requestId && HEX64_RE.test(String(d.challenge_hash || '')) && d.status !== 'failed') {
    /* אותו מזהה פעולה עם כוונה אחרת (מכשיר/טוקן אחר) אינו replay — הוא התנגשות. */
    if (d.token_hash !== tokenHash) fail('request-conflict', 'אותו מזהה פעולה כבר שימש לבדיקה במכשיר אחר.', 'already-exists');
    return Object.freeze({ replay: true, status: d.status, expires_at_ms: Number.isSafeInteger(d.challenge_expires_at_ms) ? d.challenge_expires_at_ms : 0 });
  }
  return Object.freeze(Object.assign({ replay: false }, readinessSendGate(d, nowMs, dayKey)));
}

/** האם מותר לשלוח בדיקה עכשיו — מכסה יומית ו-cooldown. */
function readinessSendGate(device, nowMs, dayKey) {
  const d = plain(device) ? device : {};
  const sameDay = d.day_key === dayKey;
  const attempts = sameDay && Number.isInteger(d.attempts_today) ? d.attempts_today : 0;
  if (attempts >= READINESS_PER_DAY) fail('readiness-quota', 'הגעת למכסת בדיקות היומית (' + READINESS_PER_DAY + '). נסה מחר.', 'resource-exhausted');
  if (Number.isSafeInteger(d.last_attempt_at_ms) && nowMs - d.last_attempt_at_ms < READINESS_COOLDOWN_MS) {
    fail('readiness-cooldown', 'המתן דקה בין ניסיונות.', 'resource-exhausted');
  }
  return Object.freeze({ attempts_today: attempts + 1, day_key: dayKey });
}

function readinessAckGate(device, nonceHash, tokenHash, nowMs) {
  const d = plain(device) ? device : null;
  if (!d || d.status === 'not_started' || !HEX64_RE.test(String(d.challenge_hash || ''))) fail('readiness-no-challenge', 'לא נשלחה בדיקה למכשיר הזה.');
  if (d.status === 'ready' && d.challenge_hash === nonceHash && d.token_hash === tokenHash) return Object.freeze({ already: true });
  if (d.challenge_hash !== nonceHash) fail('readiness-nonce', 'קוד האישור אינו תואם לבדיקה האחרונה.');
  if (d.token_hash !== tokenHash) fail('readiness-token', 'הבדיקה נשלחה למכשיר אחר.');
  if (!Number.isSafeInteger(d.challenge_expires_at_ms) || d.challenge_expires_at_ms <= nowMs) fail('readiness-expired', 'הבדיקה פגה. שלח בדיקה חדשה.');
  return Object.freeze({ already: false });
}

/** טביעת הכוונה של אימות: קמפיין, עובד, מפתח, פעולה, גרסה צפויה ומאמת.
 *  replay עם אותה טביעה = קבלה; אותו request_id עם טביעה אחרת = התנגשות. */
function verificationIntentFingerprint(verify, actorUid, hash) {
  if (!plain(verify) || typeof hash !== 'function') throw new TypeError('verify and hash are required');
  return hash(JSON.stringify(['join-verify-intent-v1', verify.campaign_id, verify.uid, verify.key, verify.action,
    verify.expected_revision, String(actorUid || '')]));
}

/* ---------- אימות → החזקה (תוכנית כתיבה טהורה) ---------- */

/** מסמך ההחזקות אחרי אימות הצהרה: המפתח נוסף (אם חסר), התוקף נשמר לצדו.
 *  אותה צורה בדיוק כמו setPersonQualifications של מנוע הסידור + valid_until. */
function holdingsAfterVerification(params) {
  const p = params || {};
  const live = plain(p.holdings) ? p.holdings : null;
  const before = live && Array.isArray(live.qualifications) ? live.qualifications.filter((k) => typeof k === 'string') : [];
  const catalog = Array.isArray(p.catalog) ? p.catalog : [];
  const entry = catalog.find((q) => q && q.key === p.key);
  if (!entry || entry.active === false) fail('holdings-unknown', 'הכשירות אינה קיימת או מושבתת בקטלוג התחנה.');
  const order = new Map(catalog.map((q, i) => [q.key, i]));
  const next = before.indexOf(p.key) === -1 ? before.concat([p.key]) : before.slice();
  next.sort((a, b) => (order.has(a) ? order.get(a) : 1e9) - (order.has(b) ? order.get(b) : 1e9));
  const validUntil = {};
  const prev = plain(live && live.valid_until) ? live.valid_until : {};
  next.forEach((k) => { if (Number.isSafeInteger(prev[k]) && prev[k] > 0) validUntil[k] = prev[k]; });
  if (Number.isSafeInteger(p.valid_until_ms) && p.valid_until_ms > 0) validUntil[p.key] = p.valid_until_ms;
  else delete validUntil[p.key];
  const revision = (live && Number.isInteger(live.revision) ? live.revision : 0) + 1;
  return Object.freeze({ before, qualifications: next, valid_until: validUntil, revision, changed: before.indexOf(p.key) === -1 || (prev[p.key] || null) !== (validUntil[p.key] || null) });
}

/* ---------- WhatsApp ---------- */

/** טקסט קבוע להעתקה. אין כאן API. */
function whatsappMessage(stationName, url, expiresAtMs, tz) {
  const when = new Date(expiresAtMs).toLocaleDateString('he-IL', { timeZone: tz || 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric' });
  return 'שלום, זהו קישור הצטרפות למערכת ResQ של ' + String(stationName || 'התחנה') + '.\n'
    + 'פתחו את הקישור בטלפון, מלאו את הפרטים ואמתו את המייל. הבקשה תאושר על ידי התחנה.\n'
    + String(url || '') + '\n'
    + 'הקישור תקף עד ' + when + '. אל תעבירו אותו הלאה.';
}

module.exports = Object.freeze({
  JoinCampaignError, SCHEMA, REGISTRANT_SCHEMA, READINESS_SCHEMA, DEFAULT_ROLE, VALID_SHIFTS, STATUSES,
  DECLARATION_STATUSES, REVIEW_STATES, READINESS_STATUSES, MAX_REGISTRATIONS, MAX_CAMPAIGN_DAYS, MAX_DECLARATIONS,
  INSPECT_PER_HOUR, READINESS_PER_DAY, READINESS_COOLDOWN_MS, READINESS_CHALLENGE_MS,
  REDEEM_KEYS, REDEEM_OPTIONAL, REDEEM_FORBIDDEN, CAMPAIGN_ID_RE, TOKEN_RE,
  newCampaignToken, parseToken, tokenMatches, normalizeCreateInput, buildCampaignDoc, deriveState, publicView,
  applyStatusAction, adminView, normalizeRedemptionInput, normalizeDeclarations, buildRegistrant, replayMatches,
  normalizeReviewAction, applyReviewAction, normalizeVerifyInput, effectiveDeclarationStatus, planDeclarationUpdate,
  promoteDeclarations, summarizeDeclarations, computeReadiness, readinessSendGate, readinessSendDecision, readinessAckGate,
  holdingsAfterVerification, verificationIntentFingerprint, whatsappMessage,
  assertNoSecret, toMillis
});
