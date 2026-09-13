import assert from 'node:assert/strict';
import { scheduleUpdateBlockReason, schedulePwaUpdateGuard } from '../schedule-update-guard.js';

const cleanDoc = {
  getElementById: () => null,
  querySelector: () => null
};

assert.equal(scheduleUpdateBlockReason({}, cleanDoc), '', 'a clean schedule screen can update');

const cases = [
  ['busy', { busy:true }, 'schedule-operation'],
  ['policy busy', { policyBusy:true }, 'schedule-operation'],
  ['source busy', { sourceBusy:true }, 'schedule-operation'],
  ['mode busy', { modeBusy:true }, 'schedule-operation'],
  ['planner retry', { plannerPending:{} }, 'schedule-retry-proof'],
  ['rollback retry', { rollbackPending:{} }, 'schedule-retry-proof'],
  ['import retry', { importPending:{} }, 'schedule-retry-proof'],
  ['edit retry', { editPending:{} }, 'schedule-retry-proof'],
  ['cutover retry', { pendingCutover:{} }, 'schedule-retry-proof'],
  ['display retry', { displayPending:{} }, 'schedule-retry-proof'],
  ['publish identity', { publishRequestId:'p1' }, 'schedule-retry-proof'],
  ['intent identity', { intentRequestIds:{ a:'r1' } }, 'schedule-retry-proof'],
  ['selected file', { importSelectedFile:{} }, 'schedule-import'],
  ['parsed import', { importMatrix:[[]] }, 'schedule-import'],
  ['imported draft', { importedDraft:{} }, 'schedule-import'],
  ['draft', { draft:{} }, 'schedule-draft'],
  ['preview', { draftPreview:{} }, 'schedule-draft'],
  ['policy edit', { policyDirty:true }, 'schedule-settings'],
  ['source edit', { sourceDirty:true }, 'schedule-settings'],
  ['source plan', { sourcePlan:{} }, 'schedule-settings'],
  ['edit list', { editList:[{}] }, 'schedule-edit'],
  ['edit form', { editFormDirty:true }, 'schedule-edit'],
  ['planner form', { plannerFormDirty:true }, 'schedule-form'],
  ['qualification form', { qualificationsDirty:true }, 'schedule-form'],
  ['gap policy', { gapPolicyDirty:true }, 'schedule-form'],
  ['mode form', { modeFormDirty:true }, 'schedule-form']
];

for (const [label, state, expected] of cases) {
  assert.equal(scheduleUpdateBlockReason(state, cleanDoc), expected, label + ' blocks an update');
}

const pasted = {
  getElementById: (id) => id === 'importPaste' ? { value:'שם,תאריך' } : null,
  querySelector: () => null
};
assert.equal(scheduleUpdateBlockReason({}, pasted), 'schedule-import', 'pasted schedule bytes block');
assert.deepEqual(schedulePwaUpdateGuard({}, cleanDoc), { safe:true }, 'clean guard is safe');
assert.equal(schedulePwaUpdateGuard({ editList:[{}] }, cleanDoc).safe, false, 'dirty guard fails closed');

console.log('Schedule PWA update guard: 30/30 PASS');
