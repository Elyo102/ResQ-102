import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertHrQueryTarget } from './hr-query-target.mjs';

const valid = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8191', GCLOUD_PROJECT: 'demo-resq' };
test('both repository emulator configurations accept only exact loopback endpoints', () => {
  for (const host of ['127.0.0.1:8080', 'localhost:8080', '127.0.0.1:8191', 'localhost:8191']) {
    assert.doesNotThrow(() => assertHrQueryTarget({ ...valid, FIRESTORE_EMULATOR_HOST: host }));
    assert.doesNotThrow(() => assertHrQueryTarget({ ...valid, FIRESTORE_EMULATOR_HOST: host,
      GOOGLE_CLOUD_PROJECT: 'demo-resq' }));
  }
});
test('remote, ambiguous, malformed and unconfigured emulator endpoints fail closed', () => {
  for (const host of [undefined, '', 'firestore.googleapis.com:443', '0.0.0.0:8080',
    '127.1:8080', '[::1]:8080', 'localhost:443', 'localhost:8081', 'localhost:08191',
    'http://localhost:8080', 'user@localhost:8080', 'localhost:8080/path',
    'localhost:8080?x=1', 'localhost:8080#x', 'localhost:8080\n',
    '127.0.0.1:8191\r\n', ' localhost:8080', 'localhost:8080 ', 'LOCALHOST:8080']) {
    assert.throws(() => assertHrQueryTarget({ ...valid, FIRESTORE_EMULATOR_HOST: host }));
  }
});
test('demo project is mandatory and conflicting project variables are denied', () => {
  for (const project of [undefined, '', 'station-102', 'demo-other', 'demo-resq\n']) {
    assert.throws(() => assertHrQueryTarget({ ...valid, GCLOUD_PROJECT: project }));
  }
  for (const project of ['', 'station-102', 'demo-other', 'demo-resq\n']) {
    assert.throws(() => assertHrQueryTarget({ ...valid, GOOGLE_CLOUD_PROJECT: project }));
  }
});
