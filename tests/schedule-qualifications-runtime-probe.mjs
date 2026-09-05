/* ====================================================================
 *  schedule-qualifications-runtime-probe · 42H.2 חבילה ב׳ — קטלוג
 *  כשירויות ומחזיקים על ה-runtime האמיתי מול Firestore בזיכרון.
 *
 *  שער · קטלוג מובנה בסדר קבוע · יצירה/עדכון/השבתה עם CAS ויומן ·
 *  כמה כשירויות לאדם · מחיקה נחסמת כשבשימוש ואחרי הוספה מקבילה ·
 *  ניסיון חוזר · רמז מהמערכת הישנה. לא אמולטור.
 * ==================================================================== */

import { createFakeDb, seed, req, ST, SID, MGR, makeChecks } from './_schedule-fake.mjs';

const { ok, eq, rejectsCode, finish } = makeChecks();

function auditOf(db) { return db._paths(ST + '/schedule_qualification_audit/').map((p) => db._get(p)); }

{
  const db = createFakeDb();
  const { rt } = await seed(db);

  /* 1 · שער וקטלוג מובנה */
  await rejectsCode('1.1 getQualificationCatalog דורש אחראי סידור', () => rt.getQualificationCatalog(req({}, 'u1')), 'manager-required');
  await rejectsCode('1.2 saveQualification דורש אחראי סידור', () => rt.saveQualification(req({ request_id: 'q1', key: 'diver', label: 'צוללן' }, 'u1')), 'manager-required');
  await rejectsCode('1.3 setPersonQualifications דורש אחראי סידור', () => rt.setPersonQualifications(req({ request_id: 'q1', person: 'u2', qualifications: [] }, 'u1')), 'manager-required');
  const first = await rt.getQualificationCatalog(req({}));
  eq('1.4 תשע מובנות בסדר הקבוע', first.catalog.map((q) => q.label), ['ראש משמרת', 'סגן', 'קצין', 'מפקדי צוותים', 'נהגים', 'חומ״ס', 'ניטור', 'יל״מ', 'לוחמים']);
  eq('1.5 שלוש ראשונות קריטיות', first.catalog.filter((q) => q.critical).map((q) => q.key), ['shift_lead', 'deputy', 'officer']);
  eq('1.6 אנשי המקור הפעיל, בלי כשירויות עדיין', [first.people.length, first.people.every((p) => p.qualifications.length === 0 && p.revision === 0)], [9, true]);
  eq('1.7 אין מחזיקים', first.holders, {});

  /* 2 · יצירה, עדכון, CAS, יומן */
  const created = await rt.saveQualification(req({ request_id: 'q-create', key: 'diver', label: 'צוללן', minimum: 1, critical: false, order: 150 }));
  eq('2.1 נוצרה כשירות מותאמת, revision 1', [created.duplicate, created.key, created.revision], [false, 'diver', 1]);
  const again = await rt.saveQualification(req({ request_id: 'q-create', key: 'diver', label: 'צוללן', minimum: 1, critical: false, order: 150 }));
  eq('2.2 ניסיון חוזר → duplicate, בלי שינוי', [again.duplicate, db._get(ST + '/schedule_qualifications/diver').revision], [true, 1]);
  await rejectsCode('2.3 אותו request_id עם תוכן אחר → request-conflict', () => rt.saveQualification(req({ request_id: 'q-create', key: 'diver', label: 'צוללנית' })), 'request-conflict');
  await rejectsCode('2.4 עדכון עם revision ישן → stale', () => rt.saveQualification(req({ request_id: 'q-upd-stale', key: 'diver', label: 'צוללן עמוק', expected_revision: 0 })), 'qualification-revision-stale');
  const updated = await rt.saveQualification(req({ request_id: 'q-upd', key: 'diver', label: 'צוללן עמוק', expected_revision: 1 }));
  eq('2.5 עדכון עם revision נכון', [updated.revision, db._get(ST + '/schedule_qualifications/diver').label], [2, 'צוללן עמוק']);
  await rejectsCode('2.6 תווית כפולה → סירוב', () => rt.saveQualification(req({ request_id: 'q-dup', key: 'pilot', label: 'נהגים' })), 'qualification-label-duplicate');
  const relabel = await rt.saveQualification(req({ request_id: 'q-relabel', key: 'driver', label: 'נהגי כבאיות', minimum: 2 }));
  eq('2.7 מובנית: תווית ומינימום נשמרים, revision 1', [relabel.revision, db._get(ST + '/schedule_qualifications/driver').critical, db._get(ST + '/schedule_qualifications/driver').minimum], [1, false, 2]);
  await rejectsCode('2.8 השבתת קריטית בלי אישור → סירוב', () => rt.saveQualification(req({ request_id: 'q-off-crit', key: 'deputy', active: false })), 'qualification-critical-disable');
  await rejectsCode('2.9 שינוי קריטיות של מובנית → סירוב', () => rt.saveQualification(req({ request_id: 'q-crit', key: 'driver', critical: true, expected_revision: 1 })), 'qualification-critical-fixed');
  const disabled = await rt.saveQualification(req({ request_id: 'q-off', key: 'monitoring', active: false }));
  eq('2.10 השבתה של מובנית לא-קריטית', [disabled.revision, db._get(ST + '/schedule_qualifications/monitoring').active], [1, false]);
  const audit = auditOf(db);
  eq('2.11 יומן: create/update/update/update עם לפני-אחרי', audit.map((a) => a.action + ':' + a.key).sort(), ['create:diver', 'update:diver', 'update:driver', 'update:monitoring'].sort());
  ok('2.12 יומן הכשירות המותאמת: before null ואז before מלא', audit.find((a) => a.action === 'create').before === null && audit.find((a) => a.action === 'update' && a.key === 'diver').before.label === 'צוללן');
  const merged = await rt.getQualificationCatalog(req({}));
  eq('2.13 הקטלוג הממוזג: תווית חדשה לנהגים, ניטור מושבת, צוללן בסוף', [merged.catalog.find((q) => q.key === 'driver').label, merged.catalog.find((q) => q.key === 'monitoring').active, merged.catalog[merged.catalog.length - 1].key], ['נהגי כבאיות', false, 'diver']);

  /* 3 · כשירויות לאדם */
  await rejectsCode('3.1 כשירות מושבתת אינה ניתנת להקצאה', () => rt.setPersonQualifications(req({ request_id: 'h-inactive', person: 'u2', qualifications: ['monitoring'] })), 'holdings-inactive');
  await rejectsCode('3.2 כשירות לא מוכרת', () => rt.setPersonQualifications(req({ request_id: 'h-unknown', person: 'u2', qualifications: ['pilot'] })), 'holdings-unknown');
  await rejectsCode('3.3 אדם שאינו חבר תחנה', () => rt.setPersonQualifications(req({ request_id: 'h-ghost', person: 'ghost', qualifications: ['driver'] })), 'person-not-member');
  const held = await rt.setPersonQualifications(req({ request_id: 'h1', person: 'u2', qualifications: ['diver', 'firefighter', 'shift_lead', 'firefighter'] }));
  eq('3.4 כמה כשירויות לאדם, בסדר הקטלוג, בלי כפילות', [held.qualifications, held.revision], [['shift_lead', 'firefighter', 'diver'], 1]);
  const heldAgain = await rt.setPersonQualifications(req({ request_id: 'h1', person: 'u2', qualifications: ['diver', 'firefighter', 'shift_lead', 'firefighter'] }));
  eq('3.5 ניסיון חוזר → duplicate, אותו revision', [heldAgain.duplicate, heldAgain.revision], [true, 1]);
  await rejectsCode('3.6 revision ישן → stale', () => rt.setPersonQualifications(req({ request_id: 'h2', person: 'u2', qualifications: ['driver'], expected_revision: 0 })), 'holdings-revision-stale');
  const changed = await rt.setPersonQualifications(req({ request_id: 'h2', person: 'u2', qualifications: ['driver', 'diver'], expected_revision: 1 }));
  eq('3.7 עדכון: נהגים נוסף, ראש משמרת ולוחמים הוסרו', [changed.qualifications, changed.revision], [['driver', 'diver'], 2]);
  const holdingsAudit = auditOf(db).filter((a) => a.action === 'holdings');
  const secondAudit = holdingsAudit.find((a) => a.request_id === 'h2');
  eq('3.8 יומן המחזיקים: לפני/אחרי + added/removed', [holdingsAudit.length, secondAudit.before, secondAudit.added, secondAudit.removed.sort()], [2, ['shift_lead', 'firefighter', 'diver'], ['driver'], ['firefighter', 'shift_lead']]);
  eq('3.9 מונה המחזיקים עלה פעמיים', db._get(ST + '/schedule_state/qualifications').holdings_revision, 2);
  const view = await rt.getQualificationCatalog(req({}));
  eq('3.10 מחזיקים לכל כשירות', view.holders, { driver: 1, diver: 1 });
  eq('3.11 האדם בקטלוג עם כשירויותיו ו-revision', [view.people.find((p) => p.uid === 'u2').qualifications, view.people.find((p) => p.uid === 'u2').revision], [['driver', 'diver'], 2]);
  ok('3.12 הכשירויות אינן תלויות בתפקיד ההרשאה', view.people.find((p) => p.uid === 'u2').roles.indexOf('driver') === -1);

  /* 4 · מחיקה: לא מובנית, לא בשימוש, ולא אחרי הוספה מקבילה */
  await rejectsCode('4.1 מחיקת מובנית → סירוב', () => rt.deleteQualification(req({ request_id: 'd-builtin', key: 'driver', expected_revision: 1 })), 'qualification-builtin');
  await rejectsCode('4.2 מחיקת כשירות בשימוש → סירוב עם מספר המחזיקים', () => rt.deleteQualification(req({ request_id: 'd-inuse', key: 'diver', expected_revision: 2 })), 'qualification-in-use');
  await rt.setPersonQualifications(req({ request_id: 'h3', person: 'u2', qualifications: ['driver'], expected_revision: 2 }));
  const originalTx = db.runTransaction;
  let raced = false;
  db.runTransaction = async (fn) => {
    // הוספה מקבילה בין ספירת המחזיקים לעסקת המחיקה — המונה זז.
    if (!raced) { raced = true; db.runTransaction = originalTx; await rt.setPersonQualifications(req({ request_id: 'h-race', person: 'u3', qualifications: ['diver'] })); }
    return originalTx.call(db, fn);
  };
  await rejectsCode('4.3 הוספה מקבילה מפילה את המחיקה, לא להפך', () => rt.deleteQualification(req({ request_id: 'd-race', key: 'diver', expected_revision: 2 })), 'qualification-holders-changed');
  db.runTransaction = originalTx;
  ok('4.4 הכשירות עדיין קיימת ו-u3 מחזיק בה', !!db._get(ST + '/schedule_qualifications/diver') && db._get(ST + '/schedule_person_qualifications/u3').qualifications.indexOf('diver') !== -1);
  await rt.setPersonQualifications(req({ request_id: 'h4', person: 'u3', qualifications: [], expected_revision: 1 }));
  const deleted = await rt.deleteQualification(req({ request_id: 'd-ok', key: 'diver', expected_revision: 2 }));
  eq('4.5 מחיקה אחרי הסרה מכל המחזיקים', [deleted.duplicate, db._get(ST + '/schedule_qualifications/diver')], [false, null]);
  const deletedAgain = await rt.deleteQualification(req({ request_id: 'd-ok', key: 'diver', expected_revision: 2 }));
  eq('4.6 ניסיון חוזר של מחיקה → duplicate', deletedAgain.duplicate, true);
  await rejectsCode('4.7 הקצאת כשירות שנמחקה → סירוב', () => rt.setPersonQualifications(req({ request_id: 'h5', person: 'u2', qualifications: ['diver'], expected_revision: 3 })), 'holdings-unknown');
  ok('4.8 יומן המחיקה', auditOf(db).some((a) => a.action === 'delete' && a.key === 'diver' && a.after === null));

  /* 5 · רמז מהמערכת הישנה */
  db._put(ST + '/quals/oldq1', { name: 'נהג ישן', order: 1, active: true });
  db._put(ST + '/member_quals/u4', { quals: ['oldq1', 'missing'] });
  const withLegacy = await rt.getQualificationCatalog(req({}));
  eq('5.1 רמז legacy לאדם, לפי שם', withLegacy.people.find((p) => p.uid === 'u4').legacy, ['נהג ישן', 'missing']);
  eq('5.2 בלי רמז למי שאין לו', withLegacy.people.find((p) => p.uid === 'u2').legacy, []);

  /* 6 · אימות חי: מינוי שבוטל לפני העסקה */
  db.runTransaction = async (fn) => { db._del(ST + '/schedule_access/' + MGR); return originalTx.call(db, fn); };
  await rejectsCode('6.1 מינוי שבוטל → manager-revoked, בלי כתיבה', () => rt.saveQualification(req({ request_id: 'q-revoked', key: 'pilot', label: 'טייס' })), 'manager-revoked');
  db.runTransaction = originalTx;
  eq('6.2 לא נכתב', db._get(ST + '/schedule_qualifications/pilot'), null);
  db._put(ST + '/schedule_access/' + MGR, { schema_version: 1, station_id: SID, uid: MGR, roles: ['schedule_manager'], active: true, revision: 1 });
}

/* seq457 §4/§5 · מפתחות שמורים; מכסה וייחוד תווית נבדקים בתוך העסקה. */
{
  const db = createFakeDb();
  const { rt } = await seed(db);
  await rejectsCode('6.1 מפתח __proto__ נדחה', () => rt.saveQualification(req({ request_id: 'q-proto', key: '__proto__', label: 'א', expected_revision: 0 })), 'qualification-key');
  await rejectsCode('6.2 מפתח constructor נדחה', () => rt.saveQualification(req({ request_id: 'q-ctor', key: 'constructor', label: 'ב', expected_revision: 0 })), 'qualification-key');
  await rejectsCode('6.3 כשירות constructor לאדם נדחית', () => rt.setPersonQualifications(req({ request_id: 'q-ctor-p', person: 'u1', qualifications: ['constructor'] })), 'holdings-unknown');
  // מסמך זדוני/ישן בקטלוג עם מפתח שמור — מתעלמים ממנו, והספירה נשארת נכונה.
  db._put(ST + '/schedule_qualifications/constructor', { station_id: SID, label: 'זבל', active: true, revision: 1 });
  db._put(ST + '/schedule_person_qualifications/u2', { station_id: SID, uid: 'u2', qualifications: ['constructor', 'driver'], revision: 1 });
  const cat = await rt.getQualificationCatalog(req({}));
  ok('6.4 הקטלוג מתעלם ממפתח שמור, המחזיקים נספרים נכון', !cat.catalog.some((e) => e.key === 'constructor') && cat.holders.driver === 1 && !Object.prototype.hasOwnProperty.call(cat.holders, 'constructor'), JSON.stringify([cat.catalog.map((e) => e.key), cat.holders]));

  // מרוץ: בין קריאת הקטלוג לעסקה נוספת כשירות עם אותה תווית → העסקה מסרבת.
  const originalTx = db.runTransaction;
  db.runTransaction = async (fn) => {
    db._put(ST + '/schedule_qualifications/diver_b', { station_id: SID, key: 'diver_b', label: 'צוללן', active: true, minimum: 0, order: 1000, revision: 1 });
    db.runTransaction = originalTx;
    return originalTx.call(db, fn);
  };
  await rejectsCode('6.5 תווית כפולה שנוספה במקביל → נדחה בעסקה', () => rt.saveQualification(req({ request_id: 'q-dup', key: 'diver_a', label: 'צוללן', expected_revision: 0 })), 'qualification-label-duplicate');
  eq('6.6 לא נוצרה diver_a', db._get(ST + '/schedule_qualifications/diver_a') || null, null);
  // מרוץ מכסה: 39 מותאמות + אחת שנוספה במקביל → ה-40 של הבקשה נדחית.
  for (let i = 0; i < 38; i += 1) db._put(ST + '/schedule_qualifications/custom_' + i, { station_id: SID, key: 'custom_' + i, label: 'מותאמת ' + i, active: true, minimum: 0, order: 1000 + i, revision: 1 });
  db.runTransaction = async (fn) => {
    db._put(ST + '/schedule_qualifications/custom_last', { station_id: SID, key: 'custom_last', label: 'מותאמת אחרונה', active: true, minimum: 0, order: 2000, revision: 1 });
    db.runTransaction = originalTx;
    return originalTx.call(db, fn);
  };
  await rejectsCode('6.7 מכסת המותאמות נבדקת בעסקה (הוספה מקבילה ממלאת אותה)', () => rt.saveQualification(req({ request_id: 'q-cap', key: 'custom_over', label: 'מעבר למכסה', expected_revision: 0 })), 'qualification-limit');
  eq('6.8 לא נוצרה custom_over', db._get(ST + '/schedule_qualifications/custom_over') || null, null);
}

finish('schedule-qualifications runtime probe checks passed');
