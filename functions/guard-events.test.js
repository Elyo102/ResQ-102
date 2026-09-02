'use strict';

// =====================================================================
//  בדיקות יחידה · guard-events
//
//      node functions/guard-events.test.js
//
//  אין תלות חיצונית, אין רשת, אין Firebase.
// =====================================================================

const assert = require('node:assert/strict');
const ge = require('./guard-events');

const ST = 'eilat_102';
const OTHER = 'station_777';
const ME = 'uid-me';
const MATE = 'uid-mate';
const GONE = 'uid-left-the-station';

const DATES = ['2026-09-01', '2026-09-02', '2026-09-03'];

let pass = 0;
function ok(label, fn) { fn(); pass++; console.log('✓ ' + label); }

// מסמך אבטחה מלא — **כולל כל השדות הרגישים**, כי בדיקת דליפה
// על מסמך נקי אינה בודקת כלום.
function guard(extra) {
  return Object.assign({
    id: 'g_0001',
    date: '2026-09-01',
    title: 'אבטחת אירוע עירוני',
    start: '18:00',
    end: '23:00',
    status: 'staffed',
    assigned: [ME, MATE],
    // כל מה שמכאן ומטה אסור לצאת
    notes: 'להביא אלונקה. יוסי ביקש לא לשבץ אותו עם דני.',
    place: 'טיילת צפון, מול מלון הים',
    signups: [ME, MATE, GONE],
    need_quals: ['q_driver', 'q_paramedic'],
    by_uid: 'uid-commander',
    by_name: 'רס"ב כהן',
    kind: 'אבטחת המונים',
    slots: 4,
    created_at: '2026-08-20T10:00:00Z',
    updated_at: '2026-08-29T14:22:11Z'
  }, extra || {});
}

const ROSTER = [
  { uid: ME, is_active: true },
  { uid: MATE, is_active: true },
  { uid: GONE, is_active: false }
];

function station(extra, over) {
  return ge.stationGuardEvents(Object.assign({
    guards: [guard(extra)], dates: DATES, roster: ROSTER, station_id: ST
  }, over || {}));
}

function personal(extra, over) {
  return ge.personalGuardEvents(Object.assign({
    guards: [guard(extra)], dates: DATES, roster: ROSTER,
    viewer_uid: ME, station_id: ST
  }, over || {}));
}

// ---------------------------------------------------------------------
console.log('\n--- 1 · סידור תחנתי · ההיטל');
// ---------------------------------------------------------------------

ok('אבטחה תקינה יוצאת', function () {
  assert.equal(station().events.length, 1);
});

ok('בדיוק שבעה שדות, ולא אחד יותר', function () {
  const keys = Object.keys(station().events[0]).sort();
  assert.deepEqual(keys, ge.EVENT_FIELDS.slice().sort());
});

ok('המיפוי assigned → people מתבצע', function () {
  const e = station().events[0];
  assert.deepEqual(e.people, [ME, MATE].sort());
  assert.equal(e.assigned, undefined);
});

ok('הערכים עצמם נכונים', function () {
  const e = station().events[0];
  assert.equal(e.id, 'g_0001');
  assert.equal(e.date, '2026-09-01');
  assert.equal(e.title, 'אבטחת אירוע עירוני');
  assert.equal(e.start, '18:00');
  assert.equal(e.end, '23:00');
  assert.equal(e.status, 'staffed');
});

// ---------------------------------------------------------------------
console.log('\n--- 2 · דליפה · שמונה שדות שאסור שיצאו');
// ---------------------------------------------------------------------

const FORBIDDEN = [
  ['notes', 'להביא אלונקה'],
  ['place', 'טיילת צפון'],
  ['signups', GONE],
  ['need_quals', 'q_paramedic'],
  ['by_uid', 'uid-commander'],
  ['by_name', 'רס"ב כהן'],
  ['kind', 'אבטחת המונים'],
  ['created_at', '2026-08-20T10:00:00Z']
];

FORBIDDEN.forEach(function (pair) {
  ok(pair[0] + ' אינו יוצא · תחנתי', function () {
    const text = JSON.stringify(station().events);
    assert.equal(text.indexOf(pair[0]), -1, 'שם השדה ' + pair[0]);
    assert.equal(text.indexOf(pair[1]), -1, 'ערך השדה ' + pair[0]);
  });
  ok(pair[0] + ' אינו יוצא · אישי', function () {
    const text = JSON.stringify(personal().events);
    assert.equal(text.indexOf(pair[0]), -1, 'שם השדה ' + pair[0]);
    assert.equal(text.indexOf(pair[1]), -1, 'ערך השדה ' + pair[0]);
  });
});

ok('שדה חדש שיתווסף למסמך מחר אינו זולג', function () {
  const r = station({ secret_new_field_2027: 'סוד' });
  const text = JSON.stringify(r.events);
  assert.equal(text.indexOf('secret_new_field_2027'), -1);
  assert.equal(text.indexOf('סוד'), -1);
});

// ---------------------------------------------------------------------
console.log('\n--- 3 · מבוטלת');
// ---------------------------------------------------------------------

ok('אבטחה מבוטלת אינה יוצאת בסידור התחנתי', function () {
  const r = station({ status: 'cancelled' });
  assert.equal(r.events.length, 0);
  assert.equal(r.dropped.guard_cancelled, 1);
});

ok('אבטחה מבוטלת אינה יוצאת גם בסידור האישי', function () {
  assert.equal(personal({ status: 'cancelled' }).events.length, 0);
});

['open', 'staffed', 'done'].forEach(function (s) {
  ok('מצב ' + s + ' כן יוצא', function () {
    assert.equal(station({ status: s }).events.length, 1);
  });
});

ok('מצב שאינו ברשימה הסגורה נופל', function () {
  const r = station({ status: 'archived' });
  assert.equal(r.events.length, 0);
  assert.equal(r.dropped.guard_status_invalid, 1);
});

// ---------------------------------------------------------------------
console.log('\n--- 4 · משובצים · פעילים בלבד');
// ---------------------------------------------------------------------

ok('משובץ לא פעיל אינו מופיע, והאירוע כן', function () {
  const r = station({ assigned: [ME, GONE] });
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.events[0].people, [ME]);
  assert.equal(r.dropped.assignee_not_active, 1);
});

ok('משובץ שאינו בסגל כלל אינו מופיע', function () {
  const r = station({ assigned: [ME, 'uid-from-another-station'] });
  assert.deepEqual(r.events[0].people, [ME]);
  assert.equal(r.dropped.assignee_not_active, 1);
});

ok('מזהה של מי שאינו פעיל אינו יוצא בשום צורה', function () {
  const text = JSON.stringify(station({ assigned: [ME, GONE] }));
  assert.equal(text.indexOf(GONE), -1);
});

ok('אבטחה בלי אף משובץ פעיל יוצאת עם people ריק', function () {
  const r = station({ assigned: [GONE] });
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.events[0].people, []);
});

ok('assigned חסר נחשב ריק ואינו מפיל', function () {
  const g = guard(); delete g.assigned;
  const r = ge.stationGuardEvents({ guards: [g], dates: DATES, roster: ROSTER });
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.events[0].people, []);
});

ok('assigned שאינו מערך מפיל את האירוע', function () {
  const r = station({ assigned: 'uid-me' });
  assert.equal(r.events.length, 0);
  assert.equal(r.dropped.guard_assigned_invalid, 1);
});

ok('UID פגום בתוך assigned מפיל רק את האירוע הפגום', function () {
  const r = ge.stationGuardEvents({
    guards: [guard({ id: 'g_good' }), guard({ id: 'g_bad', assigned: [ME, 'uid/bad'] })],
    dates: DATES, roster: ROSTER, station_id: ST
  });
  assert.deepEqual(r.events.map(function (event) { return event.id; }), ['g_good']);
  assert.equal(r.dropped.guard_assigned_invalid, 1);
});

ok('UID של Firebase עם נקודה נשמר בסידור, ו-slash או control נחסמים', function () {
  const dotted = 'dot.user';
  const roster = [{ uid: dotted, active: true }];
  const shared = { guards: [guard({ assigned: [dotted] })], dates: DATES, roster: roster, station_id: ST };
  assert.deepEqual(ge.stationGuardEvents(shared).events[0].people, [dotted]);
  assert.deepEqual(ge.personalGuardEvents(Object.assign({}, shared, { viewer_uid: dotted })).events[0].people,
    [dotted]);
  for (const malformed of ['dot/user', 'dot\u0001user']) {
    const result = ge.stationGuardEvents(Object.assign({}, shared, {
      guards: [guard({ assigned: [malformed] })]
    }));
    assert.equal(result.events.length, 0);
    assert.equal(result.dropped.guard_assigned_invalid, 1);
  }
});

ok('כפילות ב-assigned אינה מוכפלת ב-people', function () {
  assert.deepEqual(station({ assigned: [ME, ME, MATE] }).events[0].people, [ME, MATE].sort());
});

ok('רשומת סגל כמחרוזת מתקבלת', function () {
  const r = ge.stationGuardEvents({
    guards: [guard()], dates: DATES, roster: [ME, MATE]
  });
  assert.deepEqual(r.events[0].people, [ME, MATE].sort());
});

// ---------------------------------------------------------------------
console.log('\n--- 5 · תאריכים ושעות');
// ---------------------------------------------------------------------

ok('תאריך מחוץ לטווח המבוקש נופל', function () {
  const r = station({ date: '2026-09-09' });
  assert.equal(r.events.length, 0);
  assert.equal(r.dropped.guard_date_out_of_range, 1);
});

['2026-13-01', '2026-02-30', '2026-00-10', '26-09-01', '2026-9-1', '', 'מחר'].forEach(function (d, i) {
  ok('תאריך פסול #' + (i + 1) + ' נופל', function () {
    const r = station({ date: d });
    assert.equal(r.events.length, 0);
    assert.ok(r.dropped.guard_date_invalid || r.dropped.guard_date_out_of_range);
  });
});

ok('29 בפברואר בשנה מעוברת תקין', function () {
  const r = ge.stationGuardEvents({
    guards: [guard({ date: '2028-02-29' })], dates: ['2028-02-29'], roster: ROSTER
  });
  assert.equal(r.events.length, 1);
});

ok('29 בפברואר בשנה שאינה מעוברת נופל', function () {
  const r = ge.stationGuardEvents({
    guards: [guard({ date: '2027-02-29' })], dates: ['2027-02-28'], roster: ROSTER
  });
  assert.equal(r.events.length, 0);
});

// זו הבדיקה שמונעת מהמודול למחוק מהסידור בדיוק את המשמרות
// שהכי חשוב שיופיעו בו.
ok('אבטחת לילה 22:00–06:00 אינה נפסלת', function () {
  const r = station({ start: '22:00', end: '06:00' });
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].start, '22:00');
  assert.equal(r.events[0].end, '06:00');
});

ok('שעות חסרות מפילות את האירוע', function () {
  const g = guard(); delete g.start; delete g.end;
  const r = ge.stationGuardEvents({ guards: [g], dates: DATES, roster: ROSTER });
  assert.equal(r.events.length, 0);
  assert.equal(r.dropped.guard_time_invalid, 1);
});

['24:00', '18:60', '8:00', '1800', 'שש בערב', '18:00:00'].forEach(function (t, i) {
  ok('שעה פסולה #' + (i + 1) + ' מפילה את האירוע', function () {
    const r = station({ start: t });
    assert.equal(r.events.length, 0);
    assert.equal(r.dropped.guard_time_invalid, 1);
  });
});

// ---------------------------------------------------------------------
console.log('\n--- 6 · מזהה וכותרת');
// ---------------------------------------------------------------------

ok('מזהה ריק מפיל', function () {
  assert.equal(station({ id: '' }).events.length, 0);
});

ok('מזהה עם לוכסן מפיל', function () {
  assert.equal(station({ id: 'a/b' }).events.length, 0);
});

ok('מזהה שאינו מחרוזת מפיל', function () {
  assert.equal(station({ id: 7 }).events.length, 0);
});

ok('מזהה קצר מדי ומזהה ארוך מדי מפילים', function () {
  const short = station({ id: 'x' });
  const long = station({ id: 'g'.repeat(121) });
  assert.equal(short.events.length, 0);
  assert.equal(long.events.length, 0);
  assert.equal(short.dropped.guard_id_invalid, 1);
  assert.equal(long.dropped.guard_id_invalid, 1);
});

ok('כותרת ריקה מפילה', function () {
  const r = station({ title: '' });
  assert.equal(r.events.length, 0);
  assert.equal(r.dropped.guard_title_invalid, 1);
});

ok('כותרת מעל 80 תווים מפילה', function () {
  assert.equal(station({ title: 'א'.repeat(81) }).events.length, 0);
});

ok('כותרת באורך 80 בדיוק עוברת', function () {
  assert.equal(station({ title: 'א'.repeat(80) }).events.length, 1);
});

[0x0000, 0x001f, 0x007f, 0x200b, 0x2028, 0xfeff].forEach(function (code) {
  ok('תו בלתי נראה 0x' + code.toString(16) + ' בכותרת מפיל', function () {
    const bad = 'אבטחה' + String.fromCharCode(code) + 'רגילה';
    assert.equal(station({ title: bad }).events.length, 0);
  });
});

// ---------------------------------------------------------------------
console.log('\n--- 7 · תחנה');
// ---------------------------------------------------------------------

['stationId', 'station_id', 'station'].forEach(function (field) {
  ok('מסמך שנושא ' + field + ' של תחנה אחרת נופל', function () {
    const extra = {}; extra[field] = OTHER;
    const r = station(extra);
    assert.equal(r.events.length, 0);
    assert.equal(r.dropped.guard_station_mismatch, 1);
  });
  ok('מסמך שנושא ' + field + ' תואם עובר', function () {
    const extra = {}; extra[field] = ST;
    assert.equal(station(extra).events.length, 1);
  });
});

ok('בלי station_id בבקשה — אין בדיקת תחנה', function () {
  const r = ge.stationGuardEvents({
    guards: [guard({ stationId: OTHER })], dates: DATES, roster: ROSTER
  });
  assert.equal(r.events.length, 1);
});

ok('station_id פסול בבקשה חוסם הכול', function () {
  const r = station({}, { station_id: 'EILAT 102!' });
  assert.equal(r.events.length, 0);
  assert.equal(r.dropped.request_invalid, 1);
});

// ---------------------------------------------------------------------
console.log('\n--- 8 · סידור אישי · בלי עמיתים');
// ---------------------------------------------------------------------

ok('רואה אבטחה שהוא משובץ אליה', function () {
  assert.equal(personal().events.length, 1);
});

ok('people מכיל אותו בלבד — אין ולו עמית אחד', function () {
  const e = personal().events[0];
  assert.deepEqual(e.people, [ME]);
  assert.equal(JSON.stringify(e).indexOf(MATE), -1);
});

ok('אינו רואה אבטחה שאינו משובץ אליה', function () {
  const r = personal({ assigned: [MATE] });
  assert.equal(r.events.length, 0);
  assert.equal(r.dropped.not_mine, 1);
});

ok('צופה שאינו פעיל אינו רואה דבר', function () {
  const r = personal({}, { viewer_uid: GONE });
  assert.equal(r.events.length, 0);
  assert.equal(r.dropped.viewer_not_active, 1);
});

ok('צופה שאינו בסגל כלל אינו רואה דבר', function () {
  assert.equal(personal({}, { viewer_uid: 'uid-stranger' }).events.length, 0);
});

ok('צופה חסר אינו רואה דבר', function () {
  assert.equal(personal({}, { viewer_uid: '' }).events.length, 0);
});

ok('גם באישי יש בדיוק שבעה שדות', function () {
  assert.deepEqual(Object.keys(personal().events[0]).sort(), ge.EVENT_FIELDS.slice().sort());
});

// ---------------------------------------------------------------------
console.log('\n--- 9 · קלט פגום · אינו זורק');
// ---------------------------------------------------------------------

[undefined, null, {}, [], 'x', 7].forEach(function (bad, i) {
  ok('קלט פגום #' + (i + 1) + ' · תחנתי · מוחזר ריק', function () {
    const r = ge.stationGuardEvents(bad);
    assert.deepEqual(r.events, []);
  });
  ok('קלט פגום #' + (i + 1) + ' · אישי · מוחזר ריק', function () {
    assert.deepEqual(ge.personalGuardEvents(bad).events, []);
  });
});

ok('רשימת תאריכים ריקה חוסמת', function () {
  const r = station({}, { dates: [] });
  assert.equal(r.events.length, 0);
  assert.equal(r.dropped.dates_invalid, 1);
});

ok('תאריך פסול ברשימה המבוקשת חוסם הכול', function () {
  assert.equal(station({}, { dates: ['2026-09-01', 'מחר'] }).dropped.dates_invalid, 1);
});

ok('אבטחה שאינה עצם נספרת ואינה מפילה את השאר', function () {
  const r = ge.stationGuardEvents({
    guards: ['לא מסמך', guard()], dates: DATES, roster: ROSTER
  });
  assert.equal(r.events.length, 1);
  assert.equal(r.dropped.guard_malformed, 1);
});

ok('כל סיבת נפילה היא מהרשימה הסגורה', function () {
  const cases = [
    station(), station({ status: 'cancelled' }), station({ date: 'x' }),
    station({ title: '' }), station({ start: '99:99' }), station({ id: '' }),
    station({ assigned: 'x' }), station({ stationId: OTHER }),
    personal({ assigned: [MATE] }), personal({}, { viewer_uid: GONE }),
    station({}, { dates: [] }), ge.stationGuardEvents(null)
  ];
  cases.forEach(function (r) {
    Object.keys(r.dropped).forEach(function (code) {
      assert.ok(ge.DROP_CODES.includes(code), code);
    });
  });
});

// ---------------------------------------------------------------------
console.log('\n--- 10 · טוהר');
// ---------------------------------------------------------------------

ok('הקלט אינו משתנה', function () {
  const guards = [guard()];
  const before = JSON.stringify(guards);
  ge.stationGuardEvents({ guards: guards, dates: DATES, roster: ROSTER, station_id: ST });
  ge.personalGuardEvents({ guards: guards, dates: DATES, roster: ROSTER, viewer_uid: ME });
  assert.equal(JSON.stringify(guards), before);
});

ok('הפלט קפוא בכל הרמות', function () {
  const r = station();
  assert.ok(Object.isFrozen(r));
  assert.ok(Object.isFrozen(r.events));
  assert.ok(Object.isFrozen(r.events[0]));
  assert.ok(Object.isFrozen(r.events[0].people));
  assert.ok(Object.isFrozen(r.dropped));
});

ok('שתי קריאות זהות מחזירות אותו דבר בדיוק', function () {
  assert.equal(JSON.stringify(station()), JSON.stringify(station()));
});

ok('הסדר יציב לפי תאריך, שעה ומזהה', function () {
  const r = ge.stationGuardEvents({
    guards: [
      guard({ id: 'g_c', date: '2026-09-02', start: '08:00' }),
      guard({ id: 'g_a', date: '2026-09-01', start: '20:00' }),
      guard({ id: 'g_b', date: '2026-09-01', start: '06:00' })
    ],
    dates: DATES, roster: ROSTER
  });
  assert.deepEqual(r.events.map(function (e) { return e.id; }), ['g_b', 'g_a', 'g_c']);
});

console.log('\n============================================');
console.log('  עברו ' + pass);
console.log('============================================');
