'use strict';
const assert = require('node:assert/strict');
if (process.env.GCLOUD_PROJECT !== 'demo-resq' || !/^127\.0\.0\.1:(8080|8199)$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw new Error('Only a loopback demo-resq emulator is allowed');
}
const f = require('./schedule-edit.integration.test');
let at = '2026-09-01T06:00:00.000Z', passed = 0;
const test = async (name, run) => { await run(); ++passed; console.log('PASS ' + name); };
const expectedOf = p => ({ publication_id: p.publication_id, revision: p.revision, content_digest: p.content_digest });
(async () => {
  try {
    await f.wipe();
    // The imported fixture covers three days only. A one-group rotation gives
    // real targets inside that coverage; multi-group selection has pure tests.
    await f.seed({ strict: true, groups: ['A'], anchor: '2026-09-01', days_per_group: 1 });
    const api = f.runtime({ clock: () => at });
    const aliases = { 'רועי': 'u1', 'אבטחה': null };
    const report = await api.previewScheduleImport(f.req(f.MGR, { month: '2026-09', paste: f.SHEET, aliases }));
    const draft = await api.importScheduleSheet(f.req(f.MGR, { request_id: 'rep_seed_import', month: '2026-09', paste: f.SHEET, aliases, expected_report_digest: report.report_digest }));
    const preview = await api.getDraftPreview(f.req(f.MGR, { draft_id: draft.draft_id, start: '2026-09-01' }));
    await f.runtimeDoc().set({ mode: 'new' }, { merge: true });
    await api.publish(f.req(f.MGR, { request_id: 'rep_seed_publish', draft_id: draft.draft_id, expected_content_digest: preview.expected_content_digest, gap_acknowledgement: preview.gaps.digest }));
    const pointer = (await f.station().collection('schedule_state').doc('active').get()).data();
    const input = { expected: expectedOf(pointer), replication: { source: { date: '2026-09-01', sub_station: 'eilat' }, month: '2026-09', mode: 'override' } };
    let checked;
    await test('replication is authenticated and rejects client date/edits injection', async () => {
      await assert.rejects(api.previewScheduleReplication(f.req('viewer', input)), e => e.code === 'manager-required');
      await assert.rejects(api.previewScheduleReplication(f.req(f.MGR, { ...input, edits: [] })), e => e.code === 'replicate-input');
      await assert.rejects(api.previewScheduleReplication(f.req(f.MGR, { ...input, replication: { ...input.replication, not_before: '2020-01-01' } })), e => e.code === 'replicate-input');
    });
    await test('server preview binds source, month, Israel date and actual change count without writes', async () => {
      const before = (await f.station().collection('schedule_drafts').get()).size;
      checked = await api.previewScheduleReplication(f.req(f.MGR, input));
      assert.equal(checked.replication.not_before, '2026-09-01');
      assert.ok(checked.counts.changes > 0 && checked.counts.changes <= 400);
      assert.equal(checked.changes_truncated, false);
      assert.equal((await f.station().collection('schedule_drafts').get()).size, before);
    });
    await test('midnight and changed intent invalidate preview without writes', async () => {
      at = '2026-09-01T21:01:00.000Z';
      await assert.rejects(api.applyScheduleEdit(f.req(f.MGR, { ...input, request_id: 'rep_midnight', expected_edit_digest: checked.edit_digest })), e => e.code === 'edit-report-stale');
      at = '2026-09-01T06:00:00.000Z';
      await assert.rejects(api.applyScheduleEdit(f.req(f.MGR, { ...input, replication: { ...input.replication, mode: 'skip_manual' }, request_id: 'rep_changed', expected_edit_digest: checked.edit_digest })), e => e.code === 'edit-report-stale');
    });
    const payload = { ...input, request_id: 'rep_apply', expected_edit_digest: checked.edit_digest, gap_acknowledgement: checked.gaps.digest };
    let receipt;
    await test('apply uses normal publication pipeline and creates provenance audit', async () => {
      receipt = await api.applyScheduleEdit(f.req(f.MGR, payload));
      assert.equal(receipt.revision, pointer.revision + 1);
      const audit = (await f.station().collection('schedule_audit').get()).docs.map(d => d.data()).find(d => d.request_id === 'rep_apply' && d.action === 'edit-draft');
      assert.equal(audit.origin, 'replicate'); assert.equal(audit.source_date, '2026-09-01');
      assert.equal(audit.changes.length, audit.change_count);
    });
    await test('completed receipt replays after midnight and pointer advance without another publication', async () => {
      at = '2026-09-02T06:00:00.000Z';
      const count = (await f.station().collection('schedule_publications').get()).size;
      const replay = await api.applyScheduleEdit(f.req(f.MGR, payload));
      assert.equal(replay.publication_id, receipt.publication_id); assert.equal(replay.duplicate, true);
      assert.equal((await f.station().collection('schedule_publications').get()).size, count);
      await assert.rejects(api.applyScheduleEdit(f.req(f.MGR, { ...payload, replication: { ...payload.replication, mode: 'skip_manual' } })), e => e.code === 'request-conflict');
    });
    await test('no-change replication produces a zero-change preview and cannot publish', async () => {
      const current = (await f.station().collection('schedule_state').doc('active').get()).data();
      const next = { ...input, expected: expectedOf(current) };
      const p = await api.previewScheduleReplication(f.req(f.MGR, next));
      assert.equal(p.counts.changes, 0);
      await assert.rejects(api.applyScheduleEdit(f.req(f.MGR, { ...next, request_id: 'rep_noop', expected_edit_digest: p.edit_digest })), e => e.code === 'edit-no-changes');
    });
    await test('revoked live manager cannot replay a successful replication', async () => {
      await f.station().collection('schedule_access').doc(f.MGR).update({ active: false });
      await assert.rejects(api.applyScheduleEdit(f.req(f.MGR, payload)), e => e.code === 'manager-required');
    });
    console.log('Replication runtime integration: ' + passed + '/7 PASS; emulator only, no real FCM/device claim.');
  } finally { await f.wipe(); }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  const admin = require('firebase-admin'); await Promise.all(admin.apps.map(app => app.delete()));
});
