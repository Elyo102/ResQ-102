'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const bulletin = require('./bulletin');

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('✓ ' + name);
  } catch (error) {
    console.error('✗ ' + name);
    throw error;
  }
}

function throwsCode(code, fn) {
  assert.throws(fn, function (error) {
    return error instanceof bulletin.BulletinError && error.code === code;
  });
}

const validPost = {
  subStationId: 'rashit',
  category: 'general',
  text: ' הודעה לתחנה ',
  requestId: '12345678-1234-4234-9234-123456789012'
};
const validAuth = {
  uid: 'u_ff',
  token: { stationId: 'eilat_102', role: 'firefighter', shift: 'C' }
};

test('bulletin source contains no NUL bytes', function () {
  const source = fs.readFileSync(require.resolve('./bulletin'));
  assert.equal(source.includes(0), false);
});

test('post input is trimmed and normalized', function () {
  const parsed = bulletin.parsePostInput(validPost);
  assert.equal(parsed.text, 'הודעה לתחנה');
  assert.equal(parsed.subStationId, 'rashit');
});

bulletin.CATEGORIES.forEach(function (category) {
  test('accepted category: ' + category, function () {
    assert.equal(bulletin.parsePostInput(Object.assign({}, validPost, {
      category: category
    })).category, category);
  });
});

test('unknown category is rejected', function () {
  throwsCode('invalid-argument', function () {
    bulletin.parsePostInput(Object.assign({}, validPost, { category: 'safety' }));
  });
});

test('extra post field is rejected', function () {
  throwsCode('invalid-argument', function () {
    bulletin.parsePostInput(Object.assign({}, validPost, { by_name: 'זיוף' }));
  });
});

test('empty text is rejected', function () {
  throwsCode('invalid-argument', function () {
    bulletin.parsePostInput(Object.assign({}, validPost, { text: '   ' }));
  });
});

test('text over 2000 characters is rejected', function () {
  throwsCode('invalid-argument', function () {
    bulletin.parsePostInput(Object.assign({}, validPost, { text: 'א'.repeat(2001) }));
  });
});

test('text of exactly 2000 characters is accepted', function () {
  assert.equal(bulletin.parsePostInput(Object.assign({}, validPost, {
    text: 'א'.repeat(2000)
  })).text.length, 2000);
});

test('unsafe control bytes are rejected', function () {
  throwsCode('invalid-argument', function () {
    bulletin.parsePostInput(Object.assign({}, validPost, { text: 'א\u0000ב' }));
  });
});

test('line breaks remain supported', function () {
  assert.equal(bulletin.parsePostInput(Object.assign({}, validPost, {
    text: 'שורה א\nשורה ב'
  })).text, 'שורה א\nשורה ב');
});

test('path traversal in sub-station id is rejected', function () {
  throwsCode('invalid-argument', function () {
    bulletin.parsePostInput(Object.assign({}, validPost, { subStationId: '../secret' }));
  });
});

test('short request id is rejected', function () {
  throwsCode('invalid-argument', function () {
    bulletin.parsePostInput(Object.assign({}, validPost, { requestId: 'short' }));
  });
});

test('extra hide field is rejected', function () {
  throwsCode('invalid-argument', function () {
    bulletin.parseHideInput({
      sid: 'eilat_102', subStationId: 'rashit', messageId: 'm_abc', text: 'x'
    });
  });
});

test('valid hide input is accepted', function () {
  assert.deepEqual(bulletin.parseHideInput({
    sid: 'eilat_102', subStationId: 'rashit', messageId: 'm_abc'
  }), { sid: 'eilat_102', subStationId: 'rashit', messageId: 'm_abc' });
});

bulletin.MEMBER_ROLES.forEach(function (role) {
  test('posting member role accepted: ' + role, function () {
    const identity = bulletin.postingIdentity({
      uid: 'u_' + role,
      token: { stationId: 'eilat_102', role: role, shift: '' }
    });
    assert.equal(identity.role, role);
  });
});

test('district commander cannot post', function () {
  throwsCode('permission-denied', function () {
    bulletin.postingIdentity({
      uid: 'u_district',
      token: { stationId: 'eilat_102', role: 'district_commander', shift: '' }
    });
  });
});

test('pending user cannot post', function () {
  throwsCode('permission-denied', function () {
    bulletin.postingIdentity({ uid: 'u_pending', token: {} });
  });
});

test('verified super gets the server default station and display role', function () {
  const identity = bulletin.postingIdentity({
    uid: 'u_super', token: { email: 'admin@example.com', super: true }
  }, { isSuper: true, defaultStationId: 'eilat_102' });
  assert.deepEqual(identity, {
    uid: 'u_super', sid: 'eilat_102', role: 'super_admin', crew: '', isSuper: true
  });
});

test('an unverified caller cannot request the super fallback', function () {
  throwsCode('permission-denied', function () {
    bulletin.postingIdentity({
      uid: 'u_fake', token: { email: 'fake@example.com' }
    }, { isSuper: false, defaultStationId: 'eilat_102' });
  });
});

test('identity station comes only from token', function () {
  const identity = bulletin.postingIdentity(validAuth);
  assert.deepEqual(identity, {
    uid: 'u_ff', sid: 'eilat_102', role: 'firefighter', crew: 'C', isSuper: false
  });
});

test('unsafe token station id is rejected', function () {
  throwsCode('invalid-argument', function () {
    bulletin.postingIdentity({
      uid: 'u_ff', token: { stationId: '../other', role: 'firefighter' }
    });
  });
});

test('message and request keys are deterministic', function () {
  assert.equal(
    bulletin.messageId('u_ff', validPost.requestId),
    bulletin.messageId('u_ff', validPost.requestId)
  );
  assert.equal(
    bulletin.requestKey('u_ff', validPost.requestId),
    bulletin.requestKey('u_ff', validPost.requestId)
  );
});

test('request keys differ between users', function () {
  assert.notEqual(
    bulletin.requestKey('u_ff', validPost.requestId),
    bulletin.requestKey('u_other', validPost.requestId)
  );
});

test('content hash changes with content', function () {
  const identity = bulletin.postingIdentity(validAuth);
  const first = bulletin.contentHash(identity, bulletin.parsePostInput(validPost));
  const second = bulletin.contentHash(identity, bulletin.parsePostInput(
    Object.assign({}, validPost, { text: 'תוכן אחר' })
  ));
  assert.notEqual(first, second);
});

test('new request is classified as new', function () {
  assert.equal(bulletin.requestState(null, 'hash', 'path'), 'new');
});

test('same request and content is a duplicate', function () {
  assert.equal(bulletin.requestState({
    request_hash: 'hash', message_path: 'path'
  }, 'hash', 'path'), 'duplicate');
});

test('same request with other content is a conflict', function () {
  assert.equal(bulletin.requestState({
    request_hash: 'old', message_path: 'path'
  }, 'new', 'path'), 'conflict');
});

test('same request pointed at another board is a conflict', function () {
  assert.equal(bulletin.requestState({
    request_hash: 'hash', message_path: 'other'
  }, 'hash', 'path'), 'conflict');
});

test('rate window allows first five messages', function () {
  let state = null;
  for (let i = 0; i < bulletin.RATE_LIMIT; i++) {
    const decision = bulletin.rateDecision(state, 1000 + i);
    assert.equal(decision.allowed, true);
    state = {
      count: decision.count,
      window_started_at: new Date(decision.windowStartedMillis)
    };
  }
  assert.equal(state.count, 5);
});

test('sixth message inside 60 seconds is blocked', function () {
  const decision = bulletin.rateDecision({
    count: 5, window_started_at: new Date(1000)
  }, 59000);
  assert.equal(decision.allowed, false);
  assert.equal(decision.retryAfterSeconds, 2);
});

test('rate window resets after exactly 60 seconds', function () {
  const decision = bulletin.rateDecision({
    count: 5, window_started_at: new Date(1000)
  }, 61000);
  assert.equal(decision.allowed, true);
  assert.equal(decision.count, 1);
  assert.equal(decision.windowStartedMillis, 61000);
});

test('active legacy sub-station is available', function () {
  assert.equal(bulletin.subStationAvailable({ name: 'ראשית' }), true);
});

[
  { is_active: false },
  { active: false },
  { archived: true },
  { status: 'inactive' },
  { status: 'archived' }
].forEach(function (state, index) {
  test('inactive or archived sub-station is blocked #' + (index + 1), function () {
    assert.equal(bulletin.subStationAvailable(state), false);
  });
});

console.log('\n' + passed + ' bulletin helper tests passed.');
