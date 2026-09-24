import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDocFromServer, setDoc } from 'firebase/firestore';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
assert.match(endpoint, /^(127\.0\.0\.1|localhost):\d+$/, 'loopback emulator only');
const [host, portText] = endpoint.split(':');
const env = await initializeTestEnvironment({ projectId: 'demo-resq',
  firestore: { host, port: Number(portText), rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } });
const suffix = randomBytes(5).toString('hex');
const superUid = 'terms_super_' + suffix;
const pendingUid = 'terms_pending_' + suffix;
const superPath = 'registration_requests/' + pendingUid;
const markerPath = 'registration_terms_active/' + superUid;
const superDb = env.authenticatedContext(superUid, { email: superUid + '@example.invalid', super: true }).firestore();
const pendingDb = env.authenticatedContext(pendingUid, { email: pendingUid + '@example.invalid' }).firestore();
try {
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), superPath), { status: 'pending' });
  });
  await assert.rejects(getDocFromServer(doc(superDb, superPath)), error => error?.code === 'permission-denied');
  assert.equal((await getDocFromServer(doc(pendingDb, superPath))).data().status, 'pending');
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), markerPath), { uid: superUid, terms_version: '1.3',
      privacy_version: '2026-09-24', receipt_path: 'registration_consents/' + superUid + '/events/old' });
  });
  assert.equal((await getDocFromServer(doc(superDb, superPath))).data().status, 'pending');
  await assert.rejects(getDocFromServer(doc(superDb, markerPath)), error => error?.code === 'permission-denied');
  console.log('registration terms isolation: 4 PASS');
} finally {
  await env.cleanup();
}
