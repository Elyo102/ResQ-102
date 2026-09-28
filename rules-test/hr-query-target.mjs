import assert from 'node:assert/strict';

// Existing repository emulator configurations, never arbitrary hosts or ports.
const endpoints = new Set([
  '127.0.0.1:8080', 'localhost:8080',
  '127.0.0.1:8191', 'localhost:8191',
]);
export function assertHrQueryTarget(env) {
  assert.ok(endpoints.has(env.FIRESTORE_EMULATOR_HOST),
    'explicit loopback Firestore emulator on 8080 or 8191 required');
  assert.equal(env.GCLOUD_PROJECT, 'demo-resq', 'explicit demo-resq project required');
  assert.ok(env.GOOGLE_CLOUD_PROJECT === undefined || env.GOOGLE_CLOUD_PROJECT === 'demo-resq',
    'conflicting Google Cloud project denied');
}
