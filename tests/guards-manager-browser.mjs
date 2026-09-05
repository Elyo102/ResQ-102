import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(root, 'tests', 'stub');
const mime = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json'
};

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const file = path.join(root, pathname === '/' ? 'guards.html' : pathname.replace(/^\/+/, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404); response.end('not found'); return;
  }
  response.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'text/plain; charset=utf-8' });
  response.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/guards.html';

const MEMBER_GUARDS = Object.freeze([
  { id:'gdemo', title:'אבטחת בדיקה', kind:'sport', date:'2099-05-05',
    start:'10:00', end:'12:00', status:'open', slots:1,
    assigned_count:0, open_slots:1, viewer_assigned:false, viewer_signed_up:false },
  { id:'g1', title:'משחק ליגה', kind:'sport', date:'2099-01-10',
    start:'18:00', end:'23:00', status:'open', slots:2,
    assigned_count:0, open_slots:2, viewer_assigned:false, viewer_signed_up:false },
  { id:'g2', title:'הופעה בפארק', kind:'show', date:'2099-02-14',
    start:'20:00', end:'01:00', status:'staffed', slots:2,
    assigned_count:2, open_slots:0, viewer_assigned:true, viewer_signed_up:false }
]);

function managerGuards(revision = 0) {
  return [
    { id:'gdemo', title:'אבטחת בדיקה', kind:'sport', place:'מגרש בדיקה',
      date:'2099-05-05', start:'10:00', end:'12:00', status:'open', slots:1,
      need_quals:[], notes:'', revision, assigned:[], signups:[] },
    { id:'g1', title:'משחק ליגה', kind:'sport', place:'טוטו טרנר',
      date:'2099-01-10', start:'18:00', end:'23:00', status:'open', slots:2,
      need_quals:[], notes:'', revision, assigned:[], signups:[
        { uid:'u2', name:'טל חודרה', crew:'A' }, { uid:'u4', name:'דנה לוי', crew:'B' }
      ] },
    { id:'g2', title:'הופעה בפארק', kind:'show', place:'פארק העיר',
      date:'2099-02-14', start:'20:00', end:'01:00', status:'staffed', slots:2,
      need_quals:['q1'], notes:'רכב סער', revision, assigned:['stub-uid','u3'], signups:[] }
  ];
}

function repeatedBoard(rows, count = 100) {
  return Array.from({ length:count }, () => ({ data:{ guards:rows } }));
}

function defaultGuardPlans() {
  return {
    getScheduleGuardBoard: repeatedBoard(MEMBER_GUARDS),
    getScheduleGuardManagerBoard: repeatedBoard(managerGuards())
    // getEffectiveWorkdays: ברירת המחדל של הבדל מחשבת מאותו סבב (A/B/C, עוגן 1.1.2026)
  };
}

async function prepare(context, role, plans) {
  await context.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status:200, contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.addInitScript(({ roleName, callablePlans }) => {
    window.__SMOKE_ROLE = roleName;
    window.__CALLABLE_PLAN = callablePlans;
  }, { roleName:role, callablePlans:Object.assign(defaultGuardPlans(), plans || {}) });
}

async function open(page) {
  await page.goto(base, { waitUntil:'load' });
  await page.locator('#work:not(.hide)').waitFor();
  await page.locator('#openList .g').first().waitFor();
  // בדל הנתונים כולל קריאת פתע כדי לבחון רכיב אחר. היא אמורה
  // לחסום שימוש אמיתי במסך, ולכן סוגרים אותה במפורש לפני כל
  // פעולה תפעולית בבדיקה זו.
  const no = page.locator('#coNo');
  if (await no.isVisible().catch(() => false)) await no.click();
}

function managementCalls(calls) {
  return (calls || []).filter(call => call.name === 'manageScheduleGuard');
}

const source = fs.readFileSync(path.join(root, 'guards.html'), 'utf8');
assert.match(source, /getGuardManagementStatus/,
  'the screen must source guard management from its narrow server callable');
assert.match(source, /result\.data\.guard_manager\s*===\s*true/,
  'only an explicit server guard_manager=true may open management controls');
assert.match(source, /manageScheduleGuard/,
  'guard management must use the server callable');
assert.match(source, /getScheduleGuardBoard/,
  'ordinary guard viewing must use the safe server board');
assert.match(source, /getScheduleGuardManagerBoard/,
  'manager details must use the separate live-manager server board');
assert.match(source, /action:\s*'set_assignees'/,
  'assignment must name the closed server operation');
assert.match(source, /action:\s*'edit'/,
  'manager edits must use the closed server operation');
assert.match(source, /action:\s*'reschedule'/,
  'manager date changes must use the closed server operation');
assert.match(source, /action:\s*'cancel'/,
  'manager cancellation must use the closed server operation');
assert.match(source, /dlgPick\s*=\s*Object\.create\(null\)/,
  'assignment selection must safely retain every server-valid UID');
assert.match(source, /expected_revision:\s*expectedRevision\(g\)/,
  'assignment must carry optimistic-concurrency revision');
assert.doesNotMatch(source, /\b(addDoc|setDoc|updateDoc|deleteDoc)\b/,
  'the browser must not write guard documents directly');
assert.doesNotMatch(source, /assignGuard/,
  'the browser must not retain the legacy assignment callable');
assert.doesNotMatch(source, /grab\('guards'/,
  'the browser must not fall back to a raw guards collection read');

let passed = 0;
async function test(name, fn) {
  await fn(); passed += 1; console.log('✓ ' + name);
}

const browser = await chromium.launch();
try {
  const unappointed = await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' });
  await prepare(unappointed, 'firefighter', {
    getGuardManagementStatus:[{ data:{ guard_manager:false } }]
  });
  const unappointedPage = await unappointed.newPage();
  await open(unappointedPage);

await test('an ordinary firefighter without an appointment sees guards but no management controls', async () => {
    assert.equal(await unappointedPage.locator('#newCard').isVisible(), false);
    assert.equal(await unappointedPage.getByRole('button', { name:'שבץ' }).count(), 0);
    assert.match(await unappointedPage.locator('#openList').textContent(), /מקום פנוי/,
      'an unstaffed guard stays visible to ordinary viewers');
    assert.match(await unappointedPage.locator('#openList .g', { hasText:'אבטחת בדיקה' }).textContent(),
      /טרם אוישה/, 'an unstaffed guard is shown as a normal operational state');
    const regular = await unappointedPage.locator('#openList').textContent();
    for (const secret of ['פארק העיר', 'רכב סער', 'טל חודרה', 'stub-uid']) {
      assert.equal(regular.includes(secret), false, 'regular view leaked ' + secret);
    }
    const paths = await unappointedPage.evaluate(() => window.__DATA_PATHS || []);
    for (const managerOnly of ['/roster', '/quals', '/member_quals']) {
      assert.equal(paths.some(path => String(path).includes(managerOnly)), false,
        'ordinary viewer downloaded manager-only ' + managerOnly);
    }
  });
  await unappointed.close();

  const commander = await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' });
  await prepare(commander, 'commander', {
    getGuardManagementStatus:[{ data:{ guard_manager:true } }]
  });
  const commanderPage = await commander.newPage();
  await open(commanderPage);
  await test('a live commander can staff guards without receiving schedule publishing authority', async () => {
    assert.equal(await commanderPage.locator('#newCard').isVisible(), true);
    assert.ok(await commanderPage.getByRole('button', { name:'שבץ' }).count() > 0);
    const calls = await commanderPage.evaluate(() => window.__CALLABLE_CALLS || []);
    assert.ok(calls.some(call => call.name === 'getGuardManagementStatus'));
    assert.equal(calls.some(call => call.name === 'getScheduleRuntimeStatus'), false);
  });
  await commander.close();

  const superAdmin = await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' });
  await prepare(superAdmin, 'super', {
    getGuardManagementStatus:[{ data:{ guard_manager:true } }]
  });
  const superPage = await superAdmin.newPage();
  await open(superPage);
  await test('a verified super always sees guard creation and assignment controls', async () => {
    assert.equal(await superPage.locator('#newCard').isVisible(), true);
    assert.ok(await superPage.getByRole('button', { name:'שבץ' }).count() > 0);
  });
  await superAdmin.close();

  const unavailable = await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' });
  await prepare(unavailable, 'firefighter', {
    getGuardManagementStatus:[{ reject:true, code:'functions/unavailable', message:'offline' }]
  });
  const unavailablePage = await unavailable.newPage();
  await open(unavailablePage);
  await test('a runtime-status or App Check failure keeps viewing and signup available but fails management closed', async () => {
    assert.equal(await unavailablePage.locator('#work').isVisible(), true);
    assert.equal(await unavailablePage.locator('#newCard').isVisible(), false);
    assert.ok(await unavailablePage.getByRole('button', { name:'אני מעוניין' }).count() > 0);
    assert.equal(await unavailablePage.getByRole('button', { name:'שבץ' }).count(), 0);
  });
  await unavailable.close();

  const doubleFailure = await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' });
  await prepare(doubleFailure, 'firefighter', {
    getGuardManagementStatus:[{ data:{ guard_manager:false } }],
    getEffectiveWorkdays:[
      { reject:true, code:'functions/unavailable', message:'workdays-unavailable' },
      { reject:true, code:'functions/unavailable', message:'workdays-unavailable' }
    ],
    getScheduleGuardBoard:[
      { reject:true, code:'functions/unavailable', message:'offline' },
      { reject:true, code:'functions/unavailable', message:'offline' }
    ]
  });
  const doubleFailurePage = await doubleFailure.newPage();
  await doubleFailurePage.goto(base, { waitUntil:'load' });
  await doubleFailurePage.locator('#work:not(.hide)').waitFor();
  await doubleFailurePage.waitForFunction(() =>
    document.querySelector('#openMsg').textContent.includes('לוח האבטחות'));
  await test('a board failure takes precedence over a classification failure', async () => {
    assert.equal(await doubleFailurePage.locator('#openList .g').count(), 0);
    assert.match(await doubleFailurePage.locator('#openNote').textContent(), /לא ניתן לקבוע/);
    const notice = await doubleFailurePage.locator('#openMsg').textContent();
    assert.match(notice, /לא הצלחנו לטעון את לוח האבטחות/);
    assert.equal(notice.includes('האבטחות זמינות'), false,
      'the screen must not claim availability after the board read failed');
  });
  await doubleFailure.close();

  const newMode = await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' });
  await prepare(newMode, 'firefighter', {
    getGuardManagementStatus:[{ data:{ guard_manager:true } }],
    getEffectiveWorkdays:[
      { reject:true, code:'functions/unavailable', message:'workdays-unavailable' },
      { reject:true, code:'functions/unavailable', message:'workdays-unavailable' }
    ]
  });
  const newModePage = await newMode.newPage();
  await open(newModePage);
  await test('a classification failure keeps guard boards and manual management live and invents no duty kind', async () => {
    const card = newModePage.locator('#openList .g', { hasText:'הופעה בפארק' });
    assert.equal(await card.count(), 1, 'the independent guard board remains visible');
    assert.match(await newModePage.locator('#openMsg').textContent(), /סיווג.+אינם זמינים/);
    assert.equal(await card.locator('.tag.off, .tag.shift, .tag.unknown').count(), 0,
      'the screen must not invent a duty classification when the answer failed');
    assert.equal(await card.locator('.acts button').count(), 4,
      'create/assign/edit/reschedule/cancel management remains available');

    await card.getByRole('button', { name:'שבץ' }).click();
    await newModePage.locator('#dlgList input[type=checkbox]').first().waitFor();
    assert.deepEqual(await newModePage.locator('#dlgList input[type=checkbox]:checked')
      .evaluateAll(inputs => inputs.map(input => input.value)), ['stub-uid', 'u3'],
      'manual mode retains existing assignees but adds nobody from a fictitious load ranking');
    assert.match(await newModePage.locator('#dlg').textContent(), /בחירה ידנית/);
    await newModePage.locator('#dlgClose').click();

    await card.getByRole('button', { name:'ערוך' }).click();
    assert.equal(await newModePage.locator('#dlgSave').isVisible(), true,
      'editing is operational even when schedule classification is unavailable');
  });
  await newMode.close();

  const manager = await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' });
  await prepare(manager, 'firefighter', {
    getGuardManagementStatus:[{ data:{ guard_manager:true } }],
    manageScheduleGuard:[
      { data:{ guard_id:'g_new', revision:1 } },
      { data:{ guard_id:'g2', revision:1 } },
      { data:{ guard_id:'g2', revision:1 } },
      { data:{ guard_id:'g2', revision:1 } },
      { data:{ guard_id:'g2', revision:1 } },
      { data:{ guard_id:'g2', revision:1 } }
    ]
  });
  const managerPage = await manager.newPage();
  await open(managerPage);

  await test('a separately appointed firefighter can create a guard through the server callable only', async () => {
    assert.equal(await managerPage.locator('#newCard').isVisible(), true);
    await managerPage.locator('#nTitle').fill('אבטחת אירוע חדשה');
    await managerPage.locator('#btnNew').click();
    await managerPage.locator('#newMsg.ok').waitFor();
    const calls = await managerPage.evaluate(() => window.__CALLABLE_CALLS || []);
    const create = managementCalls(calls)[0];
    assert.ok(create);
    assert.equal(create.payload.action, 'create');
    assert.match(create.payload.request_id, /^guard_create_[a-f0-9]{32}$/);
    assert.deepEqual(Object.keys(create.payload.details).sort(),
      ['date', 'end', 'kind', 'need_quals', 'notes', 'place', 'slots', 'start', 'title']);
    assert.equal(Object.hasOwn(create.payload, 'stationId'), false);
    assert.equal(Object.hasOwn(create.payload, 'station_id'), false);
    const writes = await managerPage.evaluate(() => window.__FIRESTORE_WRITES || []);
    assert.equal(writes.some(write => String(write.path || '').includes('/guards')), false);
  });

  await test('a live schedule manager receives the detailed editing board only after appointment', async () => {
    const detailed = await managerPage.locator('#openList').textContent();
    assert.match(detailed, /פארק העיר/);
    assert.match(detailed, /רכב סער/);
    const paths = await managerPage.evaluate(() => window.__DATA_PATHS || []);
    for (const managerOnly of ['/roster', '/quals', '/member_quals']) {
      assert.equal(paths.some(path => String(path).includes(managerOnly)), true,
        'appointed manager needs ' + managerOnly + ' for controlled editing');
    }
  });

  await test('the assignment dialog sends the retained assignee set after a partial removal', async () => {
    const card = managerPage.locator('#openList .g', { hasText:'הופעה בפארק' });
    await card.getByRole('button', { name:'שבץ' }).click();
    await managerPage.locator('#dlgList input[type=checkbox]').first().waitFor();
    const existing = managerPage.locator('#dlgList input[type=checkbox]:checked');
    assert.deepEqual(await existing.evaluateAll(inputs => inputs.map(input => input.value)),
      ['stub-uid', 'u3'], 'currently assigned people start selected');
    await existing.first().uncheck();
    await managerPage.locator('#dlgSave').click();
    await managerPage.waitForFunction(() => (window.__CALLABLE_CALLS || [])
      .filter(call => call.name === 'manageScheduleGuard').length === 2);
    const calls = await managerPage.evaluate(() => window.__CALLABLE_CALLS || []);
    const assignment = managementCalls(calls)[1];
    assert.equal(assignment.payload.action, 'set_assignees');
    assert.equal(assignment.payload.guard_id, 'g2');
    assert.equal(assignment.payload.expected_revision, 0,
      'legacy guards without a revision use the explicit compatible revision');
    assert.deepEqual(assignment.payload.uids, ['u3'],
      'the complete desired list retains the remaining assignee');
    assert.match(assignment.payload.request_id, /^guard_assign_[a-f0-9]{32}$/);
    assert.equal(Object.hasOwn(assignment.payload, 'stationId'), false);
    assert.equal(Object.hasOwn(assignment.payload, 'station_id'), false);
  });

  await test('the assignment dialog can intentionally leave a guard unstaffed', async () => {
    const card = managerPage.locator('#openList .g', { hasText:'הופעה בפארק' });
    await card.getByRole('button', { name:'שבץ' }).click();
    const existing = managerPage.locator('#dlgList input[type=checkbox]:checked');
    assert.ok(await existing.count() >= 2, 'the current assignment is loaded again');
    while (await existing.count()) await existing.first().uncheck();
    await managerPage.locator('#dlgSave').click();
    await managerPage.waitForFunction(() => (window.__CALLABLE_CALLS || [])
      .filter(call => call.name === 'manageScheduleGuard').length === 3);
    const calls = await managerPage.evaluate(() => window.__CALLABLE_CALLS || []);
    const assignment = managementCalls(calls)[2];
    assert.equal(assignment.payload.action, 'set_assignees');
    assert.deepEqual(assignment.payload.uids, [],
      'clearing the selected set intentionally leaves the guard unstaffed');
    assert.equal(Object.hasOwn(assignment.payload, 'stationId'), false);
    assert.equal(Object.hasOwn(assignment.payload, 'station_id'), false);
  });

  await test('a manager can edit guard details through the callable with optimistic concurrency', async () => {
    const card = managerPage.locator('#openList .g', { hasText:'הופעה בפארק' });
    await card.getByRole('button', { name:'ערוך' }).click();
    await managerPage.locator('#eTitle').fill('הופעה מעודכנת');
    await managerPage.locator('#dlgSave').click();
    await managerPage.waitForFunction(() => (window.__CALLABLE_CALLS || [])
      .filter(call => call.name === 'manageScheduleGuard').length === 4);
    const calls = await managerPage.evaluate(() => window.__CALLABLE_CALLS || []);
    const edit = managementCalls(calls)[3];
    assert.equal(edit.payload.action, 'edit');
    assert.equal(edit.payload.guard_id, 'g2');
    assert.equal(edit.payload.expected_revision, 0);
    assert.equal(edit.payload.details.title, 'הופעה מעודכנת');
    assert.deepEqual(Object.keys(edit.payload.details).sort(),
      ['end', 'kind', 'need_quals', 'notes', 'place', 'slots', 'start', 'title']);
    assert.equal(Object.hasOwn(edit.payload, 'stationId'), false);
    assert.equal(Object.hasOwn(edit.payload, 'station_id'), false);
  });

  await test('a manager can postpone a guard through the callable with the supplied new date', async () => {
    const card = managerPage.locator('#openList .g', { hasText:'הופעה בפארק' });
    await card.getByRole('button', { name:'שנה תאריך' }).click();
    await managerPage.locator('#rDate').fill('2099-02-15');
    await managerPage.locator('#dlgSave').click();
    await managerPage.waitForFunction(() => (window.__CALLABLE_CALLS || [])
      .filter(call => call.name === 'manageScheduleGuard').length === 5);
    const calls = await managerPage.evaluate(() => window.__CALLABLE_CALLS || []);
    const reschedule = managementCalls(calls)[4];
    assert.equal(reschedule.payload.action, 'reschedule');
    assert.equal(reschedule.payload.guard_id, 'g2');
    assert.equal(reschedule.payload.expected_revision, 0);
    assert.deepEqual(reschedule.payload.details, { date:'2099-02-15' });
    assert.equal(Object.hasOwn(reschedule.payload, 'stationId'), false);
    assert.equal(Object.hasOwn(reschedule.payload, 'station_id'), false);
  });

  await test('a manager can cancel a live guard through the callable without deleting it', async () => {
    const card = managerPage.locator('#openList .g', { hasText:'הופעה בפארק' });
    managerPage.once('dialog', dialog => dialog.accept());
    await card.getByRole('button', { name:'בטל אבטחה' }).click();
    await managerPage.waitForFunction(() => (window.__CALLABLE_CALLS || [])
      .filter(call => call.name === 'manageScheduleGuard').length === 6);
    const calls = await managerPage.evaluate(() => window.__CALLABLE_CALLS || []);
    const cancel = managementCalls(calls)[5];
    assert.equal(cancel.payload.action, 'cancel');
    assert.equal(cancel.payload.guard_id, 'g2');
    assert.equal(cancel.payload.expected_revision, 0);
    assert.equal(Object.hasOwn(cancel.payload, 'details'), false);
    assert.equal(Object.hasOwn(cancel.payload, 'uids'), false);
    assert.equal(Object.hasOwn(cancel.payload, 'stationId'), false);
    assert.equal(Object.hasOwn(cancel.payload, 'station_id'), false);
  });
  await manager.close();

  const revokedAssignment = await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' });
  await prepare(revokedAssignment, 'firefighter', {
    getGuardManagementStatus:[{ data:{ guard_manager:true } }],
    manageScheduleGuard:[{ reject:true, code:'functions/permission-denied', message:'revoked' }]
  });
  const revokedAssignmentPage = await revokedAssignment.newPage();
  await open(revokedAssignmentPage);

  await test('a denied assignment closes the manager dialog and removes stale controls', async () => {
    const card = revokedAssignmentPage.locator('#openList .g', { hasText:'הופעה בפארק' });
    await card.getByRole('button', { name:'שבץ' }).click();
    await revokedAssignmentPage.locator('#dlgSave').click();
    await revokedAssignmentPage.waitForFunction(() => {
      const overlay = document.querySelector('#ov');
      const notice = document.querySelector('#openMsg');
      return overlay && overlay.style.display === 'none' && notice &&
        notice.textContent.includes('אין כרגע הרשאה');
    });
    assert.equal(await revokedAssignmentPage.locator('#newCard').isVisible(), false);
    assert.equal(await revokedAssignmentPage.getByRole('button', { name:'שבץ' }).count(), 0);
    assert.ok(await revokedAssignmentPage.locator('#openList .g').count() > 0,
      'permission loss must not remove the read-only guard view');
  });
  await revokedAssignment.close();

  const revoked = await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' });
  await prepare(revoked, 'firefighter', {
    getGuardManagementStatus:[{ data:{ guard_manager:true } }],
    manageScheduleGuard:[{ reject:true, code:'functions/permission-denied', message:'revoked' }]
  });
  const revokedPage = await revoked.newPage();
  await open(revokedPage);

  await test('a revoked manager loses client controls after a denied write while viewing remains available', async () => {
    await revokedPage.locator('#nTitle').fill('אבטחה שלא תיפתח');
    await revokedPage.locator('#btnNew').click();
    await revokedPage.waitForFunction(() => document.querySelector('#openMsg').textContent.includes('אין כרגע הרשאה'));
    assert.equal(await revokedPage.locator('#newCard').isVisible(), false);
    assert.equal(await revokedPage.getByRole('button', { name:'שבץ' }).count(), 0);
    assert.ok(await revokedPage.locator('#openList .g').count() > 0);
  });
  await revoked.close();

  const mobile = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await prepare(mobile, 'firefighter', {
    getGuardManagementStatus:[{ data:{ guard_manager:true } }]
  });
  const mobilePage = await mobile.newPage();
  await open(mobilePage);

  await test('all manager controls and the edit dialog remain usable on a 390px mobile screen', async () => {
    const card = mobilePage.locator('#openList .g', { hasText:'הופעה בפארק' });
    const actions = card.locator('.acts button');
    assert.equal(await actions.count(), 4);
    assert.equal(await card.locator('.acts').evaluate(el => el.scrollWidth <= el.clientWidth), true,
      'management actions wrap instead of overflowing their guard card');
    await card.getByRole('button', { name:'ערוך' }).click();
    await mobilePage.locator('#eTitle').waitFor();
    const modalFits = await mobilePage.evaluate(() => {
      const rect = document.querySelector('#dlg').getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    });
    assert.equal(modalFits, true, 'the edit dialog stays inside the mobile viewport');
    assert.equal(await mobilePage.locator('#dlgSave').isVisible(), true);
  });
  await mobile.close();

  const conflict = await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' });
  await prepare(conflict, 'firefighter', {
    getGuardManagementStatus:[{ data:{ guard_manager:true } }],
    getScheduleGuardManagerBoard:[
      { data:{ guards:managerGuards(0) } }, { data:{ guards:[] } },
      { data:{ guards:managerGuards(1) } }, { data:{ guards:[] } },
      ...repeatedBoard(managerGuards(1), 20)
    ],
    manageScheduleGuard:[
      { reject:true, code:'functions/aborted', message:'revision conflict' },
      { data:{ guard_id:'g2', revision:2 } }
    ]
  });
  const conflictPage = await conflict.newPage();
  await open(conflictPage);

  await test('a revision conflict reloads the guard and retries from its new revision', async () => {
    // המסך כבר קרא revision 0. תוצאת הלוח השנייה מוזרקת עם revision
    // 1 כדי לייצג שינוי מקביל בשרת לפני השמירה.
    let card = conflictPage.locator('#openList .g', { hasText:'הופעה בפארק' });
    await card.getByRole('button', { name:'ערוך' }).click();
    await conflictPage.locator('#eTitle').fill('ניסיון ישן');
    await conflictPage.locator('#dlgSave').click();
    await conflictPage.waitForFunction(() => {
      const overlay = document.querySelector('#ov');
      const notice = document.querySelector('#openMsg');
      return overlay && overlay.style.display === 'none' && notice &&
        notice.textContent.includes('הנתונים נטענו מחדש');
    });
    card = conflictPage.locator('#openList .g', { hasText:'הופעה בפארק' });
    await card.getByRole('button', { name:'ערוך' }).click();
    await conflictPage.locator('#eTitle').fill('ניסיון עדכני');
    await conflictPage.locator('#dlgSave').click();
    await conflictPage.waitForFunction(() => (window.__CALLABLE_CALLS || [])
      .filter(call => call.name === 'manageScheduleGuard').length === 2);
    const calls = await conflictPage.evaluate(() => window.__CALLABLE_CALLS || []);
    const edits = managementCalls(calls);
    assert.equal(edits[0].payload.expected_revision, 0);
    assert.equal(edits[1].payload.expected_revision, 1,
      'the retry uses the revision obtained from the required reload');
    assert.equal(edits[1].payload.details.title, 'ניסיון עדכני');
  });
  await conflict.close();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log('Guard manager browser checks passed: ' + passed);
