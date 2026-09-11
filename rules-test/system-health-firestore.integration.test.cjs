'use strict';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '';
const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-resq';
if (!/^(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/.test(emulatorHost) || !/^demo-[a-z0-9-]+$/.test(projectId)) {
  console.error('NOT RUN: loopback FIRESTORE_EMULATOR_HOST and demo-* project are required.');
  process.exit(2);
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, FieldPath, Timestamp } = require('firebase-admin/firestore');
const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, deleteDoc } = require('firebase/firestore');
const { createFirestoreHealthPorts } = require('../functions/system-health-firestore');
const { createSystemHealthService } = require('../functions/system-health-service');
const scope = require('../functions/health-scope');
const identity = require('../functions/identity-coordinator');

const app = initializeApp({ projectId }, 'system-health-v2-it-' + process.pid);
const db = getFirestore(app);
const nowMs = Date.parse('2026-09-11T03:15:00.000Z');
const clock = () => nowMs;
let sequence = 0;
const randomId = () => 'lease' + String(++sequence).padStart(20, '0');
let env;

async function seedStation(sid, silent) {
  await db.doc('stations/' + sid).set({ active: true, districtId: 'south', name: sid });
  await db.doc('stations/' + sid + '/config/mode').set({ mode: silent ? 'silent' : 'live' });
  await db.doc('stations/' + sid + '/backups/2026-09-11').set({ date: '2026-09-11', counts: {}, drops: [] });
  await db.doc('stations/' + sid + '/scans/2026-09').set({ ran_at: Timestamp.fromMillis(nowMs) });
}

(async () => {
  const port = Number(emulatorHost.slice(emulatorHost.lastIndexOf(':') + 1));
  const host = emulatorHost.slice(0, emulatorHost.lastIndexOf(':')).replace(/^\[|\]$/g, '');
  env = await initializeTestEnvironment({ projectId, firestore: {
    host, port, rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8')
  } });
  await seedStation('health_alpha', false);
  await seedStation('health_beta', true);
  await db.doc('config/runtime').set({ silent: false });

  const ports = createFirestoreHealthPorts({ db, FieldValue, FieldPath, clock, randomId,
    builtins: {}, knownDistricts: ['south'], activeIndex: identity.activeIndex });
  const service = createSystemHealthService({ clock, ...ports, reserve_ms: 1000, per_station_ms: 100 });
  const result = await service.run({ run_id: 'health_it_20260911_0001', deadline_ms: nowMs + 120000 });
  assert.equal(result.published, true);
  assert.ok(['all_clear', 'findings'].includes(result.verdict));
  assert.equal(result.total, 2);

  const cycle = (await db.doc('system_health_cycles/health_it_20260911_0001').get()).data();
  assert.equal(cycle.status, 'complete');
  assert.equal(cycle.published, true);
  assert.deepEqual(cycle.inventory, ['health_alpha', 'health_beta']);
  const reports = await db.collection('system_health_cycles/health_it_20260911_0001/system_health_reports').get();
  assert.equal(reports.size, 2);
  const alpha = (await db.doc('stations/health_alpha/health_shadow/2026-09-11').get()).data();
  const beta = (await db.doc('stations/health_beta/health_shadow/2026-09-11').get()).data();
  assert.equal(alpha.shadow, true);
  assert.equal(alpha.silent, false);
  assert.equal(beta.silent, true);
  assert.equal(beta.silence_reason, 'station');

  const retry = await service.run({ run_id: 'health_it_20260911_0001', deadline_ms: nowMs + 120000 });
  assert.equal(retry.resumed, true);
  assert.equal((await db.collection('system_health_cycles/health_it_20260911_0001/system_health_reports').get()).size, 2);

  const client = env.authenticatedContext('ordinary', { stationId: 'health_alpha', role: 'firefighter' }).firestore();
  await assertFails(getDoc(doc(client, 'system_health_cycles/health_it_20260911_0001')));
  await assertFails(getDoc(doc(client, 'stations/health_alpha/health_shadow/2026-09-11')));
  await assertFails(setDoc(doc(client, 'system_health_cycles/client_cycle_0001'), { status: 'complete' }));
  await assertFails(setDoc(doc(client, 'stations/health_alpha/health_shadow/2026-09-12'), { shadow: true }));
  await assertFails(deleteDoc(doc(client, 'system_health_cycles/health_it_20260911_0001')));

  const superClient = env.authenticatedContext('verified-super', { super: true, stationId: 'health_alpha' }).firestore();
  await assertFails(getDoc(doc(superClient, 'system_health_cycles/health_it_20260911_0001')));
  await assertFails(setDoc(doc(superClient, 'stations/health_alpha/health_shadow/2026-09-12'), { shadow: true }));

  const anonymous = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anonymous, 'system_health_cycles/health_it_20260911_0001')));
  await assertFails(getDoc(doc(anonymous, 'stations/health_alpha/health_shadow/2026-09-11')));

  const fenceCycle = scope.openCycle({ run_id: 'health_it_20260911_fence', stations: [
    { station_id: 'health_alpha' }, { station_id: 'health_beta' }
  ] });
  const fenceLease = await ports.claimCycle({ cycle: fenceCycle });
  const overlappingLease = await ports.claimCycle({ cycle: fenceCycle });
  assert.equal(fenceLease.acquired, true);
  assert.equal(overlappingLease.acquired, false);
  await seedStation('health_gamma', false);
  await assert.rejects(ports.publishComplete({ cycle: fenceCycle,
    lease_token: fenceLease.lease_token,
    summary: { verdict: 'all_clear' }, reports: [] }), { code: 'inventory-drift' });
  await ports.releaseCycle({ cycle_id: fenceCycle.cycle_id, lease_token: fenceLease.lease_token });

  const repairCycle = scope.openCycle({ run_id: 'health_it_20260911_repair', stations: [
    { station_id: 'health_alpha' }, { station_id: 'health_beta' }, { station_id: 'health_gamma' }
  ] });
  const repairLease = await ports.claimCycle({ cycle: repairCycle });
  const failed = { cycle_id: repairCycle.cycle_id, station_id: 'health_gamma', ok: false,
    findings: [], silent: false, silence_reason: null, error_code: 'unavailable' };
  await ports.saveReport({ cycle_id: repairCycle.cycle_id, lease_token: repairLease.lease_token, report: failed });
  await ports.saveReport({ cycle_id: repairCycle.cycle_id, lease_token: repairLease.lease_token,
    report: { ...failed, ok: true, error_code: null } });
  const repaired = await ports.readReports({ cycle_id: repairCycle.cycle_id });
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].ok, true);

  const longStationId = 's' + 'a'.repeat(65);
  await seedStation(longStationId, false);
  const longInventory = await ports.listStations({ deadline_ms: nowMs + 120000 });
  assert.equal(longInventory.complete, true);
  assert.ok(longInventory.stations.some((row) => row.station_id === longStationId));

  const batch = db.batch();
  for (let i = 0; i < 201; i += 1) {
    batch.set(db.doc('stations/cap_' + String(i).padStart(3, '0')), {
      active: true, districtId: 'south'
    });
  }
  await batch.commit();
  const cappedInventory = await ports.listStations({ deadline_ms: nowMs + 120000 });
  assert.equal(cappedInventory.complete, false);
  assert.deepEqual(cappedInventory.stations, []);

  console.log('system-health-firestore integration: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (env) await env.cleanup();
  await deleteApp(app);
});
