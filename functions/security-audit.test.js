'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSecurityAuditEvent, appendSecurityAudit } = require('./security-audit');
const at = Object.freeze({ serverTimestamp: true });
const operation = overrides => ({ kind:'set_role', target_uid:'target', op_id:'operation-123', actor_uid:'actor',
  previous_claims:{ super:false, role:'firefighter', shift:'A', stationId:'s1', districtId:'south' },
  desired_claims:{ super:true, role:'commander', shift:'B', stationId:'s2', districtId:'north' }, ...overrides });

test('every closed operation kind has deterministic domain-separated identity', () => {
  const ids = new Set();
  for (const kind of ['approve', 'set_role', 'transfer_station', 'clear_role', 'bootstrap']) {
    const op = operation({ kind }); const event = createSecurityAuditEvent(op, at);
    assert.equal(event.id, crypto.createHash('sha256').update(JSON.stringify(['resq-security-audit-v1',kind,'target','operation-123'])).digest('hex'));
    assert.equal(event.id, createSecurityAuditEvent(op, {}).id); ids.add(event.id);
    assert.equal(event.data.operation_kind, kind);
  }
  assert.equal(ids.size, 5);
  const base = createSecurityAuditEvent(operation(), at).id;
  assert.notEqual(base, createSecurityAuditEvent(operation({ target_uid:'other' }), at).id);
  assert.notEqual(base, createSecurityAuditEvent(operation({ op_id:'other' }), at).id);
  assert.notEqual(createSecurityAuditEvent(operation({target_uid:'a:b',op_id:'c'}),at).id,
    createSecurityAuditEvent(operation({target_uid:'a',op_id:'b:c'}),at).id);
});

test('closed immutable schema excludes arbitrary claims, secrets and personal fields', () => {
  const op = operation();
  Object.assign(op, { actor_email:'private@example.test', secret:'private' });
  Object.assign(op.desired_claims, { email:'private@example.test', token:'private', phone:'private', emp:'private' });
  const { data } = createSecurityAuditEvent(op, at);
  assert.deepEqual(Object.keys(data).sort(), ['schema_version','operation_id','operation_kind','target_uid','actor_uid','actor_attribution','before','after','occurred_at'].sort());
  assert.deepEqual(data.after, { super:true, role:'commander', shift:'B', station_id:'s2', district_id:'north' });
  assert.deepEqual(data.before, { super:false, role:'firefighter', shift:'A', station_id:'s1', district_id:'south' });
  assert.equal(data.actor_attribution, 'original'); assert.equal(data.occurred_at, at);
  assert(!JSON.stringify(data).includes('private'));
  assert(Object.isFrozen(data)); assert(Object.isFrozen(data.before)); assert(Object.isFrozen(data.after));
  assert.throws(() => { data.after.super = false; }, TypeError);
});

test('legacy absent actor and authority remain explicitly unknown without invented attribution', () => {
  for (const actor_uid of [undefined, null, '']) {
    const { data } = createSecurityAuditEvent(operation({ actor_uid, previous_claims:undefined, desired_claims:null }), at);
    assert.equal(data.actor_uid, null); assert.equal(data.actor_attribution, 'legacy_missing');
    assert.deepEqual(data.before, { super:false, role:null, shift:null, station_id:null, district_id:null });
    assert.deepEqual(data.after, data.before);
  }
});

test('invalid operation identifiers, kinds, authority and absent timestamp fail closed', () => {
  for (const value of ['', ' ', null, 123, {}, 'a/b', 'a\n', 'x'.repeat(129)]) {
    for (const field of ['target_uid','op_id']) assert.throws(() => createSecurityAuditEvent(operation({[field]:value}),at), TypeError);
  }
  for (const patch of [{kind:'other'}, {actor_uid:{}}, {previous_claims:[]}, {desired_claims:{super:'true'}},
    {desired_claims:{role:{secret:'value'}}}, {desired_claims:{shift:'B\n'}}]) {
    assert.throws(() => createSecurityAuditEvent(operation(patch),at), TypeError);
  }
  for (const value of [undefined,null,'now',123]) assert.throws(() => createSecurityAuditEvent(operation(),value), TypeError);
});

test('append uses only transaction create and propagates collisions without overwrite', () => {
  const records = new Map(); let calls = 0;
  const db = { collection(name) { assert.equal(name,'security_audit_events'); return { doc:id => ({path:name+'/'+id}) }; } };
  const tx = { create(ref,data) { calls++; if(records.has(ref.path)) throw Error('already-exists'); records.set(ref.path,data); } };
  const op = operation(); const id = appendSecurityAudit(tx,db,op,at);
  const original = records.get('security_audit_events/'+id);
  assert.equal(original.operation_id,op.op_id);
  assert.throws(() => appendSecurityAudit(tx,db,operation({desired_claims:{role:'changed'}}),at), /already-exists/);
  assert.equal(records.size,1); assert.equal(records.get('security_audit_events/'+id),original); assert.equal(calls,2);
  assert.throws(() => appendSecurityAudit(tx,db,operation({kind:'invalid'}),at), TypeError);
  assert.equal(calls,2,'invalid input cannot reach a transaction write');
});
