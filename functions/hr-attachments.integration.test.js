'use strict';

/* ====================================================================
 *  hr-attachments · בדיקות אמולטור.
 *
 *  ⚠⚠ **הקובץ הזה לא הורץ על ידי מי שכתב אותו.** ה-jar של אמולטור
 *  ה-Storage אינו במטמון המקומי (`~/.cache/firebase/emulators` מכיל
 *  Firestore בלבד), ומשיכתו דורשת רשת שאין לי. עבר `node --check`
 *  בלבד. **אינני מציג בדיקה שלא ראיתי עוברת.**
 *
 *  ------------------------------------------------------------------
 *  ⚠ ומה שהוא **אינו** מוכיח, ואסור לומר שהוא כן
 *  ------------------------------------------------------------------
 *  **ה-`ports` וה-`session` כאן הם עדיין כפילים**, ולא מפעלי ההורה
 *  האמיתיים. הקובץ הזה מוכיח התנהגות של Firestore ושל Storage —
 *  הוא **אינו מוכיח חיבור** ל-`hr-documents`/`hr-requests`. את זה
 *  מוכיח רק החיווט האמיתי, ולא אטען אחרת.
 *
 *  ------------------------------------------------------------------
 *  מה **רק** האמולטור מוכיח, ובדיקות היחידה אינן
 *  ------------------------------------------------------------------
 *  - שמנוע העסקאות האמיתי **זורק** על קריאה אחרי כתיבה. זה הכשל
 *    שהכפיל הקודם החמיץ (seq542 §3), ולכן יש לו כאן תרחיש משלו.
 *  - מה אמולטור Storage באמת מיישם לגבי `ifGenerationMatch: 0`.
 *    firebase-tools 15.28.1 אינו אוכף אותו בהעלאת media; לכן חוזה
 *    ה-create-only מוכח ביחידה מול בקשת ה-SDK ובשער חי מבוקר מול GCS,
 *    ולא מיוחס בטעות לאמולטור.
 *  - מגבלות האמולטור בבחירת דור ובמחיקה מותנית נחשפות ולא
 *    מוצגות כהוכחת GCS. את האינווריאנטים האלה מוכיח שער GCS חי.
 *  - שכשל בסיום **מגלגל אחורה גם את רביזיית ההורה**, כי שניהם
 *    באותה עסקה אמיתית.
 *  - שמנוע העסקאות מכריע בין סיום לניקוי שרצים במקביל.
 *  - ש-`merge: true` ממזג מפות ברקורסיה (הלקח מ-seq517).
 *
 *  **ומה שגם האמולטור אינו מוכיח:** פרטיות IAM בייצור, אכיפת
 *  App Check בענן, מכסות Functions מתארחות, וסריקת נוזקות שאינה
 *  קיימת. הצלחה כאן אינה ראיה לאף אחד מהם.
 *
 *  הרצה — **`demo-*` על לולאה מקומית בלבד**:
 *    firebase emulators:exec --only firestore,storage --project demo-resq \
 *      "cd functions && node hr-attachments.integration.test.js"
 *
 *  אין שמות ואין כתובות אמיתיות כאן — הכל מומצא.
 * ==================================================================== */

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');

/* ---- שערים. נפילה לאחור לאישורי ייצור אסורה. ---- */

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/;
function requireLoopback(name) {
  const value = process.env[name];
  if (!value) {
    console.error(name + ' is required; refusing to use a real backend.');
    process.exit(2);
  }
  /* **הגנת לולאה.** משתנה סביבה שמצביע על מארח מרוחק הופך „בדיקת
   * אמולטור" לכתיבה על מערכת אמיתית. זו טעות שקטה, ולכן היא נחסמת. */
  if (!LOOPBACK.test(value)) {
    console.error(name + ' must point at a loopback emulator, got: ' + value);
    process.exit(2);
  }
  return value;
}
requireLoopback('FIRESTORE_EMULATOR_HOST');
requireLoopback('FIREBASE_STORAGE_EMULATOR_HOST');

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-resq';
if (!/^demo-/.test(PROJECT)) {
  console.error('Refusing to run against a non demo-* project: ' + PROJECT);
  process.exit(2);
}

const admin = require('firebase-admin');
const BUCKET = PROJECT + '.appspot.com';
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = admin.firestore();
const bucket = admin.storage().bucket(BUCKET);

const A = require('./hr-attachments');
const { createHrAttachments } = A;
const { createHrAttachmentsStorage } = require('./hr-attachments-storage');

/**
 * **פיקסצ׳רים ייחודיים לכל ריצה.** תחנה, הורה ומזהי בקשה נגזרים
 * מ-`RUN`, כך ששתי ריצות — או ריצה שנקטעה באמצע והשאירה שאריות —
 * אינן נוגעות זו בזו. ניקוי חלקי לא אמור להפיל את הריצה הבאה.
 */
const RUN = (process.env.HR_ATTACH_RUN || randomUUID()).replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase();
const SID = 'demo-station-' + RUN;
/* **ה-UID ייחודי לריצה** (seq545 §D): מכסת השחקן היא מסמך גלובלי,
 * ולכן ריצה שנייה עם אותו UID נחסמת על מכסה של ריצה קודמת. */
const UID = 'demo.employee.' + RUN;
const sha = b => createHash('sha256').update(b).digest('hex');
const parentIdFor = tag => sha(Buffer.from('parent|' + RUN + '|' + tag));
const PDF = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]), Buffer.from('1.4\ndemo\n')]);

class FakeHttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

let passed = 0;
async function scenario(name, fn) {
  await fn();
  passed += 1;
  console.log('  ✓ ' + name);
}

const stationRoot = () => db.collection('stations').doc(SID);
const parentRef = pid => stationRoot().collection('hr_parents').doc(pid);
const identityRef = uid => stationRoot().collection('hr_identities').doc(uid);
const attachRef = id => stationRoot().collection('hr_attachments').doc(id);

/**
 * ההורה והזהות הם **מסמכים אמיתיים**, ו-ports קוראים וכותבים אותם
 * בתוך העסקה. רק כך „קישור ורביזיה באותה עסקה" ו„גלגול אחורה של
 * ההורה בכשל" נבדקים בפועל ולא מול כפיל.
 */
function build(pid, opts = {}) {
  const storage = createHrAttachmentsStorage({ bucket });
  const commits = [];
  const api = createHrAttachments({
    db, storage, HttpsError: FakeHttpsError,
    session: {
      context: req => ({ uid: req.auth.uid, sid: SID, role: 'firefighter', super: false }),
      async assertLive(tx, ctx, authTime) {
        const snap = await tx.get(identityRef(ctx.uid));
        if (!snap.exists) throw new FakeHttpsError('permission-denied', 'Unknown identity.');
        const d = snap.data();
        if (d.revoked === true) throw new FakeHttpsError('permission-denied', 'Your sign-in was revoked.');
        if (d.tokens_valid_after > authTime) throw new FakeHttpsError('permission-denied', 'Refresh your sign-in.');
      }
    },
    /* **ה-ports מיישמים את חוזה seq547.** הורה חסר זורק `not-found`;
     * אין `exists` ואין דגלי הרשאה; `revision` נשלח ל-`document`
     * בלבד; והחברות מגיעה מ-`attachment_ids`. */
    ports: {
      async read(tx, input) {
        for (const k of Object.keys(input)) {
          if (input[k] === undefined) throw new Error('undefined sent to read: ' + k);
        }
        if (input.parent_kind === 'request' && Object.prototype.hasOwnProperty.call(input, 'revision')) {
          throw new Error('revision must never be sent for a request');
        }
        const snap = await tx.get(parentRef(input.parent_id));
        if (!snap.exists) throw new FakeHttpsError('not-found', 'Parent not found.');
        const p = snap.data();
        if (p.read_forbidden === true) throw new FakeHttpsError('permission-denied', 'This item is private.');
        if (input.revision != null && input.revision > p.revision) {
          throw new FakeHttpsError('failed-precondition', 'That revision is not available.');
        }
        const at = input.revision == null ? p.revision : input.revision;
        const members = p.members || {};
        const attachment_ids = Object.keys(members).filter(id => members[id] <= at).sort();
        if (input.attachment_id != null && !attachment_ids.includes(input.attachment_id)) {
          throw new FakeHttpsError('permission-denied', 'This file is not part of that item.');
        }
        return { parent_kind: input.parent_kind, parent_id: input.parent_id, revision: at, attachment_ids };
      },
      async prepare(tx, args) {
        const snap = await tx.get(parentRef(args.parent_id));
        if (!snap.exists) throw new FakeHttpsError('not-found', 'Parent not found.');
        const p = snap.data();
        if (p.upload_forbidden === true) throw new FakeHttpsError('permission-denied', 'You cannot add files here.');
        if (p.revision !== args.expected_revision) throw new FakeHttpsError('aborted', 'Parent changed.');
        return Object.freeze({ ...args, observed: p.revision });
      },
      async recheck(tx, plan) {
        const snap = await tx.get(parentRef(plan.parent_id));
        if (snap.data().revision !== plan.observed) throw new FakeHttpsError('aborted', 'Parent moved.');
        return undefined;
      },
      commit(tx, plan, { at }) {
        if (opts.notifyFails) throw new FakeHttpsError('unavailable', 'The notification could not be queued.');
        const next = plan.expected_revision + (opts.revisionSkew || 1);
        tx.set(parentRef(plan.parent_id), {
          revision: next, last_attachment_at_ms: at,
          members: { [plan.attachment_id]: next }
        }, { merge: true });
        commits.push({ ...plan, revision: next });
        return { linked: true, revision: next, event_id: plan.event_id, notification_status: 'queued' };
      }
    }
  });
  return { api, storage, commits };
}

const req = (data, uid = UID) => ({ auth: { uid, token: { auth_time: 1700000000 } }, data });
const intent = (pid, tag, patch = {}) => ({
  request_id: 'req-' + RUN + '-' + tag, parent_kind: 'request', parent_id: pid, parent_revision: 1,
  display_name: 'demo.pdf', declared_type: 'application/pdf',
  byte_length: PDF.length, content_sha256: sha(PDF), ...patch
});
const payload = (pid, tag, patch = {}) => ({ ...intent(pid, tag, patch), content_base64: PDF.toString('base64') });

async function seedParent(tag) {
  const pid = parentIdFor(tag);
  await parentRef(pid).set({ revision: 1, members: {}, upload_forbidden: false, read_forbidden: false });
  await identityRef(UID).set({ revoked: false, tokens_valid_after: 0 });
  return pid;
}

/** ניקוי מלא — כולל הספרים ומכסות השחקן, לא רק הקבצים. */
async function wipe() {
  for (const name of ['hr_attachments', 'hr_attachment_ledgers', 'hr_parents', 'hr_identities', 'probe']) {
    const snap = await stationRoot().collection(name).get();
    await Promise.all(snap.docs.map(d => d.ref.delete()));
  }
  await stationRoot().delete().catch(() => {});
  const [files] = await bucket.getFiles({ prefix: 'hr-private/' + SID + '/' });
  await Promise.all(files.map(f => f.delete().catch(() => {})));
  /* **שורש המכסה מנוקה במפורש**, ולא נשען על היות ה-UID ייחודי:
   * שני מנגנוני בידוד, כי אחד מהם עלול להישבר בשקט. */
  const qid = createHash('sha256')
    .update(JSON.stringify(['hr-attachment-quota-v1', UID])).digest('hex');
  await db.collection('hr_attachment_actor_quotas').doc(qid).delete().catch(() => {});
}

(async () => {
  console.log('run fixture: ' + SID);
  await wipe();

  await scenario('**מנוע העסקאות האמיתי זורק על קריאה אחרי כתיבה** (seq542 §3)', async () => {
    /* התרחיש שהכפיל הקודם החמיץ. אם זה **לא** נזרק כאן, כל ההנחה
     * שעליה בנוי סדר הפעולות במודול שגויה, ורוצים לדעת מיד. */
    let threw = null;
    try {
      await db.runTransaction(async tx => {
        tx.set(stationRoot().collection('probe').doc('raw'), { a: 1 });
        await tx.get(stationRoot().collection('probe').doc('other'));
      });
    } catch (e) { threw = e; }
    assert.ok(threw, 'עסקה עם קריאה אחרי כתיבה חייבת להיכשל');
    assert.match(String(threw.message), /read|write/i);
  });

  await scenario('מסלול מלא: הזמנה ⇒ העלאה ⇒ ready ⇒ הורדה מחזירה בדיוק את אותם בייטים', async () => {
    const pid = await seedParent('full');
    const h = build(pid);
    const r = await h.api.reserve(req(intent(pid, 'full')));
    const up = await h.api.upload(req(payload(pid, 'full')));
    assert.equal(up.state, 'ready');
    assert.equal(up.revision, 2, 'קובץ יוצר רביזיה N+1');
    assert.equal((await parentRef(pid).get()).data().revision, 2, 'ההורה זז באותה עסקה');
    const down = await h.api.download(req({ attachment_id: r.attachment_id }));
    assert.equal(Buffer.from(down.content_base64, 'base64').toString('hex'), PDF.toString('hex'));
    assert.ok(!JSON.stringify(down).includes('hr-private/'), 'אין נתיב בתשובה');
  });

  await scenario('**כשל בסיום מגלגל אחורה גם את ההורה** — עסקה אחת, לא שתיים', async () => {
    const pid = await seedParent('rollback');
    const h = build(pid, { notifyFails: true });
    const r = await h.api.reserve(req(intent(pid, 'rollback')));
    await assert.rejects(() => h.api.upload(req(payload(pid, 'rollback'))), /notification/i);
    assert.equal((await parentRef(pid).get()).data().revision, 1, '**רביזיית ההורה לא זזה**');
    assert.notEqual((await attachRef(r.attachment_id).get()).data().state, 'ready');
  });

  await scenario('**רביזיה שאינה בדיוק N+1 נדחית**', async () => {
    const pid = await seedParent('skew');
    const h = build(pid, { revisionSkew: 2 });
    const r = await h.api.reserve(req(intent(pid, 'skew')));
    await assert.rejects(() => h.api.upload(req(payload(pid, 'skew'))),
      e => e.code === 'failed-precondition');
    assert.equal((await parentRef(pid).get()).data().revision, 1);
    assert.notEqual((await attachRef(r.attachment_id).get()).data().state, 'ready');
  });

  await scenario('מגבלת האמולטור לגבי `ifGenerationMatch: 0` גלויה ואינה מוצגת כהוכחת GCS', async () => {
    const h = build(parentIdFor('probe'));
    const path = 'hr-private/' + SID + '/probe/exists';
    const first = await h.storage.save({ path, bytes: PDF, contentType: 'application/pdf', metadata: { a: '1' } });
    let second = null;
    try {
      second = await h.storage.save({ path, bytes: PDF, contentType: 'application/pdf', metadata: { a: '2' } });
    } catch (e) {
      assert.equal(e.code, 'precondition-failed');
    }
    if (second) {
      assert.notEqual(second.generation, first.generation,
        'האמולטור שלא אוכף precondition חייב לפחות לחשוף שהדור הוחלף');
      console.log('    ! Storage emulator does not enforce ifGenerationMatch=0; this is NOT GCS proof.');
    }
    await bucket.file(path).delete().catch(() => {});
  });

  await scenario('מגבלת האמולטור בקריאה לפי דור גלויה ואינה מוצגת כהוכחת GCS', async () => {
    const h = build(parentIdFor('probe'));
    const path = 'hr-private/' + SID + '/probe/gen';
    const first = await h.storage.save({ path, bytes: PDF, contentType: 'application/pdf', metadata: {} });
    await bucket.file(path).delete();
    const second = await h.storage.save({ path, bytes: PDF, contentType: 'application/pdf', metadata: {} });
    assert.notEqual(first.generation, second.generation);
    const staleRead = await h.storage.read({ path, generation: first.generation, maxBytes: 4096 });
    const currentRead = await h.storage.read({ path, generation: second.generation, maxBytes: 4096 });
    assert.ok(currentRead);
    if (staleRead) {
      assert.equal(staleRead.generation, second.generation,
        'האמולטור מתעלם מבחירת הדור ומחזיר את הדור הנוכחי בגלוי');
      console.log('    ! Storage emulator ignores generation reads; this is NOT GCS proof.');
    }
    await bucket.file(path).delete().catch(() => {});
  });

  await scenario('**התקרה נאכפת על הזרם** — אובייקט מעל התקרה אינו נאגר', async () => {
    const h = build(parentIdFor('probe'));
    const path = 'hr-private/' + SID + '/probe/big';
    const big = Buffer.concat([PDF, Buffer.alloc(300 * 1024, 0x41)]);
    await h.storage.save({ path, bytes: big, contentType: 'application/pdf', metadata: {} });
    const out = await h.storage.read({ path, maxBytes: 64 * 1024 });
    assert.equal(out.oversize, true);
    assert.equal(out.bytes, null);
    await bucket.file(path).delete().catch(() => {});
  });

  await scenario('מגבלת האמולטור במחיקה לפי דור גלויה ואינה מוצגת כהוכחת GCS', async () => {
    const h = build(parentIdFor('probe'));
    const path = 'hr-private/' + SID + '/probe/del';
    const first = await h.storage.save({ path, bytes: PDF, contentType: 'application/pdf', metadata: {} });
    await bucket.file(path).delete();
    const second = await h.storage.save({ path, bytes: PDF, contentType: 'application/pdf', metadata: {} });
    const stale = await h.storage.remove({ path, generation: first.generation });
    const survivor = await h.storage.read({ path, generation: second.generation, maxBytes: 4096 });
    if (stale.removed) {
      assert.equal(survivor, null, 'האמולטור התעלם מתנאי הדור ומחק את הנוכחי בגלוי');
      console.log('    ! Storage emulator ignores generation deletes; this is NOT GCS proof.');
    } else {
      assert.ok(survivor, 'אם האמולטור אכף את התנאי, הדור החדש חייב לשרוד');
    }
    await bucket.file(path).delete().catch(() => {});
  });

  await scenario('התאוששות אחרי כשל: **אובייקט אחד, קישור אחד, בלי דריסה**', async () => {
    const pid = await seedParent('resume');
    const h = build(pid, { notifyFails: true });
    const r = await h.api.reserve(req(intent(pid, 'resume')));
    await assert.rejects(() => h.api.upload(req(payload(pid, 'resume'))));
    const prefix = 'hr-private/' + SID + '/request/' + pid + '/' + r.attachment_id;
    const [before] = await bucket.getFiles({ prefix });
    assert.equal(before.length, 1, 'אובייקט אחד נשמר');

    const g = build(pid);
    const resumed = await g.api.resume(req({ attachment_id: r.attachment_id }));
    assert.equal(resumed.state, 'ready');
    const [after] = await bucket.getFiles({ prefix });
    assert.equal(after.length, 1, '**אין אובייקט שני**');
    assert.equal(g.commits.length, 1, 'קישור אחד בלבד');
    assert.equal((await parentRef(pid).get()).data().revision, 2, 'רביזיה אחת נוספה, לא שתיים');
  });

  await scenario('**תוכן שהוחלף אינו מאומץ** — מטא-דאטה אינה הוכחת תוכן', async () => {
    const pid = await seedParent('tamper');
    const h = build(pid, { notifyFails: true });
    const r = await h.api.reserve(req(intent(pid, 'tamper')));
    await assert.rejects(() => h.api.upload(req(payload(pid, 'tamper'))));
    /* אותו נתיב, מטא-דאטה שנראית תקינה, בייטים אחרים. */
    const path = (await attachRef(r.attachment_id).get()).data().object_path;
    const [meta] = await bucket.file(path).getMetadata();
    await bucket.file(path).delete();
    await bucket.file(path).save(Buffer.concat([PDF, Buffer.from('tampered')]), {
      resumable: false, metadata: { contentType: 'application/pdf', metadata: meta.metadata }
    });
    const g = build(pid);
    await assert.rejects(() => g.api.resume(req({ attachment_id: r.attachment_id })),
      e => e.code === 'failed-precondition');
    assert.equal((await attachRef(r.attachment_id).get()).data().failure_code, 'foreign-object');
    const [still] = await bucket.getFiles({ prefix: path });
    assert.equal(still.length, 1, '**אובייקט זר לא נמחק ולא נדרס**');
  });

  await scenario('ניקוי תפס — שני פיוסים מקבילים, והמכסה משתחררת לכל היותר פעם אחת', async () => {
    const pid = await seedParent('reconcile');
    const h = build(pid, { notifyFails: true });
    const r = await h.api.reserve(req(intent(pid, 'reconcile')));
    await assert.rejects(() => h.api.upload(req(payload(pid, 'reconcile'))));
    await attachRef(r.attachment_id).set({ reserve_expires_ms: 1 }, { merge: true });

    const [one, two] = await Promise.all([
      h.api.reconcile({ sid: SID, attachment_id: r.attachment_id, operation_id: 'op-' + RUN + '-a' }),
      h.api.reconcile({ sid: SID, attachment_id: r.attachment_id, operation_id: 'op-' + RUN + '-b' })
    ]);
    const released = [one, two].filter(v => v.quota_released === true);
    assert.equal(released.length, 0, '**אחרי שנשלחו בייטים המכסה אינה משתחררת כלל**');
    const g = build(pid);
    const resumed = await g.api.resume(req({ attachment_id: r.attachment_id }));
    assert.equal(resumed.resume, 'upload-required');
    assert.equal(resumed.attachment_id, r.attachment_id);
  });

  await scenario('**`ready` לעולם אינו מנוקה**', async () => {
    const pid = await seedParent('keep');
    const h = build(pid);
    const r = await h.api.reserve(req(intent(pid, 'keep')));
    await h.api.upload(req(payload(pid, 'keep')));
    await attachRef(r.attachment_id).set({ reserve_expires_ms: 1 }, { merge: true });
    const out = await h.api.reconcile({ sid: SID, attachment_id: r.attachment_id, operation_id: 'op-' + RUN + '-c' });
    assert.equal(out.cleaned, false);
    assert.equal(out.reason, 'ready');
    const [files] = await bucket.getFiles({ prefix: 'hr-private/' + SID + '/request/' + pid + '/' + r.attachment_id });
    assert.equal(files.length, 1, 'הקובץ עדיין שם');
  });

  await scenario('שלילת זהות לפני החזרת הבייטים — אין בייטים', async () => {
    const pid = await seedParent('revoke');
    const h = build(pid);
    const r = await h.api.reserve(req(intent(pid, 'revoke')));
    await h.api.upload(req(payload(pid, 'revoke')));
    await identityRef(UID).set({ revoked: true, tokens_valid_after: 0 });
    await assert.rejects(() => h.api.download(req({ attachment_id: r.attachment_id })),
      e => e.code === 'permission-denied');
    await identityRef(UID).set({ revoked: false, tokens_valid_after: 0 });
  });

  await scenario('**סמן העמוד מול Firestore אמיתי** — פיקסצ׳ר פנימי, לא מסלול לקוח', async () => {
    /* `PAGE_SIZE` הוא 25 ותקרת ההורה 10, ולכן עמוד שני **אינו נוצר**
     * דרך מסלול הלקוח. הרשומות נזרעות ישירות.
     *
     * **הערה שהתיישנה ותוקנה:** הרשימה כבר אינה שואילתה עם
     * `where`/`orderBy`, אלא **קריאת מסמכים לפי מזהה** מתוך
     * `attachment_ids` ומיון בזיכרון. אין כאן אינדקס מורכב, ולכן
     * מה שנבדק הוא הקריאות והמיון — לא התנהגות אינדקס. */
    const pid = await seedParent('paging');
    const h = build(pid);
    const total = A.PAGE_SIZE + 2;
    const ids = [];
    const batch = db.batch();
    for (let n = 0; n < total; n += 1) {
      const id = sha(Buffer.from('paging|' + RUN + '|' + n));
      ids.push(id);
      batch.set(attachRef(id), {
        schema: A.SCHEMA, attachment_id: id, state: 'ready',
        station_id: SID, parent_kind: 'request', parent_id: pid,
        display_name: 'f' + n + '.pdf', declared_type: 'application/pdf', byte_length: 10,
        base_revision: 1, published_revision: n + 2, ready_at_ms: 5000000
      });
    }
    await batch.commit();
    const members = {};
    ids.forEach((id, n) => { members[id] = n + 2; });
    await parentRef(pid).set({ revision: total + 1, members }, { merge: true });

    const seen = [];
    let cursor = null;
    let pages = 0;
    for (;;) {
      const page = await h.api.list(req({ parent_kind: 'request', parent_id: pid, cursor }));
      pages += 1;
      seen.push(...page.items.map(i => i.attachment_id));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
      assert.ok(pages < 10, 'לולאה');
    }
    assert.equal(seen.length, total);
    assert.equal(new Set(seen).size, total, 'בלי חזרות');
    assert.equal(pages, 2, 'העמוד השני נבדק בפועל');
  });

  await scenario('`merge: true` ממזג מפות ברקורסיה — הלקח מ-seq517', async () => {
    const ref = stationRoot().collection('probe').doc('merge');
    await ref.set({ last: { a: 1, ghost: true } });
    await ref.set({ last: { a: 2 } }, { merge: true });
    assert.equal((await ref.get()).data().last.ghost, true, 'הדגל הישן שרד — לכן mergeFields ולא merge');
    await ref.delete();
  });

  console.log('\n' + passed + ' hr-attachments emulator scenarios passed.');
  await wipe();
  process.exit(0);
})().catch(async (error) => {
  console.error(error);
  await wipe().catch(() => {});
  process.exit(1);
});
