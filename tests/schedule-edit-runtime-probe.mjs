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

import { createFakeDb, seed, req, ST, SID, MGR, SHEET, buildRuntime, makeChecks, publishImportedSchedule } from './_schedule-fake.mjs';

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
  // ⭐ ביקורת Codex §2: גם היעדרות היא שינוי בסידור של האדם — u2 מקבל הודעה.
  ok('2.3 הודעות מתוכננות — לפחות לשלושת האנשים שנערכו (כולל היעדרות בלבד, u2) ולצוותים שהשתנו', report.notifications >= 3, String(report.notifications));
  eq('2.4 גרסה צפויה', report.next_revision, 2);
  ok('2.5 חתימת עריכה', typeof report.edit_digest === 'string' && report.edit_digest.length === 64);
  eq('2.6 הדוח אינו כותב', [drafts(), db._get(ST + '/schedule_state/active').revision], [draftsBefore, 1]);
  const belowBefore = report.below_minimum.length;
  ok('2.7 קו אדום מדווח, לא חוסם', belowBefore >= 1, JSON.stringify(report.below_minimum));

  await rejectsCode('2.8 ביצוע בלי חתימת הדוח → edit-report-stale', () => rt.applyScheduleEdit(req({ request_id: 'e2', expected: expectedOf(pointer), edits })), 'edit-report-stale');
  await rejectsCode('2.9 ביצוע עם עריכות אחרות מהדוח → edit-report-stale', () => rt.applyScheduleEdit(req({ request_id: 'e2', expected: expectedOf(pointer), edits: edits.slice(0, 1), expected_edit_digest: report.edit_digest, gap_acknowledgement: report.gaps.digest })), 'edit-report-stale');
  eq('2.10 לא נוצרה טיוטה מהניסיונות שנדחו', drafts(), draftsBefore);

  const applied = await rt.applyScheduleEdit(req({ request_id: 'e2', expected: expectedOf(pointer), edits, expected_edit_digest: report.edit_digest, gap_acknowledgement: report.gaps.digest }));
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
  const u2Push = outbox.find((n) => n.person === 'u2');
  ok('2.19b היעדרות בלבד (u2): הודעה אחת, בלי סוג ובלי מיקום', !!u2Push && perPerson.u2 === 1
    && u2Push.detail.some((d) => d.kind === 'absence_added' && d.date === '2026-09-03')
    && /היעדרות/.test(u2Push.push.body)
    && !/leave|abroad|חו"ל|חופש/.test(JSON.stringify(u2Push)), JSON.stringify(u2Push));
  ok('2.20 u1 קיבל הודעה מסכמת אחת שמכילה את כל השינויים שלו (העברה ב-1.9 + הוספה ב-2.9)', outbox.filter((n) => n.person === 'u1').length === 1 && outbox.find((n) => n.person === 'u1').detail.some((d) => d.date === '2026-09-01') && outbox.find((n) => n.person === 'u1').detail.some((d) => d.date === '2026-09-02'), JSON.stringify(outbox.find((n) => n.person === 'u1')));
  ok('2.21 ההודעות שוחררו (לא blocked)', outbox.every((n) => n.status !== 'blocked'), JSON.stringify(outbox.map((n) => n.status)));

  const after = await rt.getStationRange(req({ from: '2026-09-01', to: '2026-09-03' }, 'u2'));
  const d1 = after.days[0];
  eq('2.22 הלוח: u1 בשחמון ב-1.9, לא באילת', [d1.sub_stations.find((s) => s.sub_station === 'shahmon').people.some((p) => p.uid === 'u1'), d1.sub_stations.find((s) => s.sub_station === 'eilat').people.some((p) => p.uid === 'u1')], [true, false]);
  eq('2.23 הלוח: u3 הוסר מ-1.9', d1.sub_stations.some((s) => s.people.some((p) => p.uid === 'u3')), false);
  eq('2.24 הלוח: היעדרות u2 ב-3.9 חו"ל', after.days[2].absences.filter((a) => a.uid === 'u2').map((a) => a.kind + ':' + a.location), ['leave:abroad']);
  eq('2.25 revision בלוח', after.revision, 2);

  // ניסיון חוזר — אותה בקשה: אותה קבלה, אין revision 3.
  const again = await rt.applyScheduleEdit(req({ request_id: 'e2', expected: expectedOf(pointer), edits, expected_edit_digest: report.edit_digest, gap_acknowledgement: report.gaps.digest }));
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
  await rt.applyScheduleEdit(req({ request_id: 'e-other', expected: expectedOf(pointer), edits: [{ kind: 'unassign', uid: 'u2', dates: ['2026-09-01'] }], expected_edit_digest: other.edit_digest, gap_acknowledgement: other.gaps.digest }));
  await rejectsCode('3.1 הבסיס הוחלף בין הדוח לביצוע → edit-base-stale, בלי טיוטה', () => rt.applyScheduleEdit(req({ request_id: 'e3', expected: expectedOf(pointer), edits, expected_edit_digest: report.edit_digest, gap_acknowledgement: report.gaps.digest })), 'edit-base-stale');
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
  await rejectsCode('3.3 המצביע זז לפני עסקת הטיוטה → edit-base-stale', () => rt.applyScheduleEdit(req({ request_id: 'e4', expected: expectedOf(pointer2), edits, expected_edit_digest: report2.edit_digest, gap_acknowledgement: report2.gaps.digest })), 'edit-base-stale');
  db.runTransaction = originalTx;
  db._put(ST + '/schedule_state/active', pointer2);
  eq('3.4 לא נוצרה טיוטה', draftCount(), draftsBefore3);

  // החתימה של המצביע משתנה **בין עסקת הטיוטה לעסקת הפרסום** (אותו publication_id
  // ו-revision, כך שבדיקת publish-race עוברת) — רק שער בסיס העריכה בעסקת הפרסום תופס.
  let txCount = 0;
  db.runTransaction = async (fn) => {
    txCount += 1;
    if (txCount === 3) db._put(ST + '/schedule_state/active', Object.assign({}, db._get(ST + '/schedule_state/active'), { content_digest: 'tampered' }));
    return originalTx.call(db, fn);
  };
  await rejectsCode('3.4b חתימת הבסיס השתנתה לפני עסקת הפרסום → edit-base-stale', () => rt.applyScheduleEdit(req({ request_id: 'e4b', expected: expectedOf(pointer2), edits, expected_edit_digest: report2.edit_digest, gap_acknowledgement: report2.gaps.digest })), 'edit-base-stale');
  db.runTransaction = originalTx;
  db._put(ST + '/schedule_state/active', pointer2);
  ok('3.4c הטיוטה נוצרה אבל הפרסום לא הופעל (המצביע לא זז)', db._get(ST + '/schedule_state/active').revision === 2 && !db._paths(ST + '/schedule_publications/').some((k) => (db._get(k) || {}).status === 'active' && (db._get(k) || {}).revision === 3));

  // מינוי שבוטל רגע לפני העסקה
  db.runTransaction = async (fn) => { db._del(ST + '/schedule_access/' + MGR); return originalTx.call(db, fn); };
  await rejectsCode('3.5 מינוי שבוטל → manager-revoked', () => rt.applyScheduleEdit(req({ request_id: 'e5', expected: expectedOf(pointer2), edits, expected_edit_digest: report2.edit_digest, gap_acknowledgement: report2.gaps.digest })), 'manager-revoked');
  db.runTransaction = originalTx;
  db._put(ST + '/schedule_access/' + MGR, { schema_version: 1, station_id: SID, uid: MGR, roles: ['schedule_manager'], active: true, revision: 1 });
  eq('3.6 revision עדיין 2', db._get(ST + '/schedule_state/active').revision, 2);

  // עריכה שאינה משנה דבר
  const noop = await rt.previewScheduleEdit(req({ expected: expectedOf(pointer2), edits: [{ kind: 'unassign', uid: 'u2', dates: ['2026-09-01'] }] }));
  eq('3.7 דוח ריק', [noop.counts.changes, noop.notifications], [0, 0]);
  await rejectsCode('3.8 ביצוע עריכה ריקה → edit-no-changes', () => rt.applyScheduleEdit(req({ request_id: 'e6', expected: expectedOf(pointer2), edits: [{ kind: 'unassign', uid: 'u2', dates: ['2026-09-01'] }], expected_edit_digest: noop.edit_digest, gap_acknowledgement: noop.gaps.digest })), 'edit-no-changes');

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
  ], expected_edit_digest: week.edit_digest, gap_acknowledgement: week.gaps.digest }));
  eq('3.11 revision 3', done.revision, 3);
  const view = await rt.getStation(req({ date: '2026-09-02' }, 'u4'));
  const me = view.day.sub_stations.find((s) => s.sub_station === 'timna').people.find((p) => p.uid === 'u4');
  eq('3.12 הלוח: u4 בתמנע עם התפקיד, מסומן is_me', [!!me, me && me.is_me, me && me.role_label], [true, true, 'ff']);
  eq('3.13 היעדרות u5 מוצגת', view.day.absences.some((a) => a.uid === 'u5' && a.kind === 'sick'), true);
}

/* 4 · 42H.2 ג׳ — שער הפערים בעריכה: פער קריטי חוסם; פער אחר דורש אישור חתום. */
{
  const db = createFakeDb();
  const { rt } = await seed(db);
  const { pointer } = await publishImportedSchedule(db, rt);
  // מינימום 1 לראש משמרת (קריטית) — איש אינו מחזיק → פער קריטי בכל יום.
  await rt.saveQualification(req({ request_id: 'g-lead', key: 'shift_lead', minimum: 1 }));
  const edits = [{ kind: 'unassign', uid: 'u3', dates: ['2026-09-01'] }];
  const report = await rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits }));
  ok('4.1 הדוח מציג פערים קריטיים', report.gaps.summary.critical_gaps >= 3 && report.gaps.blocking.every((g) => g.key === 'shift_lead'), JSON.stringify(report.gaps.summary));
  await rejectsCode('4.2 עריכה עם פער קריטי → gaps-critical, בלי גרסה חדשה', () => rt.applyScheduleEdit(req({ request_id: 'g1', expected: expectedOf(pointer), edits, expected_edit_digest: report.edit_digest, gap_acknowledgement: report.gaps.digest })), 'gaps-critical');
  eq('4.3 revision נשאר 1', db._get(ST + '/schedule_state/active').revision, 1);
  // u1 מקבל ראש משמרת → נסגר הפער ביום שהוא עובד; נשארים פערים בימים אחרים → עדיין חוסם.
  await rt.setPersonQualifications(req({ request_id: 'g-hold', person: 'u1', qualifications: ['shift_lead'] }));
  const report2 = await rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits }));
  ok('4.4 המועמד לפער מוצע, לא משובץ', report2.gaps.blocking.length < report.gaps.blocking.length, JSON.stringify(report2.gaps.summary));
  const gapView = await rt.getGapReport(req({}));
  const dayWithGap = gapView.days.find((d) => d.has_critical_gap);
  ok('4.5 getGapReport על הפרסום הפעיל: מועמד לראש משמרת ביום עם פער', dayWithGap && dayWithGap.qualifications.find((q) => q.key === 'shift_lead').candidates.some((c) => c.uid === 'u1'), JSON.stringify(dayWithGap && dayWithGap.qualifications));
  // מבטלים את המינימום הקריטי; קובעים מינימום כולל לתחנה 20 → פער אחר בכל יום.
  await rt.saveQualification(req({ request_id: 'g-lead0', key: 'shift_lead', minimum: 0, expected_revision: 1 }));
  const policy = await rt.saveGapPolicy(req({ request_id: 'gp1', station_minimum: 20 }));
  eq('4.6 מינימום כולל נשמר', [policy.station_minimum, policy.revision], [20, 1]);
  await rejectsCode('4.7 revision ישן של מינימום התחנה', () => rt.saveGapPolicy(req({ request_id: 'gp2', station_minimum: 5, expected_revision: 0 })), 'gap-policy-revision-stale');
  const report3 = await rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits }));
  ok('4.8 פערי תחנה (אחרים) עם חתימה', report3.gaps.blocking.length === 0 && report3.gaps.acknowledgeable.some((g) => g.kind === 'station') && typeof report3.gaps.digest === 'string', JSON.stringify(report3.gaps.summary));
  await rejectsCode('4.9 בלי אישור → gaps-acknowledgement-required', () => rt.applyScheduleEdit(req({ request_id: 'g2', expected: expectedOf(pointer), edits, expected_edit_digest: report3.edit_digest })), 'gaps-acknowledgement-required');
  await rejectsCode('4.10 אישור על רשימה אחרת → סירוב', () => rt.applyScheduleEdit(req({ request_id: 'g2', expected: expectedOf(pointer), edits, expected_edit_digest: report3.edit_digest, gap_acknowledgement: report.gaps.digest })), 'gaps-acknowledgement-required');
  eq('4.11 לא נוצרה גרסה', db._get(ST + '/schedule_state/active').revision, 1);
  const done = await rt.applyScheduleEdit(req({ request_id: 'g2', expected: expectedOf(pointer), edits, expected_edit_digest: report3.edit_digest, gap_acknowledgement: report3.gaps.digest }));
  eq('4.12 עם אישור חתום — פורסם', done.revision, 2);
  const pub = db._get(ST + '/schedule_publications/' + done.publication_id);
  ok('4.13 האישור נשמר בפרסום וביומן', pub.gap_report.acknowledged === true && pub.gap_report.digest === report3.gaps.digest && auditOf(db).some((a) => a.action === 'publish' && a.revision === 2 && a.gaps_acknowledged === report3.gaps.digest), JSON.stringify(pub.gap_report));
  // rollback אינו נחסם על ידי פערים.
  const rolled = await rt.rollback(req({ request_id: 'g-rb', target_publication_id: pointer.publication_id, expected_active_publication_id: done.publication_id, reason_code: ROLLBACK_REASON }));
  ok('4.14 rollback אינו נחסם על ידי פערים', rolled && rolled.publication_id, JSON.stringify(rolled));
}

/* 5 · ביקורת Codex על 0e9a8dc (seq453) — כל סעיף עם בדיקה שנופלת על הקוד הישן. */

/* 5.1 §1 · TOCTOU: הנתונים משתנים בין השער המוקדם לעסקת הפרסום. */
{
  const db = createFakeDb();
  const { rt } = await seed(db);
  const { pointer } = await publishImportedSchedule(db, rt);
  await rt.saveGapPolicy(req({ request_id: 'gp-t', station_minimum: 20 }));
  const edits = [{ kind: 'unassign', uid: 'u3', dates: ['2026-09-01'] }];
  const report = await rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits }));
  ok('5.1.0 יש פערי תחנה עם חתימה', report.gaps.acknowledgeable.length > 0 && typeof report.gaps.digest === 'string');
  const originalTx = db.runTransaction;
  let txCount = 0;
  // העסקה השלישית בביצוע היא עסקת הפרסום; רגע לפניה מינימום התחנה משתנה → רשימת פערים אחרת.
  db.runTransaction = async (fn) => {
    txCount += 1;
    if (txCount === 3) db._put(ST + '/schedule_state/gap_policy', { station_id: SID, station_minimum: 25, revision: 2 });
    return originalTx.call(db, fn);
  };
  await rejectsCode('5.1.1 מדיניות הפער השתנתה לפני עסקת הפרסום → האישור אינו תקף (gaps-acknowledgement-required)', () => rt.applyScheduleEdit(req({ request_id: 't1', expected: expectedOf(pointer), edits, expected_edit_digest: report.edit_digest, gap_acknowledgement: report.gaps.digest })), 'gaps-acknowledgement-required');
  db.runTransaction = originalTx;
  eq('5.1.2 המצביע לא זז', db._get(ST + '/schedule_state/active').revision, 1);
  db._put(ST + '/schedule_state/gap_policy', { station_id: SID, station_minimum: 20, revision: 2 });

  // פער קריטי שנוצר בין השער המוקדם לעסקה: u1 מחזיק ראש משמרת; המינימום 1 מתקיים
  // רק בימים שהוא עובד, ולכן קודם מורידים אותו לימים שבהם הוא לא משובץ.
  await rt.saveQualification(req({ request_id: 'q-lead', key: 'shift_lead', minimum: 1 }));
  await rt.setPersonQualifications(req({ request_id: 'q-u1', person: 'u1', qualifications: ['shift_lead'] }));
  await rt.setPersonQualifications(req({ request_id: 'q-u3', person: 'u3', qualifications: ['shift_lead'] }));
  await rt.setPersonQualifications(req({ request_id: 'q-u4', person: 'u4', qualifications: ['shift_lead'] }));
  const edits2 = [{ kind: 'assign', uid: 'u9', dates: ['2026-09-02'], sub_station: 'timna', role: 'ff' }];
  const base2 = db._get(ST + '/schedule_state/active');   // נקרא מחדש — כדי שכשל ב-5.1.1 לא יפיל את ההמשך
  const report2 = await rt.previewScheduleEdit(req({ expected: expectedOf(base2), edits: edits2 }));
  eq('5.1.3 אין פער קריטי כשהמחזיקים משובצים', report2.gaps.blocking.length, 0);
  txCount = 0;
  db.runTransaction = async (fn) => {
    txCount += 1;
    if (txCount === 3) ['u1', 'u3', 'u4'].forEach((uid) => db._put(ST + '/schedule_person_qualifications/' + uid, { station_id: SID, uid, qualifications: [], revision: 2 }));
    return originalTx.call(db, fn);
  };
  await rejectsCode('5.1.4 המחזיקים הוסרו לפני עסקת הפרסום → gaps-critical בתוך העסקה', () => rt.applyScheduleEdit(req({ request_id: 't2', expected: expectedOf(base2), edits: edits2, expected_edit_digest: report2.edit_digest, gap_acknowledgement: report2.gaps.digest })), 'gaps-critical');
  db.runTransaction = originalTx;
  eq('5.1.5 המצביע לא זז', db._get(ST + '/schedule_state/active').revision, base2.revision);
}

/* 5.2 §1 · ניסיון חוזר של פרסום שנשאר ב-staging אינו מדלג על השער. */
{
  const db = createFakeDb();
  const { rt } = await seed(db);
  const { pointer } = await publishImportedSchedule(db, rt);
  await rt.saveGapPolicy(req({ request_id: 'gp-r', station_minimum: 20 }));
  const edits = [{ kind: 'unassign', uid: 'u3', dates: ['2026-09-01'] }];
  const report = await rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits }));
  const originalTx = db.runTransaction;
  let txCount = 0;
  // „קריסה" אחרי יצירת רשומת הפרסום (staging) ולפני עסקת הפרסום.
  db.runTransaction = async (fn) => {
    txCount += 1;
    if (txCount === 3) throw new Error('simulated crash before publish transaction');
    return originalTx.call(db, fn);
  };
  let crashed = null;
  try { await rt.applyScheduleEdit(req({ request_id: 'r1', expected: expectedOf(pointer), edits, expected_edit_digest: report.edit_digest, gap_acknowledgement: report.gaps.digest })); } catch (e) { crashed = e; }
  db.runTransaction = originalTx;
  const staging = db._paths(ST + '/schedule_publications/').map((k) => db._get(k)).find((p) => p && p.status === 'staging');
  ok('5.2.1 נשארה רשומת פרסום ב-staging', !!crashed && !!staging, String(crashed && crashed.message));
  // בינתיים מדיניות הפער השתנתה — האישור הישן אינו על הרשימה הנוכחית.
  db._put(ST + '/schedule_state/gap_policy', { station_id: SID, station_minimum: 25, revision: 2 });
  await rejectsCode('5.2.2 ניסיון חוזר עם אישור ישן → gaps-acknowledgement-required (לא מדלג על השער)', () => rt.applyScheduleEdit(req({ request_id: 'r1', expected: expectedOf(pointer), edits, expected_edit_digest: report.edit_digest, gap_acknowledgement: report.gaps.digest })), 'gaps-acknowledgement-required');
  eq('5.2.3 המצביע לא זז', db._get(ST + '/schedule_state/active').revision, 1);
  // עם האישור על הרשימה **הנוכחית** — הניסיון החוזר משלים את הפרסום.
  const fresh = await rt.getGapReport(req({ draft_id: staging.source_draft_id }));
  const done = await rt.applyScheduleEdit(req({ request_id: 'r1', expected: expectedOf(pointer), edits, expected_edit_digest: report.edit_digest, gap_acknowledgement: fresh.digest }));
  eq('5.2.4 ניסיון חוזר עם אישור עדכני → revision 2', done.revision, 2);
  const pub = db._get(ST + '/schedule_publications/' + done.publication_id);
  ok('5.2.5 הפרסום נושא את דוח הפערים שנבדק בעסקה', pub.gap_report && pub.gap_report.checked_in_transaction === true && pub.gap_report.digest === fresh.digest, JSON.stringify(pub.gap_report));
}

/* 5.3 §2 · עריכת היעדרות בלבד → הודעה לאדם, בלי הסיבה; תוכן שונה = חתימה שונה. */
{
  const db = createFakeDb();
  const { rt } = await seed(db);
  const { pointer } = await publishImportedSchedule(db, rt);
  const edits = [{ kind: 'absence', uid: 'u4', dates: ['2026-09-01'], absence: { kind: 'sick' } }];
  const report = await rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits }));
  eq('5.3.1 דוח: אדם אחד, הודעה אחת', [report.counts.people, report.notifications], [1, 1]);
  const done = await rt.applyScheduleEdit(req({ request_id: 'a1', expected: expectedOf(pointer), edits, expected_edit_digest: report.edit_digest, gap_acknowledgement: report.gaps.digest }));
  eq('5.3.2 פורסם revision 2', done.revision, 2);
  const outbox = outboxOf(db, done.publication_id);
  eq('5.3.3 outbox: הודעה אחת בדיוק, ל-u4', outbox.map((n) => n.person), ['u4']);
  ok('5.3.4 ההודעה אומרת היעדרות ותאריך — לא מחלה', outbox.length === 1 && /נרשמה היעדרות/.test(outbox[0].push.body) && /1\/9/.test(outbox[0].push.body) && !/sick|מחלה/.test(JSON.stringify(outbox[0])), JSON.stringify(outbox.map((n) => n.push)));
  const pub = db._get(ST + '/schedule_publications/' + done.publication_id);
  const prev = db._get(ST + '/schedule_publications/' + pointer.publication_id);
  ok('5.3.5 content_hash של הפרסום שונה מהקודם (היעדרויות בחתימה)', pub.content_hash !== prev.content_hash);
  // ביטול ההיעדרות → הודעה „הוסרה היעדרות".
  const p2 = db._get(ST + '/schedule_state/active');
  const edits2 = [{ kind: 'absence', uid: 'u4', dates: ['2026-09-01'], absence: null }];
  const report2 = await rt.previewScheduleEdit(req({ expected: expectedOf(p2), edits: edits2 }));
  const done2 = await rt.applyScheduleEdit(req({ request_id: 'a2', expected: expectedOf(p2), edits: edits2, expected_edit_digest: report2.edit_digest, gap_acknowledgement: report2.gaps.digest }));
  const outbox2 = outboxOf(db, done2.publication_id);
  ok('5.3.6 ביטול היעדרות → הודעה אחת „הוסרה היעדרות"', outbox2.length === 1 && outbox2[0].person === 'u4' && /הוסרה היעדרות/.test(outbox2[0].push.body), JSON.stringify(outbox2.map((n) => n.push.body)));
}

/* 5.4 §3 · העריכה מוצמדת למדיניות הפרסום; פרסום מיובא נערך מול התחנות הקנוניות בלבד. */
{
  const db = createFakeDb();
  const { rt, policyId } = await seed(db);
  // מדיניות עם מפתח היסטורי `main` במקום `eilat` — הייבוא דורש station_map.
  const legacy = await rt.savePolicy(req({
    request_id: 'p-legacy', activate: true, expected_policy_id: policyId, confirm_weakening: true,
    draft: {
      sub_stations: {
        main: { label: 'תחנה ראשית', minimum: 7, requirements: [{ role: 'ff', count: 7, required: true }] },
        shahmon: { label: 'שחמון', minimum: 0, requirements: [{ role: 'ff', count: 1, required: false }] },
        timna: { label: 'תמנע', minimum: 0, requirements: [{ role: 'ff', count: 1, required: false }] },
        yotvata: { label: 'יטבתה', minimum: 0, requirements: [{ role: 'ff', count: 1, required: false }] }
      },
      rest: { min_gap_days: 1 }, rotation: null, max_shifts_per_month: null
    }
  }));
  const cfg = db._get(ST + '/schedule_state/runtime');
  db._put(ST + '/schedule_state/runtime', Object.assign({}, cfg, { active_policy_id: legacy.policy_id }));
  const aliases = { 'רועי': 'u1', 'אבטחה': null, 'גיא': 'u5' };
  const stationMap = { eilat: 'main', shahmon: 'shahmon', timna: 'timna', yotvata: 'yotvata' };
  const ready = await rt.previewScheduleImport(req({ month: '2026-09', paste: SHEET, aliases, station_map: stationMap }));
  ok('5.4.0 הייבוא עם מיפוי תחנות אינו חסום', !ready.blocked, JSON.stringify(ready.blocked_by));
  const imported = await rt.importScheduleSheet(req({ request_id: 'imp-legacy', month: '2026-09', paste: SHEET, aliases, station_map: stationMap, expected_report_digest: ready.report_digest }));
  const preview = await rt.getDraftPreview(req({ draft_id: imported.draft_id, start: '2026-09-01' }));
  db._put(ST + '/schedule_state/runtime', Object.assign({}, db._get(ST + '/schedule_state/runtime'), { mode: 'new' }));
  await rt.publish(req({ request_id: 'pub-legacy', draft_id: imported.draft_id, expected_content_digest: preview.expected_content_digest, gap_acknowledgement: preview.gaps && preview.gaps.digest }));
  const pointer = db._get(ST + '/schedule_state/active');
  const pub = db._get(ST + '/schedule_publications/' + pointer.publication_id);
  eq('5.4.1 הפרסום נושא את מיפוי התחנות', pub.station_map, stationMap);
  await rejectsCode('5.4.2 שיבוץ ל-`main` (מפתח היסטורי שאינו בתוכנית הקנונית) → edit-sub-station-unknown', () => rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits: [{ kind: 'assign', uid: 'u9', dates: ['2026-09-02'], sub_station: 'main', role: 'ff' }] })), 'edit-sub-station-unknown');
  await rejectsCode('5.4.3 שיבוץ ל-`constructor` → edit-sub-station-unknown', () => rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits: [{ kind: 'assign', uid: 'u9', dates: ['2026-09-02'], sub_station: 'constructor', role: 'ff' }] })), 'edit-sub-station-unknown');
  let okReport = null;
  try { okReport = await rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits: [{ kind: 'assign', uid: 'u9', dates: ['2026-09-02'], sub_station: 'eilat', role: 'ff' }] })); } catch (e) { okReport = { error: e.code }; }
  eq('5.4.4 שיבוץ ל-`eilat` (קנוני) עובר, עם מיפוי בדוח', [okReport.error || null, okReport.counts && okReport.counts.changes, okReport.station_map], [null, 1, stationMap]);
  if (!okReport.error) {
  const applied = await rt.applyScheduleEdit(req({ request_id: 'e-legacy', expected: expectedOf(pointer), edits: [{ kind: 'assign', uid: 'u9', dates: ['2026-09-02'], sub_station: 'eilat', role: 'ff' }], expected_edit_digest: okReport.edit_digest, gap_acknowledgement: okReport.gaps.digest }));
  const board = await rt.getStationRange(req({ from: '2026-09-02', to: '2026-09-02' }, 'u2'));
  const subs = board.days[0].sub_stations.map((s) => s.sub_station).sort();
  eq('5.4.5 הלוח: ארבע תחנות קנוניות, בלי תחנה חמישית', [subs, board.revision], [['eilat', 'shahmon', 'timna', 'yotvata'], 2]);
  ok('5.4.6 u9 באילת ב-2.9', board.days[0].sub_stations.find((s) => s.sub_station === 'eilat').people.some((p) => p.uid === 'u9'));
  const pub2 = db._get(ST + '/schedule_publications/' + applied.publication_id);
  eq('5.4.7 הפרסום הערוך נושא את אותו מיפוי', pub2.station_map, stationMap);
  }

  // המדיניות משתנה אחרי הפרסום → אין עריכה של הפרסום הישן.
  const p2 = db._get(ST + '/schedule_state/active');
  const changed = await rt.savePolicy(req({ request_id: 'p-changed', activate: true, expected_policy_id: legacy.policy_id, confirm_weakening: true, draft: {
    sub_stations: {
      main: { label: 'תחנה ראשית', minimum: 5, requirements: [{ role: 'ff', count: 5, required: true }] },
      shahmon: { label: 'שחמון', minimum: 0, requirements: [{ role: 'ff', count: 1, required: false }] },
      timna: { label: 'תמנע', minimum: 0, requirements: [{ role: 'ff', count: 1, required: false }] },
      yotvata: { label: 'יטבתה', minimum: 0, requirements: [{ role: 'ff', count: 1, required: false }] }
    }, rest: { min_gap_days: 1 }, rotation: null, max_shifts_per_month: null } }));
  db._put(ST + '/schedule_state/runtime', Object.assign({}, db._get(ST + '/schedule_state/runtime'), { active_policy_id: changed.policy_id }));
  await rejectsCode('5.4.8 המדיניות השתנתה מאז הפרסום → edit-policy-changed', () => rt.previewScheduleEdit(req({ expected: expectedOf(p2), edits: [{ kind: 'unassign', uid: 'u9', dates: ['2026-09-02'] }] })), 'edit-policy-changed');
  ok('5.4.9 (לא נוגע) המדיניות המקורית עדיין קיימת', typeof policyId === 'string');
}

/* 5.5 §5+§6 · תקרת אזהרות ודוח; תפקיד רק מהמדיניות. */
{
  const db = createFakeDb();
  const { rt } = await seed(db);
  const { pointer } = await publishImportedSchedule(db, rt);
  await rejectsCode('5.5.1 תפקיד שאינו במדיניות (assign) → edit-role-unknown', () => rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits: [{ kind: 'assign', uid: 'u9', dates: ['2026-09-02'], sub_station: 'timna', role: 'boss' }] })), 'edit-role-unknown');
  await rejectsCode('5.5.2 תפקיד שאינו במדיניות (role) → edit-role-unknown', () => rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits: [{ kind: 'role', uid: 'u1', dates: ['2026-09-01'], role: '<script>' }] })), 'edit-role-unknown');
  // 200 עריכות × 3 תאריכים של „הסרה" למי שאינו משובץ → 600 אזהרות; בדוח נשארות 200.
  const dates = ['2026-09-01', '2026-09-02', '2026-09-03'];
  const many = [];
  for (let i = 0; i < 200; i += 1) many.push({ kind: 'unassign', uid: 'u' + (1 + (i % 9)), dates });
  const report = await rt.previewScheduleEdit(req({ expected: expectedOf(pointer), edits: many }));
  ok('5.5.3 אזהרות חסומות ב-200 והשאר נספרות', report.warnings.length === 200 && report.warnings_total > 200 && report.warnings_truncated === report.warnings_total - 200, JSON.stringify([report.warnings.length, report.warnings_total, report.warnings_truncated]));
  ok('5.5.4 גודל הדוח מדווח ומתחת לתקרה', Number.isInteger(report.report_bytes) && report.report_bytes < 256 * 1024, String(report.report_bytes));
  // אותו runtime עם תקרה נמוכה (seam לבדיקה בלבד): הדוח נדחה בדוח ובביצוע, בלי טיוטה.
  const tight = buildRuntime(db, { editReportByteLimit: 2000 });
  const drafts = () => db._paths(ST + '/schedule_drafts').filter((k) => k.split('/').length === 4).length;
  const draftsBefore = drafts();
  await rejectsCode('5.5.5 דוח מעל התקרה → edit-too-large (preview)', () => tight.previewScheduleEdit(req({ expected: expectedOf(pointer), edits: many })), 'edit-too-large');
  await rejectsCode('5.5.6 ביצוע מעל התקרה → edit-too-large, בלי טיוטה', () => tight.applyScheduleEdit(req({ request_id: 'big', expected: expectedOf(pointer), edits: many, expected_edit_digest: report.edit_digest, gap_acknowledgement: report.gaps.digest })), 'edit-too-large');
  eq('5.5.7 לא נוצרה טיוטה', drafts(), draftsBefore);
  const small = await tight.previewScheduleEdit(req({ expected: expectedOf(pointer), edits: [{ kind: 'unassign', uid: 'u1', dates: ['2026-09-01'] }] }));
  ok('5.5.8 עריכה קטנה עוברת גם עם התקרה הנמוכה', small.report_bytes <= 2000, String(small.report_bytes));
}

finish('schedule-edit runtime probe checks passed');
