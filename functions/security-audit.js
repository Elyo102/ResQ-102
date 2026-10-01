'use strict';

const crypto = require('node:crypto');
const DOMAIN = 'resq-security-audit-v1';
const KINDS = new Set(['approve', 'set_role', 'transfer_station', 'clear_role', 'bootstrap']);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function identifier(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128
      || /[\x00-\x1f\x7f/]/.test(value)) throw new TypeError('invalid audit identifier');
  return value;
}

function authority(value) {
  const claims = value == null ? {} : value;
  if (!plain(claims)) throw new TypeError('invalid audit authority');
  const field = name => {
    const v = claims[name];
    if (v == null || v === '') return null;
    if (typeof v !== 'string' || v.length > 128 || /[\x00-\x1f\x7f]/.test(v)) {
      throw new TypeError('invalid audit authority field');
    }
    return v;
  };
  if (claims.super != null && typeof claims.super !== 'boolean') throw new TypeError('invalid audit super');
  return Object.freeze({ super: claims.super === true, role: field('role'), shift: field('shift'),
    station_id: field('stationId'), district_id: field('districtId') });
}

// A completion event, not proof that Auth and Firestore changed atomically.
// Missing historical attribution stays unknown; never substitute the resumer.
function createSecurityAuditEvent(op, serverTimestamp) {
  if (!plain(op) || !KINDS.has(op.kind)) throw new TypeError('invalid audit operation');
  const target = identifier(op.target_uid);
  const operation = identifier(op.op_id);
  const actor = op.actor_uid == null || op.actor_uid === '' ? null : identifier(op.actor_uid);
  if (serverTimestamp == null || typeof serverTimestamp !== 'object') throw new TypeError('audit timestamp required');
  const id = crypto.createHash('sha256').update(JSON.stringify([DOMAIN, op.kind, target, operation])).digest('hex');
  const data = Object.freeze({ schema_version: 1, operation_id: operation, operation_kind: op.kind,
    target_uid: target, actor_uid: actor, actor_attribution: actor === null ? 'legacy_missing' : 'original',
    before: authority(op.previous_claims), after: authority(op.desired_claims), occurred_at: serverTimestamp });
  return Object.freeze({ id, data });
}

function appendSecurityAudit(tx, db, op, serverTimestamp) {
  const event = createSecurityAuditEvent(op, serverTimestamp);
  tx.create(db.collection('security_audit_events').doc(event.id), event.data);
  return event.id;
}

module.exports = Object.freeze({ createSecurityAuditEvent, appendSecurityAudit });
