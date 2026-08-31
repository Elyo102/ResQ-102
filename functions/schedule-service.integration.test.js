'use strict';

/**
 * בדיקת אינטגרציה: מנוע → שירות → פרסום → תצוגות.
 * שלושת המודולים מחוברים זה לזה בלבד, בלי מסד ובלי רשת.
 */

const assert = require('assert');
const { createCalendarEngine } = require('./schedule-calendar-engine.js');
const { createPublication } = require('./schedule-publication.js');
const { createScheduleService, ServiceError, ACTION, PRIVILEGED } = require('./schedule-service.js');

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass += 1; }
  catch (e) { fails.push(name + ' → ' + (e && e.message)); }
}
function throwsCode(fn, code) {
  try { fn(); }
  catch (e) {
    assert.strictEqual(e.code, code, 'קוד ' + e.code + ' במקום ' + code + ' (' + e.message + ')');
    return;
  }
  throw new Error('לא נזרקה שגיאה, ציפיתי ל-' + code);
}

const AT = '2026-09-01T12:00:00.000Z';
const CLOCK = () => AT;
function HASH(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return 'h' + h.toString(16);
}

const STATION = '102';
const VERSION = 'v1';

const POLICY = {
  station_id: STATION,
  version: VERSION,
  sub_stations: {
    eilat: {
      label: 'אילת', minimum: 3,
      requirements: [
        { role: 'shift_lead', label: 'ראש משמרת', count: 1, required: true },
        { role: 'driver', label: 'נהג', count: 1, required: true },
        { role: 'firefighter', label: 'לוחם', count: 1, required: true }
      ]
    },
    timna: {
      label: 'תמנע', minimum: 2,
      requirements: [
        { role: 'driver', label: 'נהג', count: 1, required: true },
        { role: 'firefighter', label: 'לוחם', count: 1, required: true }
      ]
    }
  },
  rest: { min_gap_days: 0 },
  rotation: null,
  max_shifts_per_month: null
};

const CAPS = {
  firefighter: [ACTION.VIEW_MY, ACTION.VIEW_STATION, ACTION.RESPOND_OWN],
  scheduler: [ACTION.VIEW_MY, ACTION.VIEW_STATION, ACTION.EDIT_DRAFT, ACTION.RUN_PLANNER, ACTION.PUBLISH, ACTION.RESPOND_OWN],
  officer: [ACTION.VIEW_MY, ACTION.VIEW_STATION, ACTION.EDIT_DRAFT, ACTION.RUN_PLANNER, ACTION.PUBLISH, ACTION.RESPOND_OWN]
};

function person(id, sub, roles, over) {
  return Object.assign({
    id, station_id: STATION, sub_station: sub, active: true, roles,
    source_snapshot: 'snap_1', source_version: VERSION
  }, over || {});
}

const ROSTER = [
  person('אבי', 'eilat', ['shift_lead', 'firefighter'], { qualifications: ['ראש משמרת', 'חובש'] }),
  person('בני', 'eilat', ['driver', 'firefighter']),
  person('גדי', 'eilat', ['firefighter']),
  person('דורון', 'eilat', ['firefighter', 'driver']),
  person('הראל', 'timna', ['driver', 'firefighter']),
  person('ורד', 'timna', ['firefighter'])
];

const REQ = {
  station_id: STATION, source_snapshot: 'snap_1', source_version: VERSION,
  contract_station_id: STATION, source_revision: VERSION, source_digest: 'digest_snap_1',
  policy_digest: VERSION, source_complete: true,
  availability: {}, locked: {}, carry: {},
  days: ['2026-09-01', '2026-09-02', '2026-09-03'], roster: ROSTER
};

function build() {
  const engine = createCalendarEngine({ clock: CLOCK, policy: POLICY });
  const publication = createPublication({
    clock: CLOCK, hash: HASH, rules: { max_attempts: 3, retry_backoff_ms: [1000, 5000] }
  });
  const service = createScheduleService({
    clock: CLOCK, engine, publication,
    rules: { station_id: STATION, capabilities: CAPS }
  });
  return { engine, publication, service };
}

const SCHEDULER = { id: 'רמי', role: 'scheduler', station_id: STATION, active: true };
const FIREFIGHTER = { id: 'גדי', role: 'firefighter', station_id: STATION, active: true };
const OFFICER = { id: 'יעל', role: 'officer', station_id: STATION, active: true };
function responseInput(over) {
  return Object.assign({
    actor: FIREFIGHTER,
    answer: 'confirm',
    request: {
      person: 'גדי', request_id: 'req-1', publication_id: 'p', publication_revision: 2, item_id: '2026-09-01'
    },
    active_publication: {
      id: 'p', revision: 2, station_id: STATION,
      assigned_items: [{ id: '2026-09-01', person: 'גדי' }]
    }
  }, over || {});
}

/* ================= 1. בנייה ================= */

t('בלי מנוע — סירוב', () =>
  throwsCode(() => createScheduleService({ clock: CLOCK, publication: { planPublication() {} }, rules: { station_id: STATION, capabilities: CAPS } }), 'engine-required'));
t('בלי מודול פרסום — סירוב', () =>
  throwsCode(() => createScheduleService({ clock: CLOCK, engine: { planPeriod() {} }, rules: { station_id: STATION, capabilities: CAPS } }), 'publication-required'));
t('בלי יכולות — סירוב', () =>
  throwsCode(() => createScheduleService({
    clock: CLOCK, engine: { planPeriod() {}, policy: { station_id: STATION } }, publication: { planPublication() {} },
    rules: { station_id: STATION } }), 'rules-capabilities'));
t('יכולת לא מוכרת — סירוב', () =>
  throwsCode(() => createScheduleService({
    clock: CLOCK, engine: { planPeriod() {}, policy: { station_id: STATION } }, publication: { planPublication() {} },
    rules: { station_id: STATION, capabilities: { x: ['fly'] } } }), 'capability-unknown'));
t('מנוע של תחנה אחרת — סירוב בזמן הבנייה', () =>
  throwsCode(() => createScheduleService({
    clock: CLOCK,
    engine: { planPeriod() {}, policy: { station_id: '999' } },
    publication: { planPublication() {} },
    rules: { station_id: STATION, capabilities: CAPS }
  }), 'engine-station-mismatch'));

/* ================= 2. הפרדת ההרשאות · נאכפת בשרת ================= */

t('כבאי רגיל אינו רשאי להריץ שיבוץ', () => {
  const { service } = build();
  throwsCode(() => service.runPlanner({ actor: FIREFIGHTER, request: REQ }), 'forbidden');
});

t('כבאי רגיל אינו רשאי לפרסם', () => {
  const { service } = build();
  throwsCode(() => service.publish({ actor: FIREFIGHTER, request: {} }), 'forbidden');
});

t('כבאי רגיל אינו רשאי לערוך טיוטה', () => {
  const { service } = build();
  throwsCode(() => service.assertMay(ACTION.EDIT_DRAFT, FIREFIGHTER), 'forbidden');
});

t('לכבאי רגיל אין אף אחת מהפעולות המורשות', () => {
  PRIVILEGED.forEach((a) => {
    assert.strictEqual(CAPS.firefighter.indexOf(a), -1, 'לכבאי ניתנה פעולה מורשית: ' + a);
  });
});

t('כבאי רגיל רשאי לצפות בשתי התצוגות', () => {
  const { service } = build();
  assert.strictEqual(service.assertMay(ACTION.VIEW_MY, FIREFIGHTER), true);
  assert.strictEqual(service.assertMay(ACTION.VIEW_STATION, FIREFIGHTER), true);
});

t('קצין מורשה רשאי להריץ ולפרסם', () => {
  const { service } = build();
  assert.strictEqual(service.assertMay(ACTION.RUN_PLANNER, OFFICER), true);
  assert.strictEqual(service.assertMay(ACTION.PUBLISH, OFFICER), true);
});

t('משתמש לא פעיל נחסם', () => {
  const { service } = build();
  throwsCode(() => service.assertMay(ACTION.VIEW_MY,
    Object.assign({}, FIREFIGHTER, { active: false })), 'actor-inactive');
});

t('משתמש בלי סימון פעיל מפורש נחסם', () => {
  const { service } = build();
  const a = Object.assign({}, FIREFIGHTER); delete a.active;
  throwsCode(() => service.assertMay(ACTION.VIEW_MY, a), 'actor-active');
});

t('משתמש מתחנה אחרת נחסם', () => {
  const { service } = build();
  throwsCode(() => service.assertMay(ACTION.VIEW_MY,
    Object.assign({}, FIREFIGHTER, { station_id: '999' })), 'actor-station-mismatch');
});

t('תפקיד שאין לו יכולות מוגדרות נחסם', () => {
  const { service } = build();
  throwsCode(() => service.assertMay(ACTION.VIEW_MY,
    Object.assign({}, FIREFIGHTER, { role: 'אורח' })), 'role-unknown');
});

t('אדם עונה רק עבור עצמו', () => {
  const { service } = build();
  const inp = responseInput(); inp.request.person = 'אבי';
  throwsCode(() => service.respond(inp), 'not-your-answer');
});

t('תגובה על עצמו עוברת', () => {
  const { service } = build();
  const r = service.respond(responseInput());
  assert.strictEqual(r.person, 'גדי');
  assert.strictEqual(r.answer, 'confirm');
});

t('דחייה עם קוד סיבה מוכר עוברת', () => {
  const { service } = build();
  const r = service.respond(responseInput({ answer: 'decline', reason_code: 'conflict' }));
  assert.strictEqual(r.reason_code, 'conflict');
});

t('דחייה בלי נימוק נחסמת', () => {
  const { service } = build();
  throwsCode(() => service.respond(responseInput({ answer: 'decline' })), 'decline-reason-required');
});

t('תגובה לגרסה שאינה פעילה נחסמת', () => {
  const { service } = build();
  throwsCode(() => service.respond(responseInput({
    active_publication: { id: 'p', revision: 3, station_id: STATION, assigned_items: [] }
  })), 'publication-not-active');
});

t('תגובה לפרסום פעיל של תחנה אחרת נחסמת', () => {
  const { service } = build();
  throwsCode(() => service.respond(responseInput({
    active_publication: {
      id: 'p', revision: 2, station_id: '999',
      assigned_items: [{ id: '2026-09-01', person: 'גדי' }]
    }
  })), 'publication-station-mismatch');
});

t('תגובה לשיבוץ של אדם אחר נחסמת', () => {
  const { service } = build();
  throwsCode(() => service.respond(responseInput({
    active_publication: {
      id: 'p', revision: 2, station_id: STATION,
      assigned_items: [{ id: '2026-09-01', person: 'אבי' }]
    }
  })), 'response-item-not-owned');
});

t('תגובה בלי זיהוי השיבוץ נחסמת', () => {
  const { service } = build();
  const inp = responseInput(); delete inp.request.item_id;
  throwsCode(() => service.respond(inp), 'response-target-required');
});

t('תגובה בלי מזהה פעולה נחסמת', () => {
  const { service } = build();
  const inp = responseInput(); delete inp.request.request_id;
  throwsCode(() => service.respond(inp), 'request-id-required');
});

t('תשובה שאינה confirm/decline — סירוב', () => {
  const { service } = build();
  throwsCode(() => service.respond(responseInput({ answer: 'אולי' })), 'answer-required');
});

t('„הסידור שלי" של אדם אחר — סירוב', () => {
  const { service, engine } = build();
  const plan = engine.planPeriod(REQ);
  throwsCode(() => service.buildMySchedule({ actor: FIREFIGHTER, plan, person: 'אבי' }), 'not-your-schedule');
});

/* ================= 3. הרצה מייצרת טיוטה בלבד ================= */

t('הרצה מחזירה מצב טיוטה', () => {
  const { service } = build();
  const run = service.runPlanner({ actor: SCHEDULER, request: REQ });
  assert.strictEqual(run.state, 'draft');
  assert.strictEqual(run.by, 'רמי');
  assert.ok(run.plan.rows.length > 0);
});

t('הרצה אינה מייצרת ולו התראה אחת', () => {
  const { service } = build();
  const run = service.runPlanner({ actor: SCHEDULER, request: REQ });
  assert.strictEqual(JSON.stringify(run).indexOf('notification'), -1);
});

t('הרצה לשלושה חודשים', () => {
  const { service } = build();
  const run = service.runPlanner({
    actor: SCHEDULER, months: 3,
    request: Object.assign({}, REQ, { start: '2026-09-01', days_per_month: 10 })
  });
  assert.strictEqual(run.plan.periods.length, 3);
});

/* ================= 4. מסלול מלא: הרצה → שינוי → פרסום → התראה ================= */

t('המסלול המלא מייצר התראה אישית למי שהוזז בלבד', () => {
  const { service, engine } = build();
  const first = engine.planPeriod(REQ);

  // אחראי הסידור מוציא את „גדי" מהיום הראשון ומשבץ במקומו את „דורון".
  const edited = JSON.parse(JSON.stringify(first));
  const row = edited.rows.filter((r) => r.date === '2026-09-01' && r.sub_station === 'eilat')[0];
  const idx = row.slots.map((s) => s.person).indexOf('גדי');
  assert.ok(idx > -1, 'גדי אינו בשיבוץ המקורי');
  row.slots[idx] = { person: 'דורון', role: 'firefighter', label: 'לוחם', source: 'manual' };

  const result = service.publish({
    actor: SCHEDULER,
    request: { next: edited, previous: first, publication_id: 'pub_1' }
  });

  const notified = result.notifications.map((n) => n.person).sort();
  assert.ok(notified.indexOf('גדי') > -1, 'מי שהוסר לא קיבל התראה');
  assert.ok(notified.indexOf('דורון') > -1, 'מי שנוסף לא קיבל התראה');
  assert.strictEqual(notified.indexOf('הראל'), -1, 'איש מתחנת קצה אחרת קיבל התראה');
  assert.strictEqual(result.publication.published_by, 'רמי');
});

t('פרסום ראשון מודיע לכל מי ששובץ', () => {
  const { service, engine } = build();
  const plan = engine.planPeriod(REQ);
  const r = service.publish({ actor: SCHEDULER, request: { next: plan, previous: null, publication_id: 'pub_0' } });
  assert.ok(r.notifications.length > 0);
  assert.strictEqual(r.publication.first_publication, true);
});

t('משתמש אינו יכול לצפות בתוכנית של תחנה אחרת', () => {
  const { service, engine } = build();
  const plan = JSON.parse(JSON.stringify(engine.planPeriod(REQ)));
  plan.station_id = '999';
  plan.rows.forEach((row) => { row.station_id = '999'; });
  throwsCode(() => service.buildStationSchedule({
    actor: FIREFIGHTER, plan, date: '2026-09-01'
  }), 'plan-station-mismatch');
});

t('שורת תוכנית מתחנה אחרת נחסמת גם כשהכותרת נכונה', () => {
  const { service, engine } = build();
  const plan = JSON.parse(JSON.stringify(engine.planPeriod(REQ)));
  plan.rows[0].station_id = '999';
  throwsCode(() => service.buildMySchedule({ actor: FIREFIGHTER, plan }), 'plan-row-station-mismatch');
});

t('אחראי אינו יכול לפרסם תוכנית של תחנה אחרת', () => {
  const { service, engine } = build();
  const plan = JSON.parse(JSON.stringify(engine.planPeriod(REQ)));
  plan.station_id = '999';
  plan.rows.forEach((row) => { row.station_id = '999'; });
  throwsCode(() => service.publish({
    actor: SCHEDULER,
    request: { next: plan, previous: null, publication_id: 'cross-station' }
  }), 'plan-station-mismatch');
});

t('לחיצה כפולה על פרסום — אין התראה שנייה', () => {
  const { service, engine } = build();
  const first = engine.planPeriod(REQ);
  const edited = JSON.parse(JSON.stringify(first));
  edited.rows[0].slots.pop();
  const a = service.publish({ actor: SCHEDULER, request: { next: edited, previous: first, publication_id: 'pub_2' } });
  const b = service.publish({
    actor: SCHEDULER,
    request: { next: edited, previous: first, publication_id: 'pub_2', existing_publication: a.publication }
  });
  assert.ok(a.notifications.length > 0);
  assert.strictEqual(b.duplicate, true);
  assert.strictEqual(b.notifications.length, 0);
});

/* ================= 5. תצוגות ================= */

t('„הסידור שלי" מציג רק את שלו, עם הצוות והכשירויות', () => {
  const { service, engine } = build();
  const plan = engine.planPeriod(REQ);
  const me = { id: 'אבי', role: 'firefighter', station_id: STATION, active: true };
  const mine = service.buildMySchedule({ actor: me, plan, roster: ROSTER });
  assert.ok(mine.days.length > 0);
  mine.days.forEach((day) => {
    assert.ok(day.crew.every((c) => c.person !== 'אבי'), 'האדם עצמו מופיע בצוות שלו');
    assert.ok(day.sub_station_label);
  });
  assert.deepStrictEqual(mine.days[0].qualifications, ['ראש משמרת', 'חובש']);
});

t('„הסידור שלי" מסמן מה דורש תשובה', () => {
  const { service, engine } = build();
  const plan = engine.planPeriod(REQ);
  const me = { id: 'אבי', role: 'firefighter', station_id: STATION, active: true };
  const mine = service.buildMySchedule({
    actor: me, plan, roster: ROSTER,
    changes_by_date: { '2026-09-01': { kind: 'role_changed', by: 'רמי', at: AT } }
  });
  const day = mine.days.filter((d) => d.date === '2026-09-01')[0];
  assert.strictEqual(day.requires_answer, true);
  assert.strictEqual(day.change.by, 'רמי');
  assert.ok(mine.pending_answers >= 1);
});

t('תשובה שכבר ניתנה מסירה את הדרישה', () => {
  const { service, engine } = build();
  const plan = engine.planPeriod(REQ);
  const me = { id: 'אבי', role: 'firefighter', station_id: STATION, active: true };
  const mine = service.buildMySchedule({
    actor: me, plan, roster: ROSTER,
    changes_by_date: { '2026-09-01': { kind: 'role_changed' } },
    answers_by_date: { '2026-09-01': { status: 'confirmed' } }
  });
  assert.strictEqual(mine.days.filter((d) => d.date === '2026-09-01')[0].requires_answer, false);
});

t('„סידור התחנה" מציג אתמול, היום ומחר', () => {
  const { service, engine } = build();
  const plan = engine.planPeriod(REQ);
  const v = service.buildStationSchedule({ actor: FIREFIGHTER, plan, date: '2026-09-02' });
  assert.strictEqual(v.previous_day.date, '2026-09-01');
  assert.strictEqual(v.day.date, '2026-09-02');
  assert.strictEqual(v.next_day.date, '2026-09-03');
});

t('„סידור התחנה" מציג את כל תחנות הקצה', () => {
  const { service, engine } = build();
  const plan = engine.planPeriod(REQ);
  const v = service.buildStationSchedule({ actor: FIREFIGHTER, plan, date: '2026-09-01' });
  assert.deepStrictEqual(v.day.sub_stations.map((s) => s.sub_station), ['eilat', 'timna']);
});

t('„סידור התחנה" מדגיש את המשתמש המחובר', () => {
  const { service, engine } = build();
  const plan = engine.planPeriod(REQ);
  const v = service.buildStationSchedule({ actor: FIREFIGHTER, plan, date: '2026-09-01' });
  const all = v.day.sub_stations.reduce((a, s) => a.concat(s.people), []);
  const me = all.filter((p) => p.is_me);
  assert.ok(me.length >= 1, 'המשתמש אינו מודגש');
  assert.ok(me.every((p) => p.person === 'גדי'));
  assert.ok(all.filter((p) => p.person !== 'גדי').every((p) => p.is_me === false));
});

t('„סידור התחנה" מציג אירועים ומסמן אם אני בהם', () => {
  const { service, engine } = build();
  const plan = engine.planPeriod(REQ);
  const events = [{
    id: 'e1', title: 'השתלמות', date: '2026-09-01', hours: '08:00-15:00', people: ['גדי'],
    station_id: STATION, source_snapshot: 'snap_1', source_version: VERSION
  }];
  const v = service.buildStationSchedule({ actor: FIREFIGHTER, plan, date: '2026-09-01', events });
  assert.strictEqual(v.day.events[0].includes_me, true);
});

t('אירוע מתחנה אחרת אינו דולף לתצוגות', () => {
  const { service, engine } = build();
  const plan = engine.planPeriod(REQ);
  const events = [{
    id: 'foreign', title: 'אירוע זר', date: '2026-09-01', people: ['גדי'],
    station_id: '999', source_snapshot: 'snap_1', source_version: VERSION
  }];
  throwsCode(() => service.buildStationSchedule({
    actor: FIREFIGHTER, plan, date: '2026-09-01', events
  }), 'event-station-mismatch');
  throwsCode(() => service.buildMySchedule({ actor: FIREFIGHTER, plan, events }), 'event-station-mismatch');
});

t('יום ללא סידור מחזיר בלוק ריק ולא שגיאה', () => {
  const { service, engine } = build();
  const plan = engine.planPeriod(REQ);
  const v = service.buildStationSchedule({ actor: FIREFIGHTER, plan, date: '2026-09-01' });
  assert.deepStrictEqual(v.previous_day.sub_stations, []);
});

t('התצוגות קפואות', () => {
  const { service, engine } = build();
  const plan = engine.planPeriod(REQ);
  const v = service.buildStationSchedule({ actor: FIREFIGHTER, plan, date: '2026-09-01' });
  const m = service.buildMySchedule({ actor: FIREFIGHTER, plan, roster: ROSTER });
  assert.ok(Object.isFrozen(v) && Object.isFrozen(m));
});

/* ================= 6. טוהר ================= */

t('אפס נגיעה במסד וברשת', () => {
  const src = require('fs').readFileSync(__dirname + '/schedule-service.js', 'utf8');
  assert.strictEqual(/firestore|admin\.|\.collection\(|messaging|fetch\(/i.test(src), false);
  assert.strictEqual(/Date\.now\(\)/.test(src), false);
});

/* ================= 7. עומס · נדלק עם RESQ_LOAD=1 ================= */

function loadRoster(n) {
  const out = [];
  const subs = ['eilat', 'timna'];
  for (let i = 0; i < n; i += 1) {
    const sub = subs[i % 2];
    const roles = ['firefighter'];
    if (i % 7 === 0) roles.push('shift_lead');
    if (i % 3 === 0) roles.push('driver');
    out.push(person('P' + i, sub, roles, { source_snapshot: 'load' }));
  }
  return out;
}
function loadDays(n) {
  const out = [];
  const start = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i += 1) {
    const d = new Date(start + i * 86400000);
    const p2 = (x) => String(x).padStart(2, '0');
    out.push(d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()));
  }
  return out;
}

if (process.env.RESQ_LOAD === '1') {
  [[1000, 500], [5000, 500]].forEach(function (pair) {
    const people = pair[0];
    const days = pair[1];
    t('עומס ' + people + ' משתמשים · ' + days + ' ימים', () => {
      const engine = createCalendarEngine({ clock: CLOCK, policy: POLICY });
      const t0 = Date.now();
      const plan = engine.planPeriod({
        station_id: STATION, source_snapshot: 'load', source_version: VERSION,
        contract_station_id: STATION, source_revision: VERSION, source_digest: 'digest_load',
        policy_digest: VERSION, source_complete: true, availability: {}, locked: {}, carry: {},
        days: loadDays(days), roster: loadRoster(people)
      });
      const ms = Date.now() - t0;
      const heap = Math.round(process.memoryUsage().heapUsed / 1048576);
      assert.strictEqual(plan.rows.length, days * 2);
      assert.ok(plan.summary.filled > 0, 'לא שובץ איש');
      console.log('   · ' + people + '/' + days + ' → ' + ms + ' ms · ערימה '
        + heap + ' MB · שורות ' + plan.rows.length + ' · שיבוצים ' + plan.summary.filled);
      assert.ok(ms < 120000, 'הריצה ארכה ' + ms + ' ms');
    });
  });

  t('עומס · מעבר למגבלת הסגל נחסם', () =>
    throwsCode(() => createCalendarEngine({ clock: CLOCK, policy: POLICY }).planPeriod({
      station_id: STATION, source_snapshot: 'load', source_version: VERSION,
      contract_station_id: STATION, source_revision: VERSION, source_digest: 'digest_load',
      policy_digest: VERSION, source_complete: true, availability: {}, locked: {}, carry: {},
      days: ['2026-01-01'], roster: loadRoster(20001)
    }), 'roster-too-large'));

  t('עומס · מעבר למגבלת הימים נחסם', () =>
    throwsCode(() => createCalendarEngine({ clock: CLOCK, policy: POLICY }).planPeriod({
      station_id: STATION, source_snapshot: 'load', source_version: VERSION,
      contract_station_id: STATION, source_revision: VERSION, source_digest: 'digest_load',
      policy_digest: VERSION, source_complete: true, availability: {}, locked: {}, carry: {},
      days: loadDays(1001), roster: loadRoster(10)
    }), 'days-too-many'));
}

console.log((fails.length ? '✗' : '✓') + ' schedule-service.integration: ' + pass + '/' + (pass + fails.length));
if (fails.length) { fails.forEach((f) => console.log('   ✗ ' + f)); process.exit(1); }
