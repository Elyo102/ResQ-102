import { initializeTestEnvironment, assertFails, assertSucceeds }
  from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, getDoc, setDoc } from 'firebase/firestore';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw new Error('loopback emulator only');
const [host, portText] = endpoint.split(':');
const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-resq';
if (!/^demo-[a-z0-9-]+$/.test(projectId)) throw new Error('demo project only');
const env = await initializeTestEnvironment({ projectId,
  firestore:{ rules:readFileSync('../firestore.rules', 'utf8'), host, port:Number(portText) } });
const sid = 'it_vehicle_inventory';
const member = env.authenticatedContext('ff', { email:'ff@example.test',
  role:'firefighter', emp:'1',
  stationId:sid, districtId:'south', shift:'A' }).firestore();
const outsider = env.authenticatedContext('outside', { email:'outside@example.test',
  role:'firefighter', emp:'2',
  stationId:'other_station', districtId:'north', shift:'B' }).firestore();
const item = `stations/${sid}/vehicle_inventory/v1/compartments/cabin/items/hose`;
const photo = `stations/${sid}/vehicle_inventory/v1/compartments/cabin/photos/current`;
const event = `stations/${sid}/vehicle_inventory/v1/equipment_events/event1`;
const transition = `${event}/transitions/transition1`;
const quota = `stations/${sid}/vehicle_event_quotas/actor`;
const batch = `stations/${sid}/faults/f1/photo_batches/batch1`;
const photoQuota = `stations/${sid}/fault_photo_quotas/actor`;
try {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, `registration_terms_active/ff`), { uid:'ff',
      consent_key:'1.3|2026-09-24', terms_version:'1.3',
      privacy_version:'2026-09-24',
      receipt_path:'registration_consents/ff/events/test-receipt' });
    await setDoc(doc(db, `stations/${sid}`), { status:'active', active:true,
      districtId:'south', lifecycle:{ revision:1 } });
    await setDoc(doc(db, `stations/${sid}/users/ff`), { role:'firefighter',
      employee_number:'1', is_active:true, crew:'A' });
    for (const path of [item, photo, event, transition, quota, batch, photoQuota]) {
      await setDoc(doc(db, path), { seed:true });
    }
  });
  for (const path of [item, photo, event, transition]) {
    await assertSucceeds(getDoc(doc(member, path)));
    await assertFails(getDoc(doc(outsider, path)));
    await assertFails(setDoc(doc(member, path), { changed:true }));
  }
  for (const path of [quota, batch, photoQuota]) {
    await assertFails(getDoc(doc(member, path)));
    await assertFails(setDoc(doc(member, path), { changed:true }));
  }
  console.log('operational vehicle and photo batch Rules: 18 checks passed');
} finally {
  await env.cleanup();
}
