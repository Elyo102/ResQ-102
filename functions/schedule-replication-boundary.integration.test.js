'use strict';
const assert = require('node:assert/strict');
if (process.env.GCLOUD_PROJECT !== 'demo-resq' || !/^127\.0\.0\.1:(8080|8199)$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) throw Error('Loopback demo-resq only');
const f = require('./schedule-edit.integration.test');
let passed = 0;
async function fixture(monthly) {
  await f.wipe();
  await f.seed({strict:true,groups:['A'],anchor:'2026-09-01',days_per_group:1});
  let at = '2026-09-01T06:00:00.000Z';
  const hooks={clock:()=>at,monthAuthorityEnabled:monthly};
  const api=f.runtime(hooks), input={month:'2026-09',paste:f.SHEET,aliases:{'רועי':'u1','אבטחה':null}};
  const report=await api.previewScheduleImport(f.req(f.MGR,input));
  const draft=await api.importScheduleSheet(f.req(f.MGR,{...input,request_id:'boundary_import',expected_report_digest:report.report_digest}));
  const preview=await api.getDraftPreview(f.req(f.MGR,{draft_id:draft.draft_id,start:'2026-09-01'}));
  await f.runtimeDoc().set({mode:'new'},{merge:true});
  await api.publish(f.req(f.MGR,{request_id:'boundary_seed',draft_id:draft.draft_id,expected_content_digest:preview.expected_content_digest,gap_acknowledgement:preview.gaps.digest}));
  const pointer=(await f.station().collection('schedule_state').doc('active').get()).data();
  const request={expected:{publication_id:pointer.publication_id,revision:pointer.revision,content_digest:pointer.content_digest},replication:{source:{date:'2026-09-01',sub_station:'eilat'},month:'2026-09',mode:'override'}};
  const checked=await api.previewScheduleReplication(f.req(f.MGR,request));
  assert.ok(checked.counts.changes>0);
  return {api,hooks,pointer,advance:()=>{at='2026-09-02T06:00:00.000Z';},payload:{...request,request_id:'boundary_apply',expected_edit_digest:checked.edit_digest,gap_acknowledgement:checked.gaps.digest}};
}
async function unchanged(fx) {
  assert.deepEqual((await f.station().collection('schedule_state').doc('active').get()).data(),fx.pointer);
  const publications=await f.station().collection('schedule_publications').get();
  for (const p of publications.docs.filter(p=>p.id!==fx.pointer.publication_id)) {
    assert.notEqual(p.data().status,'active');
    const jobs=await p.ref.collection('schedule_outbox').get();
    assert.ok(jobs.docs.every(j=>!['queued','sent','sending'].includes(j.data().status)));
  }
}
(async()=>{
  try {
    for (const monthly of [false,true]) {
      let fx=await fixture(monthly);
      const failing=f.runtime({...fx.hooks,beforeSnapshotFinalize:async event=>{if(event.kind==='publication')throw Error('synthetic-before-activation');}});
      await assert.rejects(failing.applyScheduleEdit(f.req(f.MGR,fx.payload)),/synthetic-before-activation/);
      const drafts=await f.station().collection('schedule_drafts').get();
      assert.ok(drafts.docs.some(d=>d.data().request_id==='boundary_apply'&&d.data().status==='complete'));
      fx.advance();
      await assert.rejects(fx.api.applyScheduleEdit(f.req(f.MGR,fx.payload)),e=>e.code==='edit-report-stale');
      await unchanged(fx);passed++;console.log(`PASS unpublished complete draft expires before retry; monthly=${monthly}`);

      fx=await fixture(monthly);
      const crossing=f.runtime({...fx.hooks,beforeSnapshotFinalize:async event=>{if(event.kind==='publication')fx.advance();}});
      await assert.rejects(crossing.applyScheduleEdit(f.req(f.MGR,fx.payload)),e=>e.code==='edit-report-stale');
      await unchanged(fx);passed++;console.log(`PASS midnight during staging cannot activate; monthly=${monthly}`);

      if(monthly){
        fx=await fixture(true);
        const first=await fx.api.applyScheduleEdit(f.req(f.MGR,fx.payload));
        fx.advance();const replay=await fx.api.applyScheduleEdit(f.req(f.MGR,fx.payload));
        assert.equal(replay.duplicate,true);assert.equal(replay.publication_id,first.publication_id);
        passed++;console.log('PASS monthly successful receipt survives cutoff change');
      }
    }
    console.log(`Replication boundary: ${passed}/5 PASS; native emulator, fake provider`);
  } finally {await f.wipe();}
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{const admin=require('firebase-admin');await Promise.all(admin.apps.map(app=>app.delete()));});
