'use strict';

const assert = require('node:assert/strict');
const { createHomeCommandCenter } = require('./home-command-center');

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const NOW = 1789275600000;
const PAGE_SIZE = 24;

function fault(id, overrides) {
  return {
    id,
    data:() => Object.assign({
      status:'open', kind:'vehicle', title:'תקלה ' + id,
      severity:'major', subject:'רכב ' + id,
      created_key:'2026-09-13T05:00:00.000Z'
    }, overrides || {})
  };
}

function profile(overrides) {
  return Object.assign({
    full_name:'אלדד יונה', is_active:true, station:'station-a',
    role:'commander', crew:'C'
  }, overrides || {});
}

function snapshotDoc(id, value) {
  return { id, exists:value != null, data:() => value };
}

function harness(options) {
  const opts = Object.assign({
    profiles:[profile(), profile()],
    faults:[fault('major')]
  }, options || {});
  const trace = [];
  let profileRead = 0;

  class Query {
    constructor(path, constraints) { this.path = path; this.constraints = constraints || []; }
    doc(id) { return new DocRef(this.path + '/' + id); }
    where(field, op, value) {
      trace.push(['where', this.path, field, op, value]);
      return new Query(this.path, this.constraints.concat([['where', field, op, value]]));
    }
    orderBy(field, direction) {
      trace.push(['orderBy', this.path, field, direction]);
      return new Query(this.path, this.constraints.concat([['orderBy', field, direction]]));
    }
    limit(value) {
      trace.push(['limit', this.path, value]);
      return new Query(this.path, this.constraints.concat([['limit', value]]));
    }
    async get() {
      trace.push(['query.get', this.path, this.constraints]);
      const cap = this.constraints.find((row) => row[0] === 'limit');
      let docs = opts.faults.filter((doc) => {
        let value;
        try { value = doc && typeof doc.data === 'function' ? doc.data() : null; } catch (_) { return true; }
        return this.constraints.filter((row) => row[0] === 'where').every((row) => {
          if (row[2] === '==') return value && value[row[1]] === row[3];
          if (row[2] === 'in') return value && Array.isArray(row[3]) && row[3].includes(value[row[1]]);
          return true;
        });
      });
      docs = docs.slice(0, cap ? cap[1] : docs.length);
      return { docs, size:docs.length, empty:docs.length === 0 };
    }
  }

  class DocRef {
    constructor(path) { this.path = path; }
    collection(name) { return new Query(this.path + '/' + name); }
    async get() {
      trace.push(['doc.get', this.path]);
      if (this.path.startsWith('users/')) {
        const at = Math.min(profileRead++, Math.max(0, opts.profiles.length - 1));
        return snapshotDoc(this.path.split('/').pop(), opts.profiles[at]);
      }
      return snapshotDoc(this.path.split('/').pop(), null);
    }
  }

  class CollectionRef extends Query {}

  const db = {
    collection(name) { return new CollectionRef(name); },
    doc(path) { return new DocRef(path); },
    async runTransaction(run) {
      trace.push(['transaction.begin']);
      const result = await run({
        get:async ref => {
          trace.push(['tx.get', ref.path]);
          if (/^stations\/[^/]+\/users\/[^/]+$/.test(ref.path)) {
            const at = Math.min(profileRead++, Math.max(0, opts.profiles.length - 1));
            return snapshotDoc(ref.path.split('/').pop(), opts.profiles[at]);
          }
          return snapshotDoc(ref.path.split('/').pop(), null);
        }
      });
      trace.push(['transaction.end']);
      return result;
    }
  };
  const service = createHomeCommandCenter({ db, HttpsError, clock:() => NOW });
  const invoke = async req => {
    if (typeof service === 'function') return service(req);
    if (service && typeof service.get === 'function') return service.get(req);
    throw new TypeError('createHomeCommandCenter must return a handler or { get(req) }');
  };
  const req = (role, data, extraToken) => ({
    auth:{ uid:'u1', token:Object.assign({ stationId:'station-a', role }, extraToken || {}) },
    data:data || {}
  });
  return { trace, invoke, req };
}

function hasOwnDeep(value, forbidden) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => hasOwnDeep(item, forbidden));
  return Object.keys(value).some(key => forbidden.has(key) || hasOwnDeep(value[key], forbidden));
}

function tasks(result) { return Array.isArray(result && result.tasks) ? result.tasks : []; }
function shift(result) { return (result && result.shift) || {}; }

async function rejects(code, run) {
  await assert.rejects(run, error => error && error.code === code);
}

let passed = 0;
async function test(name, run) {
  await run(); passed += 1; console.log('ok - ' + name);
}

(async () => {
  await test('constructor requires the closed dependency contract', async () => {
    assert.throws(() => createHomeCommandCenter(), TypeError);
    assert.throws(() => createHomeCommandCenter({ db:{}, HttpsError, clock:() => NOW }), TypeError);
  });

  await test('unauthenticated calls fail before any database read', async () => {
    const h = harness();
    await rejects('unauthenticated', () => h.invoke({ data:{} }));
    assert.deepEqual(h.trace, []);
  });

  await test('station and role come only from verified token claims', async () => {
    const h = harness({ profiles:[profile({ role:'firefighter' }), profile({ role:'firefighter' })],
      faults:[fault('critical', { severity:'critical' })] });
    await rejects('invalid-argument', () => h.invoke(h.req('firefighter', {
      stationId:'station-evil', station_id:'station-evil', role:'super_admin', super:true
    })));
    assert.equal(h.trace.some(row => row[0] === 'query.get'), false,
      'rejected body still triggered a station query');
    const result = await h.invoke(h.req('firefighter'));
    const query = h.trace.find(row => row[0] === 'query.get');
    assert.equal(query[1], 'stations/station-a/faults');
    assert.equal(tasks(result).length, 0, 'request body escalated firefighter into a manager task');
    assert.equal(result.identity.role, 'firefighter');
  });

  await test('a live profile is checked both before and after the bounded read', async () => {
    const h = harness();
    await h.invoke(h.req('commander'));
    assert.deepEqual(h.trace.filter(row => row[0] === 'tx.get').map(row => row[1]),
      ['stations/station-a/users/u1', 'stations/station-a/users/u1']);
    const events = h.trace.map(row => row[0] + ':' + row[1]);
    assert.ok(events.indexOf('tx.get:stations/station-a/users/u1') < events.indexOf('query.get:stations/station-a/faults'));
    assert.ok(events.lastIndexOf('tx.get:stations/station-a/users/u1') > events.indexOf('query.get:stations/station-a/faults'));
  });

  await test('inactive or wrong-station profile blocks before reading faults', async () => {
    for (const first of [profile({ is_active:false }), profile({ station:'station-b' }), null]) {
      const h = harness({ profiles:[first] });
      await rejects('permission-denied', () => h.invoke(h.req('commander')));
      assert.equal(h.trace.some(row => row[0] === 'query.get'), false);
    }
  });

  await test('profile becoming inactive after the read withholds the entire result', async () => {
    const h = harness({ profiles:[profile(), profile({ is_active:false })] });
    await rejects('permission-denied', () => h.invoke(h.req('commander')));
    assert.equal(h.trace.filter(row => row[0] === 'query.get').length, 3);
  });

  await test('verified super is the only profile-read exception', async () => {
    const h = harness({ profiles:[null], faults:[fault('critical', { severity:'blocking' })] });
    const result = await h.invoke(h.req('firefighter', {}, { super:true }));
    assert.equal(result.identity.role, 'super_admin');
    assert.ok(tasks(result).some(row => row.id === 'open-faults'));
    assert.equal(h.trace.filter(row => row[0] === 'tx.get').length, 0,
      'super exception performed a partial profile check');
  });

  await test('open-fault query is exact, ordered and capped at PAGE_SIZE plus one probe', async () => {
    const h = harness();
    await h.invoke(h.req('commander'));
    assert.deepEqual(h.trace.filter(row => ['where','orderBy','limit'].includes(row[0])), [
      ['where', 'stations/station-a/faults', 'status', 'in', ['open','in_repair']],
      ['orderBy', 'stations/station-a/faults', 'created_key', 'desc'],
      ['limit', 'stations/station-a/faults', PAGE_SIZE + 1],
      ['where', 'stations/station-a/faults', 'status', '==', 'open'],
      ['where', 'stations/station-a/faults', 'severity', 'in', ['blocking','critical']],
      ['limit', 'stations/station-a/faults', 1],
      ['where', 'stations/station-a/faults', 'status', '==', 'in_repair'],
      ['where', 'stations/station-a/faults', 'severity', 'in', ['blocking','critical']],
      ['limit', 'stations/station-a/faults', 1]
    ]);
    assert.equal(h.trace.filter(row => row[0] === 'query.get').length, 3);
  });

  await test('only critical or blocking valid faults can become urgent', async () => {
    const h = harness({ profiles:[profile({ role:'firefighter' }), profile({ role:'firefighter' })], faults:[
      fault('major', { severity:'major' }),
      fault('critical', { severity:'critical', title:'קריטי' }),
      fault('blocking', { severity:'blocking', title:'משבית' })
    ] });
    const result = await h.invoke(h.req('firefighter'));
    assert.ok(result.urgent);
    assert.ok(['critical', 'blocking'].includes(result.urgent.severity));
    assert.notEqual(result.urgent.id, 'major');
  });

  await test('corrupt documents are skipped and unknown severity remains visible for grading', async () => {
    const malformed = [
      { id:'throw', data:() => { throw new Error('corrupt'); } },
      fault('blank', { title:'   ', severity:'critical' }),
      fault('closed', { status:'fixed', severity:'blocking' }),
      fault('bad-severity', { severity:'catastrophic' }),
      { id:'missing-data' }
    ];
    const h = harness({ faults:malformed });
    const result = await h.invoke(h.req('commander'));
    assert.equal(result.urgent, null);
    assert.equal(tasks(result).length, 1);
    assert.match(tasks(result)[0].title, /ממתינות להערכת חומרה/);
    assert.equal(shift(result).open_faults, 1);
  });

  await test('in-repair, limiting and unset faults remain in the operational count', async () => {
    const h = harness({ faults:[
      fault('repair', { status:'in_repair', severity:'limiting' }),
      fault('grade', { severity:'unset' })
    ] });
    const result = await h.invoke(h.req('commander'));
    assert.equal(shift(result).open_faults, 2);
    assert.match(tasks(result)[0].title, /ממתינות להערכת חומרה/);
  });

  await test('server filters the open-fault task by role', async () => {
    for (const [role, allowed] of [
      ['firefighter', false], ['hr_coordinator', false], ['commander', true], ['deputy', true]
    ]) {
      const h = harness({ profiles:[profile({ role }), profile({ role })],
        faults:[fault('critical', { severity:'critical' })] });
      const result = await h.invoke(h.req(role));
      assert.equal(tasks(result).some(row => row.id === 'open-faults'), allowed, role);
    }
  });

  await test('the 25th row proves partial and an old blocking fault still becomes urgent', async () => {
    const docs = Array.from({ length:PAGE_SIZE + 1 }, (_, index) =>
      fault('f' + String(index + 1).padStart(2, '0'), {
        severity:index === PAGE_SIZE ? 'critical' : 'major',
        title:index === PAGE_SIZE ? 'אסור לדלוף מה-probe' : 'תקלה ' + index
      }));
    const h = harness({ faults:docs });
    const result = await h.invoke(h.req('commander'));
    assert.equal(shift(result).partial, true);
    assert.equal(shift(result).open_faults, PAGE_SIZE);
    assert.equal(result.urgent && result.urgent.id, 'f25');
    assert.match(JSON.stringify(result), /אסור לדלוף מה-probe/);
  });

  await test('exactly 24 rows are complete, not guessed partial', async () => {
    const h = harness({ faults:Array.from({ length:PAGE_SIZE }, (_, index) => fault('f' + index)) });
    const result = await h.invoke(h.req('commander'));
    assert.equal(shift(result).partial, false);
    assert.equal(shift(result).open_faults, PAGE_SIZE);
  });

  await test('output is closed and never forwards free URL or HTML fields', async () => {
    const h = harness({ faults:[fault('hostile', {
      severity:'critical', title:'<img src=x onerror=alert(1)>',
      html:'<script>steal()</script>', url:'https://evil.invalid', href:'javascript:alert(1)',
      onclick:'steal()', token:'secret', by_uid:'private-user'
    })] });
    const result = await h.invoke(h.req('commander'));
    assert.deepEqual(Object.keys(result).sort(),
      ['generated_at', 'identity', 'revision', 'shift', 'tasks', 'urgent']);
    assert.equal(hasOwnDeep(result, new Set(['html','url','href','onclick','token','by_uid'])), false);
    assert.match(result.urgent.title, /<img/,
      'server must preserve bounded text; the browser owns textContent rendering');
    assert.deepEqual(Object.keys(result.urgent.action).sort(), ['id','type']);
    assert.deepEqual(Object.keys(result.urgent).sort(), ['action','id','severity','summary','title']);
    for (const task of tasks(result)) {
      assert.deepEqual(Object.keys(task).sort(), ['action','id','kind','priority','summary','target_roles','title']);
      assert.deepEqual(Object.keys(task.action).sort(), ['id','type']);
    }
  });

  console.log('home-command-center: ' + passed + ' tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
