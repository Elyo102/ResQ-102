'use strict';

/* ======================================================================
 *  hr-removal-authority — שבע הבדיקות של הסרת קבצים ונהלים
 *
 *  מה נבדק כאן: **סמכות** ו**השפעה**. מי רשאי להסיר מה, ומה קורה
 *  בפועל אחרי ההסרה. הבדיקות רצות מול כפיל Firestore בזיכרון
 *  (`hr-pilot-test-harness.js`) ולכן רצות ב-`npm run static` בכל
 *  מכונה, בלי אמולטור ובלי רשת.
 *
 *  מה **אינו** נבדק כאן, ומסומן במפורש:
 *    · כללי Firestore — דורשים אמולטור. NOT RUN כאן.
 *    · מסלול ההעלאה עצמו (reserve → stored → ready) — יש לו בדיקות
 *      משלו. כאן רשומת הקובץ נזרעת ישירות, כי מה שנבדק הוא ההרשאה
 *      להסיר, לא הדרך שבה הקובץ הגיע.
 *    · מחיקה פיזית מ-Storage — **לא קיימת בכוונה**. בדיקה 6 מוכיחה
 *      שהבייטים נשארים, כי זו ההכרעה: soft delete בלבד.
 * ====================================================================== */

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { fakeDb, FakeHttpsError, people, AUTH_TIME } = require('./hr-pilot-test-harness');
const { createHrRequests } = require('./hr-requests');
const { createHrDocuments } = require('./hr-documents');

const SID = 'station_102';
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const id = (seed) => hash(['attachment', seed]);

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('✓ ' + name); }
  catch (error) { failures.push(name); console.log('✗ ' + name + ' — ' + error.message); }
}

async function rejects(promise, code) {
  try { await promise; }
  catch (error) {
    assert.equal(error.code, code, 'expected ' + code + ' but got ' + error.code + ': ' + error.message);
    return error;
  }
  assert.fail('expected a ' + code + ' rejection, but the call succeeded');
}

function world() {
  const db = fakeDb();
  const who = people(db, SID);
  let clock = Date.parse('2026-09-19T08:00:00Z');
  const now = () => (clock += 1000);
  const requests = createHrRequests({ db, auth: who.auth, HttpsError: FakeHttpsError, clock: now });
  const documents = createHrDocuments({ db, auth: who.auth, HttpsError: FakeHttpsError, clock: now });
  db._put('config/runtime', { silent: false });
  return { db, who, requests, documents };
}

/** פנייה של העובד, ועליה קובץ אחד שמישהו העלה. */
async function caseWithFile(w, ownerUid, uploaderUid, attachmentId) {
  const created = await w.requests.create(w.who.req(ownerUid, {
    request_id: 'req-create-' + attachmentId.slice(0, 10),
    subject: 'אישור מחלה', text: 'מצורף אישור.', send_now: false
  }));
  const path = 'stations/' + SID + '/hr_requests/' + created.case_id;
  const current = w.db._get(path);
  w.db._put(path, { ...current, attachment_ids: [attachmentId] });
  w.db._put('stations/' + SID + '/hr_attachments/' + attachmentId, {
    schema: 'hr-attachment-v1', attachment_id: attachmentId, state: 'ready',
    station_id: SID, actor_uid: uploaderUid, parent_kind: 'request', parent_id: created.case_id,
    display_name: 'אישור.pdf', byte_length: 1024,
    object_path: 'stations/' + SID + '/attachments/' + attachmentId,
    object_generation: '1'
  });
  return { case_id: created.case_id, revision: w.db._get(path).revision };
}

(async () => {
  /* ---------- 1 ---------- */
  await test('an employee removes a file they uploaded themselves', async () => {
    const w = world();
    const worker = w.who.add('worker', 'firefighter');
    const file = id('own');
    const c = await caseWithFile(w, worker, worker, file);
    const out = await w.requests.removeAttachment(w.who.req(worker, {
      request_id: 'req-remove-own-1', case_id: c.case_id,
      expected_revision: c.revision, attachment_id: file
    }));
    assert.equal(out.outcome, 'saved');
    assert.equal(out.removed_attachment_id, file);
    const after = w.db._get('stations/' + SID + '/hr_requests/' + c.case_id);
    assert.deepEqual(after.attachment_ids, [], 'the link is gone');
    assert.deepEqual(after.removed_attachment_ids, [file], 'and it is recorded as removed');
  });

  /* ---------- 2 ---------- */
  await test('an employee cannot remove a file HR uploaded onto their request', async () => {
    const w = world();
    const worker = w.who.add('worker', 'firefighter');
    const hr = w.who.add('hr', 'hr_coordinator');
    const file = id('hr-uploaded');
    const c = await caseWithFile(w, worker, hr, file);
    await rejects(w.requests.removeAttachment(w.who.req(worker, {
      request_id: 'req-remove-foreign-1', case_id: c.case_id,
      expected_revision: c.revision, attachment_id: file
    })), 'permission-denied');
    const after = w.db._get('stations/' + SID + '/hr_requests/' + c.case_id);
    assert.deepEqual(after.attachment_ids, [file], 'the link is untouched');
  });

  /* ---------- 3 ---------- */
  await test('an employee cannot remove a station procedure', async () => {
    const w = world();
    const worker = w.who.add('worker', 'firefighter');
    const hr = w.who.add('hr', 'hr_coordinator');
    const published = await w.documents.publish(w.who.req(hr, {
      request_id: 'req-publish-proc-1', kind: 'procedure', title: 'נוהל כיבוי',
      text: 'תוכן הנוהל.', requires_ack: false, send_now: false
    }));
    await rejects(w.documents.archiveProcedure(w.who.req(worker, {
      request_id: 'req-archive-worker-1', document_id: published.document_id, expected_revision: 1
    })), 'permission-denied');
    const after = w.db._get('stations/' + SID + '/hr_documents/' + published.document_id);
    assert.equal(after.archived_at_ms, undefined, 'the procedure is still live');
  });

  /* ---------- 4 ---------- */
  for (const [label, role, isSuper] of [
    ['commander', 'commander', false],
    ['hr_coordinator', 'hr_coordinator', false],
    ['super', 'firefighter', true]
  ]) {
    await test('a ' + label + ' can remove a station procedure', async () => {
      const w = world();
      const hr = w.who.add('hr', 'hr_coordinator');
      const actor = w.who.add('actor', role, isSuper);
      const published = await w.documents.publish(w.who.req(hr, {
        request_id: 'req-publish-proc-' + label, kind: 'procedure', title: 'נוהל',
        text: 'תוכן.', requires_ack: false, send_now: false
      }));
      const out = await w.documents.archiveProcedure(w.who.req(actor, {
        request_id: 'req-archive-' + label, document_id: published.document_id, expected_revision: 1
      }));
      assert.equal(out.outcome, 'saved');
      assert.equal(out.archived_by_uid, actor);
      const after = w.db._get('stations/' + SID + '/hr_documents/' + published.document_id);
      assert.equal(Number.isSafeInteger(after.archived_at_ms), true, 'when it was removed is recorded');
      assert.equal(after.archived_by_uid, actor, 'who removed it is recorded');
      // ⭐ והמשמעות בפועל: הנוהל יצא מכל מסלול קריאה.
      await rejects(w.documents.get(w.who.req(actor, { document_id: published.document_id })), 'not-found');
      const list = await w.documents.listProcedures(w.who.req(actor, {}));
      assert.deepEqual(list.items, [], 'and it is gone from the procedure list');
    });
  }

  /* ---------- 5 ---------- */
  await test('a commander still cannot publish or revise a publication', async () => {
    const w = world();
    const hr = w.who.add('hr', 'hr_coordinator');
    const boss = w.who.add('boss', 'commander');
    await rejects(w.documents.publish(w.who.req(boss, {
      request_id: 'req-publish-boss-1', kind: 'procedure', title: 'נוהל',
      text: 'תוכן.', requires_ack: false, send_now: false
    })), 'permission-denied');
    const published = await w.documents.publish(w.who.req(hr, {
      request_id: 'req-publish-proc-5', kind: 'procedure', title: 'נוהל',
      text: 'תוכן.', requires_ack: false, send_now: false
    }));
    await rejects(w.documents.revise(w.who.req(boss, {
      request_id: 'req-revise-boss-1', document_id: published.document_id, expected_revision: 1,
      title: 'נוהל מתוקן', text: 'תוכן אחר.', requires_ack: false, send_now: false
    })), 'permission-denied');
  });

  /* ---------- 6 ---------- */
  await test('the soft delete blocks download and linking, and keeps the bytes', async () => {
    const w = world();
    const worker = w.who.add('worker', 'firefighter');
    const file = id('soft');
    const c = await caseWithFile(w, worker, worker, file);
    const ctx = { uid: worker, sid: SID, role: 'firefighter', super: false };
    const port = () => w.db.runTransaction((tx) => w.requests.attachmentPorts.read(tx, {
      ctx, authTime: AUTH_TIME, parent_kind: 'request', parent_id: c.case_id, attachment_id: file
    }));
    const before = await port();
    assert.deepEqual(before.attachment_ids, [file], 'before removal the file is reachable');
    await w.requests.removeAttachment(w.who.req(worker, {
      request_id: 'req-remove-soft-1', case_id: c.case_id,
      expected_revision: c.revision, attachment_id: file
    }));
    // אותו שער שכבר קיים במודול הקבצים — ולכן ההורדה והשיוך נחסמים
    // בלי מצב חדש ובלי CAS חדש שם.
    await rejects(port(), 'permission-denied');
    // ⭐ וההפך, במפורש: הבייטים לא נמחקו. זו ההכרעה, ולא פשרה שנשכחה.
    const record = w.db._get('stations/' + SID + '/hr_attachments/' + file);
    assert.equal(record.state, 'ready', 'the attachment record is untouched');
    assert.equal(record.object_path, 'stations/' + SID + '/attachments/' + file,
      'the stored object is still referenced — removal hides, it does not erase');
  });

  /* ---------- 7 ---------- */
  await test('an audit row is always written — for a file and for a procedure', async () => {
    const w = world();
    const worker = w.who.add('worker', 'firefighter');
    const hr = w.who.add('hr', 'hr_coordinator');
    const boss = w.who.add('boss', 'commander');

    const file = id('audit');
    const c = await caseWithFile(w, worker, worker, file);
    const removal = await w.requests.removeAttachment(w.who.req(worker, {
      request_id: 'req-remove-audit-1', case_id: c.case_id,
      expected_revision: c.revision, attachment_id: file
    }));
    const event = w.db._get('stations/' + SID + '/hr_requests/' + c.case_id + '/events/' + removal.event_id);
    assert.equal(event.kind, 'removeAttachment');
    assert.equal(event.actor_uid, worker, 'who');
    assert.equal(Number.isSafeInteger(event.created_at_ms), true, 'when');
    assert.equal(event.attachment_id, file, 'which file');
    assert.equal(event.attachment_display_name, 'אישור.pdf', 'under which name');
    // ואין פוש על הסרה.
    assert.equal(removal.notification_status, 'no_other_recipient');
    assert.equal(w.db._get('stations/' + SID + '/hr_request_notification_jobs/' + removal.event_id), undefined,
      'no notification job is queued for a removal');

    const published = await w.documents.publish(w.who.req(hr, {
      request_id: 'req-publish-proc-7', kind: 'procedure', title: 'נוהל',
      text: 'תוכן.', requires_ack: false, send_now: false
    }));
    await w.documents.archiveProcedure(w.who.req(boss, {
      request_id: 'req-archive-audit-1', document_id: published.document_id, expected_revision: 1
    }));
    const opId = hash(['hr-document-operation-v1', boss, 'req-archive-audit-1']);
    const receipt = w.db._get('stations/' + SID + '/hr_document_operations/' + opId);
    assert.equal(receipt.actor_uid, boss, 'who removed the procedure');
    assert.equal(Number.isSafeInteger(receipt.created_at_ms), true, 'when');
    assert.equal(receipt.document_id, published.document_id, 'which procedure');
  });

  console.log('');
  console.log('NOT RUN here — Firestore rules (emulator), the upload pipeline itself, and any physical');
  console.log('deletion from Storage, which does not exist by decision: removal is a soft delete.');
  console.log('');
  if (failures.length) {
    console.error(failures.length + ' removal authority checks failed.');
    process.exit(1);
  }
  console.log(passed + ' removal authority checks passed.');
})();
