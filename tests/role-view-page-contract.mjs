import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveRoleView } from '../role-view.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, '..', 'role-view-page.js');
assert.equal(fs.existsSync(modulePath), true,
  'role-view-page.js must own cross-screen storage and fail-closed lifecycle');

const page = await import(pathToFileURL(modulePath).href + '?contract=' + Date.now());
assert.equal(typeof page.resolvePageRoleView, 'function');
assert.equal(typeof page.isPreviewSafePage, 'function');
assert.equal(typeof page.consumeActualRoleViewNavigation, 'function');
assert.equal(page.ROLE_VIEW_STORAGE_KEY, 'resq_role_view_v1');

function storage(initial = '') {
  let value = initial;
  return {
    getItem(key) { assert.equal(key, page.ROLE_VIEW_STORAGE_KEY); return value; },
    setItem(key, next) { assert.equal(key, page.ROLE_VIEW_STORAGE_KEY); value = String(next); },
    removeItem(key) { assert.equal(key, page.ROLE_VIEW_STORAGE_KEY); value = ''; },
    value() { return value; }
  };
}

const claims = {
  super:true, auth_time:100, role:'firefighter', stationId:'eilat_102',
  permissions:{ schedule:true }
};
const seed = resolveRoleView({ uid:'owner', claims, requested:'commander' });
const saved = JSON.stringify(seed.storageRecord);

assert.equal(page.isPreviewSafePage('login.html'), true);
assert.equal(page.isPreviewSafePage('schedule-management.html'), true);
for (const unsafe of ['hr.html', 'admin.html', '../schedule-management.html',
  'schedule-management.html?role=commander', '', null]) {
  assert.equal(page.isPreviewSafePage(unsafe), false, String(unsafe));
}

let box = storage(saved);
let view = page.resolvePageRoleView({
  pageId:'schedule-management.html', user:{ uid:'owner' }, claims, storage:box
});
assert.equal(view.preview, true);
assert.equal(view.readOnly, true);
assert.equal(view.presentation.role_id, 'commander');
assert.equal(JSON.parse(box.value()).owner_uid, 'owner');

box = storage('');
view = page.resolvePageRoleView({
  pageId:'schedule-management.html', user:{ uid:'owner' }, claims,
  requested:'commander', storage:box
});
assert.equal(view.preview, false,
  'a destination must never activate a role from URL/requested input');
assert.equal(box.value(), '');

box = storage(saved);
view = page.resolvePageRoleView({
  pageId:'hr.html', user:{ uid:'owner' }, claims, storage:box
});
assert.equal(view.preview, false);
assert.equal(box.value(), saved,
  'an unsupported page cannot consume or rewrite the bound record');

for (const changed of [
  { ...claims, super:false },
  { ...claims, super:'true' },
  { ...claims, auth_time:101 },
  { ...claims, permissions:{ schedule:false } }
]) {
  box = storage(saved);
  view = page.resolvePageRoleView({
    pageId:'schedule-management.html', user:{ uid:'owner' }, claims:changed, storage:box
  });
  assert.equal(view.preview, false);
  assert.equal(box.value(), '');
}

box = storage(saved);
view = page.resolvePageRoleView({
  pageId:'schedule-management.html', user:{ uid:'other-owner' }, claims, storage:box
});
assert.equal(view.preview, false);
assert.equal(box.value(), '');

const broken = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
  removeItem() { throw new Error('blocked'); }
};
assert.doesNotThrow(() => {
  view = page.resolvePageRoleView({
    pageId:'schedule-management.html', user:{ uid:'owner' }, claims, storage:broken
  });
});
assert.equal(view.preview, false, 'storage failure must fail closed');

box = storage(saved);
const cleanUrl = page.consumeActualRoleViewNavigation(
  'https://station-102.web.app/schedule-management.html?month=2026-09&resq_actual=notification#board',
  box
);
assert.equal(cleanUrl, '/schedule-management.html?month=2026-09#board');
assert.equal(box.value(), '', 'notification navigation must clear preview');

for (const destination of ['hr.html', 'hr-requests.html', 'hr-documents.html']) {
  box = storage(saved);
  const cleanDestination = page.consumeActualRoleViewNavigation(
    'https://station-102.web.app/' + destination + '?resq_actual=notification#content', box
  );
  assert.equal(cleanDestination, '/' + destination + '#content');
  assert.equal(box.value(), '', destination + ' must clear the bound preview before page initialization');
}

box = storage(saved);
assert.equal(page.consumeActualRoleViewNavigation(
  'https://station-102.web.app/schedule-management.html?role=commander', box), '');
assert.equal(box.value(), saved,
  'a role-shaped URL is never authority to change the stored preview');

console.log('role-view page contract: PASS');
