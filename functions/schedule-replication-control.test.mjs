import { test } from 'node:test';
import assert from 'node:assert/strict';
import controlled from './schedule-month-control-runtime.js';
import { createFakeDb } from '../tests/_schedule-fake.mjs';

// Real authority selector with synthetic storage; not Firestore race evidence.
function fixture(monthly, changeDuringRead = false) {
  const db = createFakeDb(), built = [], sid = 'replication_control_test';
  const prefix = `stations/${sid}/schedule_state/`;
  const control = { schema_version:1, station_id:sid, enabled:true,
    release_id:'test', activation_id:'a'.repeat(64), activated_by:'synthetic',
    activated_at:'2026-10-02T00:00:00.000Z' };
  if (monthly) {
    db._put(prefix + 'publication_authority', { schema_version:1, station_id:sid,
      generation:0, migrated:true, seed_publication_id:null, last_operation_id:'migration' });
    db._put(prefix + 'publication_authority_control', control);
  }
  const runtime = controlled.createControlledRuntime({
    deps:{db, monthAuthorityReleaseId:'test', clock:()=> '2026-10-02T00:00:00.000Z'},
    api:{previewScheduleReplication:()=> { throw Error('uncontrolled path'); }},
    resolveContext:async req=> { assert.equal(req.auth.uid, 'manager'); return {sid}; },
    translateError:error=>error,
    createRuntime:deps=> {
      built.push(deps);
      return {previewScheduleReplication:async req=> {
        await deps.db.runTransaction(async tx=> { await tx.get(db.doc(prefix + 'runtime')); });
        if (changeDuringRead) db._put(prefix + 'publication_authority_control',
          {...control, activation_id:'b'.repeat(64)});
        return {month:req.data.replication.month};
      }};
    }
  });
  return {runtime, built};
}
const request = {auth:{uid:'manager'}, data:{replication:{month:'2026-10'}}};
for (const monthly of [false, true]) test(`replication preview uses selected authority: monthly=${monthly}`, async()=> {
  const f = fixture(monthly);
  assert.deepEqual(await f.runtime.previewScheduleReplication(request), {month:'2026-10'});
  assert.equal(f.built.length, 1);
  assert.equal(f.built[0].monthAuthorityEnabled, monthly);
  assert.equal(f.built[0].monthAuthorityTransitionFence, true);
});
test('replication preview rejects authority change before returning its result', async()=> {
  const f = fixture(true, true);
  await assert.rejects(f.runtime.previewScheduleReplication(request), /authority-selection-changed/);
});
