'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contract = require('./station-provision-contract');

let passed = 0;
const failed = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { failed.push(name + ' :: ' + (e && e.message)); }
}

/* assert.throws matches the MESSAGE; our contract carries the reason in
 * error.code. Match the code, so a reworded Hebrew message never silently
 * turns an assertion into a pass. */
function throwsCode(fn, code, hint) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof contract.StationProvisionError, 'not a StationProvisionError: ' + e);
    assert.equal(e.code, code, (hint || '') + ' code=' + e.code + ' expected=' + code);
    return true;
  }, hint);
}

const OK = Object.freeze({
  request_id: 'prov_20260915_0001',
  station_id: 'shahmon',
  district_id: 'south',
  display_name: 'תחנת שחמון',
  timezone: 'Asia/Jerusalem',
  template_id: 'fire-station-v1',
  actor_uid: 'uid-super-1'
});
const withInput = (over) => Object.assign({}, OK, over || {});
const withoutKey = (key) => {
  const copy = Object.assign({}, OK);
  delete copy[key];
  return copy;
};

/* ------------------------------------------------ מצב ההקמה עצמו */

test('P1 · תחנה נולדת provisioning ומושתקת', () => {
  const plan = contract.planStationProvision(OK);
  assert.equal(plan.station_doc.status, 'provisioning');
  assert.equal(plan.station_doc.silent, true);
});

test('P2 · ארבעה זרעים, כולם של התחנה הזאת בלבד', () => {
  const plan = contract.planStationProvision(OK);
  assert.deepEqual(plan.seeds.map((s) => s.kind).sort(),
    ['backup_registration', 'health_inventory', 'hr_config', 'schedule_policy']);
  for (const seed of plan.seeds) {
    const text = JSON.stringify(seed);
    assert.equal(text.includes('eilat'), false, 'זרע מכיל תחנה אחרת');
    assert.equal(text.includes('timna'), false, 'זרע מכיל תחנה אחרת');
  }
});

test('P3 · מדיניות ריקה אך מוצהרת — max_shifts_per_month קיים כמפתח', () => {
  const plan = contract.planStationProvision(OK);
  const policy = plan.seeds.find((s) => s.kind === 'schedule_policy').value;
  assert.equal(Object.prototype.hasOwnProperty.call(policy, 'max_shifts_per_month'), true,
    'מפתח חסר יגרום ל-policy-limit-missing במנוע — מדיניות ריקה הופכת לחסם');
  assert.equal(policy.max_shifts_per_month, null);
  assert.deepEqual(policy.sub_stations, {});
});

test('P4 · אותו קלט → אותה טביעת אצבע', () => {
  assert.equal(contract.planStationProvision(OK).fingerprint,
    contract.planStationProvision(withInput({})).fingerprint);
});

test('P5 · שינוי כל שדה משנה את טביעת האצבע', () => {
  const base = contract.planStationProvision(OK).fingerprint;
  const variants = [
    withInput({ display_name: 'תחנת שחמון ב' }),
    withInput({ timezone: 'Asia/Nicosia' }),
    withInput({ district_id: 'north' }),
    withInput({ actor_uid: 'uid-super-2' }),
    withInput({ station_id: 'timna' }),
    withInput({ request_id: 'prov_20260915_0002' })
  ];
  for (const v of variants) {
    assert.notEqual(contract.planStationProvision(v).fingerprint, base,
      'שדה שאינו נכנס לטביעת האצבע: ' + JSON.stringify(v));
  }
});

test('P6 · כוונת ההזמנה הראשונה נושאת היקף בלבד — אין סוד ואין מידע אישי', () => {
  const intent = contract.planStationProvision(OK).first_admin_invitation_intent;
  assert.deepEqual(Object.keys(intent).sort(),
    ['district_id', 'issued_by', 'provision_request_id', 'role', 'station_id']);
  const text = JSON.stringify(intent).toLowerCase();
  for (const word of ['secret', 'token', 'hash', 'email', 'phone', 'password']) {
    assert.equal(text.includes(word), false, 'כוונת ההזמנה מכילה ' + word);
  }
});

test('P7 · הפלט קפוא — אי אפשר לשנות אותו אחרי החזרה', () => {
  const plan = contract.planStationProvision(OK);
  assert.equal(Object.isFrozen(plan), true, 'התוכנית עצמה אינה קפואה');
  assert.equal(Object.isFrozen(plan.station_doc), true);
  assert.equal(Object.isFrozen(plan.seeds), true);
  assert.equal(Object.isFrozen(plan.first_admin_invitation_intent), true);
  assert.throws(() => { plan.fingerprint = 'x'; }, TypeError);
  assert.throws(() => { plan.station_doc.silent = false; }, TypeError);
  assert.equal(plan.station_doc.silent, true);
});

/* ------------------------------------------------ השתקה */

test('S1 · ארגוני OR תחנתי — טבלת אמת מלאה', () => {
  const e = contract.effectiveStationSilence;
  assert.deepEqual({ ...e(false, false) }, { silent: false, reason: null });
  assert.deepEqual({ ...e(false, true) }, { silent: true, reason: 'station' });
  assert.deepEqual({ ...e(true, false) }, { silent: true, reason: 'global' });
  assert.deepEqual({ ...e(true, true) }, { silent: true, reason: 'global+station' });
});

test('S2 · תחנה לעולם לא עוקפת השתקה ארגונית', () => {
  assert.equal(contract.effectiveStationSilence(true, false).silent, true);
  assert.equal(contract.effectiveStationSilence(true, undefined).silent, true);
  assert.equal(contract.effectiveStationSilence(true, null).silent, true);
  assert.equal(contract.effectiveStationSilence(true, 0).silent, true);
});

test('S3 · רק true אמיתי משתיק', () => {
  for (const notTrue of ['true', 1, {}, [], 'yes']) {
    assert.equal(contract.effectiveStationSilence(false, notTrue).silent, false,
      String(notTrue) + ' התקבל כהשתקה');
    assert.equal(contract.effectiveStationSilence(notTrue, false).silent, false);
  }
});

/* ------------------------------------------------ קלט שחייב להיכשל */

test('N1 · תבנית לא מוכרת נדחית', () => {
  throwsCode(() => contract.planStationProvision(withInput({ template_id: 'whatever' })), 'template-unknown');
  throwsCode(() => contract.templateFor('fire-station-v2'), 'template-unknown');
});

test('N2 · מזהי תחנה ומחוז פסולים נדחים', () => {
  for (const bad of ['', 'A', 'Eilat', 'a', '-x', 'x'.repeat(65), 'a/b', 'a b']) {
    throwsCode(() => contract.planStationProvision(withInput({ station_id: bad })),
      'station-id', 'התקבל station_id: ' + JSON.stringify(bad));
  }
  throwsCode(() => contract.planStationProvision(withInput({ district_id: 'South' })), 'district-id');
});

test('N3 · שדה עודף בקלט נדחה — כולל status ו-silent', () => {
  for (const extra of [
    { status: 'ready' }, { silent: false }, { schedule_policy: { max_shifts_per_month: 4 } },
    { created_at: 123 }, { hr_config: {} }, { copy_from_station: 'eilat' }
  ]) {
    throwsCode(() => contract.planStationProvision(withInput(extra)),
      'input-shape', 'התקבל שדה עודף: ' + Object.keys(extra)[0]);
  }
});

test('N4 · שדה חסר נדחה', () => {
  for (const key of ['request_id', 'station_id', 'district_id', 'display_name',
    'timezone', 'template_id', 'actor_uid']) {
    throwsCode(() => contract.planStationProvision(withoutKey(key)), 'input-shape',
      'התקבל קלט בלי ' + key);
  }
});

test('N5 · שם תחנה עם תווי בקרה או כיווניות נדחה', () => {
  for (const bad of ['תחנה\u0000', 'תחנה‎', 'תחנה‮', '   ', '', 'x'.repeat(121)]) {
    throwsCode(() => contract.planStationProvision(withInput({ display_name: bad })),
      'display-name', 'התקבל שם: ' + JSON.stringify(bad));
  }
});

test('N6 · request_id ואזור זמן פסולים נדחים', () => {
  for (const bad of ['short', '', 'x'.repeat(121), 'has space', 'has/slash']) {
    throwsCode(() => contract.planStationProvision(withInput({ request_id: bad })), 'request-id');
  }
  for (const bad of ['', 'Jerusalem', 'Asia//Jerusalem', 'x'.repeat(70), '../etc']) {
    throwsCode(() => contract.planStationProvision(withInput({ timezone: bad })), 'timezone');
  }
});

test('N7 · actor_uid פסול נדחה', () => {
  for (const bad of ['', 'uid with space', 'x'.repeat(129), 'uid/slash']) {
    throwsCode(() => contract.planStationProvision(withInput({ actor_uid: bad })), 'actor-uid');
  }
});

test('N8 · קלט שאינו עצם נדחה', () => {
  for (const bad of [null, undefined, 'x', 7, [], [OK]]) {
    throwsCode(() => contract.planStationProvision(bad), 'input-shape');
  }
});

/* ------------------------------------------------ ניסיון חוזר */

test('R1 · אותה כוונה מזוהה ככוונה אחת', () => {
  assert.equal(contract.sameProvisionIntent(
    contract.planStationProvision(OK), contract.planStationProvision(OK)), true);
});

test('R2 · אותו request_id עם תוכן אחר אינו אותה כוונה', () => {
  const a = contract.planStationProvision(OK);
  const b = contract.planStationProvision(withInput({ display_name: 'תחנה אחרת' }));
  assert.equal(a.request_id, b.request_id);
  assert.equal(contract.sameProvisionIntent(a, b), false);
});

test('R3 · טביעת אצבע פסולה אינה מזוהה ככוונה', () => {
  const a = contract.planStationProvision(OK);
  for (const bad of [{ request_id: a.request_id, fingerprint: 'abc' },
    { request_id: a.request_id, fingerprint: null },
    { request_id: a.request_id }, null, 'x']) {
    assert.equal(contract.sameProvisionIntent(a, bad), false);
  }
});

/* ------------------------------------------------ מוכנות */

test('D1 · שש הבדיקות נדרשות, ומסמך שנוצר אינו מוכנות', () => {
  assert.deepEqual([...contract.READINESS_CHECKS].sort(), [
    'backup_registered', 'first_admin_active', 'health_inventory_registered',
    'hr_config_seeded', 'silence_wired', 'station_document'
  ]);
  const only = contract.evaluateReadiness({ station_document: true });
  assert.equal(only.ready, false);
  assert.equal(only.next_status, 'provisioning');
  assert.equal(only.unmet.length, 5);
});

test('D2 · כל הבדיקות מסומנות → ready', () => {
  const state = {};
  for (const c of contract.READINESS_CHECKS) state[c] = true;
  const out = contract.evaluateReadiness(state);
  assert.equal(out.ready, true);
  assert.equal(out.unmet.length, 0);
  assert.equal(out.next_status, 'ready');
});

test('D3 · ערך אמיתי-למראה שאינו true אינו מוכנות, והחסר נקוב בשמו', () => {
  for (const truthy of ['true', 1, {}, 'yes']) {
    const state = {};
    for (const c of contract.READINESS_CHECKS) state[c] = true;
    state.silence_wired = truthy;
    const out = contract.evaluateReadiness(state);
    assert.equal(out.ready, false, String(truthy) + ' התקבל כמוכנות');
    assert.deepEqual([...out.unmet], ['silence_wired']);
  }
});

test('D4 · כל בדיקה חסרה נקובה בנפרד', () => {
  for (const missing of contract.READINESS_CHECKS) {
    const state = {};
    for (const c of contract.READINESS_CHECKS) state[c] = true;
    delete state[missing];
    assert.deepEqual([...contract.evaluateReadiness(state).unmet], [missing]);
  }
  throwsCode(() => contract.evaluateReadiness(null), 'readiness-shape');
});

/* ------------------------------------------------ טוהר מבני */

test('X1 · המודול אינו תלוי בשום דבר מלבד node:crypto', () => {
  const src = fs.readFileSync(path.join(__dirname, 'station-provision-contract.js'), 'utf8');
  const requires = [...src.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['node:crypto'],
    'המודול צירף תלות: ' + requires.join(', '));
  for (const banned of ['firebase', 'firestore', 'admin.', 'db.', 'Math.random', 'Date.now', 'new Date(']) {
    assert.equal(src.includes(banned), false, 'המודול מכיל ' + banned);
  }
});

test('X2 · אין בפלט שום שדה זמן — המודול חסר שעון', () => {
  const text = JSON.stringify(contract.planStationProvision(OK));
  for (const word of ['created_at', 'updated_at', 'timestamp', '_at_ms']) {
    assert.equal(text.includes(word), false, 'הפלט מכיל ' + word);
  }
});

test('P28 · catalogue remains inactive and HR seed uses live schema/document path', () => {
  const plan=contract.planStationProvision(OK);
  assert.equal(plan.station_doc.active,false);
  assert.equal(plan.station_doc.name,OK.display_name);
  const hr=plan.seeds.find(s=>s.kind==='hr_config');
  assert.equal(hr.path,'config/hr');
  assert.deepEqual(Object.keys(hr.value).sort(),['email','hour_limit','name','schema_version']);
  assert.equal(hr.value.hour_limit,null);
  for(const seed of plan.seeds)assert.equal(('stations/'+OK.station_id+'/'+seed.path).split('/').length%2,0);
});

console.log('station-provision-contract: ' + passed + ' tests passed'
  + (failed.length ? ', ' + failed.length + ' FAILED' : ''));
for (const f of failed) console.log('  FAIL ' + f);
if (failed.length) process.exit(1);
