'use strict';

const assert = require('assert');
const {
  createPublication, PublicationError, CHANGE, PUSH_FIELDS, FORBIDDEN_KEYS
} = require('./schedule-publication.js');

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass += 1; }
  catch (e) { fails.push(name + ' → ' + (e && e.message)); }
}
function throwsCode(fn, code) {
  try { fn(); }
  catch (e) {
    assert.ok(e instanceof PublicationError, 'סוג לא צפוי: ' + e.name + ' ' + e.message);
    assert.strictEqual(e.code, code, 'קוד ' + e.code + ' במקום ' + code);
    return;
  }
  throw new Error('לא נזרקה שגיאה, ציפיתי ל-' + code);
}

const AT = '2026-09-01T12:00:00.000Z';
const CLOCK = () => AT;
/** גיבוב דטרמיניסטי ופשוט — מוזרק, כמו בייצור. */
function HASH(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return 'h' + h.toString(16);
}
const RULES = { max_attempts: 3, retry_backoff_ms: [1000, 5000] };
const mk = (over) => createPublication(Object.assign({ clock: CLOCK, hash: HASH, rules: RULES }, over || {}));

function plan(rows) {
  return {
    kind: 'schedule-plan', station_id: '102', source_snapshot: 'snap_1',
    source_version: 'v1', contract_station_id: '102', source_revision: 'r17',
    source_digest: 'source-digest-v1', policy_version: 'v1', policy_digest: 'policy-digest-v1',
    source_complete: true, rows,
    summary: { blocking_gaps: 0, days_below_minimum: 0, rejected_manual: 0 }
  };
}

function publicationInput(over) {
  const hasPrevious = Boolean(over && Object.prototype.hasOwnProperty.call(over, 'previous') && over.previous !== null);
  return Object.assign({
    publication_id: 'pub_default', publication_revision: hasPrevious ? 2 : 1,
    source_draft_id: 'draft_1', previous_publication_id: hasPrevious ? 'pub_previous' : null, actor: 'רמי'
  }, over || {});
}
function row(date, sub, label, slots, group) {
  return {
    date, station_id: '102', sub_station: sub, label,
    rotation_group: group === undefined ? null : group,
    slots, complete: true
  };
}
function slot(person, role, label, over) {
  return Object.assign({ person, role, label }, over || {});
}
function event(over) {
  return Object.assign({
    station_id: '102', source_snapshot: 'snap_1', source_version: 'v1'
  }, over || {});
}

const P1 = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג'), slot('רון', 'team_cmd', 'מפקד צוות')])]);

/* ================= 1. בנייה ================= */

t('בלי clock — סירוב', () => throwsCode(() => createPublication({ hash: HASH, rules: RULES }), 'clock-required'));
t('בלי hash — סירוב', () => throwsCode(() => createPublication({ clock: CLOCK, rules: RULES }), 'hash-required'));
t('בלי rules — סירוב', () => throwsCode(() => createPublication({ clock: CLOCK, hash: HASH }), 'rules-required'));
t('בלי max_attempts — סירוב', () =>
  throwsCode(() => createPublication({ clock: CLOCK, hash: HASH, rules: { retry_backoff_ms: [1] } }), 'rules-attempts'));
t('בלי backoff לכל ניסיון — סירוב', () =>
  throwsCode(() => createPublication({ clock: CLOCK, hash: HASH, rules: { max_attempts: 3, retry_backoff_ms: [1] } }), 'rules-backoff'));
t('המודול אינו מייבא crypto', () => {
  const src = require('fs').readFileSync(__dirname + '/schedule-publication.js', 'utf8');
  assert.strictEqual(/\brequire\s*\(/.test(src), false);
  assert.strictEqual(/Date\.now\(\)/.test(src), false);
});

/* ================= 2. פרסום ראשון וטיוטה שקטה ================= */

t('פרסום ראשון שולח לכל אדם את השיבוצים הראשונים שלו', () => {
  const r = mk().planPublication(publicationInput({ next: P1, previous: null, publication_id: 'pub_1' }));
  assert.strictEqual(r.notifications.length, 2);
  r.notifications.forEach((n) => {
    assert.strictEqual(n.push.title, 'ResQ · הסידור פורסם');
    assert.ok(n.detail.every((x) => x.kind === CHANGE.ASSIGNMENT_ADDED));
  });
  assert.strictEqual(r.publication.first_publication, true);
});

t('פרסום ראשון כולל גם אירוע אישי לאדם שאין לו משמרת', () => {
  const r = mk().planPublication(publicationInput({
    next: P1,
    previous: null,
    next_events: [event({ id: 'course_1', title: 'קורס', date: '2026-09-02', people: ['גיא'] })],
    publication_id: 'pub_first_event',
    actor: 'רמי'
  }));
  const mine = r.notifications.find((n) => n.person === 'גיא');
  assert.ok(mine);
  assert.deepStrictEqual(mine.detail.map((x) => x.kind), [CHANGE.EVENT_ASSIGNED]);
});

t('אי אפשר לפרסם תוכנית עם חוסר חוסם', () => {
  const bad = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג')])]);
  bad.summary.blocking_gaps = 1;
  throwsCode(() => mk().planPublication(publicationInput({
    next: bad, previous: null, publication_id: 'blocked', actor: 'רמי'
  })), 'plan-not-publishable');
});

t('אי אפשר לפרסם תוכנית עם שיבוץ ידני שנדחה', () => {
  const bad = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג')])]);
  bad.summary.rejected_manual = 1;
  throwsCode(() => mk().planPublication(publicationInput({
    next: bad, previous: null, publication_id: 'rejected', actor: 'רמי'
  })), 'plan-not-publishable');
});

t('אי אפשר לפרסם שורה שלא הושלמה', () => {
  const bad = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג')])]);
  bad.rows[0].complete = false;
  throwsCode(() => mk().planPublication(publicationInput({
    next: bad, previous: null, publication_id: 'open-row', actor: 'רמי'
  })), 'plan-not-publishable');
});

t('אין שינוי — אין התראות', () => {
  const r = mk().planPublication(publicationInput({ next: P1, previous: P1, publication_id: 'pub_2', actor: 'רמי' }));
  assert.strictEqual(r.notifications.length, 0);
});

t('אין בקוד שום שליחה בפועל', () => {
  const src = require('fs').readFileSync(__dirname + '/schedule-publication.js', 'utf8');
  assert.strictEqual(/sendMulticast|sendEachForMulticast|messaging\(\)|fetch\(/.test(src), false);
});

/* ================= 3. איתור שינוי ================= */

function changeKinds(prev, next, evPrev, evNext) {
  const r = mk().planPublication(publicationInput({
    next, previous: prev, previous_events: evPrev, next_events: evNext,
    publication_id: 'pub_x', actor: 'רמי'
  }));
  const map = {};
  r.notifications.forEach((n) => { map[n.person] = n.detail.map((x) => x.kind); });
  return map;
}

t('הוספת שיבוץ', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג'), slot('רון', 'team_cmd', 'מפקד צוות'), slot('גיא', 'driver', 'נהג')])]);
  assert.ok(changeKinds(P1, next)['גיא'].indexOf(CHANGE.ASSIGNMENT_ADDED) > -1);
});

t('הסרת שיבוץ', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג')])]);
  assert.ok(changeKinds(P1, next)['רון'].indexOf(CHANGE.ASSIGNMENT_REMOVED) > -1);
});

t('שינוי תחנת קצה', () => {
  const next = plan([
    row('2026-09-01', 'eilat', 'אילת', [slot('רון', 'team_cmd', 'מפקד צוות')]),
    row('2026-09-01', 'timna', 'תמנע', [slot('דן', 'driver', 'נהג')])
  ]);
  assert.ok(changeKinds(P1, next)['דן'].indexOf(CHANGE.SUB_STATION_CHANGED) > -1);
});

t('שינוי תפקיד', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'team_cmd', 'מפקד צוות'), slot('רון', 'team_cmd', 'מפקד צוות')])]);
  assert.ok(changeKinds(P1, next)['דן'].indexOf(CHANGE.ROLE_CHANGED) > -1);
});

t('שינוי שעות', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג', { hours: '07:00-19:00' }), slot('רון', 'team_cmd', 'מפקד צוות')])]);
  assert.ok(changeKinds(P1, next)['דן'].indexOf(CHANGE.HOURS_CHANGED) > -1);
});

t('שינוי משמרת', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג', { shift: 'לילה' }), slot('רון', 'team_cmd', 'מפקד צוות')])]);
  assert.ok(changeKinds(P1, next)['דן'].indexOf(CHANGE.SHIFT_CHANGED) > -1);
});

t('שינוי סבב', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג'), slot('רון', 'team_cmd', 'מפקד צוות')], 'ב')]);
  assert.ok(changeKinds(P1, next)['דן'].indexOf(CHANGE.ROTATION_CHANGED) > -1);
});

t('שינוי בהרכב הצוות', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג'), slot('גיא', 'team_cmd', 'מפקד צוות')])]);
  assert.ok(changeKinds(P1, next)['דן'].indexOf(CHANGE.CREW_CHANGED) > -1, 'לא זוהה שינוי צוות');
});

t('ביטול שיבוץ והחזרתו', () => {
  const cancelled = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג', { cancelled: true }), slot('רון', 'team_cmd', 'מפקד צוות')])]);
  assert.ok(changeKinds(P1, cancelled)['דן'].indexOf(CHANGE.ASSIGNMENT_CANCELLED) > -1);
  assert.ok(changeKinds(cancelled, P1)['דן'].indexOf(CHANGE.ASSIGNMENT_RESTORED) > -1);
});

t('שיבוץ לאירוע', () => {
  const ev = [event({ id: 'e1', title: 'השתלמות', date: '2026-09-03', hours: '08:00-15:00', people: ['דן'] })];
  assert.ok(changeKinds(P1, P1, [], ev)['דן'].indexOf(CHANGE.EVENT_ASSIGNED) > -1);
});

t('שינוי אירוע', () => {
  const a = [event({ id: 'e1', title: 'השתלמות', date: '2026-09-03', hours: '08:00-15:00', people: ['דן'] })];
  const b = [event({ id: 'e1', title: 'השתלמות', date: '2026-09-04', hours: '08:00-15:00', people: ['דן'] })];
  assert.ok(changeKinds(P1, P1, a, b)['דן'].indexOf(CHANGE.EVENT_CHANGED) > -1);
});

t('ביטול אירוע', () => {
  const a = [event({ id: 'e1', title: 'אבטחה', date: '2026-09-03', people: ['דן'] })];
  assert.ok(changeKinds(P1, P1, a, [])['דן'].indexOf(CHANGE.EVENT_CANCELLED) > -1);
});

t('אירוע מסומן כמבוטל', () => {
  const a = [event({ id: 'e1', title: 'אבטחה', date: '2026-09-03', people: ['דן'] })];
  const b = [event({ id: 'e1', title: 'אבטחה', date: '2026-09-03', people: ['דן'], cancelled: true })];
  assert.ok(changeKinds(P1, P1, a, b)['דן'].indexOf(CHANGE.EVENT_CANCELLED) > -1);
});

t('מי שלא נגעו בו אינו מקבל התראה', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג'), slot('רון', 'team_cmd', 'מפקד צוות'), slot('גיא', 'driver', 'נהג')])]);
  const r = mk().planPublication(publicationInput({ next, previous: P1, publication_id: 'p', actor: 'רמי' }));
  const people = r.notifications.map((n) => n.person);
  // דן ורון קיבלו שינוי צוות, גיא הוא החדש. איש מלבד השלושה אינו קיים.
  assert.deepStrictEqual(people.slice().sort(), ['גיא', 'דן', 'רון']);
});

/* ================= 4. פוש אחד מרוכז ================= */

t('שלושה שינויים לאדם — התראה אחת', () => {
  const next = plan([
    row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'team_cmd', 'מפקד צוות'), slot('רון', 'team_cmd', 'מפקד צוות')]),
    row('2026-09-02', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג')])
  ]);
  const prev = plan([
    row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג'), slot('רון', 'team_cmd', 'מפקד צוות')])
  ]);
  const r = mk().planPublication(publicationInput({ next, previous: prev, publication_id: 'p', actor: 'רמי' }));
  const mine = r.notifications.filter((n) => n.person === 'דן');
  assert.strictEqual(mine.length, 1, 'נשלחו ' + mine.length + ' התראות במקום אחת');
  assert.ok(mine[0].change_count >= 2);
  assert.ok(mine[0].push.body.indexOf('שינויים') > -1);
});

t('שינוי אחד — נוסח יחיד', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'team_cmd', 'מפקד צוות'), slot('רון', 'team_cmd', 'מפקד צוות')])]);
  const r = mk().planPublication(publicationInput({ next, previous: P1, publication_id: 'p', actor: 'רמי' }));
  const mine = r.notifications.filter((n) => n.person === 'דן')[0];
  assert.strictEqual(mine.push.body, 'שינוי אחד בסידור שלך');
});

t('לחיצה פותחת את הסידור שלי', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'team_cmd', 'מפקד צוות'), slot('רון', 'team_cmd', 'מפקד צוות')])]);
  const r = mk().planPublication(publicationInput({ next, previous: P1, publication_id: 'p', actor: 'רמי' }));
  assert.strictEqual(r.notifications[0].push.route, 'my-schedule');
});

t('ההתראה נוקבת במי שינה', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'team_cmd', 'מפקד צוות'), slot('רון', 'team_cmd', 'מפקד צוות')])]);
  const r = mk().planPublication(publicationInput({ next, previous: P1, publication_id: 'p', actor: 'רמי מושיק' }));
  assert.strictEqual(r.notifications[0].changed_by, 'רמי מושיק');
});

t('בלי מי שמפרסם — סירוב', () =>
  throwsCode(() => mk().planPublication(publicationInput({ next: P1, previous: null, publication_id: 'p', actor: '' })), 'actor-required'));

/* ================= 5. אין דליפה במסך הנעילה ================= */

t('מטען הפוש מכיל אך ורק את שדות רשימת ההיתר', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'team_cmd', 'מפקד צוות'), slot('רון', 'team_cmd', 'מפקד צוות')])]);
  const r = mk().planPublication(publicationInput({ next, previous: P1, publication_id: 'p', actor: 'רמי' }));
  r.notifications.forEach((n) => n.push.items.forEach((item) => {
    assert.deepStrictEqual(Object.keys(item).sort(), PUSH_FIELDS.slice().sort(),
      'מטען עם שדות אחרים: ' + Object.keys(item).join(','));
  }));
});

t('אין שמות של אנשים אחרים במטען הפוש — גם בשינוי צוות', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג'), slot('גיא_סודי', 'team_cmd', 'מפקד צוות')])]);
  const r = mk().planPublication(publicationInput({ next, previous: P1, publication_id: 'p', actor: 'רמי' }));
  const mine = r.notifications.filter((n) => n.person === 'דן')[0];
  const json = JSON.stringify(mine.push);
  assert.strictEqual(json.indexOf('גיא_סודי'), -1, 'שם של אדם אחר דלף לפוש');
  assert.strictEqual(json.indexOf('רון'), -1, 'שם של אדם אחר דלף לפוש');
});

t('שם האדם עצמו אינו חלק ממטען הפוש', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'team_cmd', 'מפקד צוות'), slot('רון', 'team_cmd', 'מפקד צוות')])]);
  const r = mk().planPublication(publicationInput({ next, previous: P1, publication_id: 'p', actor: 'רמי' }));
  const mine = r.notifications.filter((n) => n.person === 'דן')[0];
  assert.strictEqual(JSON.stringify(mine.push.items).indexOf('דן'), -1);
});

t('כותרת אירוע חופשית אינה יוצאת למסך הנעילה', () => {
  const title = 'בדיקה רפואית פרטית';
  const r = mk().planPublication(publicationInput({
    next: P1,
    previous: P1,
    next_events: [event({ id: 'private_1', title, date: '2026-09-03', people: ['דן'] })],
    publication_id: 'private-title',
    actor: 'רמי'
  }));
  assert.strictEqual(JSON.stringify(r.notifications[0].push).indexOf(title), -1);
  assert.deepStrictEqual(Object.keys(r.notifications[0].push.items[0]).sort(), PUSH_FIELDS.slice().sort());
});

t('התראה גדולה נחתכת לגודל בטוח ומדווחת כמה שינויים הושמטו', () => {
  const rows = [];
  for (let i = 0; i < 500; i += 1) {
    rows.push(row('D' + String(i).padStart(3, '0'), 'eilat', 'אילת', [slot('דן', 'driver', 'נהג')]));
  }
  const next = plan(rows);
  const r = mk().planPublication(publicationInput({ next, previous: plan([]), publication_id: 'large', actor: 'רמי' }));
  const push = r.notifications[0].push;
  assert.strictEqual(push.items.length, 20);
  assert.strictEqual(push.truncated_changes, 480);
  assert.ok(Buffer.byteLength(JSON.stringify(push), 'utf8') <= 3500);
});

t('שדה אסור בקלט אינו מגיע לפוש', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [
    slot('דן', 'team_cmd', 'מפקד צוות', { reason: 'ניתוח גב', absence_kind: 'sick' }),
    slot('רון', 'team_cmd', 'מפקד צוות')])]);
  const r = mk().planPublication(publicationInput({ next, previous: P1, publication_id: 'p', actor: 'רמי' }));
  const json = JSON.stringify(r.notifications.map((n) => n.push));
  assert.strictEqual(json.indexOf('ניתוח גב'), -1);
  FORBIDDEN_KEYS.forEach((k) => assert.strictEqual(json.indexOf('"' + k + '"'), -1, 'מפתח אסור: ' + k));
});

t('הפירוט הפנימי כן מכיל את הצוות — הוא לא במסך הנעילה', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג'), slot('גיא', 'team_cmd', 'מפקד צוות')])]);
  const r = mk().planPublication(publicationInput({ next, previous: P1, publication_id: 'p', actor: 'רמי' }));
  const mine = r.notifications.filter((n) => n.person === 'דן')[0];
  const crewChange = mine.detail.filter((x) => x.kind === CHANGE.CREW_CHANGED)[0];
  assert.ok(crewChange && crewChange.crew.indexOf('גיא') > -1);
});

/* ================= 6. לחיצה כפולה ================= */

t('אותו מזהה ואותו תוכן — אין פרסום שני ואין התראה שנייה', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'team_cmd', 'מפקד צוות'), slot('רון', 'team_cmd', 'מפקד צוות')])]);
  const first = mk().planPublication(publicationInput({ next, previous: P1, publication_id: 'pub_7', actor: 'רמי' }));
  assert.ok(first.notifications.length > 0);
  const again = mk().planPublication(publicationInput({
    next, previous: P1, publication_id: 'pub_7', actor: 'רמי',
    existing_publication: first.publication
  }));
  assert.strictEqual(again.duplicate, true);
  assert.strictEqual(again.notifications.length, 0);
  assert.strictEqual(again.audit.action, 'publish_duplicate_ignored');
});

t('אותו מזהה עם תוכן אחר — סירוב מפורש', () => {
  const a = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג')])]);
  const b = plan([row('2026-09-01', 'eilat', 'אילת', [slot('רון', 'driver', 'נהג')])]);
  const first = mk().planPublication(publicationInput({ next: a, previous: P1, publication_id: 'pub_8', actor: 'רמי' }));
  throwsCode(() => mk().planPublication(publicationInput({
    next: b, previous: P1, publication_id: 'pub_8', actor: 'רמי', existing_publication: first.publication
  })), 'publication-conflict');
});

t('מפתח ייחוד לכל אדם ולכל פרסום', () => {
  const next = plan([row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'team_cmd', 'מפקד צוות'), slot('רון', 'team_cmd', 'מפקד צוות')])]);
  const r = mk().planPublication(publicationInput({ next, previous: P1, publication_id: 'pub_9', actor: 'רמי' }));
  const keys = r.notifications.map((n) => n.dedupe_key);
  assert.strictEqual(new Set(keys).size, keys.length);
  keys.forEach((k) => assert.ok(k.indexOf('pub_9:') === 0));
  keys.forEach((k) => assert.ok(k.endsWith(':' + r.publication.content_hash)));
});

t('גיבוב יציב — אותו תוכן, אותו גיבוב', () => {
  const a = mk().planPublication(publicationInput({ next: P1, previous: null, publication_id: 'x', actor: 'רמי' }));
  const b = mk().planPublication(publicationInput({ next: P1, previous: null, publication_id: 'x', actor: 'רמי' }));
  assert.strictEqual(a.publication.content_hash, b.publication.content_hash);
});

t('סיכום מתעלם מכפילויות', () => {
  const n = { dedupe_key: 'k', person: 'דן', status: 'queued' };
  const s = mk().summarize([n, n, { dedupe_key: 'k2', person: 'רון', status: 'sent' }]);
  assert.strictEqual(s.total, 2);
  assert.strictEqual(s.duplicates_ignored, 1);
});

/* ================= 7. ניסיון חוזר ================= */

t('כשל ראשון — ניסיון חוזר, והפרסום נשאר תקף', () => {
  const n = { dedupe_key: 'k', person: 'דן', publication_id: 'p', push: {}, detail: [], attempt: 0 };
  const r = mk().planRetry({ notification: n, error_code: 'UNAVAILABLE' });
  assert.strictEqual(r.status, 'retry');
  assert.strictEqual(r.attempt, 1);
  assert.strictEqual(r.publication_still_valid, true);
  assert.strictEqual(r.next_attempt_at, new Date(Date.parse(AT) + 1000).toISOString());
});

t('השהיה גדלה בין ניסיונות', () => {
  const n = { dedupe_key: 'k', person: 'דן', publication_id: 'p', push: {}, detail: [], attempt: 1 };
  const r = mk().planRetry({ notification: n, error_code: 'UNAVAILABLE' });
  assert.strictEqual(r.next_attempt_at, new Date(Date.parse(AT) + 5000).toISOString());
});

t('אחרי מיצוי הניסיונות — dead_letter ולא מחיקה שקטה', () => {
  const n = { dedupe_key: 'k', person: 'דן', publication_id: 'p', push: {}, detail: [], attempt: 2 };
  const r = mk().planRetry({ notification: n, error_code: 'NOT_REGISTERED' });
  assert.strictEqual(r.status, 'dead_letter');
  assert.strictEqual(r.publication_still_valid, true);
  assert.strictEqual(r.last_error, 'NOT_REGISTERED');
});

t('ניסיון חוזר בלי קוד כשל — סירוב', () =>
  throwsCode(() => mk().planRetry({ notification: { dedupe_key: 'k' } }), 'error-code-required'));

t('ניסיון חוזר בלי התראה — סירוב', () =>
  throwsCode(() => mk().planRetry({ error_code: 'X' }), 'notification-required'));

/* ================= 8. אימות קלט ================= */

t('בלי תוכנית — סירוב', () =>
  throwsCode(() => mk().planPublication(publicationInput({ publication_id: 'p', actor: 'a' })), 'plan-required'));
t('בלי publication_id — סירוב', () =>
  throwsCode(() => mk().planPublication(publicationInput({ next: P1, publication_id: '', actor: 'a' })), 'publication-id'));
t('השוואה בין שתי תחנות — סירוב', () => {
  const other = JSON.parse(JSON.stringify(P1));
  other.station_id = '999';
  other.contract_station_id = '999';
  other.rows.forEach((entry) => { entry.station_id = '999'; });
  throwsCode(() => mk().planPublication(publicationInput({ next: P1, previous: other, publication_id: 'p', actor: 'a' })), 'station-mismatch');
});
t('אותו אדם פעמיים באותו תאריך — סירוב', () => {
  const bad = plan([
    row('2026-09-01', 'eilat', 'אילת', [slot('דן', 'driver', 'נהג')]),
    row('2026-09-01', 'timna', 'תמנע', [slot('דן', 'driver', 'נהג')])
  ]);
  throwsCode(() => mk().planPublication(publicationInput({ next: bad, previous: P1, publication_id: 'p', actor: 'a' })), 'duplicate-assignment');
});
t('אירוע בלי מזהה — סירוב', () =>
  throwsCode(() => mk().planPublication(publicationInput({
    next: P1, previous: P1, next_events: [event({ title: 'x', date: '2026-09-01', people: [] })],
    publication_id: 'p', actor: 'a' })), 'event-id'));
t('אירוע מתחנה אחרת — סירוב', () =>
  throwsCode(() => mk().planPublication(publicationInput({
    next: P1, previous: P1,
    next_events: [event({ id: 'foreign', title: 'x', date: '2026-09-01', people: ['דן'], station_id: '999' })],
    publication_id: 'p', actor: 'a' })), 'event-station-mismatch'));
t('אירוע מתמונת מקור אחרת — סירוב', () =>
  throwsCode(() => mk().planPublication(publicationInput({
    next: P1, previous: P1,
    next_events: [event({ id: 'stale', title: 'x', date: '2026-09-01', people: ['דן'], source_snapshot: 'snap_old' })],
    publication_id: 'p', actor: 'a' })), 'event-source-mismatch'));

t('התוצאה קפואה', () => {
  const r = mk().planPublication(publicationInput({ next: P1, previous: null, publication_id: 'p', actor: 'a' }));
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.publication) && Object.isFrozen(r.notifications));
});

console.log((fails.length ? '✗' : '✓') + ' schedule-publication: ' + pass + '/' + (pass + fails.length));
if (fails.length) { fails.forEach((f) => console.log('   ✗ ' + f)); process.exit(1); }
