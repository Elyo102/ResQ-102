'use strict';

// Contract tests for bulletin-receipts.js.  This file intentionally lands
// before the implementation: a receipt is evidence about an authenticated
// person and must not be designed around whatever storage code happens to be
// easiest to write.
const assert = require('node:assert/strict');
const { Timestamp } = require('firebase-admin/firestore');
const {
  createBulletinReceipts,
  PAGE_SIZE,
  RETENTION_MS
} = require('./bulletin-receipts');

const NOW = Date.parse('2026-09-14T08:00:00.000Z');
const AUTH_TIME = Date.parse('2026-09-14T07:00:00.000Z') / 1000;
const MESSAGE_ID = 'a'.repeat(64);

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const clone = value => {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (value instanceof Date || (typeof value.toMillis === 'function' && typeof value.toDate === 'function')) return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
};

class Snapshot {
  constructor(ref, value) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = value !== undefined;
    this._value = clone(value);
  }
  data() { return clone(this._value); }
}

class DocRef {
  constructor(db, path) {
    this.db = db;
    this.path = String(path).replace(/^\/+|\/+$/g, '');
    const parts = this.path.split('/');
    this.id = parts[parts.length - 1];
  }
  get parent() {
    const parts = this.path.split('/');
    return new Query(this.db, parts.slice(0, -1).join('/'));
  }
  collection(name) { return new Query(this.db, this.path + '/' + name); }
  async get() { return this.db.snapshot(this); }
  async set(value) { this.db.values.set(this.path, clone(value)); }
  async update(value) {
    if (!this.db.values.has(this.path)) throw new Error('not-found');
    this.db.values.set(this.path, { ...this.db.values.get(this.path), ...clone(value) });
  }
}

class Query {
  constructor(db, path, options = {}) {
    this.db = db;
    this.path = String(path).replace(/^\/+|\/+$/g, '');
    this.options = { ...options };
    const parts = this.path.split('/');
    this.id = parts[parts.length - 1];
  }
  get parent() {
    const parts = this.path.split('/');
    return parts.length > 1 ? new DocRef(this.db, parts.slice(0, -1).join('/')) : null;
  }
  doc(id) { return new DocRef(this.db, this.path + '/' + id); }
  orderBy(field, direction = 'asc') {
    return new Query(this.db, this.path, { ...this.options, order: [field, direction] });
  }
  startAfter(cursor) {
    return new Query(this.db, this.path, { ...this.options, cursor: cursor && cursor.id ? cursor.id : cursor });
  }
  limit(n) { return new Query(this.db, this.path, { ...this.options, limit: n }); }
  where(field, op, value) {
    const filters = (this.options.filters || []).concat([[field, op, value]]);
    return new Query(this.db, this.path, { ...this.options, filters });
  }
  async get() { return this.db.query(this); }
}

class FakeDb {
  constructor() { this.values = new Map(); this.transactionTail = Promise.resolve(); }
  doc(path) { return new DocRef(this, path); }
  collection(path) { return new Query(this, path); }
  snapshot(ref) { return new Snapshot(ref, this.values.get(ref.path)); }
  async getAll(...refs) { this.getAllCalls = (this.getAllCalls || 0) + 1; return refs.map(ref => this.snapshot(ref)); }
  runTransaction(work) {
    // Firestore retries/serializes a conflicting transaction.  Serializing the
    // fake preserves the externally relevant guarantee for the concurrency
    // case without pretending that this is an emulator.
    const run = this.transactionTail.then(() => this.runTransactionNow(work));
    this.transactionTail = run.catch(() => {});
    return run;
  }
  async runTransactionNow(work) {
    const writes = [];
    const tx = {
      get: async ref => ref instanceof Query ? this.query(ref) : this.snapshot(ref),
      create: (ref, value) => writes.push(['create', ref, clone(value)]),
      set: (ref, value, options) => writes.push(['set', ref, clone(value), options]),
      update: (ref, value) => writes.push(['update', ref, clone(value)])
    };
    const result = await work(tx);
    for (const [kind, ref, value, options] of writes) {
      const old = this.values.get(ref.path);
      if (kind === 'create' && old !== undefined) throw Object.assign(new Error('already-exists'), { code: 6 });
      if (kind === 'update' && old === undefined) throw Object.assign(new Error('not-found'), { code: 5 });
      this.values.set(ref.path, kind === 'update' || (kind === 'set' && options && options.merge)
        ? { ...(old || {}), ...value } : value);
    }
    return result;
  }
  async query(query) {
    const prefix = query.path + '/';
    let docs = [...this.values.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, value]) => new Snapshot(new DocRef(this, path), value));
    for (const [field, op, expected] of query.options.filters || []) {
      assert.ok(op === '==' || op === 'array-contains', 'fake supports == and array-contains filters only');
      docs = docs.filter(doc => op === '=='
        ? doc.data()[field] === expected
        : Array.isArray(doc.data()[field]) && doc.data()[field].includes(expected));
    }
    const [field = '__name__', direction = 'asc'] = query.options.order || [];
    const sortKey = value => (value && typeof value.toMillis === 'function')
      ? String(value.toMillis()).padStart(20, '0') : String(value);
    docs.sort((a, b) => {
      const av = field === '__name__' ? a.id : a.data()[field];
      const bv = field === '__name__' ? b.id : b.data()[field];
      const result = sortKey(av).localeCompare(sortKey(bv));
      return direction === 'desc' ? -result : result;
    });
    if (query.options.cursor !== undefined) {
      const index = docs.findIndex(doc => doc.id === query.options.cursor);
      docs = index < 0 ? [] : docs.slice(index + 1);
    }
    if (query.options.limit !== undefined) docs = docs.slice(0, query.options.limit);
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

function fixture() {
  const db = new FakeDb();
  const records = new Map();
  const authState = { reads: 0, hook: null };
  let currentNow = NOW;
  const sid = 'station_alpha';
  const people = {};
  const add = (name, role = 'firefighter', options = {}) => {
    const uid = options.uid || name + '_uid';
    const claims = { stationId: options.stationId || sid, role, ...(options.super === true ? { super: true } : {}) };
    records.set(uid, {
      uid,
      disabled: options.disabled === true,
      customClaims: claims,
      tokensValidAfterTime: new Date((options.validAfter || AUTH_TIME) * 1000).toUTCString()
    });
    if (options.profile !== false) db.values.set(`stations/${sid}/users/${uid}`, {
      stationId: sid, full_name: options.fullName || name, role,
      active: options.active !== false, is_active: options.active !== false
    });
    people[name] = { uid, claims };
    return people[name];
  };
  add('reader', 'firefighter', { fullName: 'קורא ראשון' });
  add('other', 'firefighter', { fullName: 'קורא שני' });
  add('commander', 'commander', { fullName: 'ראש משמרת' });
  add('deputy', 'deputy', { fullName: 'סגן ראש משמרת' });
  add('hr', 'hr_coordinator', { fullName: 'משאבי אנוש' });
  add('stationCommand', 'station_commander', { fullName: 'מפקד תחנה' });
  add('super', 'super_admin', { fullName: 'מנהל על', super: true });
  db.values.set(`stations/${sid}/sub_stations/board_a`, { name: 'ראשית', active: true, status: 'active' });
  db.values.set(`stations/${sid}/sub_stations/board_b`, { name: 'שחמון', active: true, status: 'active' });
  const putMessage = (board, id = MESSAGE_ID, extra = {}) => db.values.set(
    `stations/${sid}/sub_stations/${board}/bulletin_messages/${id}`,
    { kind: 'bulletin', audience: 'board', hidden: false, created_key: '2026-09-14T07:55:00.000Z', ...extra }
  );
  putMessage('board_a');
  const auth = { async getUser(uid) {
    authState.reads++;
    if (typeof authState.hook === 'function') await authState.hook({ uid, read: authState.reads, records, db });
    const value = records.get(uid);
    if (!value) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' });
    return clone(value);
  } };
  const service = createBulletinReceipts({ db, auth, HttpsError, clock: () => currentNow });
  const req = (name, data, token = {}) => ({
    auth: { uid: people[name].uid, token: { ...people[name].claims, auth_time: AUTH_TIME, ...token } }, data
  });
  const input = (extra = {}) => ({ sub_station_id: 'board_a', message_id: MESSAGE_ID, ...extra });
  return { db, records, sid, people, add, putMessage, service, req, input, authState,
    setNow(value) { currentNow = value; } };
}

const rejects = (promise, code) => assert.rejects(promise, error => error && error.code === code);
const receiptDocs = db => [...db.values.values()].filter(value => value && value.schema === 'bulletin-view-receipt-v1');
let passed = 0;
async function check(name, body) {
  await body();
  passed++;
  console.log('PASS ' + name);
}

(async () => {
  await check('input is closed; station, identity, name and presentation role cannot be supplied', async () => {
    const f = fixture();
    await rejects(f.service.markViewed({ data: f.input() }), 'unauthenticated');
    for (const injected of [
      { station_id: f.sid }, { board_id: 'board_b' }, { recipient_uid: f.people.other.uid },
      { recipient_name: 'שם מזויף' }, { viewed_at_ms: NOW }, { presentation_role: 'firefighter' },
      { message_id: '../escape' }, { sub_station_id: '../escape' }
    ]) await rejects(f.service.markViewed(f.req('reader', f.input(injected))), 'invalid-argument');
    assert.equal(receiptDocs(f.db).length, 0);
  });

  await check('receipt derives station, board, uid, name and time from trusted live records', async () => {
    const f = fixture();
    const result = await f.service.markViewed(f.req('reader', f.input()));
    assert.deepEqual(result, { outcome: 'created', viewed_at_ms: NOW });
    const [saved] = receiptDocs(f.db);
    assert.equal(saved.station_id, f.sid);
    assert.equal(saved.sub_station_id, 'board_a');
    assert.equal(saved.message_id, MESSAGE_ID);
    assert.equal(saved.recipient_uid, f.people.reader.uid);
    assert.equal(saved.recipient_name_snapshot, 'קורא ראשון');
    assert.equal(saved.viewed_at_ms, NOW);
    assert.ok(saved.expires_at instanceof Date);
    assert.equal(saved.expires_at.getTime(), NOW + RETENTION_MS);
  });

  await check('same viewer and message is idempotent under retry and concurrency', async () => {
    const f = fixture();
    const first = await f.service.markViewed(f.req('reader', f.input()));
    const retry = await f.service.markViewed(f.req('reader', f.input()));
    assert.deepEqual(first, { outcome: 'created', viewed_at_ms: NOW });
    assert.deepEqual(retry, { outcome: 'no_change', viewed_at_ms: NOW });
    const concurrent = await Promise.all([
      f.service.markViewed(f.req('reader', f.input())),
      f.service.markViewed(f.req('reader', f.input()))
    ]);
    assert.ok(concurrent.every(item => item.viewed_at_ms === NOW));
    assert.equal(receiptDocs(f.db).length, 1);
  });

  await check('Firestore Timestamp survives duplicate and viewer-list validation', async () => {
    const f = fixture();
    await f.service.markViewed(f.req('reader', f.input()));
    const entry = [...f.db.values.entries()].find(([, value]) => value && value.schema === 'bulletin-view-receipt-v1');
    entry[1].viewed_at = Timestamp.fromMillis(NOW);
    entry[1].expires_at = Timestamp.fromMillis(NOW + RETENTION_MS);
    assert.deepEqual(await f.service.markViewed(f.req('reader', f.input())),
      { outcome:'no_change', viewed_at_ms:NOW });
    const page = await f.service.listViewers(f.req('commander', f.input()));
    assert.equal(page.items.length, 1);
  });

  await check('an expired receipt is refreshed during TTL deletion lag', async () => {
    const f = fixture();
    await f.service.markViewed(f.req('reader', f.input()));
    const refreshedAt = NOW + RETENTION_MS + 1;
    f.setNow(refreshedAt);
    assert.deepEqual(await f.service.markViewed(f.req('reader', f.input())),
      { outcome: 'refreshed', viewed_at_ms: refreshedAt });
    const page = await f.service.listViewers(f.req('commander', f.input()));
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].viewed_at_ms, refreshedAt);
    assert.equal(receiptDocs(f.db).length, 1);
  });

  await check('live Auth is revalidated at write and private-return boundaries', async () => {
    const writeCase = fixture();
    writeCase.authState.hook = ({ uid, read, records }) => {
      if (uid === writeCase.people.reader.uid && read === 2) records.get(uid).customClaims.role = 'deputy';
    };
    await rejects(writeCase.service.markViewed(writeCase.req('reader', writeCase.input())), 'permission-denied');
    assert.equal(receiptDocs(writeCase.db).length, 0);

    const listCase = fixture();
    await listCase.service.markViewed(listCase.req('reader', listCase.input()));
    const boundaryRead = listCase.authState.reads + 2;
    listCase.authState.hook = ({ uid, read, records }) => {
      if (uid === listCase.people.commander.uid && read === boundaryRead) records.get(uid).disabled = true;
    };
    await rejects(listCase.service.listViewers(listCase.req('commander', listCase.input())), 'permission-denied');
  });

  await check('an existing receipt never bypasses the requested board message', async () => {
    const f = fixture();
    await f.service.markViewed(f.req('reader', f.input()));
    const boardB = { sub_station_id: 'board_b', message_id: MESSAGE_ID };
    await rejects(f.service.markViewed(f.req('reader', boardB)), 'not-found');
    f.putMessage('board_b', MESSAGE_ID);
    await rejects(f.service.markViewed(f.req('reader', boardB)), 'failed-precondition');
    assert.equal(receiptDocs(f.db).length, 1);
  });

  await check('broadcast copies collapse to one logical receipt per viewer', async () => {
    const f = fixture(), broadcastId = 'b'.repeat(64);
    f.putMessage('board_a', MESSAGE_ID, { audience: 'all_sub_stations', broadcast_id: broadcastId,
      sub_station_ids: ['board_a', 'board_b'] });
    f.putMessage('board_b', MESSAGE_ID, { audience: 'all_sub_stations', broadcast_id: broadcastId,
      sub_station_ids: ['board_a', 'board_b'] });
    assert.equal((await f.service.markViewed(f.req('reader', f.input()))).outcome, 'created');
    assert.equal((await f.service.markViewed(f.req('reader', {
      sub_station_id: 'board_b', message_id: MESSAGE_ID
    }))).outcome, 'no_change');
    assert.equal(receiptDocs(f.db).length, 1);
    const fromA = await f.service.listViewers(f.req('commander', f.input()));
    const fromB = await f.service.listViewers(f.req('commander', {
      sub_station_id: 'board_b', message_id: MESSAGE_ID
    }));
    assert.deepEqual(fromA.items, fromB.items);
  });

  await check('viewer listing revalidates the original broadcast copy', async () => {
    for (const removeOriginal of [false, true]) {
      const f = fixture(), broadcastId = 'c'.repeat(64);
      f.putMessage('board_a', MESSAGE_ID, { audience: 'all_sub_stations', broadcast_id: broadcastId });
      f.putMessage('board_b', MESSAGE_ID, { audience: 'all_sub_stations', broadcast_id: broadcastId });
      await f.service.markViewed(f.req('reader', f.input()));
      const originalPath = `stations/${f.sid}/sub_stations/board_a/bulletin_messages/${MESSAGE_ID}`;
      if (removeOriginal) f.db.values.delete(originalPath);
      else f.db.values.get(originalPath).hidden = true;
      await rejects(f.service.listViewers(f.req('commander', {
        sub_station_id: 'board_b', message_id: MESSAGE_ID
      })), 'failed-precondition');
    }
  });

  await check('locator never crosses token station and source state is revalidated', async () => {
    const f = fixture();
    await rejects(f.service.markViewed(f.req('reader', { sub_station_id: 'missing', message_id: MESSAGE_ID })), 'not-found');
    f.putMessage('board_a', MESSAGE_ID, { hidden: true });
    await rejects(f.service.markViewed(f.req('reader', f.input())), 'not-found');
    f.putMessage('board_a');
    f.db.values.set(`stations/${f.sid}/sub_stations/board_a`, { active: false, status: 'inactive' });
    await rejects(f.service.markViewed(f.req('reader', f.input())), 'failed-precondition');
    assert.equal(receiptDocs(f.db).length, 0);
  });

  await check('disabled, inactive, transferred, changed-role and revoked identities fail closed', async () => {
    for (const mutate of [
      f => { f.records.get(f.people.reader.uid).disabled = true; },
      f => { const p = f.db.values.get(`stations/${f.sid}/users/${f.people.reader.uid}`); p.active = false; p.is_active = false; },
      f => { f.records.get(f.people.reader.uid).customClaims.stationId = 'station_other'; },
      f => { f.records.get(f.people.reader.uid).customClaims.role = 'deputy'; },
      f => { f.records.get(f.people.reader.uid).tokensValidAfterTime = new Date((AUTH_TIME + 1) * 1000).toUTCString(); }
    ]) {
      const f = fixture(); mutate(f);
      await rejects(f.service.markViewed(f.req('reader', f.input())), 'permission-denied');
      assert.equal(receiptDocs(f.db).length, 0);
    }
  });

  await check('only commander, deputy and exact boolean super list viewers', async () => {
    const f = fixture();
    await f.service.markViewed(f.req('reader', f.input()));
    for (const name of ['commander', 'deputy', 'super']) {
      const page = await f.service.listViewers(f.req(name, f.input()));
      assert.equal(page.items.length, 1, name);
    }
    for (const name of ['reader', 'hr', 'stationCommand']) {
      await rejects(f.service.listViewers(f.req(name, f.input())), 'permission-denied');
    }
    await rejects(f.service.listViewers(f.req('reader', f.input(), { super: 'true' })), 'permission-denied');
  });

  await check('viewer output is minimal, paginated on demand and cursor-bound', async () => {
    const f = fixture();
    assert.ok(Number.isSafeInteger(PAGE_SIZE) && PAGE_SIZE >= 10 && PAGE_SIZE <= 100);
    for (let i = 0; i < PAGE_SIZE + 2; i++) {
      const name = 'member' + String(i).padStart(3, '0');
      f.add(name, 'firefighter', { fullName: 'עובד ' + i });
      await f.service.markViewed(f.req(name, f.input()));
    }
    const first = await f.service.listViewers(f.req('commander', f.input()));
    assert.equal(first.items.length, PAGE_SIZE);
    assert.equal(typeof first.next_cursor, 'string');
    assert.deepEqual(Object.keys(first.items[0]).sort(),
      ['recipient_name_snapshot', 'recipient_uid', 'viewed_at_ms'].sort());
    const second = await f.service.listViewers(f.req('commander', f.input({ cursor: first.next_cursor })));
    assert.equal(second.items.length, 2);
    assert.equal(second.next_cursor, null);
    const all = first.items.concat(second.items).map(item => item.recipient_uid);
    assert.equal(new Set(all).size, PAGE_SIZE + 2);
    await rejects(f.service.listViewers(f.req('commander', f.input({ cursor: '../bad' }))), 'invalid-argument');
  });

  await check('first-seen name and timestamp remain immutable after profile changes', async () => {
    const f = fixture();
    await f.service.markViewed(f.req('reader', f.input()));
    f.db.values.get(`stations/${f.sid}/users/${f.people.reader.uid}`).full_name = 'שם חדש';
    const retry = await f.service.markViewed(f.req('reader', f.input()));
    assert.equal(retry.outcome, 'no_change');
    const page = await f.service.listViewers(f.req('commander', f.input()));
    assert.equal(page.items[0].recipient_name_snapshot, 'קורא ראשון');
    assert.equal(page.items[0].viewed_at_ms, NOW);
  });

  await check('hidden source cannot leak viewer list and corrupt receipts fail closed', async () => {
    const f = fixture();
    await f.service.markViewed(f.req('reader', f.input()));
    f.putMessage('board_a', MESSAGE_ID, { hidden: true });
    await rejects(f.service.listViewers(f.req('commander', f.input())), 'not-found');
    f.putMessage('board_a');
    const entry = [...f.db.values.entries()].find(([, value]) => value && value.schema === 'bulletin-view-receipt-v1');
    entry[1].recipient_uid = f.people.other.uid;
    await rejects(f.service.listViewers(f.req('commander', f.input())), 'failed-precondition');
  });

  // ---- 42H.20 · Codex blocker 3 · getAlertsFeed / alertsFeed ----
  const feedFixture = () => {
    const f = fixture();
    const ms = iso => Date.parse(iso);
    const put = (board, id, iso, extra = {}) => f.db.values.set(
      `stations/${f.sid}/sub_stations/${board}/bulletin_messages/${id}`,
      { kind: 'bulletin', audience: 'board', hidden: false, text: 'הודעה ' + id, by_name: 'כותב',
        created_key: iso, created_at: Timestamp.fromMillis(ms(iso)), ...extra });
    const receipt = (id, uid, extra = {}) => f.db.values.set(
      `stations/${f.sid}/bulletin_view_receipts/${id}/bulletin_view_recipients/${uid}`,
      { schema: 'bulletin-view-receipt-v1', station_id: f.sid, sub_station_id: 'board_a', message_id: id,
        broadcast_id: '', recipient_uid: uid, recipient_name_snapshot: 'קורא', viewed_at_ms: NOW - 1000,
        viewed_at: new Date(NOW - 1000), message_created_key: '', expires_at: new Date(NOW + 1000), ...extra });
    const callout = (id, iso, uids, extra = {}) => f.db.values.set(`stations/${f.sid}/callouts/${id}`,
      { text: 'קריאה ' + id, by_name: 'מפקד', active: true, uids, created_key: iso, ...extra });
    f.db.values.delete(`stations/${f.sid}/sub_stations/board_a/bulletin_messages/${MESSAGE_ID}`);
    return { ...f, put, receipt, callout };
  };

  await check('feed: input is closed and needs a live member — the failure is an error, never "unread"', async () => {
    const f = feedFixture();
    await rejects(f.service.alertsFeed({ data: {} }), 'unauthenticated');
    await rejects(f.service.alertsFeed(f.req('reader', { station_id: 'other' })), 'invalid-argument');
    f.records.get(f.people.reader.uid).disabled = true;
    await rejects(f.service.alertsFeed(f.req('reader', {})), 'permission-denied');
  });

  await check('feed: only the caller\'s own valid receipt marks viewed; another user\'s receipt and an expired one never do', async () => {
    const f = feedFixture();
    f.put('board_a', 'm1', '2026-09-14T07:50:00.000Z');
    f.put('board_a', 'm2', '2026-09-14T07:51:00.000Z');
    f.put('board_a', 'm3', '2026-09-14T07:52:00.000Z');
    f.put('board_a', 'm4', '2026-09-14T07:53:00.000Z', { by_uid: f.people.reader.uid });
    f.receipt('m1', f.people.reader.uid);
    f.receipt('m2', f.people.other.uid);
    f.receipt('m3', f.people.reader.uid, { expires_at: new Date(NOW - 1) });
    const out = await f.service.alertsFeed(f.req('reader', {}));
    assert.equal(out.schema, 'alerts-feed-v1');
    const viewed = Object.fromEntries(out.items.map(item => [item.id, item.viewed]));
    assert.deepEqual(viewed, { 'board_a/m1': true, 'board_a/m2': false, 'board_a/m3': false, 'board_a/m4': true });
    assert.equal(out.unread_count, 2);
    assert.equal(out.items[0].id, 'board_a/m4', 'newest first');
    assert.ok(out.items.every(item => !('recipient_uid' in item) && !('recipient_name_snapshot' in item)));
  });

  await check('feed: a malformed own receipt is not viewed (schema is verified, not just existence)', async () => {
    const f = feedFixture();
    f.put('board_a', 'm1', '2026-09-14T07:50:00.000Z');
    f.receipt('m1', f.people.reader.uid, { station_id: 'another_station' });
    const out = await f.service.alertsFeed(f.req('reader', {}));
    assert.equal(out.items[0].viewed, false);
    assert.equal(out.unread_count, 1);
  });

  await check('feed: one batched receipt read and one batched response read — never a read per item', async () => {
    const f = feedFixture();
    for (let i = 0; i < 8; i++) f.put('board_a', 'a' + i, '2026-09-14T07:0' + i + ':00.000Z');
    for (let i = 0; i < 6; i++) f.put('board_b', 'b' + i, '2026-09-14T06:0' + i + ':00.000Z');
    for (let i = 0; i < 5; i++) f.callout('c' + i, '2026-09-13T0' + i + ':00:00.000Z', [f.people.reader.uid]);
    f.db.getAllCalls = 0;
    const out = await f.service.alertsFeed(f.req('reader', {}));
    assert.equal(f.db.getAllCalls, 2);
    assert.equal(out.window.candidates, 19);
    assert.equal(out.items.length, 19);
  });

  await check('feed: unread_count counts every candidate in the window, not only the 30 returned items', async () => {
    const f = feedFixture();
    for (let i = 0; i < 10; i++) f.put('board_a', 'a' + String(i).padStart(2, '0'), '2026-09-14T07:' + String(10 + i) + ':00.000Z');
    for (let i = 0; i < 10; i++) f.put('board_b', 'b' + String(i).padStart(2, '0'), '2026-09-14T06:' + String(10 + i) + ':00.000Z');
    for (let i = 0; i < 25; i++) f.callout('c' + String(i).padStart(2, '0'), '2026-09-13T' + String(i).padStart(2, '0') + ':00:00.000Z', [f.people.reader.uid]);
    const out = await f.service.alertsFeed(f.req('reader', {}));
    assert.equal(out.items.length, 30);
    assert.equal(out.window.candidates, 45);
    assert.equal(out.unread_count, 45);
  });

  await check('feed: a per-board limit of 10 newest and a callout limit of 25 bound the server work', async () => {
    const f = feedFixture();
    for (let i = 0; i < 14; i++) f.put('board_a', 'a' + String(i).padStart(2, '0'), '2026-09-14T07:' + String(10 + i) + ':00.000Z');
    for (let i = 0; i < 30; i++) f.callout('c' + String(i).padStart(2, '0'), '2026-09-13T' + String(i).padStart(2, '0') + ':00:00.000Z', [f.people.reader.uid]);
    const out = await f.service.alertsFeed(f.req('reader', {}));
    assert.equal(out.window.candidates, 35);
    assert.equal(out.items.filter(item => item.kind === 'bulletin').length, 10);
    assert.ok(out.items.filter(item => item.kind === 'bulletin').every(item => Number(item.id.slice(-2)) >= 4), 'the 10 newest, not the oldest');
  });

  await check('feed: callouts include closed ones for the recipient only, and seen_at on the own response marks viewed', async () => {
    const f = feedFixture();
    f.callout('open', '2026-09-13T10:00:00.000Z', [f.people.reader.uid]);
    f.callout('closed', '2026-09-13T09:00:00.000Z', [f.people.reader.uid], { active: false });
    f.callout('foreign', '2026-09-13T11:00:00.000Z', [f.people.other.uid]);
    f.db.values.set(`stations/${f.sid}/callouts/closed/responses/${f.people.reader.uid}`, { seen_at: '2026-09-13T09:01:00.000Z' });
    f.db.values.set(`stations/${f.sid}/callouts/open/responses/${f.people.other.uid}`, { seen_at: '2026-09-13T10:01:00.000Z' });
    const out = await f.service.alertsFeed(f.req('reader', {}));
    assert.deepEqual(out.items.map(item => [item.id, item.active, item.viewed]),
      [['open', true, false], ['closed', false, true]]);
    assert.equal(out.unread_count, 1);
  });

  await check('feed: hidden messages and inactive boards are excluded; a revoked token after the private reads is refused', async () => {
    const f = feedFixture();
    f.put('board_a', 'shown', '2026-09-14T07:50:00.000Z');
    f.put('board_a', 'gone', '2026-09-14T07:51:00.000Z', { hidden: true });
    f.db.values.set(`stations/${f.sid}/sub_stations/board_c`, { name: 'ארכיון', active: false });
    f.put('board_c', 'archived', '2026-09-14T07:52:00.000Z');
    const out = await f.service.alertsFeed(f.req('reader', {}));
    assert.deepEqual(out.items.map(item => item.id), ['board_a/shown']);
    f.authState.hook = async ({ read, records }) => {
      if (read === 2) records.get(f.people.reader.uid).tokensValidAfterTime = new Date((AUTH_TIME + 60) * 1000).toUTCString();
    };
    f.authState.reads = 0;
    await rejects(f.service.alertsFeed(f.req('reader', {})), 'permission-denied');
  });

  await check('retention is explicit and bounded', async () => {
    assert.ok(Number.isSafeInteger(RETENTION_MS));
    assert.ok(RETENTION_MS >= 24 * 60 * 60 * 1000);
    assert.ok(RETENTION_MS <= 400 * 24 * 60 * 60 * 1000);
  });

  console.log(`bulletin receipts: ${passed}/${passed} passed`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

/*
Mutation obligations (each is killed by a named case above):
1. Trust data.station_id / recipient_uid / recipient_name.
2. Accept `super: "true"` or a role-shaped presentation field.
3. Use board input as stored authority without reading the source document.
4. Key a receipt by board copy instead of logical broadcast id.
5. Replace create-or-no_change with an unconditional timestamp overwrite.
6. Skip the second live role/station/revocation comparison at write or private return.
7. Permit HR or station_commander to list viewers.
8. Return email, employee number, role or claims in viewer DTOs.
9. List a hidden source message's receipts.
10. Drop cursor validation or page limit.
11. Rewrite name snapshot after a later profile rename.
12. Omit expires_at or derive it from client time.
13. Treat an expired-but-not-yet-deleted receipt as permanent no_change.
14. Return no_change for a different board without validating its source message.
15. Expose a cross-board receipt after its original broadcast copy is hidden or removed.
*/
