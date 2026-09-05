// Pure cross-component contracts; real transaction races and Windows backup
// execution are separate gates. No Firebase SDK or credentials are used here.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSource } from './source-text.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readSource(path.join(root, name));
const require = createRequire(import.meta.url);
const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
// Export declarations in index.js are standalone lines. Do not use the
// generic block-comment regex here: a regex/string containing slash-star
// is not a comment and must not swallow subsequent real export lines.
const exportDeclarations = (source) => [...source.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, ' ')
  .matchAll(/^exports\.([A-Za-z0-9_]+)\s*=\s*(on\w+)\(/gm)]
  .map((match) => [match[1], match[2]]);
const loadClient = (name) => import('data:text/javascript;base64,' + Buffer.from(read(name)).toString('base64'));
const contract = require('../functions/ops-telemetry-contract.js');
const { createFakeFirestore } = require('../functions/fixtures/fake-firestore.js');
const { createIncidentLog } = require('../functions/incident-log.js');
const { createFeedback } = require('../functions/feedback.js');
const client = await loadClient('incident-client.js');
const feedbackClient = await loadClient('feedback.js');
const exporter = await import(pathToFileURL(path.join(root, 'ops-export.mjs')).href);
const now = '2026-09-03T10:00:00.000Z', sid = 'alpha_1', uid = 'ops.user';
const profilePath = 'stations/' + sid + '/users/' + uid;
const profile = { stationId: sid, role: 'firefighter', is_active: true, employee_number: '9001' };
const auth = { uid, token: { stationId: sid, role: 'firefighter', emp: 'obsolete-token-value' } };
const superAuth = { uid:'ops.super', token:{ stationId:sid, role:'', super:true,
  email:'ordinary@example.invalid' } };
const report = { kind: 'manual', screen: 'feedback.html', version: '42G.0', code: 'Error', callable: 'unknown' };
const input = { category: 'problem', rating: 2, text: 'בדיקת משוב סינתטי', allow_contact: false };
const context = { screen: 'feedback.html', version: '42G.0', day: now.slice(0, 10) };
class TestHttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
function fixture(options = {}) {
  const db = createFakeFirestore(options.withoutProfile ? {} : { [profilePath]: profile });
  const transact = db.runTransaction.bind(db);
  db.transactionReads = [];
  db.runTransaction = (work) => transact((tx) => {
    const reads = [];
    db.transactionReads.push(reads);
    return work({ ...tx, get: (ref) => { reads.push(ref.path); return tx.get(ref); } });
  });
  const deps = { db, FieldValue: db.FieldValue, HttpsError: TestHttpsError, clock: () => now,
    hash: (value) => crypto.createHash('sha256').update(String(value)).digest('hex') };
  return { db, incidents: createIncidentLog(deps), feedback: createFeedback(deps) };
}
const request = (data) => ({ auth, data });
const superRequest = (data) => ({ auth:superAuth, data });
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}
await check('server modules remain injected and do not emit logs', () => {
  for (const name of ['incident-log', 'feedback', 'ops-member-identity']) {
    assert.doesNotMatch(withoutComments(read('functions/' + name + '.js')), /\bconsole\s*\.|\blogger\s*\.|require\(['"]firebase|process\.env/);
  }
});
await check('every unknown technical value is normalized, not merely regex-scrubbed', () => {
  const marker = 'SYNTHETIC_PERSON_0501234567_private';
  for (const field of ['kind', 'screen', 'version', 'code', 'callable']) {
    const actual = contract.normalizeTelemetry({ ...report, [field]: marker });
    assert.equal(actual[field], 'unknown', field);
    assert.equal(JSON.stringify(actual).includes(marker), false);
  }
  assert.deepEqual([...contract.INPUT_FIELDS].sort(), ['callable', 'code', 'kind', 'screen', 'version']);
});
await check('actual browser payload has five finite fields and no raw error data', () => {
  const marker = 'בדיקה_פרטית_SYNTHETIC_PERSON_0501234567';
  const actual = client.buildReport('manual', { message: marker, stack: marker, code: marker, name: marker },
    { href: '/' + marker + '.html', version: marker, frame: marker, callable: marker, uid: marker });
  assert.deepEqual(Object.keys(actual).sort(), ['callable', 'code', 'kind', 'screen', 'version']);
  assert.equal(JSON.stringify(actual).includes(marker), false);
  for (const field of ['screen', 'version', 'code', 'callable']) assert.equal(actual[field], 'unknown', field);
});
await check('client technical vocabularies agree with server vocabularies', () => {
  for (const key of ['KINDS', 'SCREENS', 'VERSIONS', 'CODES', 'CALLABLES']) {
    const actual = client['TELEMETRY_' + key], expected = contract[key];
    assert.ok(Array.isArray(actual), key + ' browser vocabulary missing');
    assert.equal(new Set(actual).size, actual.length, key + ' browser duplicates');
    assert.equal(new Set(expected).size, expected.length, key + ' server duplicates');
    assert.deepEqual([...actual].sort(), [...expected].sort(), key + ' two-way vocabulary drift');
  }
  for (const [field, values] of [['kind', contract.KINDS], ['screen', contract.SCREENS],
    ['version', contract.VERSIONS], ['code', contract.CODES], ['callable', contract.CALLABLES]]) {
    for (const value of values) {
      const actual = client.buildReport(field === 'kind' ? value : 'manual',
        { code: field === 'code' ? value : 'Error' }, { href: field === 'screen' ? value : 'feedback.html',
          version: field === 'version' ? value : '42G.0', callable: field === 'callable' ? value : 'unknown' });
      assert.equal(actual[field], value, field + ' vocabulary drift');
    }
  }
});
await check('current release incidents retain their exact version on client and server', () => {
  const current = read('version.js').match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
  assert.equal(current, '42H.3');
  const browserReport = client.buildReport('manual', { code:'Error' }, {
    href:'/feedback.html', version:current, callable:'unknown'
  });
  const serverReport = contract.normalizeTelemetry({
    kind:'manual', screen:'feedback.html', version:current, code:'Error', callable:'unknown'
  });
  assert.equal(browserReport.version, current);
  assert.equal(serverReport.version, current);
  assert.equal(client.buildReport('manual', { code:'Error' }, {
    href:'/feedback.html', version:'unreleased-private-version', callable:'unknown'
  }).version, 'unknown');
  assert.equal(contract.normalizeTelemetry({
    kind:'manual', screen:'feedback.html', version:'unreleased-private-version',
    code:'Error', callable:'unknown'
  }).version, 'unknown');
});
await check('finite callable vocabulary contains only the actual public onCall exports', () => {
  const declarations = exportDeclarations(read('functions/index.js'));
  const publicCalls = declarations.filter(([, kind]) => kind === 'onCall').map(([name]) => name);
  assert.ok(publicCalls.length > 50, 'public callable discovery unexpectedly empty');
  assert.equal(new Set(publicCalls).size, publicCalls.length, 'duplicate public callable export');
  assert.deepEqual([...contract.CALLABLES].sort(), ['unknown', ...publicCalls].sort());
  for (const [name, kind] of declarations) {
    if (kind !== 'onCall') assert.equal(contract.CALLABLES.includes(name), false, name + ' is not callable');
  }
  const fixture = ["const literal = '/* not a comment';", 'exports.first = onCall(fn);',
    "const ending = '*/';", '// exports.fakeLine = onCall(fn);', '/*',
    'exports.fakeBlock = onCall(fn);', '*/', 'exports.second = onSchedule(fn);'].join('\n');
  assert.deepEqual(exportDeclarations(fixture), [['first', 'onCall'], ['second', 'onSchedule']]);
});
await check('incident storage has neither caller identity nor raw telemetry fields', async () => {
  const { db, incidents } = fixture();
  const result = await incidents.report(request(report));
  assert.equal(result.accepted, true);
  const stored = db.read('stations/' + sid + '/incidents/' + result.fingerprint);
  assert.ok(stored);
  for (const field of ['uid', 'actor_uid', 'reporter', 'email', 'employee_number', 'message', 'frame',
    'sample_message', 'sample_frame', 'last_message', 'last_frame', 'note']) assert.equal(Object.hasOwn(stored, field), false, field);
  assert.equal(JSON.stringify(stored).includes(uid), false);
});
await check('raw telemetry fields and a client-chosen station are rejected without writes', async () => {
  for (const field of ['message', 'frame', 'note', 'uid', 'email', 'stationId']) {
    const { db, incidents } = fixture();
    await assert.rejects(incidents.report(request({ ...report, [field]: 'private-marker' })),
      (error) => error.code === 'invalid-argument', field);
    assert.equal(db.writes.length, 0);
  }
});
await check('both services require canonical live membership despite valid-looking token', async () => {
  const payload = await feedbackClient.buildSubmission(input, context);
  for (const change of [{ is_active: false }, { active: false }, { stationId: 'beta_2' },
    { station_id: 'beta_2' }, { role: 'hr_coordinator' }]) {
    const { db, incidents, feedback } = fixture();
    db.write(profilePath, { ...profile, ...change });
    await assert.rejects(incidents.report(request(report)), (error) => error.code === 'permission-denied');
    await assert.rejects(feedback.submit(request(payload)), (error) => error.code === 'permission-denied');
    assert.equal(db.writes.length, 0);
  }
});
await check('verified super has both ops capabilities without a profile, but only in the signed station', async () => {
  const payload = await feedbackClient.buildSubmission(input, context);
  const { db, incidents, feedback } = fixture({ withoutProfile:true });
  const incident = await incidents.report(superRequest(report));
  const submitted = await feedback.submit(superRequest(payload));
  assert.equal(incident.accepted, true);
  assert.equal(db.read('stations/' + sid + '/incidents/' + incident.fingerprint).roles[0], 'super_admin');
  const stored = db.read('stations/' + sid + '/feedback/' + submitted.id);
  assert.equal(stored.role, 'super_admin'); assert.equal(stored.uid, superAuth.uid);
  assert.equal(stored.employee_number, '');
  assert.equal(db.keys().some((key) => key.startsWith('stations/beta_2/')), false);
  await assert.rejects(incidents.report({ auth:superAuth, data:{ ...report, stationId:'beta_2' } }),
    (error) => error.code === 'invalid-argument');
  await assert.rejects(feedback.submit({ auth:superAuth, data:{ ...payload, station_id:'beta_2' } }),
    (error) => error.code === 'invalid-argument');
});
await check('ops super authority comes only from the verified claim, never email or role text', () => {
  const source = withoutComments(read('functions/ops-member-identity.js'));
  const bootstrap = withoutComments(read('monitoring-bootstrap.js'));
  assert.match(source, /token\.super\s*===\s*true/);
  assert.doesNotMatch(source, /token\.email|auth\.token\.email|SUPER_ADMIN_EMAIL/);
  assert.doesNotMatch(source, /token\.role\s*===\s*['"]super_admin['"]/);
  assert.match(bootstrap, /claims\.super\s*===\s*true/);
  assert.doesNotMatch(bootstrap, /claims\.role\s*===\s*['"]super_admin['"]|claims\.email/);
});
await check('feedback stores live identity and does not distort private feedback text', async () => {
  const { db, feedback } = fixture();
  const text = 'טקסט סינתטי עם 050-1234567 ודוגמה@example.invalid';
  const payload = await feedbackClient.buildSubmission({ ...input, text, allow_contact: true }, context);
  const result = await feedback.submit(request(payload));
  const stored = db.read('stations/' + sid + '/feedback/' + result.id);
  assert.equal(stored.uid, uid); assert.equal(stored.employee_number, profile.employee_number);
  assert.equal(stored.text, text); assert.equal(stored.allow_contact, true);
});
await check('server replay binds all intent fields and rechecks membership before duplicate response', async () => {
  const { db, feedback } = fixture();
  const payload = await feedbackClient.buildSubmission(input, context);
  const first = await feedback.submit(request(payload)), count = db.writes.length;
  const duplicate = await feedback.submit(request(payload));
  assert.equal(duplicate.id, first.id); assert.equal(duplicate.duplicate, true); assert.equal(db.writes.length, count);
  for (const change of [{ allow_contact: true }, { version: '42G.1' }, { screen: 'swaps.html' },
    { category: 'idea' }, { rating: 3 }, { text: 'תוכן סינתטי אחר' }]) {
    await assert.rejects(feedback.submit(request({ ...payload, ...change })),
      (error) => error.code === 'already-exists', Object.keys(change)[0]);
    assert.equal(db.writes.length, count);
  }
  db.write(profilePath, { ...profile, is_active: false });
  await assert.rejects(feedback.submit(request(payload)), (error) => error.code === 'permission-denied');
  assert.equal(db.writes.length, count);
});
await check('identity is actually read inside each write/replay transaction before other reads', async () => {
  const { db, feedback, incidents } = fixture();
  const payload = await feedbackClient.buildSubmission(input, context);
  await feedback.submit(request(payload));
  await feedback.submit(request(payload));
  await incidents.report(request(report));
  assert.equal(db.transactionReads.length, 3);
  for (const reads of db.transactionReads) assert.equal(reads[0], profilePath);
});
await check('reporter has a hard cap and deduplicates before reporting', async () => {
  const sent = [];
  const instance = client.createIncidentReporter({ report: async (body) => sent.push(body),
    version: '42G.0', maxPerLoad: Infinity });
  assert.equal(await instance.report({ code: 'Error', message: 'one' }, { href: 'feedback.html' }), true);
  assert.equal(await instance.report({ code: 'Error', message: 'other private text' }, { href: 'feedback.html' }), false);
  for (const code of contract.CODES) await instance.report({ code }, { href: 'feedback.html' });
  assert.equal(sent.length, 10); assert.ok(instance.stats().sent <= 10);
});
await check('report failure stays silent and wrapped business results/errors are unchanged', async () => {
  let attempted = 0;
  const instance = client.createIncidentReporter({ report: async () => { attempted++; throw new Error('report failure'); } });
  assert.equal(await instance.report(new Error('private')), false);
  const original = Object.assign(new Error('business failure'), { code: 'functions/unavailable' });
  await assert.rejects(instance.wrapCallable('submitFeedback', async () => { throw original; })({}), (error) => error === original);
  const value = { unchanged: true };
  assert.equal(await instance.wrapCallable('submitFeedback', async () => value)({}), value);
  assert.equal(attempted, 2);
});
await check('feedback retries retain exact payload and changed consent/version/content have new IDs', async () => {
  const session = feedbackClient.createFeedbackSubmissionSession(), first = await session.prepare(input, context);
  assert.ok(Object.isFrozen(first)); assert.equal(await session.prepare({ ...input }, { ...context }), first);
  const variants = [[{ ...input, allow_contact: true }, context], [input, { ...context, version: '42G.1' }],
    [input, { ...context, screen: 'swaps.html' }], [{ ...input, category: 'idea' }, context],
    [{ ...input, rating: 3 }, context], [{ ...input, text: 'תוכן אחר' }, context]];
  const ids = new Set([first.request_id]);
  for (const [data, ctx] of variants) ids.add((await session.prepare(data, ctx)).request_id);
  assert.equal(ids.size, variants.length + 1); assert.equal(await session.prepare(input, context), first);
});
await check('malformed feedback responses never discard pending requests', async () => {
  const session = feedbackClient.createFeedbackSubmissionSession(), payload = await session.prepare(input, context);
  for (const value of [null, {}, { id: 'wrong', duplicate: false }, { id: 'f_' + 'a'.repeat(40) },
    { id: 'f_' + 'a'.repeat(40), duplicate: 'false' }]) {
    assert.equal(feedbackClient.validSubmissionResult(value), false);
    assert.throws(() => session.complete(payload, value));
    assert.equal(await session.prepare(input, context), payload);
  }
  session.complete(payload, { id: 'f_' + 'a'.repeat(40), duplicate: false });
  assert.notEqual((await session.prepare(input, context)).request_id, payload.request_id);
});
await check('feedback fails closed without secure random generation', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    await assert.rejects(feedbackClient.buildSubmission(input, context), /feedback-secure-random-required/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  }
});
await check('git ignores all private ops output including future non-Markdown files', () => {
  const files = ['_ניטור/incidents.md', '_ניטור/health.md', '_ניטור/feedback.md', '_ניטור/future.json',
    '_גיבוי/future/manifest.json', '_גיבוי/.staging/partial.tmp'];
  const output = execFileSync('git', ['check-ignore', '--no-index', '-z', '--stdin'],
    { cwd: root, input: files.join('\0') + '\0', encoding: 'utf8', windowsHide: true });
  assert.deepEqual(new Set(output.split('\0').filter(Boolean)), new Set(files));
});
await check('hosting excludes private directories and ops CLI scripts', () => {
  const ignore = JSON.parse(read('firebase.json')).hosting.ignore;
  for (const dir of ['_ניטור', '_גיבוי']) {
    assert.ok(ignore.includes(dir + '/**'), dir + ' root exclusion missing');
    assert.ok(ignore.includes('**/' + dir + '/**'), dir + ' nested exclusion missing');
  }
  assert.ok(ignore.includes('*.mjs') || ['ops-export.mjs', 'ops-backup.mjs'].every((file) => ignore.includes(file)));
});
await check('feedback page permits verified super without fixed-email or role fallback authority', () => {
  const page = read('feedback.html');
  assert.ok(page.includes('c.super === true || MEMBER_ROLES.indexOf(c.role) !== -1'));
  assert.ok(page.includes("location.replace('./login.html?next=feedback.html')"));
  assert.doesNotMatch(page, /SUPER_ADMIN_EMAIL|\.email\s*===|c\.role\s*===\s*['"]super_admin['"]/);
  assert.deepEqual([...page.matchAll(/httpsCallable\(fns,\s*'([^']+)'\)/g)].map((match) => match[1]), ['submitFeedback']);
  assert.match(page, /from\s+['"]\.\/monitored-functions\.js\?v=42h3['"]/);
  assert.doesNotMatch(page, /installIncidentReporter|createIncidentReporter|\.wrapCallable\(/,
    'feedback must share the page reporter, not install an independent quota/listener');
  assert.match(read('nav.js'), /href:\s*'feedback\.html',\s*label:\s*'חוות דעת',\s*who:\s*'member'/);
});
await check('ops collections have explicit deny rules and private backup classification', () => {
  const { DATA_POLICIES } = require('../functions/backup-policy.js');
  for (const collection of ['incidents', 'incident_days', 'feedback', 'feedback_quota']) {
    assert.match(read('firestore.rules'), new RegExp('match\\s+/' + collection +
      '/\\{[^}]+\\}\\s*\\{\\s*allow\\s+read,\\s*write:\\s*if\\s+false;\\s*\\}'));
    const policy = DATA_POLICIES.find((item) => /^stations\/\{[^}]+\}\//.test(item.path) && item.path.split('/')[2] === collection);
    assert.ok(policy, collection + ' missing classification');
    if (collection.startsWith('feedback')) assert.notEqual(policy.humanReadable, 'allowed');
  }
});
await check('retention expires feedback and quota counters, never incidents automatically', () => {
  const indexes = JSON.parse(read('firestore.indexes.json'));
  const ttl = new Set(indexes.fieldOverrides.filter((item) => item.ttl === true && item.fieldPath === 'expires_at')
    .map((item) => item.collectionGroup));
  for (const name of ['feedback', 'incident_days', 'feedback_quota']) assert.ok(ttl.has(name));
  assert.equal(ttl.has('incidents'), false);
  const incidentExpiry = indexes.fieldOverrides.filter((item) => item.collectionGroup === 'incidents' && item.fieldPath === 'expires_at');
  assert.equal(incidentExpiry.length, 1);
  assert.equal(incidentExpiry[0].ttl, false, 'disable any previously enabled incident TTL explicitly');
  assert.equal(require('../functions/feedback.js').FEEDBACK_TTL_MS, 30 * 86400000);
  assert.equal(require('../functions/feedback.js').QUOTA_TTL_MS, 3 * 86400000);
  assert.equal(require('../functions/incident-log.js').DAY_TTL_MS, 3 * 86400000);
});
await check('both callable exports explicitly enforce App Check', () => {
  const source = withoutComments(read('functions/index.js'));
  for (const name of ['reportIncident', 'submitFeedback']) {
    const at = source.indexOf('exports.' + name + ' ='); assert.ok(at >= 0, name + ' missing');
    const call = source.slice(at).match(/^exports\.\w+\s*=\s*onCall\(\s*\{([^}]+)\}/);
    assert.ok(call, name + ' options missing'); assert.match(call[1], /\benforceAppCheck\s*:\s*true\b/);
    assert.doesNotMatch(call[1], /\benforceAppCheck\s*:\s*false\b/);
  }
});
await check('export requires explicit project and rejects identity labels or unsafe arguments', () => {
  assert.throws(() => exporter.parseArgs([]));
  for (const project of ['../x', '', 'demo-resq --other', 'DEMO RESQ']) assert.throws(() => exporter.parseArgs(['--project', project]));
  assert.throws(() => exporter.parseArgs(['--project', 'demo-resq', '--station', '../x']));
  for (const out of ['public-ops', '../outside-ops', '_ניטור/../public-ops']) {
    assert.throws(() => exporter.parseArgs(['--project', 'demo-resq', '--out', out]));
  }
  assert.throws(() => exporter.parseArgs(['--project', 'demo-resq', '--resolve', 'a'.repeat(40), '--by', 'person@example.invalid']));
  assert.throws(() => exporter.parseArgs(['--project', 'demo-resq', '--bogus']));
  const parsed = exporter.parseArgs(['--project', 'demo-resq', '--station', 'alpha_1', '--dry-run']);
  assert.equal(parsed.project, 'demo-resq'); assert.equal(parsed.dryRun, true); assert.equal(parsed.out, '_ניטור');
  assert.equal(exporter.parseArgs(['--project', 'demo-resq', '--out', '_ניטור/private-subdir']).out, '_ניטור/private-subdir');
});
await check('export status actions accept an actual incident fingerprint and only closed note codes', async () => {
  const { incidents } = fixture();
  const result = await incidents.report(request(report));
  for (const action of ['--resolve', '--ignore', '--reopen']) {
    const args = exporter.parseArgs(['--project', 'demo-resq', action, result.fingerprint, '--by', 'codex', '--note-code', 'fixed']);
    assert.equal(args[action.slice(2)], result.fingerprint);
    assert.equal(args.note, 'fixed');
  }
  assert.throws(() => exporter.parseArgs(['--project', 'demo-resq', '--resolve', result.fingerprint,
    '--by', 'codex', '--note-code', 'PRIVATE_FREE_NOTE']));
  const defaults = exporter.parseArgs(['--project', 'demo-resq', '--resolve', result.fingerprint, '--by', 'codex']);
  await incidents.setStatus({ sid, fingerprint: result.fingerprint, status: 'resolved', by: defaults.by,
    note_code: defaults.note });
});
const deleteBase = ['--project', 'demo-resq', '--station', sid, '--by', 'operator'];
const deletionId = 'f_' + 'a'.repeat(40), deletionFingerprint = 'b'.repeat(40);
const feedbackDeleteArgs = [...deleteBase, '--delete-feedback', deletionId, '--confirm-delete', deletionId];
const incidentDeleteArgs = [...deleteBase, '--delete-incident', deletionFingerprint, '--confirm-delete', deletionFingerprint,
  '--expected-count', '2', '--expected-last-seen', now, '--expected-resolved-at', now];
await check('manual deletion requires an explicit single target, operator and exact confirmation', () => {
  assert.equal(exporter.parseArgs(feedbackDeleteArgs).deleteFeedback, deletionId);
  assert.equal(exporter.parseArgs(incidentDeleteArgs).expectedCount, 2);
  for (const args of [feedbackDeleteArgs, incidentDeleteArgs]) {
    for (const key of ['--project', '--station', '--by', '--confirm-delete']) {
      const missing = args.slice(), index = missing.indexOf(key); missing.splice(index, 2);
      assert.throws(() => exporter.parseArgs(missing), key);
    }
    for (const extra of [['--resolve', deletionFingerprint], ['--mark-read'], ['--station', 'beta_2'], ['--dry-run', '--dry-run']]) {
      assert.throws(() => exporter.parseArgs([...args, ...extra]), extra[0]);
    }
    for (const [key, value] of [['--by', 'codex'], ['--confirm-delete', 'wrong']]) {
      const changed = args.slice(); changed[changed.indexOf(key) + 1] = value;
      assert.throws(() => exporter.parseArgs(changed));
    }
  }
  for (const id of ['', '*', '../outside', 'f_' + 'a'.repeat(39), deletionId + ',other']) {
    assert.throws(() => exporter.parseArgs([...deleteBase, '--delete-feedback', id, '--confirm-delete', id]));
  }
  assert.throws(() => exporter.parseArgs([...feedbackDeleteArgs, '--delete-incident', deletionFingerprint]));
  assert.throws(() => exporter.parseArgs([...deleteBase, '--confirm-delete', deletionId]));
});
await check('incident deletion requires a complete canonical reviewed snapshot', () => {
  for (const key of ['--expected-count', '--expected-last-seen', '--expected-resolved-at']) {
    const args = incidentDeleteArgs.slice(); args.splice(args.indexOf(key), 2);
    assert.throws(() => exporter.parseArgs(args), key);
  }
  for (const value of ['0', '-1', '1.5', 'NaN', '1e2', '9007199254740992']) {
    const args = incidentDeleteArgs.slice(); args[args.indexOf('--expected-count') + 1] = value;
    assert.throws(() => exporter.parseArgs(args));
  }
  for (const value of ['2026-02-30T00:00:00.000Z', '2026-09-03', 'private text']) {
    const args = incidentDeleteArgs.slice(); args[args.indexOf('--expected-last-seen') + 1] = value;
    assert.throws(() => exporter.parseArgs(args));
  }
  assert.throws(() => exporter.parseArgs([...feedbackDeleteArgs, '--expected-count', '2']));
});
await check('deletion dispatcher passes only exact identities and CAS fields, and never claims malformed success', async () => {
  const calls = [];
  const services = {
    feedback: { remove: async (args) => { calls.push(['feedback', args]); return { deleted: true, id: args.id }; } },
    incidents: { removeResolved: async (args) => { calls.push(['incidents', args]); return { deleted: true, fingerprint: args.fingerprint }; } }
  };
  assert.deepEqual(await exporter.performDeletion(exporter.parseArgs(feedbackDeleteArgs), services),
    { collection: 'feedback', id: deletionId, deleted: true });
  assert.deepEqual(calls[0], ['feedback', { sid, id: deletionId, by: 'operator' }]);
  assert.deepEqual(await exporter.performDeletion(exporter.parseArgs(incidentDeleteArgs), services),
    { collection: 'incidents', id: deletionFingerprint, deleted: true });
  assert.deepEqual(calls[1], ['incidents', { sid, fingerprint: deletionFingerprint, by: 'operator',
    expected_count: 2, expected_last_seen_iso: now, expected_resolved_at: now }]);
  for (const value of [null, {}, { deleted: false, id: deletionId }, { deleted: true, id: 'different' }]) {
    await assert.rejects(exporter.performDeletion(exporter.parseArgs(feedbackDeleteArgs),
      { feedback: { remove: async () => value } }));
  }
  const failure = new Error('stale snapshot');
  await assert.rejects(exporter.performDeletion(exporter.parseArgs(incidentDeleteArgs),
    { incidents: { removeResolved: async () => { throw failure; } } }), (error) => error === failure);
});
await check('actual delete command invokes only one mocked admin method and never exports more private copies', () => {
  const modulePath = path.join(root, 'ops-export.mjs');
  for (const [args, method, id] of [[feedbackDeleteArgs, 'feedback', deletionId], [incidentDeleteArgs, 'incidents', deletionFingerprint]]) {
    const probe = [
      "import Module from 'node:module';",
      "const calls = []; const refuse = () => { throw new Error('unexpected non-delete operation'); };",
      "const sdk = { apps: [], initializeApp: ({projectId}) => { if(projectId !== 'demo-resq') refuse(); }, firestore: Object.assign(() => ({}), { FieldValue: {} }) };",
      "const load = Module._load; Module._load = function(name,...rest) {",
      "if (name === 'firebase-admin') return sdk;",
      "if (name === './feedback.js') return { createFeedback: () => ({ list: refuse, markRead: refuse, remove: async o => { calls.push(['feedback',o]); return {deleted:true,id:o.id}; } }) };",
      "if (name === './incident-log.js') return { createIncidentLog: () => ({ list: refuse, setStatus: refuse, removeResolved: async o => { calls.push(['incidents',o]); return {deleted:true,fingerprint:o.fingerprint}; } }) };",
      "if (/firebase|google-auth|gaxios/.test(name)) refuse(); return load.call(this,name,...rest); };",
      'process.argv = [process.execPath, ' + JSON.stringify(modulePath) + ', ...' + JSON.stringify(args) + '];',
      "process.once('beforeExit', () => console.log(JSON.stringify({calls})));",
      'await import(' + JSON.stringify(pathToFileURL(modulePath).href) + ');'
    ].join('\n');
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', probe],
      { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true });
    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(lines.length, 2); assert.equal(lines[0].deleted, true); assert.equal(lines[0].id, id);
    assert.equal(lines[0].project, 'demo-resq'); assert.equal(lines[0].station, sid);
    assert.equal(lines[1].calls.length, 1); assert.equal(lines[1].calls[0][0], method);
  }
});
await check('export dry-run executes without SDK loading, network, subprocesses or filesystem writes', () => {
  const modulePath = path.join(root, 'ops-export.mjs');
  for (const args of [['--project', 'demo-resq'], feedbackDeleteArgs, incidentDeleteArgs]) {
    const probe = [
    "import fs from 'node:fs';",
    "import cp from 'node:child_process';",
    "import http from 'node:http'; import https from 'node:https'; import net from 'node:net';",
    "import Module, { syncBuiltinESMExports } from 'node:module';",
    "const refuse = () => { throw new Error('dry-run attempted a side effect'); };",
    "for (const name of ['writeFileSync','appendFileSync','mkdirSync','renameSync','unlinkSync','rmSync','copyFileSync','createWriteStream']) fs[name] = refuse;",
    "for (const name of ['writeFile','appendFile','mkdir','rename','unlink','rm','copyFile']) { fs[name] = refuse; fs.promises[name] = refuse; }",
    "const openSync = fs.openSync; fs.openSync = function(file,flags,...rest) { if (typeof flags !== 'string' ? flags !== 0 : /[wa+]/.test(flags)) refuse(); return openSync.call(this,file,flags,...rest); };",
    "for (const name of ['execFileSync','execSync','spawnSync','spawn','exec','execFile']) cp[name] = refuse;",
    "http.request = https.request = http.get = https.get = net.connect = net.createConnection = refuse;",
    "net.Socket.prototype.connect = refuse; globalThis.fetch = refuse;",
    "const load = Module._load; Module._load = function(name,...rest) { if (/firebase|google-auth|gaxios/.test(name)) refuse(); return load.call(this,name,...rest); };",
    'syncBuiltinESMExports();',
    'process.argv = [process.execPath, ' + JSON.stringify(modulePath) + ', ...' + JSON.stringify([...args, '--dry-run']) + '];',
    'await import(' + JSON.stringify(pathToFileURL(modulePath).href) + ');'
  ].join('\n');
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', probe],
    { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true });
  const result = JSON.parse(output.trim());
  assert.equal(result.dryRun, true);
  assert.equal(result.network, 'not contacted');
  assert.equal(result.writes, 'none');
  assert.equal(result.documentId, args.includes('--delete-feedback') ? deletionId : args.includes('--delete-incident') ? deletionFingerprint : null);
  }
});
await check('incident export never revives legacy raw messages, traces, identity or free notes', () => {
  const raw = 'PRIVATE_LEGACY_MARKER';
  const markdown = exporter.renderIncidents([{ fingerprint: 'a'.repeat(40), status: 'open', count: 1,
    ...report, screens: ['feedback.html'], versions: ['42G.0'], first_seen_iso: now, last_seen_iso: now,
    sample_message: raw, sample_frame: raw, last_message: raw, last_frame: raw, note: raw, uid: raw }],
  { station: sid, now, days: 30 });
  assert.equal(markdown.includes(raw), false); assert.ok(markdown.includes('a'.repeat(12)));
});
await check('private feedback export renders untrusted Markdown and HTML inertly', () => {
  const text = 'טקסט נשמר\n![tracking](https://tracking.invalid/x)\n<img src="https://tracking.invalid/y">\n' + String.fromCharCode(96).repeat(3) + '\nraw';
  const markdown = exporter.renderFeedback([{ id: 'f_' + 'b'.repeat(40), uid, role: profile.role, employee_number: '9001',
    ...input, text, screen: 'feedback.html', version: '42G.0', status: 'new', created_at_iso: now }], { station: sid, now });
  assert.match(markdown, /מידע אישי/); assert.ok(markdown.includes('טקסט נשמר'));
  // Blockquotes still render images; a sufficiently long code fence is safe.
  let fence = null;
  for (const line of markdown.split(/\r?\n/)) {
    const opening = line.match(/^\s{0,3}(\x60{3,}|~{3,})/);
    if (opening) {
      if (!fence) fence = opening[1];
      else if (opening[1][0] === fence[0] && opening[1].length >= fence.length) fence = null;
      continue;
    }
    if (!fence) {
      assert.doesNotMatch(line, /(?<!\\)!\[tracking\]\(https:\/\/tracking\.invalid/);
      assert.doesNotMatch(line, /<img\s/i);
    }
  }
});
await check('health export keeps explicit warnings for missing and stale evidence', () => {
  const markdown = exporter.renderHealth({ lastSnapshot: { date: '2026-08-20', drops: {} }, lastScan: null,
    openIncidents: 1, incidents7d: 0, incidentEvents7d: 0, feedback7d: 0, feedbackUnread: 0,
    backupsListing: null }, { station: sid, now });
  assert.match(markdown, /⚠ לא רצה \d+ ימים/);
  assert.ok(markdown.includes('⚠ אין רשומה'));
  assert.ok(markdown.includes('gcloud firestore backups list'));
});
console.log('\nOps cross-component contracts: ' + passed + ' passed, ' + failed + ' failed.');
console.log('NOT RUN here: real transaction races, live export, Windows backup execution; separate gates are required.');
if (failed) process.exitCode = 1;
