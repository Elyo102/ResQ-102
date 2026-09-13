import assert from 'node:assert/strict';
import {
  ROLE_VIEW_OPTIONS, assertPresentationOnly, parseRoleViewStorage,
  resolveRoleView, roleViewClaimsEpoch, roleViewLabel
} from '../role-view.js';

let passed = 0;
function test(name, body) { body(); passed += 1; console.log('PASS ' + name); }
const real = Object.freeze({ super:true, role:'firefighter', stationId:'eilat_102', emp:'1', auth_time:100 });
const epoch = roleViewClaimsEpoch(real);
const base = { uid:'owner', claims:real };

test('only approved presentation roles exist', () => {
  assert.deepEqual(ROLE_VIEW_OPTIONS.map(option => option.id),
    ['actual','firefighter','deputy','commander','hr_coordinator']);
});
test('actual view exposes no claims-shaped presentation and is not persisted', () => {
  assert.deepEqual(resolveRoleView({ ...base, requested:'actual' }),
    { selected:'actual', preview:false, presentation:null, storageRecord:null });
});
test('preview is non-auth-shaped, frozen, and leaves real claims untouched', () => {
  const before = structuredClone(real);
  const out = resolveRoleView({ ...base, requested:'commander' });
  assert.deepEqual(real, before); assert.equal(out.preview, true);
  assert.deepEqual(out.presentation, { kind:'role_view', role_id:'commander', label:'מפקד משמרת' });
  assert.equal(assertPresentationOnly(out.presentation), true);
  assert.equal(Object.isFrozen(out.presentation), true);
  assert.deepEqual(out.storageRecord,
    { owner_uid:'owner', auth_time:100, claims_epoch:epoch, selected:'commander' });
});
test('presentation rejects every authority-shaped object', () => {
  const keys = ['super','role','roles','admin','stationId','station_id',
    'districtId','district_id','permissions','claims'];
  for (const key of keys) {
    assert.equal(assertPresentationOnly(
      { kind:'role_view', role_id:'commander', label:'מפקד משמרת', [key]:true }), false, key);
  }
});
test('only exact boolean super can activate preview', () => {
  for (const value of [false, 'true', 1, null, undefined]) {
    assert.equal(resolveRoleView(
      { ...base, claims:{ super:value }, requested:'hr_coordinator' }).preview, false);
  }
});
test('stored preview is bound to uid auth time and claims epoch', () => {
  const stored = JSON.stringify(
    { owner_uid:'owner', auth_time:100, claims_epoch:epoch, selected:'deputy' });
  assert.equal(resolveRoleView({ ...base, stored }).selected, 'deputy');
  assert.equal(resolveRoleView({ ...base, uid:'replacement', stored }).selected, 'actual');
  assert.equal(resolveRoleView({ ...base, claims:{ ...real, auth_time:101 }, stored }).selected, 'actual');
  assert.equal(resolveRoleView({ ...base, claims:{ ...real, role:'commander' }, stored }).selected, 'actual');
  assert.equal(resolveRoleView({ ...base, claims:{ ...real, stationId:'other' }, stored }).selected, 'actual');
});
test('loss of super discards stored preview', () => {
  const stored = { owner_uid:'owner', auth_time:100, claims_epoch:epoch, selected:'commander' };
  assert.deepEqual(resolveRoleView({ ...base, claims:{ super:false }, stored }),
    { selected:'actual', preview:false, presentation:null, storageRecord:null });
});
test('unknown malformed and URL-shaped selections fail closed', () => {
  for (const requested of ['admin','super_admin','../commander','COMMANDER','']) {
    assert.equal(resolveRoleView({ ...base, requested }).selected, 'actual');
  }
  assert.equal(parseRoleViewStorage('{broken'), null);
  assert.equal(parseRoleViewStorage(
    { owner_uid:'owner', auth_time:100, claims_epoch:epoch, selected:'actual' }), null);
});
test('storage parser requires exact primitive types and bounded values', () => {
  const valid = parseRoleViewStorage(
    { owner_uid:' owner ', auth_time:100, claims_epoch:epoch, selected:'hr_coordinator' });
  assert.deepEqual(valid,
    { owner_uid:'owner', auth_time:100, claims_epoch:epoch, selected:'hr_coordinator' });
  const invalid = [
    { owner_uid:'owner', auth_time:'100', claims_epoch:epoch, selected:'commander' },
    { owner_uid:'x'.repeat(129), auth_time:100, claims_epoch:epoch, selected:'commander' },
    { owner_uid:'owner', auth_time:100, claims_epoch:'x'.repeat(4097), selected:'commander' },
    { owner_uid:'owner', auth_time:100.5, claims_epoch:epoch, selected:'commander' }
  ];
  for (const record of invalid) assert.equal(parseRoleViewStorage(record), null);
});
test('claims epoch changes only with authorization relevant primitives', () => {
  assert.equal(roleViewClaimsEpoch({ ...real, exp:999, iat:888 }), epoch);
  assert.notEqual(roleViewClaimsEpoch({ ...real, districtId:'south' }), epoch);
  assert.notEqual(roleViewClaimsEpoch({ ...real, super:false }), epoch);
  assert.notEqual(roleViewClaimsEpoch({ ...real, personal_lab_control:true }), epoch);
  assert.notEqual(roleViewClaimsEpoch({ ...real, roles:['commander'] }), epoch);
  assert.notEqual(roleViewClaimsEpoch({ ...real, permissions:{ publish:true } }), epoch);
  assert.notEqual(roleViewClaimsEpoch({ ...real, emp:'2' }), epoch);
});
test('claims epoch includes array tails and nested permission leaves', () => {
  const rolesA = Array(65).fill('firefighter');
  const rolesB = rolesA.slice();
  rolesB[64] = 'commander';
  assert.notEqual(roleViewClaimsEpoch({ ...real, roles:rolesA }),
    roleViewClaimsEpoch({ ...real, roles:rolesB }));
  const permissionsA = { a:{ b:{ c:{ publish:false } } } };
  const permissionsB = { a:{ b:{ c:{ publish:true } } } };
  assert.notEqual(roleViewClaimsEpoch({ ...real, permissions:permissionsA }),
    roleViewClaimsEpoch({ ...real, permissions:permissionsB }));
});
test('claims epoch preserves an enumerable own proto key', () => {
  function permissions(publish) {
    const value = Object.create(null);
    Object.defineProperty(value, '__proto__', {
      value:{ publish }, enumerable:true, configurable:true
    });
    return value;
  }
  assert.notEqual(roleViewClaimsEpoch({ ...real, permissions:permissions(false) }),
    roleViewClaimsEpoch({ ...real, permissions:permissions(true) }));
});
test('claims epoch distinguishes arrays from objects', () => {
  assert.notEqual(roleViewClaimsEpoch({ ...real, permissions:[] }),
    roleViewClaimsEpoch({ ...real, permissions:{} }));
  assert.notEqual(roleViewClaimsEpoch({ ...real, permissions:[['publish', true]] }),
    roleViewClaimsEpoch({ ...real, permissions:{ publish:true } }));
});
test('over-complex or cyclic authority claims fail closed', () => {
  const roles = Array.from({ length:513 }, (_, index) => String(index));
  assert.equal(roleViewClaimsEpoch({ ...real, roles }), '');
  assert.equal(resolveRoleView(
    { uid:'owner', claims:{ ...real, roles }, requested:'commander' }).preview, false);
  const permissions = {}; permissions.self = permissions;
  assert.equal(roleViewClaimsEpoch({ ...real, permissions }), '');
});
test('token auth time is authoritative and malformed input fails closed', () => {
  assert.equal(resolveRoleView({ ...base, auth_time:999, requested:'commander' }).storageRecord.auth_time, 100);
  assert.equal(resolveRoleView({ uid:'owner', claims:{ ...real, auth_time:'100' }, requested:'commander' }).preview, false);
  assert.deepEqual(resolveRoleView(null),
    { selected:'actual', preview:false, presentation:null, storageRecord:null });
});
test('labels are Hebrew and unknown selection falls back safely', () => {
  assert.equal(roleViewLabel('firefighter'), 'כבאי');
  assert.equal(roleViewLabel('unknown'), 'התצוגה שלי (מנהל־על)');
});

console.log('role view: ' + passed + '/16 PASS');
