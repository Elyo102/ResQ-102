/* ====================================================================
 *  fleet · מצב הצי — בדיקת יחידה למודול הטהור, ונעיצות מקור לצרכניו.
 *
 *  שתי הטענות שנשמרות כאן, וכל אחת מהן היא באג אמיתי אם תישבר:
 *
 *  1. **רכב בלי השדה `active` הוא פעיל.** כל רכב שקיים היום בתחנה
 *     נכתב לפני שהשדה נוסף. אם היעדר השדה ייקרא כ„מושבת", הצי כולו
 *     ייעלם מהמסך ברגע הפריסה — ומפקד משמרת יראה תחנה בלי רכבים.
 *  2. **ההסרה היא השבתה ולא מחיקה, וכל צרכן מסנן.** על רכב נכתבת
 *     היסטוריית תקלות בשם; צרכן ששכח לסנן מציג רכב שהוסר, וצרכן
 *     שמסנן בנקודת הקריאה של מסמך הלוח מוחק אותו בשמירה הבאה.
 *
 *  אין Firebase, אין רשת. יציאה 0 עבר · 1 נכשל.
 * ==================================================================== */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

import {
  FLEET_ROLES, managesFleet, isActiveVehicle, activeVehicles, inactiveVehicles,
  activeBoardVehicles, cleanField, vehicleEdit, deactivationPatch,
  reactivationPatch, applyToBoardVehicle, NAME_MAX, PLATE_MAX, atFor, boardStamp
} from '../fleet.js';
import { mergeFleet } from '../faults.js';
import { vehicleStats } from '../stats.js';
import { allSlots } from '../readiness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
function check(label, fn) { fn(); passed += 1; console.log('✓ ' + label); }

/* ---------- 1. פעיל / מושבת ---------- */

check('רכב בלי השדה active הוא פעיל — כל הרכבים שנכתבו לפני שהשדה נוסף', () => {
  assert.equal(isActiveVehicle({ id: 'v1', name: 'רכב' }), true);
  assert.equal(isActiveVehicle({ id: 'v1', active: true }), true);
  assert.equal(isActiveVehicle({ id: 'v1', active: undefined }), true);
  assert.equal(isActiveVehicle({ id: 'v1', active: null }), true);
  assert.equal(isActiveVehicle({ id: 'v1', active: 'false' }), true, 'מחרוזת אינה false');
  assert.equal(isActiveVehicle({ id: 'v1', active: 0 }), true, 'ערך שגוי אינו מסתיר רכב');
  assert.equal(isActiveVehicle({ id: 'v1', active: false }), false, 'רק false בדיוק');
  assert.equal(isActiveVehicle(null), false);
  assert.equal(isActiveVehicle(undefined), false);
});

check('activeVehicles / inactiveVehicles הן חלוקה מלאה, וקלט שאינו מערך אינו מפיל', () => {
  const list = [{ id: 'a' }, { id: 'b', active: false }, { id: 'c', active: true }, null];
  assert.deepEqual(activeVehicles(list).map(v => v.id), ['a', 'c']);
  assert.deepEqual(inactiveVehicles(list).map(v => v.id), ['b']);
  for (const bad of [null, undefined, 'x', 7, {}]) {
    assert.deepEqual(activeVehicles(bad), []);
    assert.deepEqual(inactiveVehicles(bad), []);
  }
  assert.deepEqual(activeBoardVehicles({ vehicles: list }).map(v => v.id), ['a', 'c']);
  assert.deepEqual(activeBoardVehicles(null), []);
  assert.deepEqual(activeBoardVehicles({}), []);
});

/* ---------- 2. מי מנהל את הצי ---------- */

check('הצי נערך בידי מפקד משמרת, סגן, מפקד תחנה ומנהל-על — ולא בידי רכזת כוח אדם', () => {
  assert.deepEqual(FLEET_ROLES.slice().sort(), ['commander', 'deputy', 'station_commander']);
  for (const role of FLEET_ROLES) {
    assert.equal(managesFleet({ role }), true, role);
  }
  assert.equal(managesFleet({ super: true }), true);
  assert.equal(managesFleet({ role: 'super_admin' }), false, 'role alone is not signed super authority');
  assert.equal(managesFleet({ email: 'fleet-manager@example.invalid' }), false, 'email never grants fleet authority');
  const emailUnread = new Proxy({ email: 'fleet-manager@example.invalid' }, {
    get(target, key, receiver) {
      assert.notEqual(key, 'email', 'fleet authority must not read any email address');
      return Reflect.get(target, key, receiver);
    }
  });
  assert.equal(managesFleet(emailUnread), false);
  // הקבוצה שנשארת בחוץ — וזו כל הפואנטה של השער הנפרד מ-staff
  for (const role of ['hr_coordinator', 'firefighter', 'team_leader',
                      'deputy_team_leader', 'district_commander', '']) {
    assert.equal(managesFleet({ role }), false, role);
  }
  assert.equal(managesFleet(null), false);
  assert.equal(managesFleet({}), false);
  assert.equal(managesFleet({ super: 'true' }), false, 'מחרוזת אינה claim');
});

/* ---------- 3. עריכה ---------- */

check('עריכה: שם ריק נחסם, מספר רישוי וייעוד רשאים להיות ריקים, והשדות נגזמים', () => {
  assert.deepEqual(vehicleEdit({ name: '   ' }), { ok: false, error: 'name-required', patch: null });
  assert.deepEqual(vehicleEdit({}), { ok: false, error: 'name-required', patch: null });
  assert.deepEqual(vehicleEdit(null), { ok: false, error: 'name-required', patch: null });

  const ok = vehicleEdit({ name: '  טרנזיט לבן  ', plate: ' 12-345-67 ' });
  assert.deepEqual(ok, { ok: true, error: '', patch: { name: 'טרנזיט לבן', plate: '12-345-67' } });
  assert.equal('role' in ok.patch, false, 'רכב לוגיסטי אינו מקבל שדה ייעוד');

  const withRole = vehicleEdit({ name: 'רכב סער', plate: '', role: ' כיבוי ' });
  assert.deepEqual(withRole.patch, { name: 'רכב סער', plate: '', role: 'כיבוי' });

  assert.equal(vehicleEdit({ name: 'א'.repeat(NAME_MAX + 40) }).patch.name.length, NAME_MAX);
  assert.equal(vehicleEdit({ name: 'ok', plate: '9'.repeat(PLATE_MAX + 40) }).patch.plate.length, PLATE_MAX);
  assert.equal(cleanField(undefined, 10), '');
  assert.equal(cleanField(12345, 3), '123');
});

check('העריכה אינה נוגעת ב-active: שינוי שם אינו מחזיר רכב מושבת לצי בטעות', () => {
  const patch = vehicleEdit({ name: 'שם חדש', plate: '' }).patch;
  assert.equal('active' in patch, false);
  assert.equal('deactivated_at' in patch, false);
});

/* ---------- 4. השבתה ושחזור ---------- */

check('השבתה מסמנת active:false עם מי ומתי; שחזור מנקה את השאריות', () => {
  const at = '2026-09-06T10:00:00.000Z';
  assert.deepEqual(deactivationPatch({ uid: 'u1', at }),
    { active: false, deactivated_at: at, deactivated_by: 'u1' });
  assert.deepEqual(deactivationPatch({}), { active: false, deactivated_at: null, deactivated_by: '' });
  assert.deepEqual(deactivationPatch(null), { active: false, deactivated_at: null, deactivated_by: '' });

  const back = reactivationPatch();
  assert.deepEqual(back, { active: true, deactivated_at: null, deactivated_by: '' });
  // אחרי שחזור הרכב פעיל שוב, ובלי שאריות שיטעו בפעם הבאה
  assert.equal(isActiveVehicle(Object.assign({ id: 'v' }, deactivationPatch({ uid: 'u', at }), back)), true);
});

check('atFor: מסמך מקבל חותמת שרת, מערך מקבל ISO — Firebase דוחה sentinel בתוך מערך', () => {
  const sentinel = { __sentinel: 'serverTimestamp' };
  assert.equal(atFor('anchor', sentinel), sentinel, 'רכב לוגיסטי הוא מסמך משלו');
  const inArray = atFor('fire', sentinel, Date.parse('2026-09-06T10:00:00.000Z'));
  assert.equal(typeof inArray, 'string');
  assert.equal(inArray, '2026-09-06T10:00:00.000Z');
  assert.equal(boardStamp(Date.parse('2026-09-06T10:00:00.000Z')), '2026-09-06T10:00:00.000Z');
  assert.equal(typeof boardStamp(), 'string');
  // ה-patch שנכנס למערך אינו נושא שום אובייקט — רק ערכים שמותר לכתוב שם
  const patch = deactivationPatch({ uid: 'u1', at: atFor('fire', sentinel) });
  for (const value of Object.values(patch)) {
    assert.notEqual(typeof value, 'object', 'אין אובייקט בתוך רכב שיושב במערך');
  }
});

check('applyToBoardVehicle מחזיר מערך חדש ואינו משנה את המקור — שמירה שנכשלה לא משאירה מסך שקרי', () => {
  const original = [{ id: 'v1', name: 'א', slots: [{ id: 's1' }] }, { id: 'v2', name: 'ב' }];
  const frozenName = original[0].name;
  const next = applyToBoardVehicle(original, 'v1', { name: 'חדש' });
  assert.notEqual(next, original);
  assert.equal(original[0].name, frozenName, 'המקור לא השתנה');
  assert.equal(next[0].name, 'חדש');
  assert.equal(next[1], original[1], 'רכב שלא נגעו בו נשאר אותו אובייקט');
  assert.deepEqual(next[0].slots, [{ id: 's1' }], 'המשבצות נשמרות בעריכת שם');

  // מזהה שאינו קיים — אף רכב לא משתנה, ואין קריסה
  assert.deepEqual(applyToBoardVehicle(original, 'nope', { name: 'x' }).map(v => v.name), ['א', 'ב']);
  assert.deepEqual(applyToBoardVehicle(null, 'v1', { name: 'x' }), []);
});

/* ---------- 5. הצרכנים ---------- */

check('mergeFleet מסנן מושבתים משני המקורות ונושא מספר רישוי', () => {
  const board = [
    { id: 'v1', name: 'רכב סער', role: 'כיבוי' },
    { id: 'v2', name: 'רכב ירד', role: 'חילוץ', active: false },
    { id: 'v3', name: 'רכב עם רישוי', role: '', plate: '55-555-55', active: true }
  ];
  const anchor = [
    { id: 'a1', name: 'טרנזיט', plate: '12-345-67' },
    { id: 'a2', name: 'עיגון ירד', plate: '98-765-43', active: false }
  ];
  const out = mergeFleet(board, anchor);
  assert.deepEqual(out.map(v => v.id), ['v1', 'v3', 'a1']);
  assert.deepEqual(out.map(v => v.kind), ['fire', 'fire', 'anchor']);
  assert.equal(out[1].plate, '55-555-55');
  assert.equal(out[2].plate, '12-345-67');
  assert.equal(out[2].managed, true, 'רכב עיגון הוא מסמך משלו');
  assert.equal(out[0].managed, false, 'רכב מבצעי הוא אובייקט בתוך מסמך הלוח');
  // רכב בלי מזהה אינו נכנס לצי — אי אפשר לתלות עליו תקלה
  assert.deepEqual(mergeFleet([{ name: 'בלי מזהה' }], []), []);
});

check('allSlots מדלג על משבצות של רכב מושבת — משבצת של רכב שאינו בצי אינה „חסרה"', () => {
  const board = {
    command: [{ id: 'c1', rank: 'מפקד משמרת', req: '' }],
    vehicles: [
      { id: 'v1', name: 'רכב א', slots: [{ id: 's11', job: 'נהג', req: '' }] },
      { id: 'v2', name: 'רכב ירד', active: false, slots: [{ id: 's21', job: 'כבאי', req: '' }] }
    ]
  };
  assert.deepEqual(allSlots(board).map(s => s.id), ['c1', 's11']);
  // שרשרת הפיקוד אינה מושפעת
  assert.equal(allSlots({ command: board.command, vehicles: [] }).length, 1);
});

/* ---------- 6. נעיצות מקור — שאף צרכן לא יישכח ---------- */

check('כל צרכן של config/board מסנן רכב מושבת', () => {
  const consumers = [
    ['faults.js', /v\.active !== false/],
    ['readiness.js', /v\.active === false\) return;/],
    ['board.html', /board\.vehicles\.filter\(function \(v\) \{ return !v \|\| v\.active !== false; \}\)/],
    ['attendance.html', /if \(!v \|\| v\.active === false\) return;/],
    ['functions/attendance-shadow-runner.js', /function activeBoard\(board\)/]
  ];
  for (const [file, re] of consumers) assert.match(read(file), re, file);
  // הצילום הלילי מקבל לוח **כבר מסונן** מה-runner, ולכן המודול הטהור
  // אינו מכיר את המושג: לולאות הרכבים שבו אינן בודקות active, ואסור
  // שיתחילו — סינון כפול הוא בדיוק המקום שבו שני הצדדים נפרדים.
  const shadow = read('functions/attendance-shadow.js');
  const loops = shadow.split('board.vehicles').slice(1)
    .map((chunk) => chunk.slice(0, 400));
  assert.ok(loops.length >= 2, 'שתי לולאות הרכבים במקומן');
  for (const loop of loops) {
    assert.equal(/\bv(ehicle)?\.active\b/.test(loop), false,
      'attendance-shadow.js אינו מסנן רכבים בעצמו — הסינון ב-runner');
  }
});

check('board.html שומר את מערך הרכבים שלם — סינון בקריאה היה מוחק מושבתים בשמירה', () => {
  const board = read('board.html');
  assert.match(board, /vehicles: Array\.isArray\(v\.vehicles\) \? v\.vehicles : \[\]/,
    'הקריאה מכניסה את המערך כפי שהוא');
  assert.match(board, /vehicles:\s*board\.vehicles, command:\s*board\.command/,
    'השמירה כותבת את המערך השלם');
  // הרינדור מסנן בנקודת השימוש
  assert.match(board, /const shown = board\.vehicles\.filter/);
  assert.match(board, /shown\.forEach\(function \(v\)/);
});

check('faults.html: הצי נערך רק בידי fleetManager, וההסרה היא השבתה ולא מחיקה', () => {
  const html = read('faults.html');
  assert.match(html, /CAN_FLEET = managesFleet\(/);
  assert.match(html, /if \(CAN_FLEET\) \$\('anchorCard'\)\.classList\.remove\('hide'\)/);
  assert.match(html, /if \(CAN_FLEET\) \{/, 'כפתור העריכה בשורת הרכב מותנה');
  // seq477 §5: החותמת עוברת דרך atFor — חותמת שרת למסמך, ISO למערך.
  assert.match(html, /deactivationPatch\(\{ uid: ME\.uid, at: atFor\(v\.kind, serverTimestamp\(\)\) \}\)/);
  assert.equal(/at: serverTimestamp\(\) \}\)/.test(html), false,
    'חותמת שרת לא נכנסת ישירות ל-patch של רכב — במערך היא נדחית');
  assert.match(html, /reactivationPatch\(\)/);
  // שום מחיקה של רכב, לא מהאוסף ולא מהמערך
  assert.equal(/deleteDoc\(doc\(db, 'stations', SID, 'vehicles'/.test(html), false,
    'רכב לא נמחק — ההיסטוריה נכתבה על שמו');
  assert.match(html, /<button class="btn" id="btnAnchor">הוסף רכב<\/button>/,
    'הכפתור אומר „הוסף רכב" ולא „הוסף רכב עיגון"');
  // מסמך הלוח נכתב עם ארבעת המפתחות שהכללים מתירים, ולא פחות
  const save = html.slice(html.indexOf('async function saveBoardVehicles'),
                          html.indexOf('async function saveVehicleEdit'));
  for (const key of ['vehicles:', 'command:', 'updated_at:', 'by:']) assert.ok(save.includes(key), key);
});

check('הכללים: fleetManager מוגדר, אינו כולל רכזת כוח אדם, ומחיקת רכב חסומה', () => {
  const rules = read('firestore.rules');
  const fn = rules.slice(rules.indexOf('function fleetManager(sid)'),
                         rules.indexOf('function fleetManager(sid)') + 400);
  assert.match(fn, /\['deputy', 'commander', 'station_commander'\]/);
  assert.equal(fn.includes('hr_coordinator'), false, 'רכזת כוח אדם אינה מנהלת צי');
  assert.equal(/\bemail\b/.test(fn), false, 'fleetManager must not grant authority by email');
  // אותה קבוצה בדיוק בשני הצדדים
  assert.deepEqual(FLEET_ROLES.slice().sort(), ['commander', 'deputy', 'station_commander']);

  const veh = rules.slice(rules.indexOf('match /vehicles/{vehicleId}'),
                          rules.indexOf('match /vehicles/{vehicleId}') + 300);
  assert.match(veh, /allow create, update: if fleetManager\(sid\)/);
  assert.match(veh, /allow delete: if false/);

  // מסמך הלוח: שינוי מערך הרכבים דורש fleetManager, שאר המסמך נשאר staff
  assert.match(rules, /fleetManager\(sid\)\s*\|\|\s*\(resource != null/);
  assert.match(rules, /request\.resource\.data\.get\('vehicles', \[\]\)\s*==\s*resource\.data\.get\('vehicles', \[\]\)/);
});

// Execute the real orchestration entry point until its planner boundary.
// No production DB, source-text extraction, or replacement of the filter.
{
  const require = createRequire(import.meta.url);
  const runner = require('../functions/attendance-shadow-runner.js');
  const engine = require('../functions/attendance-shadow.js');
  const canonical = {
    command:[{ id:'c1', rank:'commander' }],
    vehicles:[
      { id:'legacy', slots:[{ id:'s1' }] },
      { id:'live', active:true, slots:[{ id:'s2' }] },
      { id:'off', active:false, slots:[{ id:'s3' }] }
    ]
  };
  const before = JSON.stringify(canonical);
  const data = new Map([
    ['config/attendance_shadow_v41', { mode:'shadow', station_ids:['fleet_test'] }],
    ['stations/fleet_test/config/board', canonical],
    ['stations/fleet_test/shifts/A', { assign:{ s1:'u1', s3:'u3' } }]
  ]);
  const snap = ref => ({ id:ref.path.split('/').pop(), exists:data.has(ref.path),
    data:() => data.get(ref.path) });
  const collection = () => ({ where(){ return this; }, limit(){ return this; },
    get:async () => ({ docs:[], size:0, empty:true }) });
  const db = {
    doc(path){ const ref = { path, get:async () => snap(ref), collection }; return ref; },
    collection,
    runTransaction:async fn => fn({
      get:async ref => snap(ref),
      set(ref, value, options){
        data.set(ref.path, options && options.merge
          ? Object.assign({}, data.get(ref.path), value) : value);
      }
    })
  };
  let seen;
  const stopped = new Error('planner-boundary-reached');
  const service = runner.createAttendanceShadowService({
    db, admin:{ firestore:{ Timestamp:{ fromMillis:ms => new Date(ms) } } },
    now:() => new Date('2026-09-07T05:00:00Z'),
    engine:Object.assign({}, engine, {
      buildDailySnapshot(source){ seen = source; throw stopped; }
    })
  });
  await assert.rejects(service.runStation({ sid:'fleet_test', date:'2026-09-07' }),
    error => error === stopped);
  assert.deepEqual(seen.board.vehicles.map(v => v.id), ['legacy', 'live']);
  assert.deepEqual(seen.board.command, canonical.command);
  assert.equal(seen.shifts.A.assign.s3, 'u3', 'inactive assignments are not erased');
  assert.equal(JSON.stringify(canonical), before, 'stored canonical board remains intact');
  passed += 1;
  console.log('✓ real attendance shadow runner filters inactive vehicles before planner, preserving canonical data');
}

check('fleet authority never revives email or role-only super shortcuts', () => {
  for (const file of ['board.html', 'faults.html']) {
    assert.equal(/SUPER_ADMIN|role\s*===?\s*['"]super_admin['"]/.test(read(file)), false, file);
  }
  const rules = read('firestore.rules');
  const body = rules.slice(rules.indexOf('function isSuper()'), rules.indexOf('function isSuper()') + 180);
  assert.equal(/email|super_admin/.test(body), false);
});

check('history opt-in retains retired operational and logistics vehicles without changing operational defaults', () => {
  const board = [{ id:'live' }, { id:'retired', active:false }];
  const anchors = [{ id:'retired-anchor', active:false }];
  const before = JSON.stringify({ board, anchors });
  assert.deepEqual(mergeFleet(board, anchors).map(v => v.id), ['live']);
  const history = mergeFleet(board, anchors, { includeInactive:true });
  assert.deepEqual(history.map(v => [v.id, v.active]), [['live', true], ['retired', false], ['retired-anchor', false]]);
  const rows = vehicleStats(history, [{ vehicle_id:'retired', kind:'vehicle', status:'fixed',
    severity:'blocking', created_key:'2026-09-01T00:00:00Z', fixed_key:'2026-09-03T00:00:00Z' }], '2026-01-01');
  assert.equal(rows.find(v => v.id === 'retired').total, 1);
  assert.equal(rows.find(v => v.id === 'retired').downDays, 2);
  assert.equal(JSON.stringify({ board, anchors }), before);
});

// Run the actual service-worker install/activate/fetch handlers. Only static
// app assets are cached here; Google messaging is stubbed, not network-tested.
{
  const handlers = {}, saved = new Map(), deleted = [];
  const origin = 'https://offline-fleet.example.invalid';
  const key = value => new URL(typeof value === 'string' ? value : value.url, origin + '/').pathname;
  const context = vm.createContext({ URL, Response, console,
    fetch:async () => { throw new Error('offline'); },
    caches:{
      open:async () => ({
        add:async value => saved.set(key(value), new Response(fs.readFileSync(path.join(root, key(value).slice(1))))),
        put:async (request, response) => saved.set(key(request), response.clone())
      }),
      keys:async () => ['resq-vold-release1'],
      delete:async name => { deleted.push(name); return true; },
      match:async request => saved.get(key(request))?.clone()
    },
    self:{ location:{origin}, addEventListener:(event, fn) => { handlers[event] = fn; },
      skipWaiting:async()=>{}, clients:{claim:async()=>{}}, registration:{} },
    importScripts:()=>{}, firebase:{initializeApp(){}, messaging:()=>({onBackgroundMessage(){}})}
  });
  vm.runInContext(read('firebase-messaging-sw.js'), context);
  for (const event of ['install','activate']) {
    let pending;
    handlers[event]({ waitUntil:p => { pending = p; } });
    await pending;
  }
  assert.deepEqual(deleted, ['resq-vold-release1']);
  for (const file of ['board.html', 'faults.html', 'fleet.js?v=42h12']) {
    let pending;
    handlers.fetch({ request:{ method:'GET',url:origin+'/'+file,mode:file.endsWith('.html')?'navigate':'cors' },
      respondWith:p => { pending = p; } });
    const response = await pending;
    assert.equal(response.status, 200, file + ' available before first online visit');
    assert.equal((await response.text()).replace(/\r\n/g,'\n'), read(file.split('?')[0]));
  }
  passed += 1;
  console.log('✓ real worker lifecycle caches fleet module before offline board/faults startup');
}

console.log('\n' + passed + ' fleet checks passed (pure module + source pins + runner + worker).');
