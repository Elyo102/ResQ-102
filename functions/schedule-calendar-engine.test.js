'use strict';

const assert = require('assert');
const { createCalendarEngine, CalendarError, REASON } = require('./schedule-calendar-engine.js');

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass += 1; }
  catch (e) { fails.push(name + ' → ' + (e && e.message)); }
}
function throwsCode(fn, code) {
  try { fn(); }
  catch (e) {
    assert.ok(e instanceof CalendarError, 'סוג שגיאה לא צפוי: ' + e.name + ' ' + e.message);
    assert.strictEqual(e.code, code, 'קוד ' + e.code + ' במקום ' + code);
    return;
  }
  throw new Error('לא נזרקה שגיאה, ציפיתי ל-' + code);
}

const CLOCK = () => '2026-09-01T06:00:00.000Z';
const V = 'v1';
const ST = '102';

function policy(over) {
  return Object.assign({
    station_id: ST,
    version: V,
    sub_stations: {
      eilat: {
        label: 'אילת',
        minimum: 7,
        requirements: [
          { role: 'shift_lead', label: 'ראש משמרת', count: 1, required: true },
          { role: 'team_cmd', label: 'מפקד צוות', count: 2, required: true },
          { role: 'driver', label: 'נהג', count: 2, required: true },
          { role: 'firefighter', label: 'לוחם', count: 2, required: false }
        ]
      },
      timna: {
        label: 'תמנע',
        minimum: 2,
        requirements: [
          { role: 'driver', label: 'נהג', count: 1, required: true },
          { role: 'firefighter', label: 'לוחם', count: 1, required: true }
        ]
      }
    },
    rest: { min_gap_days: 1 },
    rotation: null,
    max_shifts_per_month: null
  }, over || {});
}

function mk(over) {
  return createCalendarEngine({ clock: CLOCK, policy: policy(over) });
}

function person(id, sub, roles, over) {
  return Object.assign({
    id, station_id: ST, sub_station: sub, active: true, roles,
    source_snapshot: 'snap_1', source_version: V
  }, over || {});
}

function roster() {
  const out = [];
  for (let i = 1; i <= 4; i += 1) out.push(person('L' + i, 'eilat', ['shift_lead', 'firefighter']));
  for (let i = 1; i <= 8; i += 1) out.push(person('C' + i, 'eilat', ['team_cmd', 'firefighter']));
  for (let i = 1; i <= 8; i += 1) out.push(person('D' + i, 'eilat', ['driver', 'firefighter']));
  for (let i = 1; i <= 8; i += 1) out.push(person('F' + i, 'eilat', ['firefighter']));
  for (let i = 1; i <= 4; i += 1) out.push(person('TD' + i, 'timna', ['driver', 'firefighter']));
  for (let i = 1; i <= 4; i += 1) out.push(person('TF' + i, 'timna', ['firefighter']));
  return out;
}

const BASE = {
  station_id: ST, source_snapshot: 'snap_1', source_version: V,
  contract_station_id: ST, source_revision: V, source_digest: 'digest_snap_1',
  policy_digest: V, source_complete: true,
  availability: {}, locked: {}, carry: {}
};
function run(engine, over) {
  return engine.planPeriod(Object.assign({}, BASE, { days: ['2026-09-01'], roster: roster() }, over || {}));
}

/* ================= 1. אין ברירות מחדל שקטות ================= */

t('בלי clock — סירוב', () =>
  throwsCode(() => createCalendarEngine({ policy: policy() }), 'clock-required'));
t('בלי מדיניות — סירוב', () =>
  throwsCode(() => createCalendarEngine({ clock: CLOCK }), 'policy-required'));
t('מדיניות בלי station_id — סירוב', () => {
  const p = policy(); delete p.station_id;
  throwsCode(() => createCalendarEngine({ clock: CLOCK, policy: p }), 'policy-station');
});
t('מדיניות בלי גרסה — סירוב', () => {
  const p = policy(); delete p.version;
  throwsCode(() => createCalendarEngine({ clock: CLOCK, policy: p }), 'policy-version');
});
t('בלי תחנות קצה — סירוב', () =>
  throwsCode(() => createCalendarEngine({ clock: CLOCK, policy: policy({ sub_stations: {} }) }), 'policy-sub-stations'));
t('תחנת קצה בלי קו מינימום — סירוב', () => {
  const p = policy(); delete p.sub_stations.eilat.minimum;
  throwsCode(() => createCalendarEngine({ clock: CLOCK, policy: p }), 'sub-station-minimum');
});
t('תחנת קצה בלי דרישות — סירוב', () => {
  const p = policy(); p.sub_stations.eilat.requirements = [];
  throwsCode(() => createCalendarEngine({ clock: CLOCK, policy: p }), 'sub-station-requirements');
});
t('דרישה בלי סימון חובה מפורש — סירוב', () => {
  const p = policy(); delete p.sub_stations.eilat.requirements[0].required;
  throwsCode(() => createCalendarEngine({ clock: CLOCK, policy: p }), 'requirement-required');
});
t('תפקיד כפול בתחנת קצה — סירוב', () => {
  const p = policy();
  p.sub_stations.eilat.requirements.push({ role: 'driver', count: 1, required: true });
  throwsCode(() => createCalendarEngine({ clock: CLOCK, policy: p }), 'requirement-duplicate');
});
t('בלי min_gap_days — סירוב', () => {
  const p = policy(); delete p.rest;
  throwsCode(() => createCalendarEngine({ clock: CLOCK, policy: p }), 'policy-rest');
});
t('בלי הצהרת מחזוריות — סירוב', () => {
  const p = policy(); delete p.rotation;
  throwsCode(() => createCalendarEngine({ clock: CLOCK, policy: p }), 'policy-rotation-missing');
});
t('מחזוריות null מפורשת — מתקבלת', () => { assert.ok(mk()); });
t('בלי הצהרת תקרת משמרות — סירוב', () => {
  const p = policy(); delete p.max_shifts_per_month;
  throwsCode(() => createCalendarEngine({ clock: CLOCK, policy: p }), 'policy-limit-missing');
});
t('מחזוריות בלי days_per_group — סירוב', () => {
  const p = policy({ rotation: { groups: ['א', 'ב'], anchor: '2026-09-01', strict: false } });
  throwsCode(() => createCalendarEngine({ clock: CLOCK, policy: p }), 'rotation-span');
});
t('מחזוריות בלי הצהרת strict — סירוב', () => {
  const p = policy({ rotation: { groups: ['א', 'ב'], anchor: '2026-09-01', days_per_group: 1 } });
  throwsCode(() => createCalendarEngine({ clock: CLOCK, policy: p }), 'rotation-strict');
});
t('קבוצה כפולה במחזוריות — סירוב', () => {
  const p = policy({ rotation: { groups: ['א', 'א'], anchor: '2026-09-01', days_per_group: 1, strict: false } });
  throwsCode(() => createCalendarEngine({ clock: CLOCK, policy: p }), 'rotation-groups');
});
t('תכנון חודשי שאינו מתחיל בראש חודש — סירוב', () =>
  throwsCode(() => mk().planMonths(Object.assign({}, BASE, {
    months: 1, start: '2026-09-02', roster: roster() })), 'month-start-required'));

/* ================= 2. מקור אחד ================= */

t('בלי צילום מקור — סירוב', () =>
  throwsCode(() => mk().planPeriod({ station_id: ST, source_version: V, days: ['2026-09-01'], roster: roster() }), 'snapshot-required'));
t('בלי גרסת מקור — סירוב', () =>
  throwsCode(() => mk().planPeriod({ station_id: ST, source_snapshot: 's', days: ['2026-09-01'], roster: roster() }), 'version-required'));
t('בלי station_id בקלט — סירוב', () =>
  throwsCode(() => mk().planPeriod({ source_snapshot: 's', source_version: V, days: ['2026-09-01'], roster: roster() }), 'station-required'));
t('תחנה שאינה תחנת המדיניות — סירוב', () =>
  throwsCode(() => run(mk(), { station_id: '999' }), 'station-mismatch'));
t('גרסת מדיניות שאינה תואמת — סירוב', () =>
  throwsCode(() => run(mk(), { policy_digest: 'v2' }), 'policy-digest-mismatch'));
t('חוזה מקור מתחנה אחרת — סירוב', () =>
  throwsCode(() => run(mk(), { contract_station_id: '999' }), 'contract-station-mismatch'));
t('גרסת מקור שאינה תואמת לחוזה — סירוב', () =>
  throwsCode(() => run(mk(), { source_revision: 'v2' }), 'source-revision-mismatch'));
t('מקור שאינו מסומן כמלא — סירוב', () =>
  throwsCode(() => run(mk(), { source_complete: false }), 'source-incomplete'));
t('בלי תמונת זמינות מפורשת — סירוב', () => {
  const input = Object.assign({}, BASE, { days: ['2026-09-01'], roster: roster() });
  delete input.availability;
  throwsCode(() => mk().planPeriod(input), 'availability-required');
});
t('בלי תמונת שיבוצים ידניים מפורשת — סירוב', () => {
  const input = Object.assign({}, BASE, { days: ['2026-09-01'], roster: roster() });
  delete input.locked;
  throwsCode(() => mk().planPeriod(input), 'locked-required');
});
t('בלי מצב המשך מפורש — סירוב', () => {
  const input = Object.assign({}, BASE, { days: ['2026-09-01'], roster: roster() });
  delete input.carry;
  throwsCode(() => mk().planPeriod(input), 'carry-required');
});
t('יום עתידי במצב ההמשך — סירוב', () =>
  throwsCode(() => run(mk(), { carry: { lastDay: { L1: 999999 } } }), 'carry-last-day-invalid'));
t('אדם מגרסת מקור אחרת — סירוב', () => {
  const r = roster(); r[0].source_version = 'v9';
  throwsCode(() => run(mk(), { roster: r }), 'person-version-mismatch');
});
t('אדם מתחנה אחרת — סירוב', () => {
  const r = roster(); r[0].station_id = '777';
  throwsCode(() => run(mk(), { roster: r }), 'person-station-mismatch');
});
t('אדם בלי תחנת שיוך — סירוב', () => {
  const r = roster(); delete r[0].sub_station;
  throwsCode(() => run(mk(), { roster: r }), 'person-sub-station');
});
t('תחנת שיוך לא מוכרת — סירוב', () => {
  const r = roster(); r[0].sub_station = 'nowhere';
  throwsCode(() => run(mk(), { roster: r }), 'person-sub-station-unknown');
});
t('אדם בלי סימון פעיל מפורש — סירוב', () => {
  const r = roster(); delete r[0].active;
  throwsCode(() => run(mk(), { roster: r }), 'person-active');
});
t('מזהה כפול בסגל — סירוב', () => {
  const r = roster(); r.push(person('L1', 'eilat', ['firefighter']));
  throwsCode(() => run(mk(), { roster: r }), 'roster-duplicate');
});
t('שיבוץ ידני לתחנת קצה לא מוכרת — סירוב', () =>
  throwsCode(() => run(mk(), { locked: { nowhere: { '2026-09-01': ['L1'] } } }), 'locked-sub-station-unknown'));

/* ================= 3. תאריכים ================= */

t('תאריך בלתי אפשרי — סירוב', () =>
  throwsCode(() => run(mk(), { days: ['2026-02-30'] }), 'impossible-date'));
t('חודש 13 — סירוב', () =>
  throwsCode(() => run(mk(), { days: ['2026-13-01'] }), 'impossible-date'));
t('תאריך כפול — סירוב', () =>
  throwsCode(() => run(mk(), { days: ['2026-09-01', '2026-09-01'] }), 'duplicate-date'));
t('ימים שאינם בסדר עולה — סירוב כדי שלא לעקוף מנוחה', () =>
  throwsCode(() => run(mk(), { days: ['2026-09-02', '2026-09-01'] }), 'days-not-ascending'));
t('תבנית לא תקינה — סירוב', () =>
  throwsCode(() => run(mk(), { days: ['1/9/2026'] }), 'bad-date'));
t('29 בפברואר בשנה מעוברת — מתקבל', () => {
  const p = run(mk(), { days: ['2028-02-29'] });
  assert.strictEqual(p.rows[0].date, '2028-02-29');
});
t('טווח הפוך — סירוב', () => throwsCode(() => mk().daysBetween('2026-09-10', '2026-09-01'), 'bad-range'));

/* ================= 4. שיבוץ תקין ================= */

t('יום מלא — כל התקנים מאוישים בשתי תחנות הקצה', () => {
  const p = run(mk());
  const eilat = p.rows.filter((r) => r.sub_station === 'eilat')[0];
  const timna = p.rows.filter((r) => r.sub_station === 'timna')[0];
  assert.deepStrictEqual(eilat.gaps, []);
  assert.deepStrictEqual(timna.gaps, []);
  assert.strictEqual(eilat.slots.length, 7);
  assert.strictEqual(timna.slots.length, 2);
});

t('אין אדם פעמיים באותו יום', () => {
  const p = run(mk());
  const ids = p.rows.reduce((a, r) => a.concat(r.slots.map((s) => s.person)), []);
  assert.strictEqual(new Set(ids).size, ids.length);
});

t('כל אדם ממלא תפקיד שהוא מחזיק', () => {
  const map = new Map(roster().map((x) => [x.id, x]));
  run(mk()).rows.forEach((r) => r.slots.forEach((s) => {
    if (s.role) assert.ok(map.get(s.person).roles.indexOf(s.role) > -1, s.person + '/' + s.role);
  }));
});

t('אדם לא פעיל אינו משובץ', () => {
  const r = roster().map((x) => (x.id === 'L1' ? Object.assign({}, x, { active: false }) : x));
  const p = run(mk(), { roster: r });
  const ids = p.rows.reduce((a, row) => a.concat(row.slots.map((s) => s.person)), []);
  assert.strictEqual(ids.indexOf('L1'), -1);
});

t('אותו קלט — אותה תוצאה בייט בבייט', () => {
  const a = JSON.stringify(run(mk()).rows);
  const b = JSON.stringify(run(mk()).rows);
  assert.strictEqual(a, b);
});

t('התאמה מלאה נמצאת גם כשבחירה חמדנית הייתה משאירה חור', () => {
  const eng = createCalendarEngine({
    clock: CLOCK,
    policy: {
      station_id: ST,
      version: V,
      sub_stations: {
        eilat: {
          label: 'אילת',
          minimum: 4,
          requirements: [
            { role: 'a', count: 1, required: true },
            { role: 'b', count: 1, required: true },
            { role: 'c', count: 1, required: true },
            { role: 'd', count: 1, required: true }
          ]
        }
      },
      rest: { min_gap_days: 0 },
      rotation: null,
      max_shifts_per_month: null
    }
  });
  const p = run(eng, {
    roster: [
      person('A', 'eilat', ['a']),
      person('B', 'eilat', ['b', 'c']),
      person('C', 'eilat', ['a', 'b']),
      person('D', 'eilat', ['c', 'd'])
    ]
  });
  const row = p.rows[0];
  assert.strictEqual(row.slots.length, 4);
  assert.deepStrictEqual(row.gaps, []);
  assert.strictEqual(row.complete, true);
});

t('אין Math.random במקור', () => {
  const src = require('fs').readFileSync(__dirname + '/schedule-calendar-engine.js', 'utf8');
  assert.strictEqual(/Math\.random/.test(src), false);
});

/* ================= 5. אין העברה בין תחנות קצה ================= */

t('חוסר בתמנע אינו נסגר באנשי אילת', () => {
  const r = roster().filter((x) => x.sub_station !== 'timna');
  const p = run(mk(), { roster: r.concat([person('TD1', 'timna', ['driver', 'firefighter'])]) });
  const timna = p.rows.filter((x) => x.sub_station === 'timna')[0];
  const ids = timna.slots.map((s) => s.person);
  assert.ok(ids.every((id) => id.indexOf('T') === 0), 'אדם מאילת שובץ בתמנע: ' + ids.join(','));
  assert.ok(timna.gaps.length > 0, 'החוסר בתמנע נסתם במקום להישאר חור');
});

t('חור מנומק בקודים ניטרליים בלבד', () => {
  const p = run(mk(), { roster: [person('D1', 'eilat', ['driver'])] });
  const eilat = p.rows.filter((x) => x.sub_station === 'eilat')[0];
  assert.ok(eilat.gaps.length > 0);
  const allowed = Object.keys(REASON).map((k) => REASON[k]);
  eilat.gaps.forEach((g) => {
    assert.ok(Array.isArray(g.reasons) && g.reasons.length > 0, 'חור בלי סיבה');
    g.reasons.forEach((x) => assert.ok(allowed.indexOf(x.code) > -1, 'קוד לא מוכר: ' + x.code));
  });
});

/* ================= 6. אין דליפת מידע אישי ================= */

t('סיבת אי-זמינות אינה מגיעה לפלט', () => {
  const p = run(mk(), {
    roster: [person('L1', 'eilat', ['shift_lead'])],
    availability: { L1: { '2026-09-01': { kind: 'sick', note: 'ניתוח גב' } } }
  });
  const json = JSON.stringify(p);
  assert.strictEqual(json.indexOf('ניתוח גב'), -1, 'הערה רפואית דלפה');
  assert.strictEqual(json.indexOf('sick'), -1, 'קטגוריית מחלה דלפה');
  const eilat = p.rows.filter((x) => x.sub_station === 'eilat')[0];
  const g = eilat.gaps.filter((x) => x.role === 'shift_lead')[0];
  assert.ok(g.reasons.some((x) => x.code === REASON.NOT_AVAILABLE));
});

t('אין בפלט אף מפתח שנושא סיבה חופשית', () => {
  const p = run(mk(), { availability: { L1: { '2026-09-01': { kind: 'vacation' } } } });
  const json = JSON.stringify(p);
  ['vacation', 'reserve', 'course', 'מחלה', 'חופשה', 'מילואים'].forEach((w) => {
    assert.strictEqual(json.indexOf(w), -1, 'דלף: ' + w);
  });
});

/* ================= 7. שיבוץ ידני עובר בדיקות ================= */

t('שיבוץ ידני נשמר ונספר לתקן', () => {
  const p = run(mk(), { locked: { eilat: { '2026-09-01': ['D7'] } } });
  const eilat = p.rows.filter((x) => x.sub_station === 'eilat')[0];
  const mine = eilat.slots.filter((s) => s.person === 'D7')[0];
  assert.ok(mine && mine.source === 'manual');
  assert.strictEqual(eilat.slots.length, 7, 'התקן גדל מעבר לנדרש');
});

t('שיבוץ ידני מופיע ראשון', () => {
  const p = run(mk(), { locked: { eilat: { '2026-09-01': ['D7'] } } });
  const eilat = p.rows.filter((x) => x.sub_station === 'eilat')[0];
  assert.strictEqual(eilat.slots[0].person, 'D7');
});

t('שיבוץ ידני אינו נדרס בהרצה אוטומטית', () => {
  const p = run(mk(), { locked: { eilat: { '2026-09-01': ['F8'] } } });
  const eilat = p.rows.filter((x) => x.sub_station === 'eilat')[0];
  assert.ok(eilat.slots.some((s) => s.person === 'F8' && s.source === 'manual'));
});

t('שיבוץ ידני של אדם מתחנת קצה אחרת נדחה ומדווח', () => {
  const p = run(mk(), { locked: { eilat: { '2026-09-01': ['TD1'] } } });
  const eilat = p.rows.filter((x) => x.sub_station === 'eilat')[0];
  assert.ok(!eilat.slots.some((s) => s.person === 'TD1'), 'ידני פסול שובץ');
  assert.deepStrictEqual(eilat.rejected_manual, [{ person: 'TD1', code: REASON.OUT_OF_SUB_STATION }]);
});

t('שיבוץ ידני של אדם לא פעיל נדחה', () => {
  const r = roster().map((x) => (x.id === 'D7' ? Object.assign({}, x, { active: false }) : x));
  const p = run(mk(), { roster: r, locked: { eilat: { '2026-09-01': ['D7'] } } });
  const eilat = p.rows.filter((x) => x.sub_station === 'eilat')[0];
  assert.strictEqual(eilat.rejected_manual[0].code, REASON.INACTIVE);
});

t('שיבוץ ידני של אדם לא זמין נדחה', () => {
  const p = run(mk(), {
    locked: { eilat: { '2026-09-01': ['D7'] } },
    availability: { D7: { '2026-09-01': { kind: 'sick' } } }
  });
  const eilat = p.rows.filter((x) => x.sub_station === 'eilat')[0];
  assert.strictEqual(eilat.rejected_manual[0].code, REASON.NOT_AVAILABLE);
});

t('שיבוץ ידני שמפר מנוחה נדחה', () => {
  const p = run(mk(), {
    days: ['2026-09-01', '2026-09-02'],
    locked: { eilat: { '2026-09-02': ['L1'] } },
    carry: { load: { L1: 1 }, lastDay: {}, byRole: {} }
  });
  const day2 = p.rows.filter((x) => x.date === '2026-09-02' && x.sub_station === 'eilat')[0];
  const day1 = p.rows.filter((x) => x.date === '2026-09-01' && x.sub_station === 'eilat')[0];
  if (day1.slots.some((s) => s.person === 'L1')) {
    assert.strictEqual(day2.rejected_manual.filter((x) => x.person === 'L1')[0].code, REASON.REST);
  }
});

t('שיבוץ ידני לתפקיד שהאדם אינו מחזיק נדחה', () => {
  // F1 הוא לוחם בלבד. גרירה שלו למשבצת „נהג" אינה חוקית,
  // גם כשאחראי הסידור עשה אותה ביד.
  const p = run(mk(), { locked: { eilat: { '2026-09-01': [{ person: 'F1', role: 'driver' }] } } });
  const eilat = p.rows.filter((x) => x.sub_station === 'eilat')[0];
  assert.ok(!eilat.slots.some((s) => s.person === 'F1' && s.role === 'driver'), 'לוחם שובץ כנהג');
  assert.deepStrictEqual(eilat.rejected_manual, [{ person: 'F1', code: REASON.NO_QUALIFIED }]);
});

t('שיבוץ ידני לתפקיד שהאדם כן מחזיק מתקבל בתפקיד שנקבע', () => {
  const p = run(mk(), { locked: { eilat: { '2026-09-01': [{ person: 'D5', role: 'driver' }] } } });
  const eilat = p.rows.filter((x) => x.sub_station === 'eilat')[0];
  const mine = eilat.slots.filter((s) => s.person === 'D5')[0];
  assert.ok(mine, 'הנהג לא שובץ');
  assert.strictEqual(mine.role, 'driver');
  assert.strictEqual(mine.source, 'manual');
});

t('שיבוץ ידני לתפקיד שאינו בתקן תחנת הקצה — סירוב', () =>
  throwsCode(() => run(mk(), {
    locked: { timna: { '2026-09-01': [{ person: 'TD1', role: 'shift_lead' }] } }
  }), 'locked-role-unknown'));

t('רשומת שיבוץ ידני פגומה — סירוב', () =>
  throwsCode(() => run(mk(), { locked: { eilat: { '2026-09-01': [{ role: 'driver' }] } } }), 'locked-shape'));

t('שיבוץ ידני של מזהה שאינו בסגל נדחה', () => {
  const p = run(mk(), { locked: { eilat: { '2026-09-01': ['רוח_רפאים'] } } });
  const eilat = p.rows.filter((x) => x.sub_station === 'eilat')[0];
  assert.strictEqual(eilat.rejected_manual[0].person, 'רוח_רפאים');
  assert.ok(!eilat.slots.some((s) => s.person === 'רוח_רפאים'));
});

t('שיבוץ ידני שנדחה משאיר את היום לא שלם גם אם התקן מולא אוטומטית', () => {
  const p = run(mk(), { locked: { eilat: { '2026-09-01': ['רוח_רפאים'] } } });
  const eilat = p.rows.filter((x) => x.sub_station === 'eilat')[0];
  assert.strictEqual(eilat.slots.length, 7);
  assert.strictEqual(eilat.complete, false);
});

/* ================= 8. קו מינימום ================= */

t('מתחת לקו המינימום מסומן', () => {
  const p = run(mk(), { roster: [person('L1', 'eilat', ['shift_lead']), person('TD1', 'timna', ['driver']), person('TF1', 'timna', ['firefighter'])] });
  const eilat = p.rows.filter((x) => x.sub_station === 'eilat')[0];
  assert.strictEqual(eilat.below_minimum, true);
  assert.strictEqual(eilat.complete, false);
});

t('מעל הקו — לא מסומן', () => {
  const eilat = run(mk()).rows.filter((x) => x.sub_station === 'eilat')[0];
  assert.strictEqual(eilat.below_minimum, false);
  assert.strictEqual(eilat.complete, true);
});

t('קו המינימום מגיע מהמדיניות ולא מהקוד', () => {
  const p = policy();
  p.sub_stations.eilat.minimum = 99;
  const eng = createCalendarEngine({ clock: CLOCK, policy: p });
  const eilat = run(eng).rows.filter((x) => x.sub_station === 'eilat')[0];
  assert.strictEqual(eilat.minimum, 99);
  assert.strictEqual(eilat.below_minimum, true);
});

/* ================= 9. מנוחה, מחזוריות, תקרה ================= */

t('אין שני ימים רצופים לאותו אדם', () => {
  const eng = mk();
  const p = eng.planPeriod(Object.assign({}, BASE, {
    days: ['2026-09-01', '2026-09-02'],
    roster: [person('TD1', 'timna', ['driver']), person('TF1', 'timna', ['firefighter'])]
  }));
  const day2 = p.rows.filter((x) => x.date === '2026-09-02' && x.sub_station === 'timna')[0];
  assert.strictEqual(day2.slots.length, 0);
  assert.ok(day2.gaps[0].reasons.some((x) => x.code === REASON.REST));
});

t('min_gap_days=0 מאפשר ימים רצופים', () => {
  const eng = createCalendarEngine({ clock: CLOCK, policy: policy({ rest: { min_gap_days: 0 } }) });
  const p = eng.planPeriod(Object.assign({}, BASE, {
    days: ['2026-09-01', '2026-09-02'],
    roster: [person('TD1', 'timna', ['driver']), person('TF1', 'timna', ['firefighter'])]
  }));
  const day2 = p.rows.filter((x) => x.date === '2026-09-02' && x.sub_station === 'timna')[0];
  assert.strictEqual(day2.slots.length, 2);
});

t('מחזוריות קשיחה חוסמת קבוצה זרה', () => {
  const eng = createCalendarEngine({ clock: CLOCK, policy: policy({
    rotation: { groups: ['א', 'ב'], anchor: '2026-09-01', days_per_group: 1, strict: true } }) });
  const p = eng.planPeriod(Object.assign({}, BASE, {
    days: ['2026-09-02'],
    roster: [person('TD1', 'timna', ['driver'], { group: 'א' }), person('TF1', 'timna', ['firefighter'], { group: 'א' })]
  }));
  const timna = p.rows.filter((x) => x.sub_station === 'timna')[0];
  assert.strictEqual(timna.slots.length, 0);
  assert.ok(timna.gaps[0].reasons.some((x) => x.code === REASON.OUT_OF_ROTATION));
});

t('מחזוריות מעדיפה את קבוצת היום — גם כשסדר השמות הפוך', () => {
  const eng = createCalendarEngine({ clock: CLOCK, policy: policy({
    rest: { min_gap_days: 0 },
    rotation: { groups: ['א', 'ב'], anchor: '2026-09-01', days_per_group: 1, strict: false } }) });
  const p = eng.planPeriod(Object.assign({}, BASE, {
    days: ['2026-09-02'],
    roster: [person('A_first', 'timna', ['driver', 'firefighter'], { group: 'א' }),
      person('Z_last', 'timna', ['driver', 'firefighter'], { group: 'ב' })]
  }));
  const timna = p.rows.filter((x) => x.sub_station === 'timna')[0];
  assert.strictEqual(timna.rotation_group, 'ב');
  assert.strictEqual(timna.slots.filter((s) => s.role === 'driver')[0].person, 'Z_last');
});

t('תקרת משמרות מזהירה ואינה חוסמת', () => {
  const eng = createCalendarEngine({ clock: CLOCK, policy: policy({
    rest: { min_gap_days: 0 }, max_shifts_per_month: 1 }) });
  const p = eng.planPeriod(Object.assign({}, BASE, {
    days: ['2026-09-01', '2026-09-02'],
    roster: [person('TD1', 'timna', ['driver']), person('TF1', 'timna', ['firefighter'])]
  }));
  const day2 = p.rows.filter((x) => x.date === '2026-09-02' && x.sub_station === 'timna')[0];
  assert.strictEqual(day2.slots.length, 2, 'התקרה חסמה במקום להזהיר');
  assert.ok(day2.slots.every((s) => s.over_limit === true));
});

/* ================= 10. חודשים ================= */

t('שלושה חודשים — שלוש תקופות', () => {
  const r = mk().planMonths(Object.assign({}, BASE, {
    months: 3, start: '2026-09-01', roster: roster() }));
  assert.strictEqual(r.periods.length, 3);
  assert.strictEqual(r.periods[0].from, '2026-09-01');
  assert.strictEqual(r.periods[0].to, '2026-09-30');
  assert.strictEqual(r.periods[1].from, '2026-10-01');
  assert.strictEqual(r.periods[1].to, '2026-10-31');
  assert.strictEqual(r.periods[2].to, '2026-11-30');
});

t('ארבעה חודשים — סירוב', () =>
  throwsCode(() => mk().planMonths(Object.assign({}, BASE, {
    months: 4, start: '2026-09-01', roster: roster() })), 'months-range'));

t('המנוחה נשמרת בגבול החודש', () => {
  const eng = mk();
  const r = eng.planMonths(Object.assign({}, BASE, {
    months: 2, start: '2026-09-01', roster: roster() }));
  const last = r.periods[0].rows.filter((x) => x.date === '2026-09-30')
    .reduce((set, row) => new Set([...set, ...row.slots.map((s) => s.person)]), new Set());
  const first = r.periods[1].rows.filter((x) => x.date === '2026-10-01')
    .reduce((set, row) => new Set([...set, ...row.slots.map((s) => s.person)]), new Set());
  assert.strictEqual([...last].some((id) => first.has(id)), false, 'אותו אדם שובץ משני צדי גבול החודש');
});

t('תקרת משמרות חודשית מתאפסת בראש חודש', () => {
  const eng = createCalendarEngine({ clock: CLOCK, policy: policy({
    rest: { min_gap_days: 0 }, max_shifts_per_month: 50
  }) });
  const r = eng.planMonths(Object.assign({}, BASE, {
    months: 2, start: '2026-09-01', roster: roster()
  }));
  const firstOctober = r.periods[1].rows.filter((x) => x.date === '2026-10-01');
  assert.ok(firstOctober.every((row) => row.slots.every((slot) => slot.over_limit !== true)));
});

t('עומס מחודש קודם אינו מזהם את החודש הראשון בבקשה', () => {
  const eng = createCalendarEngine({ clock: CLOCK, policy: policy({
    rest: { min_gap_days: 0 }, max_shifts_per_month: 1
  }) });
  const r = eng.planMonths(Object.assign({}, BASE, {
    months: 1, start: '2026-09-01', roster: roster(),
    carry: { load: { L1: 99 }, lastDay: {}, byRole: { L1: { shift_lead: 99 } } }
  }));
  const firstDay = r.periods[0].rows.filter((x) => x.date === '2026-09-01');
  assert.ok(firstDay.every((row) => row.slots.every((slot) => slot.over_limit !== true)));
});

/* ================= 11. תוצאה, טוהר, מגבלות ================= */

t('התוצאה קפואה ומסומנת כתוכנית', () => {
  const p = run(mk());
  assert.strictEqual(p.kind, 'schedule-plan');
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.rows) && Object.isFrozen(p.summary));
  assert.ok(Object.isFrozen(p.rows[0]) && Object.isFrozen(p.rows[0].slots));
  assert.ok(Object.isFrozen(p.carry.load) && Object.isFrozen(p.carry.byRole));
});

t('התוצאה נושאת את צילום המקור והגרסה', () => {
  const p = run(mk());
  assert.strictEqual(p.source_snapshot, 'snap_1');
  assert.strictEqual(p.source_version, V);
  assert.strictEqual(p.policy_version, V);
});

t('explain אומר שדבר לא פורסם', () => {
  const eng = mk();
  const s = eng.explain(run(eng));
  assert.ok(s.indexOf('טיוטה') > -1 && s.indexOf('לא פורסם') > -1, s);
});

t('אפס require ואפס נגיעה במסד', () => {
  const src = require('fs').readFileSync(__dirname + '/schedule-calendar-engine.js', 'utf8');
  assert.strictEqual(/\brequire\s*\(/.test(src), false);
  assert.strictEqual(/firestore|admin\.|\.collection\(|messaging/i.test(src), false);
  assert.strictEqual(/Date\.now\(\)|new Date\(\)/.test(src), false);
});

t('אינו מייבא ואינו דורס את schedule-autofill', () => {
  const src = require('fs').readFileSync(__dirname + '/schedule-calendar-engine.js', 'utf8');
  assert.strictEqual(/schedule-autofill/.test(src.replace(/^ \*.*$/gm, '')), false);
});

t('סגל גדול מהמותר — סירוב', () => {
  const big = [];
  for (let i = 0; i < 20001; i += 1) big.push(person('P' + i, 'eilat', ['firefighter']));
  throwsCode(() => run(mk(), { roster: big }), 'roster-too-large');
});

t('יותר מדי ימים — סירוב', () => {
  const many = [];
  for (let i = 0; i < 1001; i += 1) many.push('2026-09-01');
  throwsCode(() => run(mk(), { days: many }), 'days-too-many');
});

console.log((fails.length ? '✗' : '✓') + ' schedule-calendar-engine: ' + pass + '/' + (pass + fails.length));
if (fails.length) { fails.forEach((f) => console.log('   ✗ ' + f)); process.exit(1); }
