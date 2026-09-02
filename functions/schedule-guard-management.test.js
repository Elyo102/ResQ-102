'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const guards = require('./schedule-guard-management');

function create(details) {
  return guards.parseCommand({ action: 'create', request_id: 'request_create_01', details: Object.assign({
    title: 'אבטחת הופעה', kind: 'show', place: 'טיילת', date: '2026-09-05',
    start: '22:00', end: '06:00', slots: 2, need_quals: [], notes: ''
  }, details || {}) });
}

function existing(patch) {
  return Object.assign({
    title: 'אבטחת הופעה', kind: 'show', place: 'טיילת', date: '2026-09-05',
    start: '22:00', end: '06:00', slots: 2, need_quals: [], notes: '',
    status: 'open', revision: 4, assigned: [], signups: { signup_a: { name: 'א' } }
  }, patch || {});
}

function command(action, patch) {
  return guards.parseCommand(Object.assign({
    action, request_id: 'request_' + action + '_01', guard_id: 'guard_01', expected_revision: 4
  }, patch || {}));
}

test('create builds an open unstaffed guard and preserves overnight hours', () => {
  const result = guards.operation(null, create(), [], 'guard_new_01');
  assert.equal(result.guard_id, 'guard_new_01');
  assert.equal(result.after.status, 'open');
  assert.equal(result.after.revision, 1);
  assert.deepEqual(result.after.assigned, []);
  assert.equal(result.after.start, '22:00');
  assert.equal(result.after.end, '06:00');
});

test('create rejects client-supplied station, status and arbitrary fields', () => {
  for (const extra of [{ stationId: 'other' }, { status: 'staffed' }, { assigned: ['a1'] }]) {
    assert.throws(() => guards.parseCommand(Object.assign({
      action: 'create', request_id: 'request_create_02', details: {
        title: 'אבטחה', date: '2026-09-05', start: '08:00', end: '12:00', slots: 1
      }
    }, extra)), { name: 'GuardManagementError' });
  }
});

test('details reject malformed dates times controls and unknown kinds', () => {
  for (const details of [
    { date: '2026-02-30' }, { start: '24:00' }, { title: 'אסור\nכאן' }, { kind: 'made_up' }
  ]) assert.throws(() => create(details), { name: 'GuardManagementError' });
});

test('a manager can fill an open guard with active people only', () => {
  const result = guards.operation(existing(), command('set_assignees', { uids: ['fire_b', 'fire_a'] }),
    ['fire_a', 'fire_b'], 'unused');
  assert.equal(result.after.status, 'staffed');
  assert.deepEqual(result.after.assigned, ['fire_a', 'fire_b']);
  assert.deepEqual(result.added, ['fire_a', 'fire_b']);
  assert.deepEqual(result.notifications, [
    { uid: 'fire_a', kind: 'assigned' }, { uid: 'fire_b', kind: 'assigned' }
  ]);
});

test('unassign is allowed after staffed and returns the guard to open', () => {
  const result = guards.operation(existing({ status: 'staffed', assigned: ['fire_a', 'fire_b'] }),
    command('set_assignees', { uids: ['fire_a'] }), ['fire_a', 'fire_b'], 'unused');
  assert.equal(result.after.status, 'open');
  assert.deepEqual(result.after.assigned, ['fire_a']);
  assert.deepEqual(result.removed, ['fire_b']);
  assert.deepEqual(result.notifications, [
    { uid: 'fire_b', kind: 'removed' }, { uid: 'fire_a', kind: 'updated' }
  ]);
});

test('a retained firefighter gets a replacement update when the team changes', () => {
  const first = guards.operation(existing({ slots: 2 }),
    command('set_assignees', { uids: ['fire_a'] }), ['fire_a', 'fire_b'], 'unused');
  const second = guards.operation(Object.assign(existing({ slots: 2 }), first.after),
    guards.parseCommand({
      action: 'set_assignees', request_id: 'request_replace_01', guard_id: 'guard_01',
      expected_revision: first.after.revision, uids: ['fire_a', 'fire_b']
    }), ['fire_a', 'fire_b'], 'unused');
  assert.deepEqual(second.notifications, [
    { uid: 'fire_b', kind: 'assigned' }, { uid: 'fire_a', kind: 'updated' }
  ]);
});

test('inactive, duplicate and over-capacity assignments fail closed', () => {
  assert.throws(() => guards.operation(existing(), command('set_assignees', { uids: ['fire_a', 'fire_b'] }),
    ['fire_a'], 'unused'), { code: 'guard-assignee-inactive' });
  assert.throws(() => command('set_assignees', { uids: ['fire_a', 'fire_a'] }), { name: 'GuardManagementError' });
  assert.throws(() => guards.operation(existing({ slots: 1 }), command('set_assignees', { uids: ['fire_a', 'fire_b'] }),
    ['fire_a', 'fire_b'], 'unused'), { code: 'guard-capacity' });
});

test('edit and reschedule remain available after staffing and notify once per affected person', () => {
  const before = existing({ status: 'staffed', assigned: ['fire_a', 'fire_b'], signups: { fire_b: {}, signup_a: {} } });
  const edited = guards.operation(before, command('edit', { details: { title: 'אבטחה עודכנה' } }),
    ['fire_a', 'fire_b', 'signup_a'], 'unused');
  assert.equal(edited.after.title, 'אבטחה עודכנה');
  assert.equal(edited.after.status, 'staffed');
  assert.deepEqual(edited.notifications, [
    { uid: 'fire_a', kind: 'updated' }, { uid: 'fire_b', kind: 'updated' }, { uid: 'signup_a', kind: 'updated' }
  ]);
  const moved = guards.operation(before, command('reschedule', { details: { date: '2026-09-06' } }),
    ['fire_a', 'fire_b', 'signup_a'], 'unused');
  assert.equal(moved.after.date, '2026-09-06');
  assert.equal(moved.notifications.every((item) => item.kind === 'rescheduled'), true);
});

test('a dotted Firebase UID remains one valid signup notification recipient', () => {
  const moved = guards.operation(existing({ signups: { 'dot.user': {} } }),
    command('reschedule', { details: { date: '2026-09-06' } }), [], 'unused');
  assert.deepEqual(moved.notifications, [{ uid: 'dot.user', kind: 'rescheduled' }]);
});

test('a dotted Firebase UID can be assigned and unassigned manually', () => {
  const staffed = guards.operation(existing({ slots: 1 }),
    command('set_assignees', { uids: ['dot.user'] }), ['dot.user'], 'unused');
  assert.equal(staffed.after.status, 'staffed');
  assert.deepEqual(staffed.after.assigned, ['dot.user']);
  assert.deepEqual(staffed.notifications, [{ uid: 'dot.user', kind: 'assigned' }]);
  const reopened = guards.operation(Object.assign(existing({ slots: 1 }), staffed.after),
    guards.parseCommand({
      action: 'set_assignees', request_id: 'request_dot_remove_01', guard_id: 'guard_01',
      expected_revision: staffed.after.revision, uids: []
    }), ['dot.user'], 'unused');
  assert.equal(reopened.after.status, 'open');
  assert.deepEqual(reopened.notifications, [{ uid: 'dot.user', kind: 'removed' }]);
  for (const uid of ['bad/uid', 'bad\nuid', '']) {
    assert.throws(() => command('set_assignees', { uids: [uid] }),
      { name: 'GuardManagementError' });
  }
});

test('an edit cannot silently lower capacity below existing assignments', () => {
  assert.throws(() => guards.operation(existing({ status: 'staffed', assigned: ['fire_a', 'fire_b'] }),
    command('edit', { details: { slots: 1 } }), ['fire_a', 'fire_b'], 'unused'),
  { code: 'guard-slots-below-assigned' });
});

test('cancel preserves history and blocks later mutations', () => {
  const cancelled = guards.operation(existing({ assigned: ['fire_a'] }), command('cancel'), ['fire_a'], 'unused');
  assert.equal(cancelled.after.status, 'cancelled');
  assert.deepEqual(cancelled.notifications, [
    { uid: 'fire_a', kind: 'cancelled' }, { uid: 'signup_a', kind: 'cancelled' }
  ]);
  assert.throws(() => guards.operation(Object.assign(existing(), cancelled.after),
    command('edit', { expected_revision: cancelled.after.revision, details: { title: 'אסור' } }),
  ['fire_a'], 'unused'), { code: 'guard-terminal' });
});

test('stale revisions conflict and no-op updates do not make notifications', () => {
  assert.throws(() => guards.operation(existing(), command('edit', { expected_revision: 3, details: { title: 'חדש' } }),
    [], 'unused'), { code: 'guard-revision-conflict' });
  const same = guards.operation(existing(), command('edit', { details: { title: 'אבטחת הופעה' } }), [], 'unused');
  assert.equal(same.changed, false);
  assert.equal(same.after.revision, 4);
  assert.deepEqual(same.notifications, []);
});

test('terminal completion is explicit and not a free-form status patch', () => {
  const done = guards.operation(existing(), command('complete'), [], 'unused');
  assert.equal(done.after.status, 'done');
  assert.throws(() => guards.parseCommand({
    action: 'edit', request_id: 'request_status_01', guard_id: 'guard_01', expected_revision: 4,
    details: { status: 'done' }
  }), { name: 'GuardManagementError' });
});
