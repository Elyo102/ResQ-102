'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHandler } = require('./bulk-import-disabled');

class TestHttpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function rejectsWith(label, handler, req, code) {
  let caught = null;
  try {
    await handler(req);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught && caught.code, code, label);
  console.log('✓ ' + label);
}

(async function run() {
  await rejectsWith(
    'unauthenticated callers are rejected by the authorization gate',
    createHandler({
      requireSuperAdmin: function () {
        throw new TestHttpsError('unauthenticated', 'login required');
      },
      HttpsError: TestHttpsError
    }),
    {},
    'unauthenticated'
  );

  await rejectsWith(
    'non-super callers are rejected by the authorization gate',
    createHandler({
      requireSuperAdmin: function () {
        throw new TestHttpsError('permission-denied', 'super only');
      },
      HttpsError: TestHttpsError
    }),
    {},
    'permission-denied'
  );

  const order = [];
  const request = new Proxy({ marker: 'canary-password-must-not-be-read' }, {
    get: function (target, key) {
      if (key === 'data') throw new Error('request payload was read');
      return target[key];
    }
  });
  await rejectsWith(
    'a super caller is stopped with failed-precondition after authz',
    createHandler({
      requireSuperAdmin: function (value) {
        assert.equal(value, request);
        order.push('authz');
      },
      HttpsError: class extends TestHttpsError {
        constructor(code, message) {
          order.push('blocked');
          super(code, message);
        }
      }
    }),
    request,
    'failed-precondition'
  );
  assert.deepEqual(order, ['authz', 'blocked']);
  console.log('✓ authorization runs before the fail-closed response');

  const source = fs.readFileSync(path.join(__dirname, 'bulk-import-disabled.js'), 'utf8');
  for (const token of ['req.data', 'openAudit', 'db.', 'admin.auth',
                       'writeProfile', 'console.', 'password', '.pw']) {
    assert.equal(source.includes(token), false,
      'disabled handler must not contain side effect token ' + token);
  }
  console.log('✓ disabled handler has no payload, audit, Auth, Firestore or log access');

  const indexSource = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const section = indexSource.match(
    /exports\.bulkImport[\s\S]*?\/\/ ---------------------------------------------------------------------\r?\n\/\/  מצב שקט/
  );
  assert.ok(section, 'bulkImport export section exists');
  for (const token of ['req.data', 'openAudit', 'createUser', 'setCustomUserClaims',
                       'writeProfile', 'emp_index/']) {
    assert.equal(section[0].includes(token), false,
      'bulkImport export must not contain old provisioning token ' + token);
  }
  console.log('✓ deployed bulkImport export contains no provisioning implementation');
  console.log('\n6 bulk-import disablement checks passed.');
})().catch(function (error) {
  console.error(error);
  process.exit(1);
});
