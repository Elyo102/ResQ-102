import assert from 'node:assert/strict';
import fs from 'node:fs';

const original = fs.readFileSync(new URL('../role-view.js', import.meta.url), 'utf8');
const claims = { super:true, role:'firefighter', stationId:'eilat_102', auth_time:100 };

async function moduleFor(name, from, to) {
  assert.equal(original.includes(from), true, name + ': mutation anchor missing');
  const mutated = original.replace(from, to);
  assert.notEqual(mutated, original, name + ': mutation was not applied');
  return import('data:text/javascript;base64,' + Buffer.from(mutated).toString('base64') + '#' + name);
}

const cases = [
  {
    name:'strict-super', from:'claims.super !== true', to:'!claims.super',
    kill:api => assert.equal(api.resolveRoleView(
      { uid:'owner', claims:{ super:'true', auth_time:100 }, requested:'commander' }).preview, false)
  },
  {
    name:'uid-binding', from:'stored.owner_uid !== uid', to:'false',
    kill:api => {
      const epoch = api.roleViewClaimsEpoch(claims);
      const stored = { owner_uid:'other', auth_time:100, claims_epoch:epoch, selected:'commander' };
      assert.equal(api.resolveRoleView({ uid:'owner', auth_time:100, claims, stored }).preview, false);
    }
  },
  {
    name:'auth-time-binding', from:'stored.auth_time !== authTime', to:'false',
    kill:api => {
      const epoch = api.roleViewClaimsEpoch(claims);
      const stored = { owner_uid:'owner', auth_time:99, claims_epoch:epoch, selected:'commander' };
      assert.equal(api.resolveRoleView({ uid:'owner', auth_time:100, claims, stored }).preview, false);
    }
  },
  {
    name:'claims-epoch-binding', from:'stored.claims_epoch !== claimsEpoch', to:'false',
    kill:api => {
      const stored = { owner_uid:'owner', auth_time:100, claims_epoch:'old', selected:'commander' };
      assert.equal(api.resolveRoleView({ uid:'owner', auth_time:100, claims, stored }).preview, false);
    }
  },
  {
    name:'selection-allowlist',
    from:"Object.freeze({ id: 'hr_coordinator', label: 'משאבי אנוש' })",
    to:"Object.freeze({ id: 'administrator', label: 'מנהל' })",
    kill:api => assert.deepEqual(api.ROLE_VIEW_OPTIONS.map(option => option.id),
      ['actual','firefighter','deputy','commander','hr_coordinator'])
  },
  {
    name:'presentation-exact-shape',
    from:"{ kind: 'role_view', role_id: selected, label: option.label }",
    to:"{ kind: 'role_view', role_id: selected, label: option.label, uid: 'victim' }",
    kill:api => assert.equal(api.resolveRoleView(
      { uid:'owner', auth_time:100, claims, requested:'commander' }).preview, true)
  },
  {
    name:'personal-lab-epoch',
    from:"'super','personal_lab_control','role'",
    to:"'super','role'",
    kill:api => assert.notEqual(api.roleViewClaimsEpoch(claims),
      api.roleViewClaimsEpoch({ ...claims, personal_lab_control:true }))
  },
  {
    name:'roles-array-epoch',
    from:'if (Array.isArray(value)) {',
    to:'if (Array.isArray(value)) return null; if (false) {',
    kill:api => {
      const a = Array(65).fill('firefighter');
      const b = a.slice(); b[64] = 'commander';
      assert.notEqual(api.roleViewClaimsEpoch({ ...claims, roles:a }),
        api.roleViewClaimsEpoch({ ...claims, roles:b }));
    }
  },
  {
    name:'permissions-object-epoch',
    from:"if (type === 'object') {",
    to:"if (type === 'object') return null; if (false) {",
    kill:api => assert.notEqual(
      api.roleViewClaimsEpoch({ ...claims, permissions:{ a:{ b:{ c:{ publish:false } } } } }),
      api.roleViewClaimsEpoch({ ...claims, permissions:{ a:{ b:{ c:{ publish:true } } } } }))
  },
  {
    name:'proto-key-epoch',
    from:'Object.keys(value).sort().map(key =>',
    to:"Object.keys(value).sort().filter(key => key !== '__proto__').map(key =>",
    kill:api => {
      const make = publish => {
        const value = Object.create(null);
        Object.defineProperty(value, '__proto__', { value:{ publish }, enumerable:true });
        return value;
      };
      assert.notEqual(api.roleViewClaimsEpoch({ ...claims, permissions:make(false) }),
        api.roleViewClaimsEpoch({ ...claims, permissions:make(true) }));
    }
  },
  {
    name:'container-type-tag',
    from:"return ['array', out];",
    to:"return ['object', out];",
    kill:api => assert.notEqual(
      api.roleViewClaimsEpoch({ ...claims, permissions:[] }),
      api.roleViewClaimsEpoch({ ...claims, permissions:{} }))
  },
  {
    name:'token-auth-time-source',
    from:'const authTime = nonNegativeInteger(claims.auth_time);',
    to:'const authTime = nonNegativeInteger(input.auth_time);',
    kill:api => assert.equal(api.resolveRoleView(
      { uid:'owner', auth_time:999, claims, requested:'commander' }).storageRecord.auth_time, 100)
  }
];

const control = await import('../role-view.js');
let killed = 0;
for (const item of cases) {
  await item.kill(control);
  const api = await moduleFor(item.name, item.from, item.to);
  try {
    await item.kill(api);
  } catch (error) {
    killed += 1;
    console.log('KILLED ' + item.name + ': ' + error.message);
  }
}
assert.equal(killed, cases.length, 'every unsafe role-view mutation must be killed');
console.log('role view mutations: ' + killed + '/' + cases.length + ' KILLED');
