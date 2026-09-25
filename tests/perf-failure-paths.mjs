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
  const start = body.indexOf('async function ' + name + '(');
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
    SID: 'station-a', AUTH_GEN: 1, shots: {}, shotsInflight: {}, db: {},
    collection: (...parts) => parts.join('/'),
    getDocs: () => (++reads === 1 ? old.promise : fresh.promise),
    paintShots: (list, box) => paints.push({ list, box })
  };
  vm.createContext(context);
  vm.runInContext(functionText(body, 'loadShots'), context);
  const first = context.loadShots({ id: 'fault-1' }, {});
  context.AUTH_GEN = 2;
  context.shots = {};
  context.shotsInflight = {};
  const second = context.loadShots({ id: 'fault-1' }, {});
  const newRequest = context.shotsInflight['station-a:fault-1'];
  old.resolve({ forEach: fn => fn({ data: () => ({ data: 'old' }) }) });
  await first;
  assert.equal(context.shotsInflight['station-a:fault-1'], newRequest);
  assert.equal(paints.length, 0);
  fresh.resolve({ forEach: fn => fn({ data: () => ({ data: 'new' }) }) });
  await second;
  assert.equal(reads, 2);
  assert.equal(paints.length, 1);
  assert.equal(paints[0].list[0].data, 'new');
  console.log('PASS photos same-station identity race');
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
