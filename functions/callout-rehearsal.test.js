'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const body = source.slice(source.indexOf('exports.sendCallout ='), source.indexOf('exports.listCalloutRecipients ='));
const sid = 'station_rehearsal';
const sender = 'commander_rehearsal';
const recipient = 'firefighter_rehearsal';
let record = null;
let writes = 0;
let providerCalls = 0;

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const db = {
  doc(docPath) { return { path:docPath, id:docPath.split('/').pop() }; },
  collection() { return { where() { return this; }, async get() { return { forEach() {} }; } }; },
  async runTransaction(fn) {
    return fn({
      async get(ref) { return { exists:record !== null, data:() => structuredClone(record), ref }; },
      set(_ref, value) { writes += 1; record = structuredClone(value); }
    });
  }
};

const context = {
  exports:{}, onCall:(_options, fn) => fn, CALLOUT_OPTIONS:{}, db, crypto, HttpsError,
  console, Date, Array, Number, String, JSON, Object, Promise,
  freshCalloutActor:async () => ({ sid, homeSid:sid, role:'commander', crew:'A', name:'מפקד בדיקה',
    claims:{}, email:'commander@example.test', isSuper:false }),
  uidsInCrew:async () => [sender, recipient], runtimeFresh:async () => ({ silent:false }),
  CREW_HE_S:{ A:'א׳' }, CALLOUT_ROLE_HE:{ commander:'מפקד' }, hhmmIL:() => '10:00',
  FV:{ serverTimestamp:() => ({ server:true }) },
  pushToUsers:async () => { providerCalls += 1; throw new Error('rehearsal reached provider'); },
  logSilenced:async () => {}
};
vm.createContext(context);
vm.runInContext(body, context);

(async () => {
  const req = { auth:{ uid:sender }, data:{
    text:'תרגול בחירת נמענים', target:'crew:A', request_id:'rehearsal_request_00000001', rehearsal:true
  } };
  const result = await context.exports.sendCallout(req);
  assert.equal(result.ok, true);
  assert.equal(result.rehearsal, true);
  assert.equal(result.sent, 0);
  assert.equal(result.selected, 1);
  assert.equal(providerCalls, 0);
  assert.equal(writes, 1);
  assert.equal(record.active, false);
  assert.equal(record.delivery_state, 'rehearsal');
  assert.deepEqual(record.uids, []);
  assert.deepEqual(record.rehearsal_uids, [recipient]);

  const replay = await context.exports.sendCallout(req);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.selected, 1);
  assert.equal(providerCalls, 0);
  assert.equal(writes, 1, 'an exact replay must not rewrite the rehearsal');

  const before = structuredClone(record);
  await assert.rejects(context.exports.sendCallout({ auth:{ uid:sender }, data:{
    text:'תרגול בחירת נמענים', target:'crew:A', request_id:'rehearsal_invalid_000001', rehearsal:'true'
  } }), error => error && error.code === 'invalid-argument');
  assert.deepEqual(record, before);
  assert.equal(providerCalls, 0);
  console.log('Callout rehearsal: PASS (server-enforced no provider, no recipient-visible audience, replay-safe)');
})().catch(error => { console.error(error); process.exitCode = 1; });
