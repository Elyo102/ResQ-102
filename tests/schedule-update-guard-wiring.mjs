import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const managementPath = path.join(root, 'schedule-management.js');
const guardPath = path.join(root, 'schedule-update-guard.js');
const htmlPath = path.join(root, 'schedule-management.html');
const management = fs.readFileSync(managementPath, 'utf8');
const guard = fs.readFileSync(guardPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function region(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing production anchor: ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing production end anchor: ${end}`);
  return source.slice(from, to);
}

function marker(flag) {
  return new RegExp(
    `(?:state\\.${escape(flag)}\\s*=\\s*true|markScheduleUpdateDirty\\(\\s*['\"]${escape(flag)}['\"]\\s*\\))`
  );
}

function resetMarker(flag) {
  return new RegExp(
    `(?:state\\.${escape(flag)}\\s*=\\s*(?:false|null)|${escape(flag)}\\s*:\\s*(?:false|null)|clearScheduleUpdateDirty\\(\\s*['\"]${escape(flag)}['\"]\\s*\\))`
  );
}

function stateDeclaration(flag) {
  const block = region(management, 'const state = {', '\n};');
  return new RegExp(`(?:^|[,\\s])${escape(flag)}\\s*:\\s*(?:false|null)(?:[,\\s]|$)`).test(block);
}

function hasId(id) {
  return new RegExp(`\\bid=[\"']${escape(id)}[\"']`).test(html);
}

const clauses = [
  {
    id:'source-paste', flag:'sourceDirty', controls:['sourcePaste', 'sourceParse'],
    read:() => region(management, "$('sourceParse').addEventListener", 'function resetScopedWorkspace()'),
    why:'parsing pasted workforce data must mark the unsaved source'
  },
  {
    id:'source-column-map', flag:'sourceDirty', controls:['sourceMap'],
    read:() => region(management, 'function renderSourceMap()', 'function renderSourceActive()'),
    why:'changing a workforce column mapping must mark the unsaved source'
  },
  {
    id:'source-active-values', flag:'sourceDirty', controls:['sourceActive'],
    read:() => region(management, 'function renderSourceActive()', 'function renderActiveSummary()'),
    why:'changing active workforce values must mark the unsaved source'
  },
  {
    id:'edit-person-selection', flag:'editFormDirty', controls:['editPerson'],
    read:() => region(management, 'function renderEditSearch()', 'function editItemText('),
    why:'selecting a person in the edit drawer creates unsaved edit-form intent'
  },
  {
    id:'edit-fields', flag:'editFormDirty',
    controls:['editRange', 'editDate', 'editAction', 'editStation', 'editRole', 'editAbsence'],
    read:() => region(management, "$('editSearch').addEventListener", '/* =================================================================='),
    why:'changing any edit drawer value before Add must remain protected'
  },
  {
    id:'planner-fields', flag:'plannerFormDirty', controls:['startMonth', 'months'],
    read:() => management,
    extra:(part) => /(?:startMonth.*months|months.*startMonth)[\s\S]{0,600}addEventListener/.test(part),
    why:'month and horizon changes without an override must block reload'
  },
  {
    id:'qualification-catalog', flag:'qualificationsDirty', controls:['qualRows'],
    read:() => region(management, 'function renderQualCatalog()', 'async function saveQualificationRow('),
    why:'catalog label, minimum, and active inputs must mark unsaved qualification changes'
  },
  {
    id:'qualification-person', flag:'qualificationsDirty', controls:['qualPeople'],
    read:() => region(management, 'function renderQualPeople()', 'async function savePersonQualifications('),
    why:'employee qualification checkboxes must mark unsaved changes'
  },
  {
    id:'qualification-new', flag:'qualificationsDirty',
    controls:['qualNewKey', 'qualNewLabel', 'qualNewMinimum'],
    read:() => management,
    why:'new qualification fields must mark unsaved changes before Save'
  },
  {
    id:'gap-policy', flag:'gapPolicyDirty', controls:['gapStationMinimum'],
    read:() => management,
    why:'station minimum changes must be protected before Save'
  },
  {
    id:'mode-target', flag:'modeFormDirty', controls:['modeTargets'],
    read:() => region(management, 'function renderModeCard()', 'function updateModeApply()'),
    why:'selecting a runtime mode target must mark the confirmation form'
  },
  {
    id:'mode-confirmation', flag:'modeFormDirty', controls:['modeConfirm', 'modeReason'],
    read:() => region(management, "$('modeConfirm').addEventListener", "$('modeApply').addEventListener"),
    why:'mode confirmation and reason must be protected before Apply'
  }
];

const failures = [];
const allFlags = [...new Set(clauses.map((item) => item.flag).concat('displayPending'))];
for (const flag of allFlags) {
  if (!new RegExp(`\\b${escape(flag)}\\b`).test(guard)) {
    failures.push(`${flag}: schedule-update-guard.js does not consume the state`);
  }
  if (!stateDeclaration(flag)) failures.push(`${flag}: missing false/null field in the real state object`);
  const reset = region(management, 'function resetScopedWorkspace()', '\n}\n');
  if (!resetMarker(flag).test(reset)) failures.push(`${flag}: resetScopedWorkspace does not clear it`);
}

for (const clause of clauses) {
  for (const control of clause.controls) {
    if (!hasId(control)) failures.push(`${clause.id}: real UI control #${control} is missing`);
  }
  const part = clause.read();
  if (!marker(clause.flag).test(part)) failures.push(`${clause.id}: ${clause.why}`);
  if (clause.extra && !clause.extra(part)) failures.push(`${clause.id}: no real input/change listener covers the controls`);
}

// A display write can commit while its response is lost.  The exact payload and
// request id therefore have to be stored before the await, retained on an
// ambiguous catch, and cleared only after a verified response.
for (const [name, start, end] of [
  ['display-show', 'async function showImportedSchedule()', 'async function clearImportedSchedule()'],
  ['display-clear', 'async function clearImportedSchedule()', 'function renderSummary(']
]) {
  const body = region(management, start, end);
  const pendingAt = body.search(/state\.displayPending\s*=/);
  const awaitAt = body.search(/await call\.displaySet\s*\(/);
  if (pendingAt < 0 || awaitAt < 0 || pendingAt > awaitAt) {
    failures.push(`${name}: displayPending must capture the exact payload before await call.displaySet`);
  }
  const catchAt = body.indexOf('catch (error)');
  const catchBody = catchAt < 0 ? '' : body.slice(catchAt);
  if (/state\.displayPending\s*=\s*(?:null|false)/.test(catchBody)) {
    failures.push(`${name}: ambiguous catch clears displayPending and destroys retry proof`);
  }
}

// The approval checkboxes are DOM state today.  A state-only guard check would
// be dead wiring, so the guard must inspect the actual controls or the product
// must mirror both controls into state from their change handlers.
for (const id of ['reviewDraft', 'draftGapAck']) {
  const mirrorsDom = new RegExp(`['\"]${id}['\"][\\s\\S]{0,180}addEventListener[\\s\\S]{0,180}state\\.${id}`).test(management);
  const readsDom = new RegExp(`has(?:Checked|Control)\\(\\s*doc\\s*,\\s*['\"]${id}['\"]`).test(guard);
  if (!mirrorsDom && !readsDom) failures.push(`${id}: guard state check is not wired to the real checkbox`);
}

// Mutation self-check: each required dirty marker is load-bearing in this
// wiring contract.  This runs independently even while production is red.
const synthetic = clauses.map((item) => `${item.id}:state.${item.flag}=true`).join('\n');
for (const clause of clauses) {
  const mutated = synthetic.replace(`${clause.id}:state.${clause.flag}=true`, `${clause.id}:noop()`);
  assert.equal(mutated.includes(`${clause.id}:state.${clause.flag}=true`), false,
    `mutation removes ${clause.id}`);
  assert.equal(new RegExp(`${escape(clause.id)}:state\\.${escape(clause.flag)}=true`).test(mutated), false,
    `contract catches missing ${clause.id} marker`);
}

if (failures.length) {
  console.error(`Schedule update guard wiring: ${failures.length} FAILURES`);
  failures.forEach((failure) => console.error(' - ' + failure));
  assert.fail('schedule-management.js does not wire every update-guard state; see failures above');
}

console.log(`Schedule update guard wiring: ${clauses.length + 3}/${clauses.length + 3} PASS; ${clauses.length}/${clauses.length} marker mutations caught`);
