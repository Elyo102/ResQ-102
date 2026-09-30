import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSource, compareInventory } from './containment-inventory.mjs';

test('direct browser package imports fail closed', () => {
  assert.throws(() => inspectSource('tests/new-browser.mjs', "import {chromium} from 'playwright';"), /DIRECT_PLAYWRIGHT_ESCAPE/);
  assert.throws(() => inspectSource('tests/new-browser.mjs', "const p=require('playwright');"), /DIRECT_PLAYWRIGHT_ESCAPE/);
});
test('removing the shared fixture import cannot retain executable browser calls', () => {
  assert.throws(() => inspectSource('tests/new-browser.mjs', 'browser.newContext();'), /UNCONTAINED_BROWSER_ENTRY/);
});
test('contained imports retain exact call inventory', () => {
  const value = inspectSource('tests/new-browser.mjs', "import {chromium} from './lib/contained-playwright.cjs'; const b=await chromium.launch(); await b.newContext();");
  assert.equal(value.launch, 1); assert.equal(value.context, 1);
});
test('metadata-only Playwright config cannot acquire browser execution', () => {
  assert.throws(() => inspectSource('tests/playwright.config.mjs', "import {devices} from 'playwright/test'; browser.newContext();"), /CONFIG_EXECUTOR_ESCAPE/);
});
test('new or replaced browser entry cannot silently change a closed inventory', () => {
  const before = { schema: 1, entries: [{ file: 'tests/a.mjs', launch: 1 }] };
  assert.throws(() => compareInventory({ schema: 1, entries: [...before.entries, { file: 'tests/b.mjs', launch: 1 }] }, before), /INVENTORY_CHANGED/);
  assert.throws(() => compareInventory({ schema: 1, entries: [{ file: 'tests/b.mjs', launch: 1 }] }, before), /INVENTORY_CHANGED/);
  compareInventory(structuredClone(before), before);
});
