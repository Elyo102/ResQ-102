// ============================================================
//  בדיקות לצינור ההתאוששות — ops-disaster-restore.mjs
// ============================================================
//  Node מובנה בלבד. אין Firebase, אין רשת, אין אמולטור: כל גישת
//  Firestore עוברת דרך firestoreApi מזויף בזיכרון שסופר כתיבות.
//  שורש הפיקסטורה הוא תיקייה זמנית עם עותק של functions/backup-policy.js
//  האמיתי ו-.firebaserc שמצביע על station-102 — כך שרשימת הסירוב
//  הקשיחה נבדקת מול אותו קובץ שהייצור משתמש בו.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeEol, eolProblems } from './eol-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, '..', 'ops-disaster-restore.mjs');
// backup-policy.js נטען מהמאגר: RESQ_REPO_ROOT, אחרת שורש המאגר שמעל tests/,
// אחרת עותק הקריאה ב-/tmp/resq-join (סביבת הפיתוח של החבילה).
const policyRoot = [process.env.RESQ_REPO_ROOT, path.resolve(here, '..'), '/tmp/resq-join']
  .filter(Boolean).find((root) => fs.existsSync(path.join(root, 'functions', 'backup-policy.js')));
if (!policyRoot) throw new Error('functions/backup-policy.js לא נמצא — הגדר RESQ_REPO_ROOT');

const dr = await import(pathToFileURL(scriptPath).href);

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-dr-test-'));
fs.mkdirSync(path.join(fixture, 'functions'));
fs.copyFileSync(path.join(policyRoot, 'functions', 'backup-policy.js'), path.join(fixture, 'functions', 'backup-policy.js'));
fs.writeFileSync(path.join(fixture, '.firebaserc'), JSON.stringify({ projects: { default: 'station-102' } }));
const policy = dr.loadPolicy({ root: fixture });

let passed = 0;
async function check(name, fn) { await fn(); console.log('PASS ' + name); passed++; }

// ---------- firestoreApi מזויף ----------
function createFakeApi(seed = {}) {
  const store = new Map(Object.entries(seed).map(([p, d]) => [p, JSON.parse(JSON.stringify(d))]));
  const api = {
    calls: { create: 0, get: 0, list: 0, commitAtomic: 0 },
    createdPaths: [],
    readbackOverride: new Map(),
    failCreateFor: new Set(),
    store,
    async listCollectionPaths(parent) {
      api.calls.list++;
      const prefix = parent ? parent + '/' : '';
      const depth = parent ? parent.split('/').length + 1 : 1;
      const out = new Set();
      for (const p of store.keys()) {
        if (!p.startsWith(prefix)) continue;
        const segs = p.split('/');
        if (segs.length > depth) out.add(segs.slice(0, depth).join('/'));
      }
      return [...out];
    },
    async listDocuments(collectionPath, pageToken) {
      const depth = collectionPath.split('/').length + 1;
      // כמו Firestore listDocuments: כולל מסמכי אב חסרים (data: null) שיש להם תת-אוספים
      const all = [...new Set([...store.keys()].filter((p) => p.startsWith(collectionPath + '/') && p.split('/').length >= depth).map((p) => p.split('/').slice(0, depth).join('/')))].sort();
      const start = pageToken ? all.indexOf(pageToken) + 1 : 0;
      const page = all.slice(start, start + 2); // עמודים קטנים בכוונה כדי לבדוק דפדוף
      return { documents: page.map((p) => ({ path: p, data: store.has(p) ? store.get(p) : null })), nextPageToken: start + 2 < all.length ? page[page.length - 1] : null };
    },
    async getDocument(p) {
      api.calls.get++;
      if (api.readbackOverride.has(p) && store.has(p)) return api.readbackOverride.get(p); // מזייף קריאה חוזרת שגויה אחרי כתיבה
      return store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : null;
    },
    async createDocument(p, data) {
      api.calls.create++;
      if (api.failCreateFor.has(p)) throw new Error('injected create failure');
      if (store.has(p)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; }
      store.set(p, JSON.parse(JSON.stringify(data)));
      api.createdPaths.push(p);
    },
    /* קומיט אטומי, בדיוק כמו batch.commit של Firestore: הכול מוכן
     * בצד, ורק אם כל הכתיבות תקפות הן נכנסות ל-store. כשל באמצע
     * אינו משאיר דבר — וזו בדיוק ההתנהגות שהבדיקה למטה מוכיחה. */
    async commitAtomic(writes) {
      api.calls.commitAtomic++;
      if (writes.length > dr.ATOMIC_COMMIT_LIMIT) throw new Error('atomic commit limit exceeded');
      const staged = [];
      for (const w of writes) {
        if (api.failCreateFor.has(w.path)) throw new Error('injected atomic failure at ' + w.path);
        if (store.has(w.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; }
        staged.push([w.path, JSON.parse(JSON.stringify(w.data))]);
      }
      for (const [p, d] of staged) { store.set(p, d); api.createdPaths.push(p); }
    }
  };
  return api;
}

// ---------- זרעים: 12+ תבניות מדיניות, כולל מוחרגות, זהות, ידני, after_parent ----------
const S = 'stations/eilat_102';
const seed = {
  // restore
  [S]: { name: 'תחנה 102', active: true },
  [S + '/config/hrConfig']: { month_start: 1, n: 3.5 },
  'config/mode': { mode: 'normal' },
  'config/other': { flag: true },
  [S + '/shifts/crew_a']: { label: 'צוות א', ts: { __ts: '2026-09-01T00:00:00.000Z' } },
  [S + '/callouts/co1']: { title: 'אירוע' },
  [S + '/callouts/co1/responses/u1']: { going: true },
  // restore_after_parent
  [S + '/shifts/crew_a/days/2026-09-01']: { present: ['u1'] },
  'join_campaigns/camp1': { title: 'קמפיין' },
  'join_campaigns/camp1/registrants/u9': { uid: 'u9' },
  'join_campaigns/orphan/registrants/u8': { uid: 'u8' }, // האב חסר — אינו נכתב
  // identity_and_auth
  'emp_index/1001': { uid: 'u1' },
  'registration_requests/u2': { status: 'pending' },
  'meta/counters': { next_emp: 1002 },
  [S + '/users/u1']: { role: 'firefighter', emp: 1001 },
  [S + '/roster/u1']: { active: true },
  // exclude / do_not_restore
  [S + '/push_tokens/u1']: { token: 'SECRET-TOKEN' },
  [S + '/guard_outbox/o1']: { pending: true },
  [S + '/device_readiness/u1']: { ready: true },
  'hr_request_actor_quotas/q1': { count: 3 },
  [S + '/hr_nudge_actions/a1']: { x: 1 },
  'login_attempts/1001': { fails: 2 },
  [S + '/incidents/abc']: { count: 1 },
  // rebuild
  'directory/u1': { name: 'x' },
  [S + '/health/2026-09-01']: { ok: true },
  // specialized (manual_required)
  [S + '/signatures/u1']: { png: { __bytes: 'AAAA' } },
  [S + '/documents/d1']: { name: 'doc' },
  [S + '/faults/f1']: { open: true },
  [S + '/faults/f1/photos/p1']: { url: 'x' },
  // unclassified
  'mystery_collection/z1': { z: 1 },
  // קנרית ישנה במקור — לעולם אינה מועתקת
  '_resq_restore_canary/run-old': { run_id: 'old' }
};
const EXCLUDED = [S + '/push_tokens/u1', S + '/guard_outbox/o1', S + '/device_readiness/u1', 'hr_request_actor_quotas/q1', S + '/hr_nudge_actions/a1', 'login_attempts/1001', S + '/incidents/abc', 'directory/u1', S + '/health/2026-09-01', 'mystery_collection/z1', '_resq_restore_canary/run-old'];
const MANUAL = [S + '/signatures/u1', S + '/documents/d1', S + '/faults/f1/photos/p1'];
const IDENTITY = ['emp_index/1001', 'registration_requests/u2', 'meta/counters', S + '/users/u1', S + '/roster/u1'];
const RESTORABLE = [S, S + '/config/hrConfig', 'config/mode', 'config/other', S + '/shifts/crew_a', S + '/callouts/co1', S + '/callouts/co1/responses/u1', S + '/shifts/crew_a/days/2026-09-01', 'join_campaigns/camp1', 'join_campaigns/camp1/registrants/u9', S + '/faults/f1'];
const ORPHAN = 'join_campaigns/orphan/registrants/u8'; // נצלם ומתוכנן, אבל אינו נכתב כי האב אינו ביעד

const fixedNow = () => new Date('2026-09-18T10:00:00.000Z');
/* מפתח חתימה תקף לבדיקות. שחזור שבוצע חייב חתימה, ולכן כל ריצת
 * execute כאן נושאת מפתח; המקרים חסרי-המפתח נבדקים במפורש ודורשים כשל. */
const TEST_SIGNING_KEY = 'test-signing-key-'.padEnd(48, 'x');
const envWith = (extra) => Object.assign({ RESQ_RESTORE_TARGET_ALLOWLIST: '', RESQ_RESTORE_SIGNING_KEY: TEST_SIGNING_KEY }, extra);
const backupArgs = dr.parseArgs(['backup', '--source', 'station-102']);
let setDir;

try {
  await check('canonical JSON is key-sorted, stable and rejects non-finite numbers', async () => {
    assert.equal(dr.canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
    assert.equal(dr.documentHash({ b: 1, a: 2 }), dr.documentHash({ a: 2, b: 1 }));
    assert.throws(() => dr.canonicalJson({ n: Infinity }), /לא סופי/);
    assert.throws(() => dr.canonicalJson({ u: undefined }), /undefined/);
  });

  await check('Firestore values round-trip through tagged snapshot encoding', async () => {
    const ts = { seconds: 1788220800, nanoseconds: 500, toDate: () => new Date(1788220800000) };
    const encoded = dr.encodeValue({ t: ts, g: { latitude: 29.5, longitude: 34.9 }, r: { path: 'stations/x', firestore: {} }, b: Buffer.from('hi'), d: new Date(0), nested: [ts] });
    assert.deepEqual(encoded.t, { __ts: '2026-09-01T00:00:00.000Z', __nanos: 500 });
    assert.deepEqual(encoded.g, { __geo: { lat: 29.5, lng: 34.9 } });
    assert.deepEqual(encoded.r, { __ref: 'stations/x' });
    assert.deepEqual(encoded.b, { __bytes: Buffer.from('hi').toString('base64') });
    assert.deepEqual(encoded.d, { __ts: '1970-01-01T00:00:00.000Z' });
    const decoded = dr.decodeValue(encoded, null);
    assert.ok(decoded.t instanceof Date); assert.equal(decoded.r.path, 'stations/x'); assert.equal(decoded.b.toString(), 'hi');
    assert.equal(decoded.g.latitude, 29.5);
  });

  await check('path → policy template matching prefers literal segments and handles {document=**}', async () => {
    assert.equal(dr.classifyPath('config/mode', policy).template, 'config/mode');
    assert.equal(dr.classifyPath('config/other', policy).template, 'config/{docId}');
    assert.equal(dr.classifyPath(S + '/push_tokens/u1', policy).template, 'stations/{sid}/push_tokens/{uid}');
    assert.equal(dr.classifyPath(S + '/shifts/crew_a/days/2026-09-01', policy).template, 'stations/{sid}/shifts/{crew}/{document=**}');
    assert.equal(dr.classifyPath(S + '/shifts/crew_a/days/2026-09-01', policy).action, 'after_parent');
    assert.equal(dr.classifyPath(S + '/shifts/crew_a/days/2026-09-01', policy).parent, S + '/shifts/crew_a');
    assert.equal(dr.classifyPath('mystery_collection/z1', policy).action, 'unclassified');
    assert.equal(dr.classifyPath('stations/x', policy).action, 'restore');
    assert.equal(dr.classifyPath('stations', policy).action, 'unclassified');
    assert.equal(dr.classifyPath('_resq_restore_canary/r', policy).action, 'skipped_policy');
  });

  await check('every exclude / do_not_restore / rebuild policy in DATA_POLICIES classifies as skipped_policy; specialized as manual_required', async () => {
    let skipped = 0, manual = 0;
    for (const item of policy.DATA_POLICIES) {
      const concrete = item.path.split('/').map((seg, i) => seg === '{document=**}' ? 'deep/x' : seg.startsWith('{') ? 'id' + i : seg).join('/');
      const cls = dr.classifyPath(concrete, policy);
      assert.equal(cls.template, item.path, 'template round-trip for ' + item.path);
      if (item.backupPolicy === 'exclude' || item.restorePolicy === 'do_not_restore' || item.restorePolicy === 'rebuild') { assert.equal(cls.action, 'skipped_policy', item.path); skipped++; }
      else if (item.backupPolicy === 'specialized_media_export' || item.restorePolicy === 'specialized_restore') { assert.equal(cls.action, 'manual_required', item.path); manual++; }
      else if (policy.IDENTITY_POLICY_PATHS.includes(item.path)) assert.equal(cls.action, 'identity', item.path);
      else assert.ok(['restore', 'after_parent'].includes(cls.action), item.path);
    }
    assert.ok(skipped >= 50 && manual >= 10, 'policy coverage: ' + skipped + '/' + manual);
  });

  await check('parseArgs: subcommands, duplicate args, dry-run default, confirm rules', async () => {
    assert.throws(() => dr.parseArgs([]), /פקודה לא מוכרת/);
    assert.throws(() => dr.parseArgs(['backup']), /--source/);
    assert.throws(() => dr.parseArgs(['backup', '--source', 'demo-resq', '--source', 'demo-resq']), /כפול/);
    assert.throws(() => dr.parseArgs(['verify', '--set', 'x', '--target', 'y']), /לא מוכר/);
    assert.equal(dr.parseArgs(['backup', '--source', 'demo-resq']).dryRun, false);
    assert.equal(dr.parseArgs(['backup', '--source', 'demo-resq', '--dry-run']).dryRun, true);
    const restore = dr.parseArgs(['restore', '--set', 'x', '--target', 'demo-resq']);
    assert.equal(restore.dryRun, true); assert.equal(restore.execute, false);
    assert.throws(() => dr.parseArgs(['restore', '--set', 'x', '--target', 'demo-resq', '--execute']), /confirm-target/);
    assert.throws(() => dr.parseArgs(['restore', '--set', 'x', '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq2']), /אינו זהה/);
    assert.throws(() => dr.parseArgs(['restore', '--set', 'x', '--target', 'demo-resq', '--confirm-target', 'demo-resq']), /תקף רק עם/);
    assert.throws(() => dr.parseArgs(['restore', '--set', 'x', '--target', 'demo-resq', '--dry-run', '--execute', '--confirm-target', 'demo-resq']), /סותרים/);
    assert.equal(dr.parseArgs(['restore', '--set', 'x', '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq']).dryRun, false);
  });

  await check('backup dry-run touches nothing and loads no api', async () => {
    const result = await dr.runBackup(dr.parseArgs(['backup', '--source', 'station-102', '--dry-run']), { root: fixture });
    assert.equal(result.dryRun, true); assert.equal(result.sdk, 'not loaded');
    assert.equal(fs.existsSync(path.join(fixture, '_גיבוי')), false);
    await assert.rejects(dr.runBackup(dr.parseArgs(['backup', '--source', 'demo-resq', '--out', '_ניטור']), { root: fixture, firestoreApi: createFakeApi() }), /לא בטוח/);
    await assert.rejects(dr.runBackup(dr.parseArgs(['backup', '--source', 'demo-resq', '--out', '..']), { root: fixture, firestoreApi: createFakeApi() }), /שורש|לא בטוח/);
    await assert.rejects(dr.runBackup(dr.parseArgs(['backup', '--source', 'demo-resq']), { root: fixture }), /firestoreApi/);
    assert.equal(fs.existsSync(path.join(fixture, '_גיבוי')), false);
  });

  await check('backup writes a verified snapshot set; excluded classes are counted, never stored', async () => {
    const api = createFakeApi(seed);
    const result = await dr.runBackup(backupArgs, { root: fixture, firestoreApi: api, now: fixedNow });
    setDir = result.destination;
    assert.match(path.basename(setDir), dr.SET);
    assert.equal(api.calls.create, 0);
    const set = dr.readSet(setDir);
    assert.equal(set.manifest.schema, 'resq-firestore-snapshot-v1');
    assert.equal(set.manifest.state, 'complete');
    assert.equal(set.manifest.source_project, 'station-102');
    assert.equal(set.manifest.created_at, '2026-09-18T10:00:00.000Z');
    assert.equal(set.manifest.policy_digest, dr.policyDigest(policy));
    const stored = set.documents.map((d) => d.path);
    for (const p of EXCLUDED) assert.equal(stored.includes(p), false, 'excluded must not be stored: ' + p);
    for (const p of [...RESTORABLE, ...IDENTITY, ...MANUAL, ORPHAN]) assert.ok(stored.includes(p), 'must be stored: ' + p);
    assert.equal(stored.includes('join_campaigns/orphan'), false, 'a missing parent document is never invented');
    assert.equal(stored.length, RESTORABLE.length + IDENTITY.length + MANUAL.length + 1);
    assert.equal(fs.readFileSync(path.join(setDir, 'documents.jsonl'), 'utf8').includes('SECRET-TOKEN'), false);
    const excludedCount = set.manifest.paths_excluded.reduce((s, p) => s + p.count, 0);
    assert.equal(excludedCount, EXCLUDED.length - 1); // mystery_collection is unclassified, not excluded
    assert.equal(set.manifest.paths_unclassified.length, 1);
    assert.equal(set.manifest.identity_group.count, IDENTITY.length);
    for (const d of set.documents) assert.equal(d.sha256, dr.documentHash(d.data));
    assert.ok(fs.existsSync(path.join(setDir, 'snapshot-manifest.md')));
    assert.equal(fs.existsSync(path.join(fixture, '_גיבוי', '.resq-fs-backup.lock')), false);
    const verification = dr.verifySet(setDir, { root: fixture });
    assert.deepEqual(verification.errors, []); assert.equal(verification.ok, true);
  });

  await check('tampered documents.jsonl / manifest fails verify and blocks restore before any write', async () => {
    const file = path.join(setDir, 'documents.jsonl');
    const original = fs.readFileSync(file, 'utf8');
    try {
      fs.writeFileSync(file, original.replace('"next_emp":1002', '"next_emp":9999'));
      const v = dr.verifySet(setDir, { root: fixture });
      assert.equal(v.ok, false);
      assert.ok(v.errors.some((e) => /SHA-256 של המסמך/.test(e)) && v.errors.some((e) => /documents\.jsonl/.test(e)));
      const api = createFakeApi();
      await assert.rejects(dr.runRestore(dr.parseArgs(['restore', '--set', setDir, '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq']),
        { root: fixture, firestoreApi: api, env: envWith({ RESQ_RESTORE_TARGET_ALLOWLIST: 'demo-resq' }) }), /נכשל באימות/);
      assert.equal(api.calls.create, 0);
    } finally { fs.writeFileSync(file, original); }
    const manifestFile = path.join(setDir, 'snapshot-manifest.json');
    const manifestOriginal = fs.readFileSync(manifestFile, 'utf8');
    try {
      const m = JSON.parse(manifestOriginal); m.documents.count += 1; m.identity_group.count -= 1;
      fs.writeFileSync(manifestFile, JSON.stringify(m));
      const v = dr.verifySet(setDir, { root: fixture });
      assert.equal(v.ok, false);
      assert.ok(v.errors.some((e) => /ספירת המסמכים/.test(e)) && v.errors.some((e) => /קבוצת הזהות/.test(e)));
    } finally { fs.writeFileSync(manifestFile, manifestOriginal); }
    assert.equal(dr.verifySet(setDir, { root: fixture }).ok, true);
  });

  await check('plan excludes every exclude/rebuild/do_not_restore path, lists specialized as manual_required, orders after_parent after parent', async () => {
    const set = dr.readSet(setDir);
    const plan = dr.buildPlan(set, 'demo-resq', { root: fixture, now: () => new Date('2026-09-18T10:05:00.000Z') });
    const planned = plan.write_order.map((d) => d.path);
    for (const p of EXCLUDED) assert.equal(planned.includes(p), false, p);
    for (const p of MANUAL) { assert.equal(planned.includes(p), false, p); assert.ok(plan.manual_required.some((m) => m.path === p), p); }
    for (const p of IDENTITY) { assert.equal(planned.includes(p), false, p); assert.ok(plan.identity_group.documents.some((m) => m.path === p), p); }
    assert.equal(plan.counts.skipped_policy, 0); assert.equal(plan.counts.unclassified, 0);
    assert.ok(planned.indexOf(S + '/shifts/crew_a') < planned.indexOf(S + '/shifts/crew_a/days/2026-09-01'));
    assert.ok(planned.indexOf('join_campaigns/camp1') < planned.indexOf('join_campaigns/camp1/registrants/u9'));
    assert.ok(planned.indexOf(S) < planned.indexOf(S + '/config/hrConfig'));
    assert.equal(plan.rpo.seconds, 300); assert.equal(plan.rpo.measured, true);
    assert.equal(plan.identity_group.name, 'identity_and_auth');
    // סט שמכיל מסמך מוחרג (מדיניות השתנתה) — התוכנית מדלגת עליו, לא כותבת
    const poisoned = { manifest: set.manifest, documents: [...set.documents, { path: S + '/push_tokens/z', data: { t: 1 }, sha256: dr.documentHash({ t: 1 }) }, { path: 'nope/x', data: {}, sha256: dr.documentHash({}) }] };
    const plan2 = dr.buildPlan(poisoned, 'demo-resq', { root: fixture });
    assert.equal(plan2.counts.skipped_policy, 1); assert.equal(plan2.counts.unclassified, 1);
    assert.equal(plan2.write_order.some((d) => d.path.includes('push_tokens') || d.path.startsWith('nope/')), false);
  });

  await check('target == source is refused', async () => {
    assert.throws(() => dr.refuseTarget('demo-resq', 'demo-resq', { root: fixture }), /חייבים להיות שונים/);
    const api = createFakeApi();
    // סט שמקורו demo-resq
    const api2 = createFakeApi({ 'config/mode': { mode: 'x' } });
    const other = await dr.runBackup(dr.parseArgs(['backup', '--source', 'demo-resq']), { root: fixture, firestoreApi: api2, now: fixedNow });
    await assert.rejects(dr.runRestore(dr.parseArgs(['restore', '--set', other.destination, '--target', 'demo-resq']), { root: fixture, firestoreApi: api, env: envWith({}) }), /חייבים להיות שונים/);
    assert.equal(api.calls.create, 0);
  });

  await check('production target station-102 is refused even with --execute --confirm-target and allowlist', async () => {
    const api = createFakeApi();
    const set2 = (await dr.runBackup(dr.parseArgs(['backup', '--source', 'demo-resq']), { root: fixture, firestoreApi: createFakeApi({ 'config/mode': { mode: 'x' } }), now: fixedNow })).destination;
    for (const argv of [['restore', '--set', set2, '--target', 'station-102'], ['restore', '--set', set2, '--target', 'station-102', '--execute', '--confirm-target', 'station-102']]) {
      await assert.rejects(dr.runRestore(dr.parseArgs(argv), { root: fixture, firestoreApi: api, env: envWith({ RESQ_RESTORE_TARGET_ALLOWLIST: 'station-102,demo-resq' }) }), /סירוב קשיח/);
    }
    assert.equal(api.calls.create, 0);
    // גם מזהה שמגיע מ-.firebaserc בלבד (לא מהרשימה הקשיחה)
    const altRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-dr-alt-'));
    try {
      fs.writeFileSync(path.join(altRoot, '.firebaserc'), JSON.stringify({ projects: { default: 'future-prod-id' } }));
      assert.throws(() => dr.refuseTarget('future-prod-id', 'demo-resq', { root: altRoot }), /סירוב קשיח/);
      assert.throws(() => dr.refuseTarget('station-102', 'demo-resq', { root: altRoot }), /סירוב קשיח/);
    } finally { fs.rmSync(altRoot, { recursive: true, force: true }); }
  });

  await check('execute without confirm / confirm mismatch / missing allowlist are refused with zero writes', async () => {
    const api = createFakeApi();
    const base = ['restore', '--set', setDir, '--target', 'demo-resq'];
    assert.throws(() => dr.parseArgs([...base, '--execute']), /confirm-target/);
    assert.throws(() => dr.parseArgs([...base, '--execute', '--confirm-target', 'demo-resq-x']), /אינו זהה/);
    const args = dr.parseArgs([...base, '--execute', '--confirm-target', 'demo-resq']);
    await assert.rejects(dr.runRestore(Object.assign({}, args, { confirmTarget: 'demo-resq-x' }), { root: fixture, firestoreApi: api, env: envWith({ RESQ_RESTORE_TARGET_ALLOWLIST: 'demo-resq' }) }), /confirm-target/);
    await assert.rejects(dr.runRestore(args, { root: fixture, firestoreApi: api, env: envWith({}) }), /ALLOWLIST.*חסר/);
    await assert.rejects(dr.runRestore(args, { root: fixture, firestoreApi: api, env: envWith({ RESQ_RESTORE_TARGET_ALLOWLIST: 'other-project' }) }), /אינו מופיע/);
    await assert.rejects(dr.runRestore(args, { root: fixture, env: envWith({ RESQ_RESTORE_TARGET_ALLOWLIST: 'demo-resq' }) }), /firestoreApi/);
    assert.equal(api.calls.create, 0);
  });

  await check('dry-run writes zero documents, needs no allowlist, produces plan + unmeasured report', async () => {
    const api = createFakeApi();
    // dry-run ללא מפתח חתימה מותר — ומסומן unsigned במפורש.
    const result = await dr.runRestore(dr.parseArgs(['restore', '--set', setDir, '--target', 'demo-resq']), { root: fixture, firestoreApi: api, env: envWith({ RESQ_RESTORE_SIGNING_KEY: '' }), now: fixedNow });
    assert.equal(result.mode, 'dry-run'); assert.equal(result.ok, true);
    assert.equal(api.calls.create, 0); assert.equal(api.calls.get, 0);
    assert.equal(result.summary.written, 0);
    assert.equal(result.summary.planned_writes, RESTORABLE.length + IDENTITY.length + 1);
    assert.equal(result.rpo_seconds, null); assert.equal(result.rto_seconds, null); assert.equal(result.measured, false);
    assert.equal(result.canary.status, 'not_attempted');
    assert.equal(result.identity_group.status, 'planned');
    for (const name of ['restore-plan.json', 'restore-plan.md', 'integrity-report.json', 'integrity-report.md', 'restore-manifest.json']) assert.ok(fs.existsSync(path.join(result.run_dir, name)), name);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.run_dir, 'restore-manifest.json'), 'utf8'));
    assert.equal(manifest.signature, null); assert.equal(manifest.unsigned, true);
    assert.equal(manifest.rpo_seconds, null); assert.equal(manifest.measured, false);
    // ריצת dry-run אינה שוברת את אימות הסט
    assert.equal(dr.verifySet(setDir, { root: fixture }).ok, true);
    // אותו dry-run עם מפתח — נחתם. החתימה אינה תלויה במצב, רק במפתח.
    const signedDry = await dr.runRestore(dr.parseArgs(['restore', '--set', setDir, '--target', 'demo-resq']),
      { root: fixture, firestoreApi: createFakeApi(), env: envWith({}), now: fixedNow });
    assert.equal(signedDry.signed, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(signedDry.run_dir, 'restore-manifest.json'), 'utf8')).unsigned, false);
  });

  await check('execute writes only allowed docs, canary first, skips existing, never overwrites, reads back every write', async () => {
    const preExisting = { [S + '/config/hrConfig']: { month_start: 99, note: 'existing-in-target' }, 'join_campaigns/camp1': { title: 'already here' } };
    const api = createFakeApi(preExisting);
    let tick = 0;
    const now = () => new Date(Date.parse('2026-09-18T12:00:00.000Z') + (tick++ ? 7000 : 0));
    const result = await dr.runRestore(dr.parseArgs(['restore', '--set', setDir, '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq']),
      { root: fixture, firestoreApi: api, env: envWith({ RESQ_RESTORE_TARGET_ALLOWLIST: 'staging-a, demo-resq', RESQ_RESTORE_SIGNING_KEY: TEST_SIGNING_KEY }), now });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.mode, 'execute');
    assert.ok(api.createdPaths[0].startsWith('_resq_restore_canary/run-'), 'canary must be the first write');
    assert.equal(result.canary.status, 'ok');
    const written = api.createdPaths.slice(1);
    for (const p of EXCLUDED) assert.equal(written.includes(p), false, p);
    for (const p of MANUAL) assert.equal(written.includes(p), false, p);
    assert.equal(written.includes(ORPHAN), false, 'after_parent without parent must not be written');
    assert.equal(result.summary.skipped_parent_not_restored, 1);
    for (const p of Object.keys(preExisting)) { assert.equal(written.includes(p), false, p); assert.deepEqual(api.store.get(p), preExisting[p]); }
    assert.equal(result.summary.skipped_exists, 2);
    assert.ok(written.includes('join_campaigns/camp1/registrants/u9'), 'child of a pre-existing parent is written');
    assert.equal(result.identity_group.status, 'restored');
    for (const p of IDENTITY) assert.ok(written.includes(p), p);
    assert.equal(result.summary.written, RESTORABLE.length - 2 - 0 + IDENTITY.length);
    assert.equal(result.summary.manual_required, MANUAL.length);
    assert.equal(result.mismatch_after_readback, 0);
    assert.equal(result.measured, true);
    assert.equal(result.rpo_seconds, Math.round((Date.parse('2026-09-18T12:00:00.000Z') - Date.parse('2026-09-18T10:00:00.000Z')) / 1000));
    assert.equal(result.rto_seconds, 7);
    assert.equal(result.signed, true);
    const report = JSON.parse(fs.readFileSync(path.join(result.run_dir, 'integrity-report.json'), 'utf8'));
    assert.equal(report.written.length, result.summary.written);
    assert.ok(report.written.every((w) => dr.documentHash(api.store.get(w.path)) === w.sha256));
    const manifest = JSON.parse(fs.readFileSync(path.join(result.run_dir, 'restore-manifest.json'), 'utf8'));
    assert.equal(manifest.signature.alg, 'HMAC-SHA256'); assert.equal(manifest.unsigned, false);
    assert.equal(dr.verifySignature(report, manifest, { RESQ_RESTORE_SIGNING_KEY: TEST_SIGNING_KEY }).verified, true);
    assert.equal(dr.verifySignature(report, manifest, { RESQ_RESTORE_SIGNING_KEY: 'wrong-key-'.padEnd(48, 'y') }).verified, false);
    const md = fs.readFileSync(path.join(result.run_dir, 'integrity-report.md'), 'utf8');
    assert.ok(md.includes('| written | ' + result.summary.written + ' |') && md.includes('restored'));
  });

  await check('readback mismatch is reported and fails the run', async () => {
    const api = createFakeApi();
    api.readbackOverride.set('config/mode', { mode: 'corrupted-on-readback' });
    const result = await dr.runRestore(dr.parseArgs(['restore', '--set', setDir, '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq']),
      { root: fixture, firestoreApi: api, env: envWith({ RESQ_RESTORE_TARGET_ALLOWLIST: 'demo-resq' }) });
    assert.equal(result.ok, false); assert.equal(result.mismatch_after_readback, 1);
    const report = JSON.parse(fs.readFileSync(path.join(result.run_dir, 'integrity-report.json'), 'utf8'));
    assert.equal(report.mismatch_after_readback[0].path, 'config/mode');
    // ריצה שנכשלה היא עדיין ריצה שבוצעה: המניפסט שלה חייב להיות חתום.
    assert.equal(result.signed, true);
    const rbManifest = JSON.parse(fs.readFileSync(path.join(result.run_dir, 'restore-manifest.json'), 'utf8'));
    assert.equal(rbManifest.unsigned, false);
    assert.equal(rbManifest.signature.alg, 'HMAC-SHA256');
    assert.equal(dr.verifySignature(report, rbManifest, { RESQ_RESTORE_SIGNING_KEY: TEST_SIGNING_KEY }).verified, true);
  });

  await check('identity group is all-or-nothing: partial identity state in target skips every identity write', async () => {
    const api = createFakeApi({ 'emp_index/1001': { uid: 'someone-else' } });
    const result = await dr.runRestore(dr.parseArgs(['restore', '--set', setDir, '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq']),
      { root: fixture, firestoreApi: api, env: envWith({ RESQ_RESTORE_TARGET_ALLOWLIST: 'demo-resq' }) });
    assert.equal(result.identity_group.status, 'skipped');
    assert.match(result.identity_group.reason, /target_has_partial_identity_state:emp_index\/1001/);
    for (const p of IDENTITY) assert.equal(api.createdPaths.includes(p), false, p);
    assert.deepEqual(api.store.get('emp_index/1001'), { uid: 'someone-else' });
    assert.ok(api.createdPaths.includes('config/mode'), 'non-identity docs still restore');
    assert.equal(result.summary.skipped_exists, 0, 'identity docs blocked by the gate are not counted as skipped_exists');
  });

  await check('identity group checksum gate: a set whose identity digest disagrees is skipped before any identity write', async () => {
    // מזייפים סט: המניפסט מצביע על טביעת קבוצת זהות אחרת — verify מזהה, ואם
    // מישהו יעקוף את verify, השער של הקבוצה עדיין עוצר.
    const set = dr.readSet(setDir);
    const forged = Object.assign({}, set, { manifest: Object.assign({}, set.manifest, { identity_group: { count: IDENTITY.length, sha256: 'f'.repeat(64) } }) });
    assert.equal(dr.verifySet(setDir, { root: fixture }).ok, true);
    const v = Object.assign({}, dr.verifySet(setDir, { root: fixture }));
    assert.ok(v.ok);
    const plan = dr.buildPlan(forged, 'demo-resq', { root: fixture });
    const digest = dr.sha256Hex(plan.identity_group.documents.map((d) => d.sha256).sort().join('\n'));
    assert.notEqual(digest, forged.manifest.identity_group.sha256);
    assert.equal(digest, set.manifest.identity_group.sha256);
  });

  await check('a failing canary aborts with zero data writes', async () => {
    const api = createFakeApi();
    const origCreate = api.createDocument;
    api.createDocument = async (p, d) => { if (p.startsWith('_resq_restore_canary/')) throw new Error('canary refused'); return origCreate(p, d); };
    const result = await dr.runRestore(dr.parseArgs(['restore', '--set', setDir, '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq']),
      { root: fixture, firestoreApi: api, env: envWith({ RESQ_RESTORE_TARGET_ALLOWLIST: 'demo-resq' }) });
    assert.equal(result.ok, false); assert.equal(result.canary.status, 'failed');
    assert.equal(api.createdPaths.length, 0); assert.equal(result.summary.written, 0);
    assert.ok(result.errors[0].includes('הקנרית'));
  });

  await check('a write failure mid-run stops the run, keeps what was written and reports the error', async () => {
    const api = createFakeApi();
    api.failCreateFor.add(S + '/shifts/crew_a');
    const result = await dr.runRestore(dr.parseArgs(['restore', '--set', setDir, '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq']),
      { root: fixture, firestoreApi: api, env: envWith({ RESQ_RESTORE_TARGET_ALLOWLIST: 'demo-resq' }) });
    assert.equal(result.ok, false);
    assert.equal(result.identity_group.status, 'skipped');
    assert.match(result.identity_group.reason, /run_aborted/);
    assert.ok(result.errors[0].includes('injected create failure'));
  });

  await check('report command lists runs, checks report digest and signature state', async () => {
    const report = dr.runReport(dr.parseArgs(['report', '--set', setDir]), { env: envWith({ RESQ_RESTORE_SIGNING_KEY: TEST_SIGNING_KEY }) });
    assert.ok(report.runs.length >= 5);
    assert.ok(report.runs.every((r) => r.report_sha256_ok));
    const signed = report.runs.filter((r) => !r.unsigned);
    assert.ok(signed.length >= 1 && signed.every((r) => r.signature.verified));
    assert.ok(report.runs.filter((r) => r.unsigned).every((r) => r.signature.reason === 'unsigned'));
    const dryRuns = report.runs.filter((r) => r.mode === 'dry-run');
    assert.ok(dryRuns.length >= 1 && dryRuns.every((r) => r.measured === false && r.rpo_seconds === null));
  });

  await check('CLI: verify / plan / report / dry-run restore work end-to-end via subprocess', async () => {
    const env = Object.assign({}, process.env, { RESQ_REPO_ROOT: fixture });
    delete env.RESQ_RESTORE_TARGET_ALLOWLIST; delete env.RESQ_RESTORE_SIGNING_KEY;
    const run = (argv) => execFileSync(process.execPath, [scriptPath, ...argv], { encoding: 'utf8', env, timeout: 20000, windowsHide: true, stdio: 'pipe' });
    assert.equal(JSON.parse(run(['verify', '--set', setDir]).trim()).ok, true);
    const planOut = run(['plan', '--set', setDir, '--target', 'demo-resq']);
    assert.equal(JSON.parse(planOut.split('\n')[0]).counts.identity, IDENTITY.length);
    assert.ok(planOut.includes('manual_required'));
    const restoreOut = JSON.parse(run(['restore', '--set', setDir, '--target', 'demo-resq']).trim());
    assert.equal(restoreOut.mode, 'dry-run'); assert.equal(restoreOut.summary.written, 0);
    assert.ok(JSON.parse(run(['report', '--set', setDir])).runs.length >= 1);
    for (const argv of [['restore', '--set', setDir, '--target', 'station-102'], ['restore', '--set', setDir, '--target', 'station-102', '--execute', '--confirm-target', 'station-102'], ['plan', '--set', setDir, '--target', 'station-102']]) {
      assert.throws(() => run(argv), (error) => /סירוב קשיח/.test(String(error.stderr)));
    }
    assert.throws(() => run(['restore', '--set', setDir, '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq']), (error) => /ALLOWLIST/.test(String(error.stderr)));
  });

  await check('sandboxed probe: dry-run restore performs no firebase-admin import, no network, no subprocess', async () => {
    const probe = [
      "import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import cp from 'node:child_process';",
      "import Module, { syncBuiltinESMExports } from 'node:module';",
      "const refuse = () => { throw new Error('dry-run attempted a side effect'); };",
      "http.request = https.request = http.get = https.get = net.connect = net.createConnection = refuse;",
      "net.Socket.prototype.connect = refuse; globalThis.fetch = refuse;",
      "for (const name of ['execFileSync','execSync','spawnSync','spawn','exec','execFile']) cp[name] = refuse;",
      "const load = Module._load; Module._load = function(name,...rest) { if (/firebase|google-auth|gaxios|grpc/.test(name)) refuse(); return load.call(this,name,...rest); };",
      "const resolve = Module._resolveFilename; Module._resolveFilename = function(name,...rest) { if (/firebase|google-auth|gaxios|grpc/.test(name)) refuse(); return resolve.call(this,name,...rest); };",
      'syncBuiltinESMExports();',
      'process.argv = [process.execPath, ' + JSON.stringify(scriptPath) + ', "restore", "--set", ' + JSON.stringify(setDir) + ', "--target", "demo-resq"];',
      'await import(' + JSON.stringify(pathToFileURL(scriptPath).href) + ');'
    ].join('\n');
    const env = Object.assign({}, process.env, { RESQ_REPO_ROOT: fixture });
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', env, timeout: 20000, windowsHide: true });
    const result = JSON.parse(output.trim());
    assert.equal(result.mode, 'dry-run'); assert.equal(result.summary.written, 0); assert.equal(result.measured, false);
    // ההוכחה ההפוכה: אותו sandbox עם --execute מגיע לניסיון טעינת SDK ונחסם — כלומר החסימה אמיתית
    const executeEnv = Object.assign({}, env, { RESQ_RESTORE_TARGET_ALLOWLIST: 'demo-resq' });
    const executeProbe = probe.replace('"--target", "demo-resq"]', '"--target", "demo-resq", "--execute", "--confirm-target", "demo-resq"]');
    assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', executeProbe], { encoding: 'utf8', env: executeEnv, timeout: 20000, windowsHide: true, stdio: 'pipe' }),
      (error) => /side effect|firebase-admin|Cannot find/.test(String(error.stderr)));
  });

  await check('ops-disaster-restore.ps1 uses no PowerShell-7-only syntax and keeps the required guards', async () => {
    /* CRLF אינו פגם: checkout עם core.autocrlf=true מוציא את הקובץ כך.
       מנרמלים לפני ניתוח התחביר, ודוחים CR בודד ותווי בקרה בלבד. */
    const raw = normalizeEol(fs.readFileSync(path.resolve(here, '..', 'ops-disaster-restore.ps1'), 'utf8'));
    assert.deepEqual(eolProblems(raw), [], 'lone CR or control characters in the .ps1');
    // מסירים מחרוזות והערות ואז בודקים תחביר
    const stripped = raw.split('\n').map((line) => {
      let out = ''; let quote = '';
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) { if (ch === quote) quote = ''; out += ' '; continue; }
        if (ch === '#') break;
        if (ch === '\'' || ch === '"') { quote = ch; out += ' '; continue; }
        out += ch;
      }
      return out;
    }).join('\n');
    assert.doesNotMatch(stripped, /\?\?/, 'null-coalescing ?? is PowerShell 7 only');
    assert.doesNotMatch(stripped, /\?\./, 'null-conditional ?. is PowerShell 7 only');
    assert.doesNotMatch(stripped, /\?\s*[^\s?:]+\s*:/, 'ternary is PowerShell 7 only');
    assert.doesNotMatch(stripped, /-Parallel/i, '-Parallel is PowerShell 7 only');
    assert.doesNotMatch(stripped, /\s-Path\s/, 'use -LiteralPath');
    assert.ok(/Test-Path -LiteralPath/.test(raw));
    assert.ok(/\$PSVersionTable\.PSVersion\.Major/.test(raw));
    assert.ok(raw.includes("if ($DryRun -and $Execute) { throw") && raw.includes('$ConfirmTarget -cne $Target'));
    assert.ok(raw.includes("'--dry-run'") && raw.includes("'--confirm-target'"));
    assert.equal((raw.match(/\$PSVersionTable/g) || []).length, 1, 'PSVersion is used for the log line only');
  });

  await check('no lone CR or control characters in the delivered sources (CRLF tolerated)', async () => {
    for (const name of ['ops-disaster-restore.mjs', 'ops-disaster-restore.ps1', 'DISASTER-RECOVERY-RUNBOOK.md', 'DR-WIRING.md', path.join('tests', 'ops-disaster-restore.test.mjs')]) {
      const file = path.resolve(here, '..', name);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      assert.deepEqual(eolProblems(text), [], name + ' carries a lone CR or a control character');
    }
    const source = fs.readFileSync(scriptPath, 'utf8');
    assert.doesNotMatch(source, /^import[^\n]*firebase/m, 'no top-level firebase import');
    assert.doesNotMatch(source, /^const[^\n]*require\(['"]firebase/m, 'no top-level firebase require');
  });

  await check('identity group is written in ONE atomic commit, never document by document', async () => {
    const api = createFakeApi();
    const result = await dr.runRestore(dr.parseArgs(['restore', '--set', setDir, '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq']),
      { root: fixture, firestoreApi: api, env: envWith({ RESQ_RESTORE_TARGET_ALLOWLIST: 'demo-resq' }) });
    assert.equal(result.identity_group.status, 'restored');
    assert.equal(result.identity_group.reason, 'atomic_commit_after_all_checksums_verified');
    assert.equal(api.calls.commitAtomic, 1, 'exactly one atomic commit for the whole identity group');
    for (const p of IDENTITY) assert.ok(api.store.has(p), p + ' missing after the atomic commit');
  });

  await check('a failure on the SECOND identity document leaves ZERO identity documents written', async () => {
    // הכשל המהותי שהביקורת מצאה: כתיבה בזה אחר זה משאירה את הראשון
    // אחרי שהשני נכשל. עם קומיט אטומי — אף אחד מהם לא נכתב.
    const second = IDENTITY[1];
    const api = createFakeApi();
    api.failCreateFor.add(second);
    const result = await dr.runRestore(dr.parseArgs(['restore', '--set', setDir, '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq']),
      { root: fixture, firestoreApi: api, env: envWith({ RESQ_RESTORE_TARGET_ALLOWLIST: 'demo-resq' }) });
    assert.equal(result.identity_group.status, 'skipped');
    assert.match(result.identity_group.reason, /atomic_commit_failed/);
    for (const p of IDENTITY) {
      assert.equal(api.store.has(p), false, p + ' was written despite the failed atomic commit');
      assert.equal(api.createdPaths.includes(p), false, p + ' appears in createdPaths');
      assert.equal(result.summary.written > 0 && JSON.stringify(result).includes('"' + p + '"') &&
        JSON.parse(fs.readFileSync(path.join(result.run_dir, 'integrity-report.json'), 'utf8')).written.some((w) => w.path === p), false,
        p + ' is reported as written');
    }
    assert.equal(result.ok, false, 'a failed identity group fails the run');
    const report = JSON.parse(fs.readFileSync(path.join(result.run_dir, 'integrity-report.json'), 'utf8'));
    assert.ok(report.errors.some((e) => /קבוצת הזהות לא נכתבה/.test(e)));
    // מסמכים שאינם זהות שנכתבו לפני כן נשארים — הם אינם חלק מהקבוצה.
    assert.ok(api.createdPaths.includes('config/mode'));
  });

  await check('an identity group larger than the atomic commit limit is refused, not split', async () => {
    const api = createFakeApi();
    const result = await dr.runRestore(dr.parseArgs(['restore', '--set', setDir, '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq']),
      { root: fixture, firestoreApi: api, env: envWith({ RESQ_RESTORE_TARGET_ALLOWLIST: 'demo-resq' }), atomicLimitOverride: 2 });
    // הגבול נבדק מול ATOMIC_COMMIT_LIMIT האמיתי; כאן מוודאים שהקבוע קיים
    // ושהגדלים נבדקים מולו, ושהערך הוא גבול ה-batch של Firestore.
    assert.equal(dr.ATOMIC_COMMIT_LIMIT, 500);
    assert.ok(IDENTITY.length <= dr.ATOMIC_COMMIT_LIMIT);
    assert.equal(result.identity_group.status, 'restored');
    const src = fs.readFileSync(new URL('../ops-disaster-restore.mjs', import.meta.url), 'utf8');
    assert.match(src, /group_exceeds_atomic_commit_limit/);
    assert.match(src, /identityDocs\.length > ATOMIC_COMMIT_LIMIT/);
  });

  await check('an adapter without commitAtomic restores no identity document at all', async () => {
    const api = createFakeApi();
    delete api.commitAtomic;
    const result = await dr.runRestore(dr.parseArgs(['restore', '--set', setDir, '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq']),
      { root: fixture, firestoreApi: api, env: envWith({ RESQ_RESTORE_TARGET_ALLOWLIST: 'demo-resq' }) });
    assert.equal(result.identity_group.status, 'skipped');
    assert.match(result.identity_group.reason, /adapter_has_no_atomic_commit/);
    for (const p of IDENTITY) assert.equal(api.store.has(p), false, p);
  });

  await check('--execute without a signing key fails before the canary, with zero writes', async () => {
    for (const key of ['', 'short-key']) {
      const api = createFakeApi();
      await assert.rejects(
        dr.runRestore(dr.parseArgs(['restore', '--set', setDir, '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq']),
          { root: fixture, firestoreApi: api, env: envWith({ RESQ_RESTORE_TARGET_ALLOWLIST: 'demo-resq', RESQ_RESTORE_SIGNING_KEY: key }) }),
        /RESQ_RESTORE_SIGNING_KEY/);
      assert.equal(api.calls.create, 0, 'no document was created (key: "' + key + '")');
      assert.equal(api.calls.commitAtomic, 0, 'no atomic commit was attempted');
      assert.equal(api.createdPaths.length, 0);
      assert.equal(api.store.size, 0, 'the target store is untouched');
      // גם הקנרית לא נכתבה: הסירוב קודם לה.
      assert.equal([...api.store.keys()].some((k) => k.startsWith('_resq_restore_canary/')), false);
    }
    // הסירוב הוא של הפונקציה עצמה, לא רק של הזרימה
    assert.throws(() => dr.requireSigningKey({ RESQ_RESTORE_SIGNING_KEY: '' }), /RESQ_RESTORE_SIGNING_KEY/);
    assert.throws(() => dr.requireSigningKey({ RESQ_RESTORE_SIGNING_KEY: 'x'.repeat(dr.SIGNING_KEY_MIN_LENGTH - 1) }), /קצר/);
    assert.equal(dr.requireSigningKey({ RESQ_RESTORE_SIGNING_KEY: TEST_SIGNING_KEY }), TEST_SIGNING_KEY);
  });

  console.log('ops-disaster-restore: ' + passed + '/' + passed + ' PASS (fake in-memory firestoreApi; no Firebase, no network, no production data)');
} finally {
  if (path.dirname(fixture) !== fs.realpathSync(os.tmpdir()) || !path.basename(fixture).startsWith('resq-dr-test-')) throw new Error('Unsafe fixture cleanup');
  fs.rmSync(fixture, { recursive: true, force: true });
}
