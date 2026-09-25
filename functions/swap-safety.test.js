'use strict';
const assert = require('assert');
const ss = require('./swap-safety');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ': ' + (e && e.message)); }
}

function fakeDb(docs) {
  return {
    doc(path) {
      return {
        async get() {
          const v = docs[path];
          return { exists: v !== undefined, data: () => v };
        }
      };
    },
    collection(path) {
      return {
        where() { return this; },
        async get() {
          const rows = docs[path] || [];
          return { forEach: (fn) => rows.forEach((r) => fn({ id: r.id, data: () => r })) };
        }
      };
    }
  };
}

console.log('swap-safety');
(async () => {
  await check('resolveSwapNames prefers roster over client-supplied name', async () => {
    const db = fakeDb({
      'stations/s1/roster/u1': { full_name: 'Roster Name' },
      'stations/s1/users/u1': { full_name: 'User Name' }
    });
    const out = await ss.resolveSwapNames(db, 's1', {
      from_uid: 'u1', from_name: 'Client Forged', to_uid: '', to_name: ''
    });
    assert.strictEqual(out.from_name, 'Roster Name');
  });

  await check('approvedSwapsFor queries only the two parties', async () => {
    const calls = [];
    const db = {
      collection(path) {
        return {
          where(field, op, val) { calls.push([field, op, val]); return this; },
          async get() { return { forEach() {} }; }
        };
      }
    };
    await ss.approvedSwapsFor(db, 's1', ['a', 'b'], 'x');
    assert.ok(calls.some(c => c[0] === 'from_uid'));
    assert.ok(calls.some(c => c[0] === 'to_uid'));
    assert.ok(calls.every(c => c[0] !== 'status' || c[2] === 'approved') || calls.some(c => c[0] === 'status' && c[2] === 'approved'));
  });

  console.log(fail ? ('FAIL ' + fail) : ('PASS ' + pass));
  process.exit(fail ? 1 : 0);
})();
