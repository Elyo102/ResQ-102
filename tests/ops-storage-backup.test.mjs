import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA, DEFAULT_BUCKET, DEFAULT_PREFIX, parseArgs,
  refuseProdStorageBucket, runBackup, runVerify,
  runRestore, refuseRestoreTarget, denyTargets, isValidObjectName, objectKey,
  readManifest, mapListedFilesToObjects, listMetaMissingRequired, SEAL_PASSPHRASE_ENV
} from '../ops-storage-backup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEAL_ENV = { [SEAL_PASSPHRASE_ENV]: 'correct-horse-storage-seal!!' };
let passed = 0;
async function check(name, fn) { await fn(); console.log('PASS ' + name); passed++; }

function createFakeStorage(seed = {}) {
  // seed: { name: { generation, size, contentType, md5Hash, crc32c, bytes } }
  const store = new Map();
  for (const [name, meta] of Object.entries(seed)) {
    store.set(objectKey(name, meta.generation), { name, ...meta, bytes: Buffer.from(meta.bytes || '') });
  }
  const api = {
    downloads: 0,
    uploads: 0,
    lists: 0,
    async listObjects({ prefix, pageToken }) {
      api.lists += 1;
      const all = [...store.values()]
        .filter((o) => o.name.startsWith(prefix))
        .sort((a, b) => objectKey(a.name, a.generation).localeCompare(objectKey(b.name, b.generation)));
      const keys = all.map((o) => objectKey(o.name, o.generation));
      let start = 0;
      if (pageToken) {
        const idx = keys.indexOf(pageToken);
        if (idx < 0) throw new Error('page token לא מוכר');
        start = idx + 1;
      }
      const page = all.slice(start, start + 2);
      return {
        objects: page.map(({ bytes, ...meta }) => meta),
        nextPageToken: start + 2 < all.length ? objectKey(page[page.length - 1].name, page[page.length - 1].generation) : null
      };
    },
    async downloadObject({ name, generation }) {
      api.downloads += 1;
      const item = store.get(objectKey(name, generation));
      if (!item) throw new Error('missing object');
      return Buffer.from(item.bytes);
    },
    async getMetadata({ name, generation }) {
      const item = store.get(objectKey(name, generation));
      if (!item) return null;
      const { bytes, ...meta } = item;
      return meta;
    },
    async uploadObject({ name, generation, bytes, ifGenerationMatch }) {
      api.uploads += 1;
      const existing = [...store.values()].some((o) => o.name === name);
      if (ifGenerationMatch === 0 && existing) {
        const err = new Error('object exists');
        err.code = 'precondition-failed';
        throw err;
      }
      store.set(objectKey(name, generation || '1'), {
        name,
        generation: String(generation || '1'),
        size: bytes.length,
        contentType: 'application/pdf',
        md5Hash: 'm',
        crc32c: 'c',
        bytes: Buffer.from(bytes)
      });
    },
    store
  };
  return api;
}

const o1 = 'hr-private/eilat_102/request/p1/a1';
const o2 = 'hr-private/eilat_102/request/p1/a2';
const o3 = 'hr-private/eilat_102/document/d1/a3';

await check('parseArgs: dry-run default; execute flips; restore confirm rules', async () => {
  assert.equal(parseArgs(['backup', '--out', 'D:/x']).dryRun, true);
  assert.equal(parseArgs(['backup', '--out', 'D:/x', '--execute']).dryRun, false);
  assert.throws(() => parseArgs(['backup', '--out', 'D:/x', '--dry-run', '--execute']), /סותרים/);
  assert.throws(() => parseArgs(['restore', '--set', 's', '--target', 'demo', '--execute']), /confirm-target/);
  assert.equal(parseArgs(['restore', '--set', 's', '--target', 'demo']).dryRun, true);
});

await check('path template validation', async () => {
  assert.equal(isValidObjectName(o1), true);
  assert.equal(isValidObjectName('hr-private/bad'), false);
  assert.equal(isValidObjectName('other/x/y/z/w'), false);
});

await check('backup dry-run opens no content and loads no api', async () => {
  const api = createFakeStorage();
  const result = await runBackup(parseArgs(['backup', '--out', path.join(os.tmpdir(), 'nope')]));
  assert.equal(result.dryRun, true);
  assert.equal(result.opens_content, false);
  assert.equal(api.downloads, 0);
  assert.equal(api.lists, 0);
});

await check('incremental backup by generation; resume; COMPLETE', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-st-'));
  const api = createFakeStorage({
    [o1]: { generation: '10', size: 5, contentType: 'application/pdf', md5Hash: 'aa', crc32c: 'cc', bytes: 'hello' },
    [o2]: { generation: '11', size: 3, contentType: 'application/pdf', md5Hash: 'bb', crc32c: 'dd', bytes: 'pdf' },
    [o3]: { generation: '12', size: 4, contentType: 'image/png', md5Hash: 'ee', crc32c: 'ff', bytes: 'img!' }
  });
  const result = await runBackup(
    parseArgs(['backup', '--out', dir, '--execute', '--project', 'demo-src']),
    { storageApi: api, env: SEAL_ENV, now: () => new Date('2026-09-23T15:00:00.000Z') }
  );
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.ok, true);
  assert.equal(result.counts.copied, 3);
  assert.ok(api.downloads >= 3);
  const manifest = readManifest(dir);
  assert.equal(manifest.schema, SCHEMA);
  assert.equal(manifest.bucket, DEFAULT_BUCKET);
  assert.equal(manifest.objects.length, 3);
  const byName = Object.fromEntries(manifest.objects.map((o) => [o.name, o]));
  assert.equal(byName[o1].firestore_link.object_generation, '10');
  assert.equal(byName[o1].firestore_link.attachment_id, 'a1');
  assert.equal(byName[o3].firestore_link.parent_kind, 'document');
  // resume: second run skips completed
  const again = await runBackup(parseArgs(['backup', '--out', dir, '--execute']), { storageApi: api, env: SEAL_ENV });
  assert.equal(again.counts.skipped, 3);
  assert.equal(again.counts.copied, 0);
});

await check('partial backup marked PARTIAL/FAILED not success', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-st-part-'));
  const api = createFakeStorage({
    [o1]: { generation: '1', size: 2, contentType: 'application/pdf', md5Hash: 'a', crc32c: 'b', bytes: 'ok' },
    [o2]: { generation: '2', size: 2, contentType: 'application/pdf', md5Hash: 'c', crc32c: 'd', bytes: 'no' }
  });
  const realDownload = api.downloadObject.bind(api);
  api.downloadObject = async (req) => {
    if (req.name === o2) throw new Error('injected failure');
    return realDownload(req);
  };
  const result = await runBackup(parseArgs(['backup', '--out', dir, '--execute']), { storageApi: api, env: SEAL_ENV });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.counts.copied, 1);
  assert.equal(result.counts.failed, 1);
  const v = await runVerify(parseArgs(['verify', '--set', dir]), { storageApi: api, env: SEAL_ENV });
  assert.equal(v.ok, false);
  assert.equal(v.status, 'PARTIAL');
});

await check('verify without restore checks local checksums + adapter metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-st-v-'));
  const api = createFakeStorage({
    [o1]: { generation: '7', size: 4, contentType: 'application/pdf', md5Hash: 'm1', crc32c: 'c1', bytes: 'data' }
  });
  await runBackup(parseArgs(['backup', '--out', dir, '--execute']), { storageApi: api, env: SEAL_ENV });
  const v = await runVerify(parseArgs(['verify', '--set', dir]), { storageApi: api, compareRemote: true, env: SEAL_ENV });
  assert.equal(v.ok, true);
  // One-byte tamper must fail verify
  const manifest = readManifest(dir);
  const file = path.join(dir, manifest.objects[0].backup_destination);
  const orig = fs.readFileSync(file);
  const flipped = Buffer.from(orig);
  flipped[0] = (flipped[0] ^ 0xff) & 0xff;
  fs.writeFileSync(file, flipped);
  const bad = await runVerify(parseArgs(['verify', '--set', dir]), { storageApi: api, env: SEAL_ENV });
  assert.equal(bad.ok, false);
});

await check('restore dry-run writes nothing; execute to demo only; no silent overwrite; station-102 denied', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-st-r-'));
  const src = createFakeStorage({
    [o1]: { generation: '9', size: 3, contentType: 'application/pdf', md5Hash: 'm', crc32c: 'c', bytes: 'abc' }
  });
  await runBackup(parseArgs(['backup', '--out', dir, '--execute']), { storageApi: src, env: SEAL_ENV });
  const dry = await runRestore(parseArgs(['restore', '--set', dir, '--target', 'demo-resq']), { root, env: SEAL_ENV });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.writes, 'none');

  assert.throws(() => refuseRestoreTarget('station-102', { root }), /סירוב קשיח/);
  assert.equal(denyTargets({ root }).has('station-102'), true);

  const dest = createFakeStorage();
  await assert.rejects(
    runRestore(
      parseArgs(['restore', '--set', dir, '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq']),
      { root, storageApi: dest, env: { ...SEAL_ENV, RESQ_STORAGE_RESTORE_TARGET_ALLOWLIST: '' } }
    ),
    /ALLOWLIST/
  );
  const ok = await runRestore(
    parseArgs(['restore', '--set', dir, '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq']),
    { root, storageApi: dest, env: { ...SEAL_ENV, RESQ_STORAGE_RESTORE_TARGET_ALLOWLIST: 'demo-resq' } }
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.written, 1);
  // second restore: exists → skipped, not overwritten
  const again = await runRestore(
    parseArgs(['restore', '--set', dir, '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq']),
    { root, storageApi: dest, env: { ...SEAL_ENV, RESQ_STORAGE_RESTORE_TARGET_ALLOWLIST: 'demo-resq' } }
  );
  assert.equal(again.skipped_exists, 1);
  assert.equal(again.written, 0);
  assert.equal(Buffer.from(dest.store.get(objectKey(o1, '9')).bytes).toString(), 'abc');
});

await check('invalid object path fails closed during backup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-st-bad-'));
  const api = createFakeStorage({
    'not-hr/private/x': { generation: '1', size: 1, contentType: 't', md5Hash: 'm', crc32c: 'c', bytes: 'z' }
  });
  // Bypass seed key path — inject via list only
  api.listObjects = async () => ({
    objects: [{ name: 'evil/path', generation: '1', size: 1, contentType: 't', md5Hash: 'm', crc32c: 'c' }],
    nextPageToken: null
  });
  const result = await runBackup(parseArgs(['backup', '--out', dir, '--execute']), { storageApi: api, env: SEAL_ENV });
  assert.equal(result.ok, false);
  assert.ok(['FAILED', 'PARTIAL'].includes(result.status));
});


await check('refuseProdStorageBucket blocks default production bucket', () => {
  assert.throws(() => refuseProdStorageBucket('station-102-hr-private-europe-west1', { env: {} }), /סירוב|ייצור|production/i);
  assert.doesNotThrow(() => refuseProdStorageBucket('demo-resq-hr-private', { env: {} }));
  assert.doesNotThrow(() => refuseProdStorageBucket('station-102-hr-private-europe-west1', { env: { RESQ_STORAGE_ALLOW_PROD_BUCKET: '1' } }));
});


await check('encrypted backup: no plaintext on disk; wrong passphrase fails clean; one-byte tamper fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-st-enc-'));
  const SECRET = 'FIXTURE_PLAINTEXT_MEDICAL_MARKER_XYZ';
  const api = createFakeStorage({
    [o1]: { generation: '1', size: Buffer.byteLength(SECRET), contentType: 'application/pdf', md5Hash: 'm', crc32c: 'c', bytes: SECRET }
  });
  const result = await runBackup(parseArgs(['backup', '--out', dir, '--execute']), { storageApi: api, env: SEAL_ENV });
  assert.equal(result.ok, true);
  const manifest = readManifest(dir);
  assert.equal(manifest.sealed, true);
  assert.equal(manifest.seal_passphrase_env, SEAL_PASSPHRASE_ENV);
  assert.equal(JSON.stringify(manifest).includes(SECRET), false);
  assert.equal(JSON.stringify(manifest).includes(SEAL_ENV[SEAL_PASSPHRASE_ENV]), false);
  // Walk all files under backup dir — fixture plaintext must not appear clear
  function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        const buf = fs.readFileSync(p);
        assert.equal(buf.includes(Buffer.from(SECRET)), false, 'plaintext leaked in ' + p);
        assert.ok(name.endsWith('.json') || name.endsWith('.bin.enc') || name.includes('state'), 'unexpected file ' + name);
      }
    }
  }
  walk(dir);
  const objPath = path.join(dir, manifest.objects[0].backup_destination);
  assert.ok(objPath.endsWith('.bin.enc'));
  assert.equal(manifest.objects[0].encrypted, true);
  // wrong passphrase: verify integrity decrypt fails, no plaintext leftover
  const wrong = await runVerify(parseArgs(['verify', '--set', dir]), {
    storageApi: api,
    env: { [SEAL_PASSPHRASE_ENV]: 'wrong-passphrase-xxxxxxxxxx' }
  });
  assert.equal(wrong.ok, false);
  walk(dir);
  await assert.rejects(
    runRestore(
      parseArgs(['restore', '--set', dir, '--target', 'demo-resq', '--execute', '--confirm-target', 'demo-resq']),
      { root, storageApi: createFakeStorage(), env: { ...SEAL_ENV, [SEAL_PASSPHRASE_ENV]: 'wrong-passphrase-xxxxxxxxxx', RESQ_STORAGE_RESTORE_TARGET_ALLOWLIST: 'demo-resq' } }
    ),
    /integrity|פענוח|חותם|auth|failed|נכשל/i
  );
  walk(dir);
});

await check('mapListedFilesToObjects: no N+1 getMetadata when list metadata present', async () => {
  let fetchCalls = 0;
  const files = [];
  for (let i = 0; i < 50; i++) {
    files.push({
      name: 'hr-private/eilat_102/request/p/a' + i,
      metadata: {
        generation: String(1000 + i),
        size: 10 + i,
        contentType: 'application/pdf',
        md5Hash: 'm' + i,
        crc32c: 'c' + i,
        updated: '2026-01-01T00:00:00.000Z',
        metadata: {}
      }
    });
  }
  const mapped = await mapListedFilesToObjects(files, {
    fetchMetadata: async () => { fetchCalls += 1; return {}; }
  });
  assert.equal(mapped.objects.length, 50);
  assert.equal(mapped.fetchCalls, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(listMetaMissingRequired(files[0].metadata), false);
  // Missing generation triggers exactly one fetch
  const sparse = [{ name: 'hr-private/eilat_102/request/p/z', metadata: { size: 3 } }];
  const mapped2 = await mapListedFilesToObjects(sparse, {
    fetchMetadata: async () => ({ generation: '9', size: 3, contentType: 't', md5Hash: '', crc32c: '' })
  });
  assert.equal(mapped2.fetchCalls, 1);
  assert.equal(mapped2.objects[0].generation, '9');
});

console.log('ops-storage-backup: ' + passed + '/' + passed + ' PASS (fake adapter; no real files/medical data)');
