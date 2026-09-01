/**
 * Firestore browser boundary for station transfers.
 *
 * Transfer requests and per-user transfer locks are orchestration records.
 * Only Cloud Functions may read or mutate them; even a super administrator
 * using the browser SDK must go through the callable boundary.
 *
 * The final checks also lock the intended live-membership behaviour: an ID
 * token that still carries valid station claims must stop reading station data
 * as soon as stations/{sid}/users/{uid}.is_active becomes false.
 */

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc
} from 'firebase/firestore';

const SID = 'eilat_102';
const OTHER_SID = 'other_99';
let passed = 0;

async function allowed(label, action) {
  try {
    await assertSucceeds(action);
    passed += 1;
    console.log('✓ ' + label);
  } catch (error) {
    throw new Error('Expected operation to succeed: ' + label + '\n' +
      ((error && error.message) || error));
  }
}

async function blocked(label, action) {
  try {
    await assertFails(action);
    passed += 1;
    console.log('✓ ' + label);
  } catch (error) {
    throw new Error('Browser boundary opened: ' + label + '\n' +
      ((error && error.message) || error));
  }
}

const env = await initializeTestEnvironment({
  projectId: 'resq-station-transfer-rules',
  firestore: {
    rules: readFileSync('../firestore.rules', 'utf8'),
    host: '127.0.0.1',
    port: 8080
  }
});

// The emulator can survive between local runs.  A retained inactive profile
// or forged lock would make this suite depend on execution order rather than
// on the rules under review.
await env.clearFirestore();

const client = (uid, email, claims) =>
  env.authenticatedContext(uid, Object.assign({ email }, claims)).firestore();

const actors = [
  ['anonymous client', env.unauthenticatedContext().firestore()],
  ['pending account', client('pending_1', 'pending@example.test', {})],
  ['station member', client('member_1', 'member@example.test', {
    emp: '1001', role: 'firefighter', stationId: SID, districtId: 'south', shift: 'A'
  })],
  ['HR coordinator', client('hr_1', 'hr@example.test', {
    emp: '1002', role: 'hr_coordinator', stationId: SID, districtId: 'south', shift: ''
  })],
  ['station commander', client('commander_1', 'commander@example.test', {
    emp: '1003', role: 'station_commander', stationId: SID, districtId: 'south', shift: ''
  })],
  ['out-of-station HR coordinator', client('other_hr_1', 'other-hr@example.test', {
    emp: '1004', role: 'hr_coordinator', stationId: OTHER_SID,
    districtId: 'north', shift: ''
  })],
  ['super administrator', client('super_1', 'super@example.test', { super: true })]
];

const protectedCollections = [
  'station_transfer_requests',
  'station_transfer_locks'
];

try {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    for (const collectionName of protectedCollections) {
      await setDoc(doc(db, collectionName + '/seeded'), {
        target_uid: 'member_1',
        source_station_id: SID,
        target_station_id: OTHER_SID,
        status: 'pending_target'
      });
    }

    await setDoc(doc(db, `stations/${SID}`), {
      name: 'Eilat', districtId: 'south'
    });
    await setDoc(doc(db, `stations/${SID}/users/stale_member`), {
      full_name: 'Stale Member',
      employee_number: '1005',
      role: 'firefighter',
      crew: 'A',
      is_active: true
    });
    await setDoc(doc(db, `stations/${SID}/roster/visible_before`), {
      full_name: 'Visible Before', role: 'firefighter', crew: 'A', is_active: true
    });
    await setDoc(doc(db, `stations/${SID}/roster/must_be_hidden_after`), {
      full_name: 'Hidden After', role: 'firefighter', crew: 'A', is_active: true
    });
    await setDoc(doc(db, `stations/${OTHER_SID}`), {
      name: 'Destination', districtId: 'north', active: true
    });
    await setDoc(doc(db, `stations/${OTHER_SID}/users/stale_member`), {
      full_name: 'Transferred Member',
      employee_number: '1005',
      role: 'firefighter',
      crew: 'A',
      is_active: true
    });
    await setDoc(doc(db, `stations/${OTHER_SID}/roster/visible_after_transfer`), {
      full_name: 'Visible At Destination', role: 'firefighter', crew: 'A', is_active: true
    });
  });

  for (const [actorName, actor] of actors) {
    for (const collectionName of protectedCollections) {
      const seeded = doc(actor, collectionName + '/seeded');
      const createOnly = doc(actor, collectionName + '/created-by-' +
        actorName.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase());

      await blocked(actorName + ' cannot get ' + collectionName,
        getDoc(seeded));
      await blocked(actorName + ' cannot list ' + collectionName,
        getDocs(collection(actor, collectionName)));
      await blocked(actorName + ' cannot create in ' + collectionName,
        setDoc(createOnly, { status: 'forged' }));
      await blocked(actorName + ' cannot update ' + collectionName,
        updateDoc(seeded, { status: 'approved' }));
      await blocked(actorName + ' cannot delete from ' + collectionName,
        deleteDoc(seeded));
    }
  }

  const staleClaims = {
    emp: '1005', role: 'firefighter', stationId: SID,
    districtId: 'south', shift: 'A'
  };
  const beforeDeactivation = client(
    'stale_member', 'stale-member@example.test', staleClaims);

  await allowed('active member can read station roster before deactivation',
    getDoc(doc(beforeDeactivation, `stations/${SID}/roster/visible_before`)));

  await env.withSecurityRulesDisabled(async (context) => {
    await updateDoc(
      doc(context.firestore(), `stations/${SID}/users/stale_member`),
      { is_active: false }
    );
  });

  // A fresh SDK context with the same claims models an already-issued token:
  // the token is unchanged, while the live station membership is now inactive.
  const staleTokenAfterDeactivation = client(
    'stale_member', 'stale-member@example.test', staleClaims);

  await blocked('stale token cannot read station data after live membership is inactive',
    getDoc(doc(staleTokenAfterDeactivation,
      `stations/${SID}/roster/must_be_hidden_after`)));
  await blocked('stale token cannot list station roster after live membership is inactive',
    getDocs(collection(staleTokenAfterDeactivation, `stations/${SID}/roster`)));

  // A transfer creates the destination membership before the browser obtains
  // a refreshed token.  The old source token must not retain a self-service
  // back door to the inactive source profile, while the refreshed destination
  // token must work normally.
  const staleSelfChecks = await Promise.allSettled([
    blocked('stale source token cannot read its inactive source user profile',
      getDoc(doc(staleTokenAfterDeactivation,
        `stations/${SID}/users/stale_member`))),
    blocked('stale source token cannot update its inactive source user profile',
      updateDoc(doc(staleTokenAfterDeactivation,
        `stations/${SID}/users/stale_member`), { phone: '0500000000' }))
  ]);

  const destinationClaims = {
    emp: '1005', role: 'firefighter', stationId: OTHER_SID,
    districtId: 'north', shift: 'A'
  };
  const refreshedDestinationToken = client(
    'stale_member', 'stale-member@example.test', destinationClaims);
  await allowed('refreshed destination token reads destination roster after transfer',
    getDoc(doc(refreshedDestinationToken,
      `stations/${OTHER_SID}/roster/visible_after_transfer`)));

  const staleSelfFailures = staleSelfChecks
    .filter((result) => result.status === 'rejected')
    .map((result) => String(result.reason && result.reason.message || result.reason));
  if (staleSelfFailures.length) {
    throw new Error('Inactive source self-access remained open:\n' +
      staleSelfFailures.join('\n'));
  }

  console.log('\n' + passed + ' station-transfer rules checks passed.');
} finally {
  await env.cleanup();
}
