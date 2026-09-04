// effective-workdays.js — המודול המשותף לארבעת המסכים, בלי DOM ובלי Firebase.
//
// מה נבדק: (1) רשימת ההיתר על תשובת השרת — תשובה פגומה נזרקת ולא
// הופכת ל„אף אחד לא עובד"; (2) worksOn מחזיר שלושה ערכים ולא-ידוע
// לעולם אינו false; (3) מיזוג שני חלונות — סירוב למקור שונה ולחפיפה,
// ורווח בין חלונות = לא-ידוע; (4) בדיקת המנוחה: gain/lose, החלפות
// מאושרות, ויום צמוד לא-ידוע מדווח כ-unknown ולא כחוקי.
import assert from 'node:assert/strict';
import * as W from '../effective-workdays.js?v=42h0';

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('✓ ' + name); }
const throwsCode = (fn, code) => assert.throws(fn, (e) => e && e.code === code);

function answer(over) {
  return { data: Object.assign({
    mode: 'shadow', source: 'legacy', fallback: null,
    from: '2026-08-01', to: '2026-08-31', coverage: { from: '2026-08-01', to: '2026-08-31' },
    unknown_dates: [], unknown_uids: {},
    by_uid: { me: ['2026-08-01', '2026-08-04', '2026-08-07'], u2: ['2026-08-02', '2026-08-05'] },
    shift_hours: { shift_start: '07:00', shift_end: '07:00', shift_hours: 24, hours_source: 'legacy-rotation-config', extra: 'x' },
    provenance: { mode: 'shadow', source: 'legacy' }, generated_at: 'now'
  }, over || {}) };
}

test('תשובה תקינה עוברת; שדות השעות מסוננים לרשימת ההיתר', () => {
  const ctx = W.parseEffectiveWorkdays(answer());
  assert.equal(ctx.mode, 'shadow');
  assert.equal(ctx.byUid.get('me').has('2026-08-04'), true);
  assert.deepEqual(Object.keys(ctx.shiftHours), ['shift_start', 'shift_end', 'shift_hours']);
  assert.deepEqual(W.shiftRotationShim(ctx), { shift_start: '07:00', shift_end: '07:00', shift_hours: 24 });
});

test('תשובה פגומה נזרקת — לא מערכים ריקים', () => {
  throwsCode(() => W.parseEffectiveWorkdays({ data: null }), 'workdays-shape');
  throwsCode(() => W.parseEffectiveWorkdays(answer({ mode: 'live' })), 'workdays-mode');
  throwsCode(() => W.parseEffectiveWorkdays(answer({ source: 'rotation' })), 'workdays-source');
  throwsCode(() => W.parseEffectiveWorkdays(answer({ fallback: 'v2' })), 'workdays-fallback');
  throwsCode(() => W.parseEffectiveWorkdays(answer({ by_uid: [] })), 'workdays-by-uid');
  throwsCode(() => W.parseEffectiveWorkdays(answer({ by_uid: { me: ['2026-09-01'] } })), 'workdays-by-uid');
  throwsCode(() => W.parseEffectiveWorkdays(answer({ unknown_dates: ['x'] })), 'workdays-unknown-dates');
  throwsCode(() => W.parseEffectiveWorkdays(answer({ unknown_uids: { z: 'gone' } })), 'workdays-unknown-uids');
  throwsCode(() => W.parseEffectiveWorkdays(answer({ from: '2026-09-01' })), 'workdays-range');
});

test('worksOn: true · false · unknown — ולא-ידוע לעולם אינו false', () => {
  const ctx = W.parseEffectiveWorkdays(answer({ unknown_dates: ['2026-08-20'], unknown_uids: { gone: 'not-in-roster' } }));
  assert.equal(W.worksOn(ctx, 'me', '2026-08-04'), true);
  assert.equal(W.worksOn(ctx, 'me', '2026-08-05'), false);
  assert.equal(W.worksOn(ctx, 'me', new Date(2026, 7, 4)), true, 'Date מתקבל');
  assert.equal(W.worksOn(ctx, 'me', '2026-08-20'), 'unknown', 'יום מחוץ לכיסוי');
  assert.equal(W.worksOn(ctx, 'me', '2026-09-01'), 'unknown', 'יום מחוץ לטווח');
  assert.equal(W.worksOn(ctx, 'gone', '2026-08-04'), 'unknown', 'אינו בסגל');
  assert.equal(W.worksOn(ctx, 'stranger', '2026-08-04'), 'unknown', 'לא נשאל עליו');
  assert.equal(W.worksOn(null, 'me', '2026-08-04'), 'unknown');
  assert.deepEqual(W.unknownDaysBetween(ctx, '2026-08-19', '2026-09-02'), ['2026-08-20', '2026-09-01', '2026-09-02']);
});

test('מיזוג שני חלונות: איחוד; מקור שונה או חפיפה — סירוב; רווח = לא-ידוע', () => {
  const a = W.parseEffectiveWorkdays(answer({ from: '2026-01-01', to: '2026-03-31', coverage: null, by_uid: { me: ['2026-01-05'] } }));
  const b = W.parseEffectiveWorkdays(answer({ from: '2026-04-02', to: '2026-06-30', coverage: null, by_uid: { me: ['2026-05-05'] } }));
  const m = W.mergeEffectiveWorkdays([a, b]);
  assert.equal(m.from, '2026-01-01'); assert.equal(m.to, '2026-06-30');
  assert.equal(W.worksOn(m, 'me', '2026-01-05'), true);
  assert.equal(W.worksOn(m, 'me', '2026-05-05'), true);
  assert.equal(W.worksOn(m, 'me', '2026-04-01'), 'unknown', 'היום שבין החלונות');
  const c = W.parseEffectiveWorkdays(answer({ from: '2026-03-31', to: '2026-04-30', coverage: null, by_uid: {} }));
  throwsCode(() => W.mergeEffectiveWorkdays([a, c]), 'workdays-merge-overlap');
  const d = W.parseEffectiveWorkdays(answer({ from: '2026-04-02', to: '2026-06-30', coverage: null, by_uid: {}, mode: 'new', source: 'publication', provenance: { mode: 'new', source: 'v2' } }));
  throwsCode(() => W.mergeEffectiveWorkdays([a, d]), 'workdays-merge-source');
  const e = W.parseEffectiveWorkdays(answer({ from: '2026-04-02', to: '2026-06-30', coverage: null, unknown_uids: { me: 'not-in-roster' }, by_uid: {} }));
  const m2 = W.mergeEffectiveWorkdays([a, e]);
  assert.equal(W.worksOn(m2, 'me', '2026-01-05'), 'unknown', 'לא-ידוע בחלון אחד גובר — לא ממציאים ימים');
  throwsCode(() => W.mergeEffectiveWorkdays([]), 'workdays-merge-empty');
  // 421: legacy_digest הוא חתימת תוכן **הטווח** — שונה בין היסטוריה לעתיד גם
  // כשהמקור יציב. זהות המקור (legacy_basis_digest) היא מה שחייב להיות זהה.
  const hist = W.parseEffectiveWorkdays(answer({ from: '2025-09-01', to: '2026-08-31', coverage: null, by_uid: { me: ['2026-08-30'] },
    provenance: { mode: 'shadow', source: 'legacy', legacy_basis_digest: 'B1', legacy_digest: 'R-hist' } }));
  const next = W.parseEffectiveWorkdays(answer({ from: '2026-09-01', to: '2027-08-31', coverage: null, by_uid: { me: ['2026-09-02'] },
    provenance: { mode: 'shadow', source: 'legacy', legacy_basis_digest: 'B1', legacy_digest: 'R-next' } }));
  const both = W.mergeEffectiveWorkdays([hist, next]);
  assert.equal(W.worksOn(both, 'me', '2026-08-30'), true);
  assert.equal(W.worksOn(both, 'me', '2026-09-02'), true);
  assert.equal(W.worksOn(both, 'me', '2026-09-01'), false);
  const otherBasis = W.parseEffectiveWorkdays(answer({ from: '2026-09-01', to: '2027-08-31', coverage: null, by_uid: {},
    provenance: { mode: 'shadow', source: 'legacy', legacy_basis_digest: 'B2', legacy_digest: 'R-next' } }));
  throwsCode(() => W.mergeEffectiveWorkdays([hist, otherBasis]), 'workdays-merge-source');
  const pubA = W.parseEffectiveWorkdays(answer({ from: '2026-09-01', to: '2026-09-30', by_uid: {}, mode: 'new', source: 'publication',
    provenance: { mode: 'new', source: 'v2', publication_id: 'p1', revision: 1, content_digest: 'c1' } }));
  const pubB = W.parseEffectiveWorkdays(answer({ from: '2026-10-01', to: '2026-10-31', coverage: { from: '2026-10-01', to: '2026-10-31' }, by_uid: {}, mode: 'new', source: 'publication',
    provenance: { mode: 'new', source: 'v2', publication_id: 'p2', revision: 1, content_digest: 'c2' } }));
  throwsCode(() => W.mergeEffectiveWorkdays([pubA, pubB]), 'workdays-merge-source');
  assert.equal(W.workdaysSourceIdentity(hist), W.workdaysSourceIdentity(next));
  assert.notEqual(W.workdaysSourceIdentity(hist), W.workdaysSourceIdentity(otherBasis));
});

test('החלפה: gain/lose, החלפות מאושרות, ויום צמוד לא-ידוע', () => {
  const ctx = W.parseEffectiveWorkdays(answer({ unknown_dates: ['2026-08-09'] }));
  // me עובד 1,4,7. מקבל את ה-5 (צמוד ל-4) → הפרה.
  const r = W.swapRestCheckEffective(ctx, [], { uid: 'me', name: 'אני', gain: '2026-08-05', lose: '2026-08-01' },
    { uid: 'u2', name: 'הוא', gain: '2026-08-03', lose: '2026-08-05' });
  assert.deepEqual(r.map((x) => [x.uid, x.days, x.unknown]), [['me', ['2026-08-04'], []], ['u2', ['2026-08-02'], []]]);
  // יום בקצה החלון: השכן שמעבר לחלון אינו ידוע — ולכן לא „חוקי". זו הסיבה
  // שמסך ההחלפות משאיר יום שלם מכל צד של טווח הבחירה.
  const edge = W.swapRestCheckEffective(ctx, [], { uid: 'u2', name: 'הוא', gain: '2026-08-01', lose: '2026-08-05' }, null);
  assert.deepEqual(edge, [{ uid: 'u2', name: 'הוא', gain: '2026-08-01', days: ['2026-08-02'], unknown: ['2026-07-31'] }]);
  // ויתור על היום הצמוד מנקה.
  assert.equal(W.wouldWorkEffective(ctx, [], 'me', '2026-08-04', '2026-08-05', '2026-08-04'), false);
  // החלפה מאושרת אחרת שנתנה לו את ה-3 → הפרה סביב ה-4? לא: ה-4 הוא היום שלו ממילא; סביב ה-2:
  const approved = [{ status: 'approved', from_uid: 'x', from_date: '2026-08-03', to_uid: 'me', to_date: '2026-08-20' }];
  assert.equal(W.wouldWorkEffective(ctx, approved, 'me', '2026-08-03', null, null), true, 'נכנס בהחלפה מאושרת');
  assert.equal(W.wouldWorkEffective(ctx, approved, 'me', '2026-08-20', null, null), false, 'יצא בהחלפה מאושרת');
  // יום צמוד לא ידוע (9.8): מקבל את ה-8 → סביבו 7 (עובד → הפרה) ו-9 (לא ידוע).
  const u = W.restConflictsEffective(ctx, [], 'me', '2026-08-08', null);
  assert.deepEqual(u, { days: ['2026-08-07'], unknown: ['2026-08-09'] });
  const v = W.swapRestCheckEffective(ctx, [], { uid: 'u2', name: 'הוא', gain: '2026-08-10', lose: '2026-08-02' }, null);
  assert.deepEqual(v, [{ uid: 'u2', name: 'הוא', gain: '2026-08-10', days: [], unknown: ['2026-08-09'] }]);
  assert.match(W.restWhyEffective(v[0]), /מחוץ לסידור המפורסם/);
  assert.match(W.restWhyEffective(r[0]), /48 שעות רצוף/);
});

test('UID בשם __proto__/constructor — מפתח רגיל, לא ירושה, בשני הכיוונים', () => {
  const ctx = W.parseEffectiveWorkdays(answer({ by_uid: JSON.parse('{"__proto__":["2026-08-03"],"constructor":[]}'),
    unknown_uids: JSON.parse('{"prototype":"not-in-roster"}') }));
  assert.equal(W.worksOn(ctx, '__proto__', '2026-08-03'), true);
  assert.equal(W.worksOn(ctx, 'constructor', '2026-08-03'), false);
  assert.equal(W.worksOn(ctx, 'prototype', '2026-08-03'), 'unknown');
  assert.equal(W.worksOn(ctx, 'toString', '2026-08-03'), 'unknown');
  assert.equal(Object.getPrototypeOf(ctx.unknownUids), null);
  const m = W.mergeEffectiveWorkdays([ctx]);
  assert.equal(W.worksOn(m, '__proto__', '2026-08-03'), true);
  assert.equal(({}).prototype, undefined);
});

test('תווית מקור', () => {
  assert.equal(W.workdaysSourceLabel(W.parseEffectiveWorkdays(answer())), 'הסידור הקיים');
  assert.equal(W.workdaysSourceLabel(W.parseEffectiveWorkdays(answer({ mode: 'new', source: 'publication' }))), 'הסידור המפורסם');
  assert.equal(W.workdaysSourceLabel(W.parseEffectiveWorkdays(answer({ mode: 'new', fallback: 'legacy' }))), 'הסידור הקיים (אין פרסום פעיל)');
});

console.log('\n' + passed + ' effective-workdays client checks passed.');
