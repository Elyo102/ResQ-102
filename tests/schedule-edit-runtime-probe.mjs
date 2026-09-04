/* ====================================================================
 *  schedule-edit-runtime-probe · 42H.2 חבילה א׳ — עריכת סידור שפורסם,
 *  על ה-runtime האמיתי מול Firestore בזיכרון (לא אמולטור).
 *
 *  מסלול: גיליון סינתטי → ייבוא → פרסום ב-new (revision 1) →
 *  previewScheduleEdit (דוח בלי כתיבה) → applyScheduleEdit (טיוטה נגזרת
 *  → publish → revision 2, CAS, יומן, outbox — פוש אחד לאדם) → הלוח
 *  מציג את השינוי → rollback הקיים מחזיר את revision 1.
 *
 *  יציאה: 0 עבר · 1 נכשל · 2 לא רץ.
 * ==================================================================== */

import { createFakeDb, seed, req, ST, SID, MGR, makeChecks, publishImportedSchedule } from './_schedule-fake.mjs';

const { ok, eq, rejectsCode, finish } = makeChecks();
const ROLLBACK_REASON = 'wrong_assignment';

function expectedOf(pointer) {
  return { publication_id: pointer.publication_id, revision: pointer.revision, content_digest: pointer.content_digest };
}
function outboxOf(db, pubId) {
  return db._paths(ST + '/schedule_publications/' + pubId + '/schedule_outbox/').map((p) => db._get(p));
}
function auditOf(db) {
  return db._paths(ST + '/schedule_audit/').map((p) => db._get(p));
}

/* 1 · שערים */
{
  const db = createFakeDb();
  const { rt } = await seed(db);
  // עדיין shadow, אין פרסום פעיל
  await rejectsCode('1.1 previewScheduleEdit דורש אחראי סידור', () => rt.previewScheduleEdit(req({ expected: { publication_id: 'p_x', revision: 1, content_digest: 'd' }, edits: [] }, 'u1')), 'manager-required');
  await rejectsCode('1.2 applyScheduleEdit דורש אחראי סידור', () => rt.applyScheduleEdit(req({ request_id: 'e1', expected: { publication_id: 'p_x', revision: 1, content_digest: 'd' }, edits: [] }, 'u1')), 'manager-required');
  await rejectsCode('1.3 ב-shadow אין עריכת פרסום (אין פרסום פעיל)', () => rt.previewScheduleEdit(req({ expected: { publication_id: 'p_x', revision: 1, content_digest: 'd' }, edits: [{ kind: 'unassign', uid: 'u1', dates: ['2026-09-01'] }] })), 'schedule-mode-blocked');
  const { pointer } = await publishImportedSchedule(db, rt);
  ok('1.4 יש פרסום פעיל revision 1', pointer && pointer.revision === 1, JSON.stringify(pointer));
  await rejectsCode('1.5 בלי בסיס (expected) — נדחה', () => rt.previewScheduleEdit(req({ edits: [{ kind: 'unassign', uid: 'u1', dates: ['2026-09-01'] }] })), 'edit-base-required');
  await rejectsCode('1.6 בסיס שאינו הפרסום הפעיל → edit-base-stale', () => rt.previewScheduleEdit(req({ expected: Object.assign(expectedOf(pointer), { revision: 7 }), edits: [{ kind: 'unassign', uid: 'u1', dates: ['2026-09-01'] }] })), 'edit-base-stale');
  await rejectsCode('1.7 בלי עריכות — נדחה', () => rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits: [] })), 'edits-required');
  await rejectsCode('1.8 תאריך מחוץ לפרסום', () => rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits: [{ kind: 'unassign', uid: 'u1', dates: ['2026-10-01'] }] })), 'edit-date-outside');
  await rejectsCode('1.9 אדם שאינו במקור', () => rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits: [{ kind: 'assign', uid: 'ghost', dates: ['2026-09-01'], sub_station: 'eilat' }] })), 'edit-person-unknown');
}

/* 2 · דוח → ביצוע → revision חדש, יומן, outbox, לוח, rollback */
{
  const db = createFakeDb();
  const { rt } = await seed(db);
  const { pointer, published } = await publishImportedSchedule(db, rt);
  const before = await rt.getStationRange(req({ from: '2026-09-01', to: '2026-09-03' }, 'u2'));
  const eilat1 = before.days[0].sub_stations.find((s) => s.sub_station === 'eilat');
  ok('2.0 מצב התחלה: u1 באילת ב-1.9', eilat1.people.some((p) => p.uid === 'u1'), JSON.stringify(eilat1.people.map((p) => p.uid)));
  const drafts = () => db._paths(ST + '/schedule_drafts').filter((k) => k.split('/').length === 4).length;
  const draftsBefore = drafts();
  const edits = [
    { kind: 'assign', uid: 'u1', dates: ['2026-09-01', '2026-09-02'], sub_station: 'shahmon' },   // העברה + הוספה
    { kind: 'absence', uid: 'u2', dates: ['2026-09-03'], absence: { kind: 'leave', location: 'abroad' } },
    { kind: 'unassign', uid: 'u3', dates: ['2026-09-01'] }
  ];
  const report = await rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits }));
  eq('2.1 דוח: 4 שינויים ל-3 אנשים', [report.counts.changes, report.counts.people, report.people_changed.map((p) => p.uid)], [4, 3, ['u1', 'u2', 'u3']]);
  ok('2.2 שמות בדוח', report.changes.every((c) => typeof c.name === 'string' && c.name.length > 1));
  eq('2.3 הודעות מתוכננות — לפחות למי ששובץ/הוסר (היעדרות אינה נדחפת)', report.notifications >= 2, true);
  eq('2.4 גרסה צפויה', report.next_revision, 2);
  ok('2.5 חתימת עריכה', typeof report.edit_digest === 'string' && report.edit_digest.length === 64);
  eq('2.6 הדוח אינו כותב', [drafts(), db._get(ST + '/schedule_state/active').revision], [draftsBefore, 1]);
  const belowBefore = report.below_minimum.length;
  ok('2.7 קו אדום מדווח, לא חוסם', belowBefore >= 1, JSON.stringify(report.below_minimum));

  await rejectsCode('2.8 ביצוע בלי חתימת הדוח → edit-report-stale', () => rt.applyScheduleEdit(req({ request_id: 'e2', expected: expectedOf(pointer), edits })), 'edit-report-stale');
  await rejectsCode('2.9 ביצוע עם עריכות אחרות מהדוח → edit-report-stale', () => rt.applyScheduleEdit(req({ request_id: 'e2', expected: expectedOf(pointer), edits: edits.slice(0, 1), expected_edit_digest: report.edit_digest })), 'edit-report-stale');
  eq('2.10 לא נוצרה טיוטה מהניסיונות שנדחו', drafts(), draftsBefore);

  const applied = await rt.applyScheduleEdit(req({ request_id: 'e2', expected: expectedOf(pointer), edits, expected_edit_digest: report.edit_digest }));
  eq('2.11 פורסם revision 2, לא כפילות', [applied.duplicate, applied.revision, typeof applied.publication_id], [false, 2, 'string']);
  const active = db._get(ST + '/schedule_state/active');
  eq('2.12 המצביע זז לפרסום החדש', [active.publication_id, active.revision, active.previous_publication_id], [applied.publication_id, 2, pointer.publication_id]);
  const pub = db._get(ST + '/schedule_publications/' + applied.publication_id);
  eq('2.13 הפרסום מסומן כערוך עם בסיס', [pub.edited, pub.edit_base.publication_id, pub.edit_base.revision, pub.status], [true, pointer.publication_id, 1, 'active']);
  const oldPub = db._get(ST + '/schedule_publications/' + pointer.publication_id);
  ok('2.14 הפרסום הקודם לא שונה (snapshot בלתי משתנה)', oldPub.content_digest === pointer.content_digest && oldPub.status === 'active' && published.publication_id === pointer.publication_id, JSON.stringify([oldPub.content_digest === pointer.content_digest, oldPub.status]));
  const draft = db._get(ST + '/schedule_drafts/' + applied.draft_id);
  eq('2.15 הטיוטה הנגזרת: edited, בסיס, סיכום', [draft.edited, draft.edit_base.revision, draft.edit_summary.changes, draft.edit_summary.people], [true, 1, 4, ['u1', 'u2', 'u3']]);

  const audit = auditOf(db);
  const editAudit = audit.find((a) => a.action === 'edit-draft');
  const publishAudit = audit.find((a) => a.action === 'publish' && a.revision === 2);
  ok('2.16 יומן: edit-draft עם לפני/אחרי לכל אדם ויום, מזהים בלבד', editAudit && editAudit.change_count === 4 && editAudit.changes.every((c) => c.uid && c.date && c.before && c.after && !c.name), JSON.stringify(editAudit));
  ok('2.17 יומן: publish עם edited_from', publishAudit && publishAudit.edited_from.publication_id === pointer.publication_id && publishAudit.edit_changes === 4, JSON.stringify(publishAudit));
  ok('2.18 היומן לא מכיל שמות', JSON.stringify(audit).indexOf('רועי') === -1 && JSON.stringify(audit).indexOf('דניאל') === -1);

  const outbox = outboxOf(db, applied.publication_id);
  const perPerson = outbox.reduce((m, n) => { m[n.person] = (m[n.person] || 0) + 1; return m; }, {});
  ok('2.19 outbox: הודעה אחת בדיוק לכל אדם שהשתנה', Object.values(perPerson).every((n) => n === 1) && perPerson.u1 === 1 && perPerson.u3 === 1, JSON.stringify(perPerson));
  ok('2.20 u1 קיבל הודעה מסכמת אחת שמכילה את כל השינויים שלו (העברה ב-1.9 + הוספה ב-2.9)', outbox.filter((n) => n.person === 'u1').length === 1 && outbox.find((n) => n.person === 'u1').detail.some((d) => d.date === '2026-09-01') && outbox.find((n) => n.person === 'u1').detail.some((d) => d.date === '2026-09-02'), JSON.stringify(outbox.find((n) => n.person === 'u1')));
  ok('2.21 ההודעות שוחררו (לא blocked)', outbox.every((n) => n.status !== 'blocked'), JSON.stringify(outbox.map((n) => n.status)));

  const after = await rt.getStationRange(req({ from: '2026-09-01', to: '2026-09-03' }, 'u2'));
  const d1 = after.days[0];
  eq('2.22 הלוח: u1 בשחמון ב-1.9, לא באילת', [d1.sub_stations.find((s) => s.sub_station === 'shahmon').people.some((p) => p.uid === 'u1'), d1.sub_stations.find((s) => s.sub_station === 'eilat').people.some((p) => p.uid === 'u1')], [true, false]);
  eq('2.23 הלוח: u3 הוסר מ-1.9', d1.sub_stations.some((s) => s.people.some((p) => p.uid === 'u3')), false);
  eq('2.24 הלוח: היעדרות u2 ב-3.9 חו"ל', after.days[2].absences.filter((a) => a.uid === 'u2').map((a) => a.kind + ':' + a.location), ['leave:abroad']);
  eq('2.25 revision בלוח', after.revision, 2);

  // ניסיון חוזר — אותה בקשה: אותה קבלה, אין revision 3.
  const again = await rt.applyScheduleEdit(req({ request_id: 'e2', expected: expectedOf(pointer), edits, expected_edit_digest: report.edit_digest }));
  eq('2.26 ניסיון חוזר → duplicate, אותו פרסום, revision נשאר 2', [again.duplicate, again.publication_id, db._get(ST + '/schedule_state/active').revision], [true, applied.publication_id, 2]);
  await rejectsCode('2.27 אותו request_id עם עריכה אחרת → request-conflict', () => rt.applyScheduleEdit(req({ request_id: 'e2', expected: expectedOf(pointer), edits: edits.slice(0, 1), expected_edit_digest: 'x' })), 'request-conflict');

  // עריכה נוספת על הבסיס הישן (revision 1) — נדחית: הבסיס כבר לא פעיל.
  await rejectsCode('2.28 עריכה על בסיס ישן → edit-base-stale', () => rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits: [{ kind: 'unassign', uid: 'u1', dates: ['2026-09-01'] }] })), 'edit-base-stale');

  // rollback הקיים מחזיר את revision 1 כ-revision 3.
  const rolled = await rt.rollback(req({ request_id: 'rb1', target_publication_id: pointer.publication_id, expected_active_publication_id: applied.publication_id, reason_code: ROLLBACK_REASON }));
  ok('2.29 rollback עובד על פרסום ערוך', rolled && rolled.publication_id, JSON.stringify(rolled));
  const back = await rt.getStationRange(req({ from: '2026-09-01', to: '2026-09-01' }, 'u2'));
  eq('2.30 אחרי rollback: u1 חזר לאילת', back.days[0].sub_stations.find((s) => s.sub_station === 'eilat').people.some((p) => p.uid === 'u1'), true);
}

/* 3 · מרוצים: הבסיס משתנה בין הדוח לביצוע; מינוי שבוטל; עריכה ללא שינוי */
{
  const db = createFakeDb();
  const { rt } = await seed(db);
  const { pointer } = await publishImportedSchedule(db, rt);
  const edits = [{ kind: 'unassign', uid: 'u1', dates: ['2026-09-01'] }];
  const report = await rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits }));
  // עריכה מתחרה שהתפרסמה בינתיים
  const other = await rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits: [{ kind: 'unassign', uid: 'u2', dates: ['2026-09-01'] }] }));
  await rt.applyScheduleEdit(req({ request_id: 'e-other', expected: expectedOf(pointer), edits: [{ kind: 'unassign', uid: 'u2', dates: ['2026-09-01'] }], expected_edit_digest: other.edit_digest }));
  await rejectsCode('3.1 הבסיס הוחלף בין הדוח לביצוע → edit-base-stale, בלי טיוטה', () => rt.applyScheduleEdit(req({ request_id: 'e3', expected: expectedOf(pointer), edits, expected_edit_digest: report.edit_digest })), 'edit-base-stale');
  eq('3.2 revision נשאר 2', db._get(ST + '/schedule_state/active').revision, 2);

  const pointer2 = db._get(ST + '/schedule_state/active');
  const report2 = await rt.previewScheduleEdit(req({ expected: expectedOf(pointer2), edits }));
  // המצביע זז **בתוך** הביצוע — אחרי הדוח ולפני העסקה (מדמה פרסום מקביל).
  const originalTx = db.runTransaction;
  const draftCount = () => db._paths(ST + '/schedule_drafts').filter((k) => k.split('/').length === 4).length;
  const draftsBefore3 = draftCount();
  let bumped = false;
  db.runTransaction = async (fn) => {
    if (!bumped) { bumped = true; db._put(ST + '/schedule_state/active', Object.assign({}, db._get(ST + '/schedule_state/active'), { revision: 9 })); }
    return originalTx.call(db, fn);
  };
  await rejectsCode('3.3 המצביע זז לפני עסקת הטיוטה → edit-base-stale', () => rt.applyScheduleEdit(req({ request_id: 'e4', expected: expectedOf(pointer2), edits, expected_edit_digest: report2.edit_digest })), 'edit-base-stale');
  db.runTransaction = originalTx;
  db._put(ST + '/schedule_state/active', pointer2);
  eq('3.4 לא נוצרה טיוטה', draftCount(), draftsBefore3);

  // מינוי שבוטל רגע לפני העסקה
  db.runTransaction = async (fn) => { db._del(ST + '/schedule_access/' + MGR); return originalTx.call(db, fn); };
  await rejectsCode('3.5 מינוי שבוטל → manager-revoked', () => rt.applyScheduleEdit(req({ request_id: 'e5', expected: expectedOf(pointer2), edits, expected_edit_digest: report2.edit_digest })), 'manager-revoked');
  db.runTransaction = originalTx;
  db._put(ST + '/schedule_access/' + MGR, { schema_version: 1, station_id: SID, uid: MGR, roles: ['schedule_manager'], active: true, revision: 1 });
  eq('3.6 revision עדיין 2', db._get(ST + '/schedule_state/active').revision, 2);

  // עריכה שאינה משנה דבר
  const noop = await rt.previewScheduleEdit(req({ expected: expectedOf(pointer2), edits: [{ kind: 'unassign', uid: 'u2', dates: ['2026-09-01'] }] }));
  eq('3.7 דוח ריק', [noop.counts.changes, noop.notifications], [0, 0]);
  await rejectsCode('3.8 ביצוע עריכה ריקה → edit-no-changes', () => rt.applyScheduleEdit(req({ request_id: 'e6', expected: expectedOf(pointer2), edits: [{ kind: 'unassign', uid: 'u2', dates: ['2026-09-01'] }], expected_edit_digest: noop.edit_digest })), 'edit-no-changes');

  // תפקיד + מיקום היעדרות + שבוע שלם
  const week = await rt.previewScheduleEdit(req({ expected: expectedOf(pointer2), edits: [
    { kind: 'assign', uid: 'u4', dates: ['2026-09-01', '2026-09-02', '2026-09-03'], sub_station: 'timna', role: 'ff' },
    { kind: 'absence', uid: 'u5', dates: ['2026-09-01', '2026-09-02'], absence: { kind: 'sick' } }
  ] }));
  ok('3.9 שבוע: שינויים ל-u4 (העברה/הוספה) ול-u5', week.people_changed.map((p) => p.uid).indexOf('u4') !== -1 && week.people_changed.map((p) => p.uid).indexOf('u5') !== -1, JSON.stringify(week.people_changed));
  ok('3.10 אזהרה: u5 חולה ומשובץ', week.warnings.some((w) => w.code === 'absent-while-assigned' && w.uid === 'u5'), JSON.stringify(week.warnings));
  const done = await rt.applyScheduleEdit(req({ request_id: 'e7', expected: expectedOf(pointer2), edits: [
    { kind: 'assign', uid: 'u4', dates: ['2026-09-01', '2026-09-02', '2026-09-03'], sub_station: 'timna', role: 'ff' },
    { kind: 'absence', uid: 'u5', dates: ['2026-09-01', '2026-09-02'], absence: { kind: 'sick' } }
  ], expected_edit_digest: week.edit_digest }));
  eq('3.11 revision 3', done.revision, 3);
  const view = await rt.getStation(req({ date: '2026-09-02' }, 'u4'));
  const me = view.day.sub_stations.find((s) => s.sub_station === 'timna').people.find((p) => p.uid === 'u4');
  eq('3.12 הלוח: u4 בתמנע עם התפקיד, מסומן is_me', [!!me, me && me.is_me, me && me.role_label], [true, true, 'ff']);
  eq('3.13 היעדרות u5 מוצגת', view.day.absences.some((a) => a.uid === 'u5' && a.kind === 'sick'), true);
}

finish('schedule-edit runtime probe checks passed');
