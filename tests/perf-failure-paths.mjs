// Execute the production handlers with controlled Firestore/range responses.
// These races and offline paths are not established by source-string tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const functionText = (body, name) => {
  const start = body.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name + ' exists');
  const tail = /\r?\n}\r?\n/g;
  tail.lastIndex = start;
  const match = tail.exec(body);
  assert.ok(match && match.index > start, name + ' terminates');
  return body.slice(start, match.index + match[0].lastIndexOf('}') + 1);
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Hours: a server read failure prevents automatic fill and cannot overwrite
// the previously displayed assignment. An old normal read cannot win a race
// against the later server-confirmed write refresh.
{
  const body = source('attendance.html');
  const pending = deferred();
  let holdOld = false;
  let serverFails = false;
  const messages = [];
  const snap = data => ({ exists: () => true, data: () => data });
  const board = site => snap({ vehicles: [{ active: true, slots: [{ id: 'slot', site }] }] });
  const shift = snap({ assign: { slot: 'user-1' } });
  const context = {
    db: {}, SID: 'station-a', SUBJ: { uid: 'user-1', emp: 1, crew: 'A' },
    viewYear: 2026, viewMonth: 8, mySite: 'old-site', swaps: [], sites: [],
    staticLoadGeneration: 0, staticStationCache: null, staticBoardCache: null,
    staticCacheFresh: () => false,
    scheduleCompatibilityMode: '', effective: null, rotations: [], overrides: {},
    guardMonthRange: () => ({ from: '2026-09-01', to: '2026-09-30' }),
    callEffectiveWorkdays: async () => ({ mode: 'new' }),
    parseEffectiveWorkdays: value => value,
    shiftRotationShim: () => null,
    subStationAvailable: () => true,
    doc: (...parts) => parts.join('/'), collection: (...parts) => parts.join('/'),
    getDoc: ref => holdOld && ref.endsWith('/config/board') ? pending.promise
      : Promise.resolve(ref.endsWith('/config/board') ? board('old-site') : shift),
    getDocs: async () => ({ forEach: () => {} }),
    getDocFromServer: ref => serverFails ? Promise.reject(new Error('offline'))
      : Promise.resolve(ref.endsWith('/config/board') ? board('new-site') : shift),
    getDocsFromServer: async () => ({ forEach: () => {} }),
    msg: value => messages.push(value),
    showLegacyCompatibilityFailure: () => { throw new Error('unexpected compatibility failure'); }
  };
  vm.createContext(context);
  vm.runInContext(functionText(body, 'loadStatic'), context);
  assert.equal(await context.loadStatic(true), true, JSON.stringify(messages));
  assert.equal(context.mySite, 'new-site');
  serverFails = true;
  assert.equal(await context.loadStatic(true), false);
  assert.equal(context.mySite, 'new-site', 'failed server refresh must not stamp empty/stale assignment');
  assert.ok(messages.some(value => value.includes('לא ניתן לאמת')));
  serverFails = false;
  holdOld = true;
  context.staticStationCache = null;
  context.staticBoardCache = null;
  const oldLoad = context.loadStatic();
  assert.equal(await context.loadStatic(true), true);
  pending.resolve(board('old-site'));
  assert.equal(await oldLoad, false);
  assert.equal(context.mySite, 'new-site', 'late old response cannot replace fresh assignment');
  console.log('PASS attendance offline fail-closed and old-response race');
}

// Photos: a late request for the same station under old identity must not
// remove the new identity's in-flight request or paint the new screen.
{
  const body = source('faults.html');
  const old = deferred(), fresh = deferred();
  let reads = 0;
  const paints = [];
  const context = {
    SID: 'station-a', AUTH_GEN: 1, shots: {}, shotsPages: {}, shotsInflight: {}, db: {},
    ME:{ uid:'user-a' }, auth:{ currentUser:{ uid:'user-a' } }, CAN_MANAGE:false,
    collection: (...parts) => parts.join('/'),
    query: ref => ref, orderBy: () => 'id', documentId: () => 'id', limit: n => n,
    getDocs: () => (++reads === 1 ? old.promise : fresh.promise),
    paintShots: (list, box) => paints.push({ list, box }), moreShots: () => {}
  };
  vm.createContext(context);
  for (const name of ['currentUid', 'writeFence', 'assertFence', 'loadShots']) {
    vm.runInContext(functionText(body, name), context);
  }
  const first = context.loadShots({ id: 'fault-1' }, { isConnected:true });
  context.AUTH_GEN = 2;
  context.shots = {};
  context.shotsInflight = {};
  const second = context.loadShots({ id: 'fault-1' }, { isConnected:true });
  const newRequest = context.shotsInflight['station-a:fault-1'];
  old.resolve({ docs:[{ data: () => ({ data: 'old' }) }] });
  await first;
  assert.equal(context.shotsInflight['station-a:fault-1'], newRequest);
  assert.equal(paints.length, 0);
  fresh.resolve({ docs:[{ data: () => ({ data: 'new' }) }] });
  await second;
  assert.equal(reads, 2);
  assert.equal(paints.length, 1);
  assert.equal(paints[0].list[0].data, 'new');
  console.log('PASS photos same-station identity race');
}

// Execute the actual identity fences and both paged loaders. Only currentUser
// changes: the asynchronous observer has NOT yet updated ME/SID/AUTH_GEN.
{
  const body = source('faults.html');
  const makeBox = () => ({ isConnected:true, children:[],
    append(child) { this.children.push(child); }, replaceChildren() { this.children=[]; } });
  const snapshot = count => ({ docs:Array.from({length:count}, (_, i) => ({
    id:String(i), data:() => ({data:'synthetic-photo-' + i}) })) });
  const fixture = () => {
    const pending=[], paints=[], requests=[];
    const context = { SID:'station-a', AUTH_GEN:1, ME:{uid:'a'},
      auth:{currentUser:{uid:'a'}}, CAN_MANAGE:false,
      shots:{}, shotsPages:{}, shotsInflight:{}, db:{},
      collection: (...parts) => parts.slice(1).join('/'),
      query:(ref,...constraints) => ({ref,constraints}), orderBy:() => 'order',
      documentId:() => 'id', limit:n => ({limit:n}), startAfter:doc => ({after:doc.id}),
      getDocs:request => { const next=deferred(); pending.push(next); requests.push(request); return next.promise; },
      document:{createElement:() => ({textContent:'',disabled:false})},
      paintShots:(list,box) => { paints.push(list.slice()); box.replaceChildren(); }
    };
    vm.createContext(context);
    for (const name of ['currentUid','writeFence','assertFence','loadShots','moreShots']) {
      vm.runInContext(functionText(body,name),context);
    }
    return {context,pending,paints,requests};
  };
  const fault={id:'fault-1'}, key='station-a:fault-1';
  for (const outcome of ['success','error']) {
    const f=fixture(), box=makeBox(), task=f.context.loadShots(fault,box);
    f.context.auth.currentUser={uid:'b'};
    if(outcome==='success')f.pending[0].resolve(snapshot(11));
    else f.pending[0].reject(new Error('synthetic-network'));
    await task;
    assert.equal(f.paints.length,0);
    assert.equal(Object.hasOwn(f.context.shots,key),false);
    assert.equal(Object.hasOwn(f.context.shotsPages,key),false);
    assert.equal(box.children.length,0,'no stale error/retry UI');
  }
  {
    const f=fixture(), a=makeBox(), b=makeBox();
    const one=f.context.loadShots(fault,a), two=f.context.loadShots(fault,b);
    assert.equal(f.requests.length,1,'overlap coalesces');
    f.pending[0].resolve(snapshot(11)); await Promise.all([one,two]);
    assert.equal(f.paints.length,2); assert.equal(f.context.shots[key].length,10);
    assert.equal(f.requests[0].constraints.at(-1).limit,11);
    const next=a.children[0].onclick();
    f.pending[1].resolve(snapshot(2)); await next;
    assert.equal(f.context.shots[key].length,12,'same identity can page');
    f.context.auth.currentUser={uid:'b'};
    await f.context.loadShots(fault,makeBox());
    assert.equal(f.paints.length,3,'cached response cannot paint after live UID switch');
    assert.equal(f.requests.length,2);
  }
  for (const outcome of ['success','error']) {
    const f=fixture(), box=makeBox(), task=f.context.loadShots(fault,box);
    f.pending[0].resolve(snapshot(11)); await task;
    const button=box.children[0], state=f.context.shotsPages[key], cursor=state.cursor;
    const next=button.onclick(); f.context.auth.currentUser={uid:'b'};
    if(outcome==='success')f.pending[1].resolve(snapshot(2));
    else f.pending[1].reject(new Error('synthetic-network'));
    await next;
    assert.equal(f.context.shots[key].length,10); assert.equal(state.cursor,cursor);
    assert.equal(f.paints.length,1);
    assert.equal(button.textContent,'עוד תמונות','stale page error must not paint retry');
  }
  console.log('PASS photos live-UID fences: initial success/error, cached hit, page success/error and positive coalescing/paging');
}

// Schedule: imported-display in OFF mode must not invoke the operational
// daily callable. In active mode the daily card can finish while the range
// fails, and must become visible with the month error.
{
  const body = source('schedule-management.js');
  const make = (mode, fetchRange) => {
    let mineCalls = 0;
    const els = {
      mineContent: { children: [], appendChild(item) { this.children.push(item); } },
      mineNote: { textContent: '' }, mineToday: { hidden: false }, mineHead: {}
    };
    const context = {
      state: { authGeneration: 1, month: '2026-09-01', status: { mode } },
      canViewSchedule: () => true, monthStart: () => '2026-09-01',
      renderBoardHead: () => {}, $: id => els[id],
      clear: box => { box.children = []; },
      node: (tag, cls, value) => ({ tag, cls, value, type: '', addEventListener() {} }),
      fetchRange, loadMine: async () => { mineCalls++; return true; },
      renderMineToday: () => {}, daysWithMe: days => days,
      renderBoard: () => {}, watchWeekLabel: () => {}, focusTodayColumn: () => {},
      syncTodayButton: () => {}, publishedLine: () => '', absenceNote: () => '',
      guardsNotice: () => '', isStaleRangeError: () => false,
      errorText: error => error.message
    };
    vm.createContext(context);
    vm.runInContext(functionText(body, 'loadMineRange'), context);
    return { context, els, mineCalls: () => mineCalls };
  };
  const imported = make('off', async () => ({ source: 'imported-display', active: true, days: [] }));
  await imported.context.loadMineRange();
  assert.equal(imported.mineCalls(), 0);
  assert.equal(imported.els.mineToday.hidden, true);
  const broken = make('new', async () => { throw new Error('month unavailable'); });
  await broken.context.loadMineRange();
  assert.equal(broken.mineCalls(), 1);
  assert.equal(broken.els.mineToday.hidden, false);
  assert.ok(broken.els.mineContent.children.some(item => item.cls === 'msg err'));
  console.log('PASS schedule OFF imported-display and active month-failure paths');
}
