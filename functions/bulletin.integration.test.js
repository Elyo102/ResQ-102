'use strict';

// Run only through:
// firebase emulators:exec --only firestore --project demo-resq
//   "cd functions && node bulletin.integration.test.js"
//
// The callable's .run() hook executes the real handler without opening an HTTP
// port. Admin SDK still talks to the Firestore emulator, so transactions,
// timestamps, idempotency documents, rate limits and audit writes are real.

const assert = require('node:assert/strict');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is required; refusing to run against a real project.');
  process.exit(2);
}

const functions = require('./index');
const admin = require('firebase-admin');
const bulletin = require('./bulletin');
const db = admin.firestore();

const SID = 'test_station';
const SUB = 'rashit';
const SUPER_SID = 'eilat_102';
let passed = 0;

function requestId(label) {
  return ('req-' + label + '-000000000000000000000000').slice(0, 40);
}

function auth(uid, role, sid, shift) {
  return {
    uid: uid,
    token: {
      email: uid + '@example.com',
      role: role,
      stationId: sid,
      shift: shift || '',
      emp: '101'
    }
  };
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('✓ ' + name);
  } catch (error) {
    console.error('✗ ' + name);
    throw error;
  }
}

async function rejectsCode(code, promise) {
  try {
    await promise;
    assert.fail('expected callable error ' + code);
  } catch (error) {
    if (error && error.code === 'ERR_ASSERTION') throw error;
    assert.match(String(error && error.code || ''), new RegExp(code + '$'));
  }
}

async function seed() {
  const batch = db.batch();
  batch.set(db.doc(`stations/${SID}`), { name: 'תחנת בדיקה' });
  batch.set(db.doc(`stations/${SID}/sub_stations/${SUB}`), {
    name: 'ראשית', order: 1, status: 'active'
  });
  batch.set(db.doc(`stations/${SID}/sub_stations/second`), {
    name: 'שנייה', order: 2, status: 'active'
  });
  batch.set(db.doc(`stations/${SID}/sub_stations/inactive`), {
    name: 'לא פעילה', order: 3, status: 'inactive'
  });
  batch.set(db.doc(`stations/${SID}/users/u_ff`), {
    full_name: 'שם מהשרת', role: 'firefighter', crew: 'C', is_active: true
  });
  batch.set(db.doc(`stations/${SID}/users/u_rate`), {
    full_name: 'בודק קצב', role: 'firefighter', crew: 'A', is_active: true
  });
  batch.set(db.doc(`stations/${SID}/users/u_inactive`), {
    full_name: 'משתמש כבוי', role: 'firefighter', crew: 'A', is_active: false
  });
  batch.set(db.doc(`stations/${SID}/users/u_cmd`), {
    full_name: 'ראש משמרת', role: 'commander', crew: 'C', is_active: true
  });
  batch.set(db.doc(`stations/${SID}/users/u_dep`), {
    full_name: 'סגן ראש משמרת', role: 'deputy', crew: 'C', is_active: true
  });
  batch.set(db.doc(`stations/${SID}/users/u_stale`), {
    full_name: 'תפקיד ישן', role: 'firefighter', crew: 'C', is_active: true
  });
  batch.set(db.doc(`stations/${SID}/users/u_role_removed`), {
    full_name: 'תפקיד הוסר', role: '', crew: 'C', is_active: true
  });
  batch.set(db.doc(`stations/${SID}/users/u_cmd_inactive`), {
    full_name: 'מפקד כבוי', role: 'commander', crew: 'C', is_active: false
  });
  batch.set(db.doc(`stations/${SUPER_SID}`), { name: 'אילת' });
  batch.set(db.doc(`stations/${SUPER_SID}/sub_stations/${SUB}`), {
    name: 'ראשית', order: 1, status: 'active'
  });
  await batch.commit();
}

async function main() {
await seed();

const firstPayload = {
  subStationId: SUB,
  category: 'equipment',
  text: '  בדיקת ציוד בשעה 10:00  ',
  requestId: requestId('first')
};
const firefighter = auth('u_ff', 'firefighter', SID, 'C');

let firstResult;
await test('firefighter posts through the callable', async function () {
  firstResult = await functions.postBulletinMessage.run({
    auth: firefighter, data: firstPayload
  });
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.duplicate, false);
});

await test('stored identity and time are server-owned', async function () {
  const snap = await db.doc(
    `stations/${SID}/sub_stations/${SUB}/bulletin_messages/${firstResult.id}`
  ).get();
  assert.equal(snap.exists, true);
  const value = snap.data();
  assert.equal(value.kind, 'bulletin');
  assert.equal(value.text, 'בדיקת ציוד בשעה 10:00');
  assert.equal(value.category, 'equipment');
  assert.equal(value.by_uid, 'u_ff');
  assert.equal(value.by_name, 'שם מהשרת');
  assert.equal(value.by_role, 'firefighter');
  assert.equal(value.by_crew, 'C');
  assert.equal(value.hidden, false);
  assert.equal(value.created_at instanceof admin.firestore.Timestamp, true);
  assert.equal(value.created_key, value.created_at.toDate().toISOString());
  assert.equal(typeof value.request_hash, 'string');
  assert.equal(value.request_hash.length, 64);
});

await test('client-supplied identity or time fields are rejected', async function () {
  await rejectsCode('invalid-argument', functions.postBulletinMessage.run({
    auth: firefighter,
    data: Object.assign({}, firstPayload, {
      requestId: requestId('forged'), by_name: 'שם מזויף', created_at: new Date(0)
    })
  }));
});

await test('identical retry is idempotent and creates no duplicate', async function () {
  const retry = await functions.postBulletinMessage.run({
    auth: firefighter, data: firstPayload
  });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.id, firstResult.id);
  const all = await db.collection(
    `stations/${SID}/sub_stations/${SUB}/bulletin_messages`
  ).get();
  assert.equal(all.size, 1);
});

await test('request id reuse with changed content is blocked', async function () {
  await rejectsCode('already-exists', functions.postBulletinMessage.run({
    auth: firefighter,
    data: Object.assign({}, firstPayload, { text: 'תוכן אחר' })
  }));
});

await test('request id reuse on another board is blocked', async function () {
  await rejectsCode('already-exists', functions.postBulletinMessage.run({
    auth: firefighter,
    data: Object.assign({}, firstPayload, { subStationId: 'second' })
  }));
});

await test('inactive sub-station is blocked', async function () {
  await rejectsCode('failed-precondition', functions.postBulletinMessage.run({
    auth: firefighter,
    data: Object.assign({}, firstPayload, {
      subStationId: 'inactive', requestId: requestId('inactive')
    })
  }));
});

await test('district commander is not a station member for posting', async function () {
  await rejectsCode('permission-denied', functions.postBulletinMessage.run({
    auth: auth('u_dist', 'district_commander', SID, ''),
    data: Object.assign({}, firstPayload, { requestId: requestId('district') })
  }));
});

await test('pending user without an approved role is blocked', async function () {
  await rejectsCode('permission-denied', functions.postBulletinMessage.run({
    auth: { uid: 'u_pending', token: { email: 'pending@example.com' } },
    data: Object.assign({}, firstPayload, { requestId: requestId('pending') })
  }));
});

await test('inactive station user is blocked even with a still-valid token', async function () {
  await rejectsCode('permission-denied', functions.postBulletinMessage.run({
    auth: auth('u_inactive', 'firefighter', SID, 'A'),
    data: Object.assign({}, firstPayload, { requestId: requestId('user-off') })
  }));
});

await test('station cannot be selected in the payload', async function () {
  await rejectsCode('invalid-argument', functions.postBulletinMessage.run({
    auth: auth('u_outside', 'firefighter', 'other_station', 'A'),
    data: Object.assign({}, firstPayload, {
      sid: SID, requestId: requestId('outside')
    })
  }));
});

await test('five messages per 60-second window are accepted and the sixth is blocked', async function () {
  const rateAuth = auth('u_rate', 'firefighter', SID, 'A');
  for (let i = 0; i < bulletin.RATE_LIMIT; i++) {
    const result = await functions.postBulletinMessage.run({
      auth: rateAuth,
      data: {
        subStationId: SUB, category: 'general', text: 'הודעת קצב ' + i,
        requestId: requestId('rate-' + i)
      }
    });
    assert.equal(result.ok, true);
  }
  await rejectsCode('resource-exhausted', functions.postBulletinMessage.run({
    auth: rateAuth,
    data: {
      subStationId: SUB, category: 'general', text: 'הודעת קצב שישית',
      requestId: requestId('rate-six')
    }
  }));
});

let superPost;
await test('verified super without station claims uses the server fallback', async function () {
  superPost = await functions.postBulletinMessage.run({
    auth: {
      uid: 'u_super',
      token: { email: 'fire102.shits@gmail.com', super: true }
    },
    data: {
      subStationId: SUB, category: 'maintenance', text: 'בדיקת מנהל',
      requestId: requestId('super-post')
    }
  });
  const snap = await db.doc(
    `stations/${SUPER_SID}/sub_stations/${SUB}/bulletin_messages/${superPost.id}`
  ).get();
  assert.equal(snap.data().by_name, 'מנהל המערכת');
  assert.equal(snap.data().by_role, 'super_admin');
});

let broadcastResult;
const commander = auth('u_cmd', 'commander', SID, 'C');
const deputy = auth('u_dep', 'deputy', SID, 'C');
const broadcastPayload = {
  category: 'general',
  text: 'עדכון פיקודי לכל התחנות',
  requestId: requestId('broadcast-first')
};

await test('commander broadcasts atomically to every active sub-station', async function () {
  broadcastResult = await functions.broadcastBulletinMessage.run({
    auth: commander, data: broadcastPayload
  });
  assert.equal(broadcastResult.ok, true);
  assert.equal(broadcastResult.duplicate, false);
  assert.deepEqual(broadcastResult.boardIds.sort(), [SUB, 'second'].sort());
  assert.equal(broadcastResult.targetCount, 2);

  const first = await db.doc(
    `stations/${SID}/sub_stations/${SUB}/bulletin_messages/${broadcastResult.id}`
  ).get();
  const second = await db.doc(
    `stations/${SID}/sub_stations/second/bulletin_messages/${broadcastResult.id}`
  ).get();
  const inactive = await db.doc(
    `stations/${SID}/sub_stations/inactive/bulletin_messages/${broadcastResult.id}`
  ).get();
  assert.equal(first.exists, true);
  assert.equal(second.exists, true);
  assert.equal(inactive.exists, false);
  assert.equal(first.data().text, broadcastPayload.text);
  assert.equal(first.data().audience, 'all_sub_stations');
  assert.equal(first.data().broadcast_id, broadcastResult.id);
  assert.deepEqual(first.data().sub_station_ids, [SUB, 'second'].sort());
  assert.deepEqual(second.data().sub_station_ids, [SUB, 'second'].sort());
  assert.equal(first.data().by_uid, 'u_cmd');
  assert.equal(first.data().created_key, second.data().created_key);
});

await test('deputy may broadcast to every active sub-station too', async function () {
  const result = await functions.broadcastBulletinMessage.run({
    auth: deputy,
    data: {
      category: 'maintenance',
      text: 'עדכון הסגן לכל התחנות',
      requestId: requestId('broadcast-deputy')
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.targetCount, 2);
  const first = await db.doc(
    `stations/${SID}/sub_stations/${SUB}/bulletin_messages/${result.id}`
  ).get();
  const second = await db.doc(
    `stations/${SID}/sub_stations/second/bulletin_messages/${result.id}`
  ).get();
  assert.equal(first.exists, true);
  assert.equal(second.exists, true);
  assert.equal(first.data().by_uid, 'u_dep');
  assert.equal(first.data().by_role, 'deputy');
  assert.equal(first.data().created_key, second.data().created_key);
});

await test('identical broadcast retry creates no duplicate copies', async function () {
  const retry = await functions.broadcastBulletinMessage.run({
    auth: commander, data: broadcastPayload
  });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.id, broadcastResult.id);
  for (const boardId of [SUB, 'second']) {
    const messages = await db.collection(
      `stations/${SID}/sub_stations/${boardId}/bulletin_messages`
    ).where('broadcast_id', '==', broadcastResult.id).get();
    assert.equal(messages.size, 1);
  }
});

await test('broadcast retry fails closed when the active target set changed', async function () {
  await db.doc(`stations/${SID}/sub_stations/second`).set({
    status: 'inactive'
  }, { merge: true });
  await rejectsCode('already-exists', functions.broadcastBulletinMessage.run({
    auth: commander, data: broadcastPayload
  }));
  await db.doc(`stations/${SID}/sub_stations/second`).set({
    status: 'active'
  }, { merge: true });
});

for (const role of ['firefighter', 'team_leader', 'station_commander',
  'hr_coordinator', 'district_commander']) {
  await test(role + ' cannot broadcast to every sub-station', async function () {
    await rejectsCode('permission-denied', functions.broadcastBulletinMessage.run({
      auth: auth('u_' + role, role, SID, 'A'),
      data: Object.assign({}, broadcastPayload, {
        requestId: requestId('broadcast-denied-' + role)
      })
    }));
  });
}

await test('broadcast payload cannot choose station or target boards', async function () {
  await rejectsCode('invalid-argument', functions.broadcastBulletinMessage.run({
    auth: commander,
    data: Object.assign({}, broadcastPayload, {
      requestId: requestId('broadcast-forged'),
      sid: 'other_station', boardIds: ['other']
    })
  }));
});

await test('inactive or stale commander is blocked server-side', async function () {
  await rejectsCode('permission-denied', functions.broadcastBulletinMessage.run({
    auth: auth('u_cmd_inactive', 'commander', SID, 'C'),
    data: Object.assign({}, broadcastPayload, {
      requestId: requestId('broadcast-inactive')
    })
  }));
  await rejectsCode('failed-precondition', functions.broadcastBulletinMessage.run({
    auth: auth('u_stale', 'commander', SID, 'C'),
    data: Object.assign({}, broadcastPayload, {
      requestId: requestId('broadcast-stale')
    })
  }));
  await rejectsCode('failed-precondition', functions.broadcastBulletinMessage.run({
    auth: auth('u_role_removed', 'commander', SID, 'C'),
    data: Object.assign({}, broadcastPayload, {
      requestId: requestId('broadcast-role-removed')
    })
  }));
});

let firstReply;
const replyPayload = {
  subStationId: SUB,
  messageId: firstResult.id,
  text: 'הציוד ייבדק במשמרת הקרובה',
  requestId: requestId('reply-first')
};

await test('commander replies with server-owned identity and time', async function () {
  firstReply = await functions.replyToBulletinMessage.run({
    auth: commander, data: replyPayload
  });
  assert.equal(firstReply.ok, true);
  assert.equal(firstReply.duplicate, false);
  const reply = await db.doc(
    `stations/${SID}/sub_stations/${SUB}/bulletin_messages/${firstResult.id}/bulletin_replies/${firstReply.id}`
  ).get();
  assert.equal(reply.exists, true);
  assert.equal(reply.data().kind, 'bulletin_reply');
  assert.equal(reply.data().by_uid, 'u_cmd');
  assert.equal(reply.data().by_name, 'ראש משמרת');
  assert.equal(reply.data().by_role, 'commander');
  assert.equal(reply.data().hidden, false);
  assert.equal(reply.data().created_at instanceof admin.firestore.Timestamp, true);
  const parent = await db.doc(
    `stations/${SID}/sub_stations/${SUB}/bulletin_messages/${firstResult.id}`
  ).get();
  assert.equal(parent.data().reply_count, 1);
});

await test('identical reply retry is idempotent and does not increment count', async function () {
  const retry = await functions.replyToBulletinMessage.run({
    auth: commander, data: replyPayload
  });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.id, firstReply.id);
  const parent = await db.doc(
    `stations/${SID}/sub_stations/${SUB}/bulletin_messages/${firstResult.id}`
  ).get();
  assert.equal(parent.data().reply_count, 1);
});

await test('deputy may reply too', async function () {
  const result = await functions.replyToBulletinMessage.run({
    auth: deputy,
    data: Object.assign({}, replyPayload, {
      text: 'מאשר את הטיפול',
      requestId: requestId('reply-deputy')
    })
  });
  assert.equal(result.ok, true);
  const parent = await db.doc(
    `stations/${SID}/sub_stations/${SUB}/bulletin_messages/${firstResult.id}`
  ).get();
  assert.equal(parent.data().reply_count, 2);
});

for (const role of ['firefighter', 'team_leader', 'station_commander',
  'hr_coordinator', 'district_commander']) {
  await test(role + ' cannot reply to a bulletin message', async function () {
    await rejectsCode('permission-denied', functions.replyToBulletinMessage.run({
      auth: auth('u_' + role, role, SID, 'A'),
      data: Object.assign({}, replyPayload, {
        requestId: requestId('reply-denied-' + role)
      })
    }));
  });
}

await test('reply cannot cross board or forge identity fields', async function () {
  await rejectsCode('not-found', functions.replyToBulletinMessage.run({
    auth: commander,
    data: Object.assign({}, replyPayload, {
      subStationId: 'second',
      requestId: requestId('reply-cross-board')
    })
  }));
  await rejectsCode('invalid-argument', functions.replyToBulletinMessage.run({
    auth: commander,
    data: Object.assign({}, replyPayload, {
      requestId: requestId('reply-forged'), by_name: 'זיוף'
    })
  }));
});

await test('ordinary member cannot invoke the hide-reply callable', async function () {
  await rejectsCode('permission-denied', functions.hideBulletinReply.run({
    auth: firefighter,
    data: {
      sid: SID, subStationId: SUB,
      messageId: firstResult.id, replyId: firstReply.id
    }
  }));
});

await test('super soft-hides a reply and decrements the visible count once', async function () {
  const superAuth = {
    uid: 'u_super',
    token: { email: 'fire102.shits@gmail.com', super: true }
  };
  const payload = {
    sid: SID, subStationId: SUB,
    messageId: firstResult.id, replyId: firstReply.id
  };
  const hidden = await functions.hideBulletinReply.run({
    auth: superAuth, data: payload
  });
  assert.equal(hidden.alreadyHidden, false);
  const reply = await db.doc(
    `stations/${SID}/sub_stations/${SUB}/bulletin_messages/${firstResult.id}/bulletin_replies/${firstReply.id}`
  ).get();
  assert.equal(reply.data().hidden, true);
  const parent = await db.doc(
    `stations/${SID}/sub_stations/${SUB}/bulletin_messages/${firstResult.id}`
  ).get();
  assert.equal(parent.data().reply_count, 1);
  const again = await functions.hideBulletinReply.run({
    auth: superAuth, data: payload
  });
  assert.equal(again.alreadyHidden, true);
  const after = await db.doc(
    `stations/${SID}/sub_stations/${SUB}/bulletin_messages/${firstResult.id}`
  ).get();
  assert.equal(after.data().reply_count, 1);
});

await test('ordinary member cannot invoke the hide callable', async function () {
  await rejectsCode('permission-denied', functions.hideBulletinMessage.run({
    auth: firefighter,
    data: { sid: SID, subStationId: SUB, messageId: firstResult.id }
  }));
});

await test('super hides every broadcast copy, including an archived board', async function () {
  await db.doc(`stations/${SID}/sub_stations/second`).set({
    status: 'inactive'
  }, { merge: true });
  const hidden = await functions.hideBulletinMessage.run({
    auth: {
      uid: 'u_super',
      token: { email: 'fire102.shits@gmail.com', super: true }
    },
    data: { sid: SID, subStationId: SUB, messageId: broadcastResult.id }
  });
  assert.equal(hidden.ok, true);
  assert.equal(hidden.broadcast, true);
  assert.equal(hidden.targetCount, 2);
  assert.equal(hidden.hiddenCount, 2);
  for (const boardId of [SUB, 'second']) {
    const snap = await db.doc(
      `stations/${SID}/sub_stations/${boardId}/bulletin_messages/${broadcastResult.id}`
    ).get();
    assert.equal(snap.data().hidden, true);
    assert.equal(snap.data().hidden_by, 'u_super');
  }
});

await test('super soft-hides and seals an audit record', async function () {
  const superAuth = {
    uid: 'u_super',
    token: { email: 'fire102.shits@gmail.com', super: true }
  };
  const hidden = await functions.hideBulletinMessage.run({
    auth: superAuth,
    data: { sid: SID, subStationId: SUB, messageId: firstResult.id }
  });
  assert.equal(hidden.ok, true);
  assert.equal(hidden.alreadyHidden, false);

  const snap = await db.doc(
    `stations/${SID}/sub_stations/${SUB}/bulletin_messages/${firstResult.id}`
  ).get();
  const value = snap.data();
  assert.equal(value.hidden, true);
  assert.equal(value.hidden_by, 'u_super');
  assert.equal(value.hidden_at instanceof admin.firestore.Timestamp, true);

  const audits = await db.collection('admin_audit')
    .where('action', '==', 'hide_bulletin_message').get();
  assert.equal(audits.size, 2);
  assert.equal(audits.docs.every(function (doc) {
    return doc.data().outcome === 'done';
  }), true);
  const broadcastAudit = audits.docs.map(function (doc) { return doc.data(); })
    .find(function (entry) { return entry.broadcast === true; });
  assert.equal(broadcastAudit.target_count, 2);
  assert.equal(broadcastAudit.message_paths.length, 2);
});

await test('hiding an already-hidden message is idempotent', async function () {
  const hidden = await functions.hideBulletinMessage.run({
    auth: {
      uid: 'u_super',
      token: { email: 'fire102.shits@gmail.com', super: true }
    },
    data: { sid: SID, subStationId: SUB, messageId: firstResult.id }
  });
  assert.equal(hidden.alreadyHidden, true);
});

console.log('\n' + passed + ' callable integration tests passed against Firestore emulator.');
await admin.app().delete();
}

main().catch(async function (error) {
  console.error(error);
  try { await admin.app().delete(); } catch (ignore) {}
  process.exitCode = 1;
});
