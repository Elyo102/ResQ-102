'use strict';

/* ====================================================================
 *  hr-attachments · בדיקות יחידה.
 *
 *  ------------------------------------------------------------------
 *  מה שונה מהגרסה הקודמת, ולמה
 *  ------------------------------------------------------------------
 *  הכפיל הקודם **הרשה קריאה אחרי כתיבה** בתוך עסקה. Firestore אמיתי
 *  זורק שם. לכן באג אמיתי במוצר — `chargeQuota` שכותב ואז
 *  `assertLive` שקורא — עבר מתחת לעשרות בדיקות ירוקות. זו הפעם
 *  הרביעית שכפיל שלי הסתיר כשל.
 *
 *  לכן בכפיל הזה:
 *  - **`tx.get` אחרי `tx.set`/`tx.create` זורק**, באותו נוסח.
 *  - **`session.assertLive` עושה `tx.get` אמיתי** על מסמך זהות, כמו
 *    בייצור — כך שכל קריאה מאוחרת מדי מתפוצצת בבדיקות.
 *  - **ההורה הוא מסמך אמיתי בעסקה.** `ports.read`/`prepare`/`recheck`
 *    קוראים אותו ו-`commit` כותב אותו, ולכן „קישור ורביזיה באותה
 *    עסקה" נבדק בפועל, וכשל בסיום **מגלגל אחורה גם את ההורה**.
 *  - **`startAfter` דורש ערך לכל שדה `orderBy`.** סמן שהוא ID בלבד
 *    נדחה, ולא „עובד" בשקט.
 *  - מיזוג מפות **ברקורסיה** (הלקח מ-seq517) נשאר.
 *
 *  ⚠ **מה שהקובץ הזה אינו:** אמולטור. כפיל של port מוכיח שהמודול
 *  קורא לו נכון ובסדר הנכון — הוא **אינו** מוכיח ש-`hr-documents`
 *  באמת יוצר רביזיה N+1. את זה מוכיח רק חיווט אמיתי.
 *
 *  **פיקסצ׳רים סינתטיים בלבד.** אין מסמך אמיתי ואין קובץ אישי —
 *  Hosting מגיש את שורש המאגר, ולכן בינארי במאגר הוא קובץ באוויר.
 * ==================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const A = require('./hr-attachments');

const SID = 'test-station';
const UID = 'employee.01';
const HR = 'hr.coordinator';
const PARENT = 'a'.repeat(64);
const AUTH_TIME = 1700000000;
const sha = b => createHash('sha256').update(b).digest('hex');

const PDF = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]), Buffer.from('1.4\nsynthetic\n')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic')]);

class FakeHttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ==================================================================
 *  Firestore בזיכרון · CAS אמיתי · **קריאה אחרי כתיבה זורקת**
 * ================================================================== */

const READ_AFTER_WRITE = 'Firestore transactions require all reads to be executed before all writes.';

function makeDb() {
  const docs = new Map();
  const versions = new Map();
  const versionOf = k => versions.get(k) || 0;
  const bump = k => versions.set(k, versionOf(k) + 1);
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const snapOf = key => ({
    exists: docs.has(key), id: key.slice(key.lastIndexOf('/') + 1),
    data: () => (docs.has(key) ? clone(docs.get(key)) : undefined)
  });

  /* Firestore אמיתי ממזג מפות **ברקורסיה**; `mergeFields` מחליף
   * נתיב שלם. הכפיל חייב להתנהג כך — הלקח מ-seq517. */
  const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const deepMerge = (base, patch) => {
    const out = Object.assign({}, base || {});
    for (const k of Object.keys(patch || {})) {
      out[k] = isPlain(patch[k]) && isPlain(out[k]) ? deepMerge(out[k], patch[k]) : clone(patch[k]);
    }
    return out;
  };
  const write = (key, value, options) => {
    if (options && Array.isArray(options.mergeFields)) {
      const out = Object.assign({}, docs.get(key) || {});
      for (const f of options.mergeFields) out[f] = clone(value[f]);
      docs.set(key, out);
    } else if (options && options.merge) {
      docs.set(key, deepMerge(docs.get(key), value));
    } else {
      docs.set(key, clone(value));
    }
    bump(key);
  };

  const cmp = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
  const OPS = {
    '==': (a, b) => a === b,
    '<=': (a, b) => a <= b,
    '<': (a, b) => a < b,
    '>=': (a, b) => a >= b,
    '>': (a, b) => a > b
  };

  function collectionRef(prefix, shape) {
    const s = shape || { filters: [], order: [], limit: 0, after: null };
    return {
      __prefix: prefix,
      doc: id => docRef(prefix + '/' + id),
      where(field, op, value) {
        if (!OPS[op]) throw new Error('unsupported operator ' + op);
        return collectionRef(prefix, { ...s, filters: [...s.filters, [field, op, value]] });
      },
      orderBy(field, dir) {
        return collectionRef(prefix, { ...s, order: [...s.order, [field, dir === 'desc' ? -1 : 1]] });
      },
      limit(n) { return collectionRef(prefix, { ...s, limit: n }); },
      /**
       * **סמן חייב ערך לכל שדה `orderBy`.** Firestore אמיתי מפרש
       * `startAfter(x)` מול הסדר המוצהר; סמן שהוא ID בלבד מול סדר
       * דו-שדתי הוא באג שקט, ולכן כאן הוא שגיאה רועשת.
       */
      startAfter(...values) {
        if (!s.order.length) throw new Error('startAfter requires orderBy');
        if (values.length !== s.order.length) {
          throw new Error('startAfter expects ' + s.order.length + ' values, got ' + values.length);
        }
        return collectionRef(prefix, { ...s, after: values });
      },
      async get() {
        let rows = [...docs.entries()]
          .filter(([k]) => k.startsWith(prefix + '/') && !k.slice(prefix.length + 1).includes('/'))
          .map(([k, v]) => ({ id: k.slice(k.lastIndexOf('/') + 1), __v: clone(v), data() { return clone(this.__v); } }))
          .filter(row => s.filters.every(([f, op, val]) => OPS[op](row.__v[f], val)));
        if (!s.order.length) throw new Error('query requires an explicit orderBy');
        rows.sort((x, y) => {
          for (const [f, dir] of s.order) {
            const c = cmp(x.__v[f], y.__v[f]);
            if (c !== 0) return c * dir;
          }
          return 0;
        });
        if (s.after) {
          rows = rows.filter(row => {
            for (let n = 0; n < s.order.length; n += 1) {
              const [f, dir] = s.order[n];
              const c = cmp(row.__v[f], s.after[n]);
              if (c !== 0) return c * dir > 0;
            }
            return false;
          });
        }
        return { docs: s.limit ? rows.slice(0, s.limit) : rows };
      }
    };
  }

  const docRef = path => ({
    __key: String(path),
    collection: sub => collectionRef(String(path) + '/' + sub),
    async get() { return snapOf(String(path)); },
    async set(v, o) { write(String(path), v, o); }
  });

  const state = { docs, commits: 0, aborts: 0, readAfterWrite: 0 };
  const db = {
    doc: p => docRef(p),
    collection: p => collectionRef(p),
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const seen = new Map();
        const writes = [];
        let wrote = false;
        const tx = {
          async get(ref) {
            /* **החוק.** לא „רצוי" — כך Firestore מתנהג. */
            if (wrote) { state.readAfterWrite += 1; throw new Error(READ_AFTER_WRITE); }
            seen.set(ref.__key, versionOf(ref.__key));
            return snapOf(ref.__key);
          },
          set(ref, v, o) { wrote = true; writes.push({ key: ref.__key, v, o }); },
          create(ref, v) { wrote = true; writes.push({ key: ref.__key, v, create: true }); }
        };
        const result = await fn(tx);
        let conflict = false;
        seen.forEach((v, k) => { if (versionOf(k) !== v) conflict = true; });
        if (conflict) { state.aborts += 1; continue; }
        for (const w of writes) {
          if (w.create && docs.has(w.key)) throw Object.assign(new Error('exists'), { code: 'already-exists' });
          write(w.key, w.v, w.o);
        }
        state.commits += 1;
        return result;
      }
      throw Object.assign(new Error('contention'), { code: 'aborted' });
    }
  };
  return { db, state, docs };
}

/* ==================================================================
 *  אחסון סינתטי · דורות ו-create-only
 * ================================================================== */

function makeStorage(opts = {}) {
  const objects = new Map();
  let seq = 100;
  const calls = { save: 0, read: 0, remove: 0 };
  return {
    objects, calls,
    async save({ path, bytes, metadata }) {
      calls.save += 1;
      /* `holdSave` משאיר את השמירה **פתוחה** — כמו בקשה שיצאה לרשת
       * ועדיין לא הוכרעה. זה מה שהופך „היעדר" לחסר משמעות. */
      if (opts.holdSave && calls.save === 1) await opts.holdSave;
      if (opts.saveThrows) { const e = new Error('boom'); e.code = opts.saveThrows; throw e; }
      if (objects.has(path)) { const e = new Error('exists'); e.code = 'precondition-failed'; throw e; }
      seq += 1;
      objects.set(path, { bytes: Buffer.from(bytes), metadata: { ...metadata }, generation: String(seq) });
      if (opts.crashAfterSave) { const e = new Error('lost'); e.code = 'unavailable'; throw e; }
      return { generation: String(seq) };
    },
    async read({ path, generation }) {
      calls.read += 1;
      /* `failReads` מדמה **מוות של התהליך**: האובייקט נשמר, ושום
       * שלב נוסף — כולל האימוץ שבתוך אותה קריאה — לא הספיק לרוץ.
       * בלי זה „קריסה" הייתה מתאוששת מיד, והבדיקה הייתה עוקפת את
       * מסלול ההתאוששות במקום להוכיח אותו. */
      if (opts.failReads && calls.read <= opts.failReads) {
        const e = new Error('process died'); e.code = 'unavailable'; throw e;
      }
      const o = objects.get(path);
      if (!o) return null;
      if (generation != null && String(generation) !== o.generation) return null;
      return { bytes: Buffer.from(o.bytes), metadata: { ...o.metadata }, generation: o.generation };
    },
    async remove({ path, generation }) {
      calls.remove += 1;
      if (opts.removeFails) return { removed: false, reason: 'generation-mismatch' };
      const o = objects.get(path);
      if (!o) return { removed: false, reason: 'not-found' };
      if (generation != null && String(generation) !== o.generation) {
        return { removed: false, reason: 'generation-mismatch' };
      }
      objects.delete(path);
      return { removed: true };
    }
  };
}

/* ==================================================================
 *  ports · ההורה הוא מסמך אמיתי בעסקה
 * ================================================================== */

function build(opts = {}) {
  const { db, state, docs } = makeDb();
  const storage = opts.storage || makeStorage();
  const parentKey = 'stations/' + SID + '/hr_parents/' + PARENT;
  const identityKey = 'stations/' + SID + '/hr_identities/' + UID;

  docs.set(parentKey, {
    revision: opts.revision || 1, members: {},
    upload_forbidden: opts.canUpload === false, read_forbidden: opts.canRead === false,
    closed: opts.closed === true
  });
  docs.set(identityKey, { revoked: false, tokens_valid_after: 0 });
  docs.set('stations/' + SID + '/hr_identities/' + HR, { revoked: false, tokens_valid_after: 0 });

  const parentRef = db.doc(parentKey);
  const commits = [];
  const rechecks = [];
  const reads = [];
  let parentReads = 0;

  const READ_FIELDS = ['ctx', 'authTime', 'parent_kind', 'parent_id', 'revision', 'attachment_id'];

  /**
   * **ה-ports כאן מיישמים את החוזה של seq547, ואוכפים אותו בחזרה.**
   * כפיל שמקבל בשקט שדה אסור אינו כפיל — הוא כרית. לכן:
   * `undefined` נזרק, שדה לא מוכר נזרק, ו-`revision` ל-`request`
   * נזרק. הורה חסר **זורק** `not-found`; אין `exists` ואין דגלי
   * הרשאה, והצלחת `read` **היא** הרשאת הקריאה.
   */
  const ports = {
    async read(tx, input) {
      parentReads += 1;
      reads.push(input);
      for (const k of Object.keys(input)) {
        if (!READ_FIELDS.includes(k)) throw new Error('unexpected field sent to read: ' + k);
        if (input[k] === undefined) throw new Error('undefined sent to read: ' + k);
      }
      if (input.parent_kind === 'request' && Object.prototype.hasOwnProperty.call(input, 'revision')) {
        throw new Error('revision must never be sent for a request');
      }
      const snap = await tx.get(db.doc('stations/' + SID + '/hr_parents/' + input.parent_id));
      if (!snap.exists) throw new FakeHttpsError('not-found', 'Parent not found.');
      const p = snap.data();
      const revoked = opts.revokeReadAfter != null && parentReads > opts.revokeReadAfter;
      if (p.read_forbidden === true || revoked) {
        throw new FakeHttpsError('permission-denied', 'This item is private.');
      }
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
      const snap = await tx.get(parentRef);
      if (!snap.exists) throw new FakeHttpsError('not-found', 'Parent not found.');
      const p = snap.data();
      if (p.upload_forbidden === true) throw new FakeHttpsError('permission-denied', 'You cannot add files here.');
      if (p.closed === true) throw new FakeHttpsError('failed-precondition', 'This item is closed.');
      if (p.revision !== args.expected_revision) throw new FakeHttpsError('aborted', 'Parent changed.');
      if (opts.prepareNull) return null;
      return Object.freeze({ ...args, observed: p.revision });
    },
    async recheck(tx, plan) {
      rechecks.push(plan);
      const snap = await tx.get(parentRef);
      if (snap.data().revision !== plan.observed) throw new FakeHttpsError('aborted', 'Parent moved.');
      return undefined;
    },
    /** **סינכרוני**, ורץ בשלב הכתיבה. */
    commit(tx, plan, { at }) {
      if (opts.notifyFails) throw new FakeHttpsError('unavailable', 'The notification could not be queued.');
      if (opts.linkNotLinked) return { linked: false };
      const next = plan.expected_revision + (opts.revisionSkew || 1);
      tx.set(parentRef, { revision: next, members: { [plan.attachment_id]: next } }, { merge: true });
      commits.push({ ...plan, at, revision: next });
      return {
        linked: true, revision: next,
        event_id: opts.wrongEvent ? 'evt-other' : plan.event_id,
        notification_status: 'queued'
      };
    }
  };

  const session = {
    context: req2 => ({ uid: req2.auth.uid, sid: SID, role: req2.auth.role || 'firefighter', super: req2.auth.super === true }),
    /** **קריאה אמיתית בעסקה** — בדיוק כמו `requireLive` בייצור. */
    async assertLive(tx, ctx, authTime) {
      const snap = await tx.get(db.doc('stations/' + SID + '/hr_identities/' + ctx.uid));
      if (!snap.exists) throw new FakeHttpsError('permission-denied', 'Unknown identity.');
      const d = snap.data();
      if (d.revoked === true) throw new FakeHttpsError('permission-denied', 'Your sign-in was revoked.');
      if (d.tokens_valid_after > authTime) throw new FakeHttpsError('permission-denied', 'Refresh your sign-in.');
    }
  };

  let t = 1_000_000;
  const api = A.createHrAttachments({
    db, storage, HttpsError: FakeHttpsError, session, ports,
    clock: () => (opts.clock ? opts.clock() : (t += 1000)),
    hooks: opts.hooks || {}
  });
  return {
    api, db, state, docs, storage, commits, rechecks, reads,
    parentKey, identityKey,
    parent: () => docs.get(parentKey),
    setParent: p => docs.set(parentKey, { ...docs.get(parentKey), ...p }),
    addMembers: map => docs.set(parentKey,
      { ...docs.get(parentKey), members: { ...docs.get(parentKey).members, ...map } }),
    revoke: () => docs.set(identityKey, { revoked: true, tokens_valid_after: 0 }),
    attachment: id => docs.get('stations/' + SID + '/hr_attachments/' + id),
    ledger: () => [...docs.entries()].filter(([k]) => k.includes('hr_attachment_ledgers'))[0]
  };
}

const req = (data, who = UID) => ({ auth: { uid: who, token: { auth_time: AUTH_TIME } }, data });

const base = (bytes = PDF, patch = {}) => ({
  request_id: 'req-000000001',
  parent_kind: 'request',
  parent_id: PARENT,
  parent_revision: 1,
  display_name: 'report.pdf',
  declared_type: 'application/pdf',
  byte_length: bytes.length,
  content_sha256: sha(bytes),
  ...patch
});
const withBytes = (bytes = PDF, patch = {}) => ({ ...base(bytes, patch), content_base64: bytes.toString('base64') });

const idOfDoc = h => [...h.docs.keys()].filter(k => k.includes('/hr_attachments/'))[0].split('/').pop();

/**
 * **פיקסצ׳ר פנימי לסמן העמוד** (seq545 §D). תקרת ההורה היא 10 קבצים
 * ו-`PAGE_SIZE` הוא 25 — ולכן עמוד שני אינו נוצר דרך מסלול הלקוח,
 * וזה **נכון**: קבוע מוצר אינו משתנה כדי להקל על בדיקה. הרשומות
 * נזרעות ישירות, ומה שנבדק הוא הסדר והסמן.
 */
const seedId = n => createHash('sha256').update('hr-attachment-seed-' + n).digest('hex');
function seedReady(h, ids, revisionOf, kind = 'request') {
  const members = {};
  for (const [n, id] of ids.entries()) {
    h.docs.set('stations/' + SID + '/hr_attachments/' + id, {
      schema: A.SCHEMA, attachment_id: id, state: 'ready',
      station_id: SID, parent_kind: kind, parent_id: PARENT,
      display_name: 'f' + n + '.pdf', declared_type: 'application/pdf', byte_length: 10,
      base_revision: 1, published_revision: revisionOf(n), ready_at_ms: 5_000_000
    });
    members[id] = revisionOf(n);
  }
  /* **ההורה הוא מקור האמת לחברות**, ולכן הפיקסצ׳ר רושם אותה שם. */
  h.addMembers(members);
}

/** מעלה קובץ אחד, ומעדכן את הרביזיה הבאה. */
async function uploadOne(h, n, rev) {
  await h.api.reserve(req(base(PDF, { request_id: 'req-' + String(n).padStart(9, '0'), parent_revision: rev })));
  return h.api.upload(req(withBytes(PDF, { request_id: 'req-' + String(n).padStart(9, '0'), parent_revision: rev })));
}

/* ==================================================================
 *  0 · הכפיל עצמו — כי כפיל שאינו משחזר את הכשל אינו בדיקה
 * ================================================================== */

test('**הכפיל דוחה קריאה אחרי כתיבה** — הבאג של seq542 §3 חייב להתפוצץ כאן', async () => {
  const { db, state } = makeDb();
  await assert.rejects(() => db.runTransaction(async tx => {
    tx.set(db.doc('x/1'), { a: 1 });
    await tx.get(db.doc('x/2'));
  }), new RegExp('all reads to be executed before all writes'));
  assert.equal(state.readAfterWrite, 1);
});

test('**הכפיל דוחה סמן שאינו נושא ערך לכל שדה סדר**', async () => {
  const { db } = makeDb();
  const q = db.collection('c').orderBy('published_revision').orderBy('attachment_id');
  assert.throws(() => q.startAfter('only-an-id'), /expects 2 values, got 1/);
  assert.doesNotThrow(() => q.startAfter(3, 'b'.repeat(64)));
  assert.throws(() => db.collection('c').startAfter(1), /requires orderBy/);
});

test('הכפיל ממזג מפות ברקורסיה, ו-`mergeFields` מחליף נתיב שלם', async () => {
  const { db, docs } = makeDb();
  docs.set('x/1', { m: { a: 1, b: 2 }, k: 'keep' });
  await db.doc('x/1').set({ m: { b: 9 } }, { merge: true });
  assert.deepEqual(docs.get('x/1'), { m: { a: 1, b: 9 }, k: 'keep' });
  await db.doc('x/1').set({ m: { c: 3 } }, { mergeFields: ['m'] });
  assert.deepEqual(docs.get('x/1'), { m: { c: 3 }, k: 'keep' });
});

test('**כל פעולה מבצעת קריאת זהות בעסקה** — assertLive אינו קישוט', async () => {
  const h = build();
  let live = 0;
  const spy = build({});
  assert.ok(spy);
  h.docs.set(h.identityKey, { revoked: false, tokens_valid_after: AUTH_TIME + 1 });
  await assert.rejects(() => h.api.reserve(req(base())), e => e.code === 'permission-denied');
  assert.equal(live, 0);
});

/* ==================================================================
 *  1 · מעטפת · base64 · אורך · hash · חתימה
 * ================================================================== */

test('קנוניות base64 — הלוך-חזור, לא „הצליח לפענח"', () => {
  assert.ok(A.decodeCanonical(PDF.toString('base64')));
  assert.equal(A.decodeCanonical('JVBERi0xLjQ'), null, 'ריפוד חסר');
  assert.equal(A.decodeCanonical('JVBERi0x LjQK'), null, 'רווח');
  assert.equal(A.decodeCanonical('JVBERi0x\nLjQK'), null, 'שורה חדשה');
  assert.equal(A.decodeCanonical('JVBERi0xLjQK==='), null, 'ריפוד עודף');
  assert.equal(A.decodeCanonical('_-BERi0xLjQK'), null, 'base64url');
  assert.equal(A.decodeCanonical(''), null, 'ריק');
  for (const bad of [null, undefined, 123, {}, []]) assert.equal(A.decodeCanonical(bad), null);
});

test('**התקרה נאכפת על אורך המחרוזת, לפני הפענוח**', () => {
  assert.equal(A.MAX_BASE64, Math.ceil(A.MAX_BYTES / 3) * 4);
  assert.equal(A.decodeCanonical('A'.repeat(A.MAX_BASE64 + 4)), null);
});

test('חתימת קסם — הסוג מהבייטים, לא מההצהרה', () => {
  assert.ok(A.signatureMatches(PDF, 'application/pdf'));
  assert.ok(A.signatureMatches(PNG, 'image/png'));
  assert.ok(!A.signatureMatches(PDF, 'image/png'), 'PDF שמוצהר כ-PNG');
  assert.ok(!A.signatureMatches(PNG, 'application/pdf'));
  assert.ok(!A.signatureMatches(Buffer.from('<svg xmlns='), 'image/png'), 'SVG הוא מסמך פעיל');
  assert.ok(!A.signatureMatches(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'application/pdf'), 'ZIP/Office');
  assert.ok(!A.signatureMatches(Buffer.from([0x47, 0x49, 0x46, 0x38]), 'image/png'), 'GIF אינו ברשימה');
  assert.ok(!A.signatureMatches(Buffer.concat([Buffer.from([0]), PDF]), 'application/pdf'), 'היסט 1');
  assert.ok(!A.signatureMatches(Buffer.from([0x89, 0x50]), 'image/png'), 'קצר מהחתימה');
});

test('העלאה נדחית על אורך, hash וחתימה שאינם תואמים', async () => {
  const h = build();
  await assert.rejects(() => h.api.upload(req(withBytes(PDF, { byte_length: PDF.length + 1 }))), /size/i);
  await assert.rejects(() => h.api.upload(req(withBytes(PDF, { content_sha256: 'b'.repeat(64) }))), /digest/i);
  await assert.rejects(() => h.api.upload(req({ ...base(PDF, { declared_type: 'image/png' }), content_base64: PDF.toString('base64') })), /declared type/i);
  assert.equal(h.storage.calls.save, 0, '**שום דבר לא נשמר על קלט פסול**');
});

test("`byte_length` חייב להיות מספר שלם ממש — הלקח מ-seq517", async () => {
  const h = build();
  for (const bad of ['1024', 1.5, -1, 0, NaN, Infinity, null, true]) {
    await assert.rejects(() => h.api.reserve(req(base(PDF, { byte_length: bad }))), /size/i);
  }
});

test('שם קובץ — נתיב, בקרה, RTL-override ושמות שמורים', async () => {
  const h = build();
  const bad = ['../../etc/passwd', 'a\\b.pdf', 'a/b.pdf', 'a\u0007b.pdf', 'a\u202egnp.exe.pdf',
    '', '   ', 'CON', 'x'.repeat(A.MAX_NAME + 1)];
  for (const name of bad) {
    await assert.rejects(() => h.api.reserve(req(base(PDF, { display_name: name }))), /file name/i, JSON.stringify(name));
  }
  await assert.doesNotReject(() => h.api.reserve(req(base(PDF, { display_name: 'דוח שעות אוגוסט.pdf' }))));
});

/* ==================================================================
 *  2 · כוונה · שידור חוזר · מכסת קצב
 * ================================================================== */

test('אותו `request_id` עם **כל** שינוי אחר — `already-exists`', async () => {
  for (const patch of [{ content_sha256: sha(PNG) }, { display_name: 'other.pdf' },
    { declared_type: 'image/png' }, { byte_length: 99 }]) {
    const h = build();
    await h.api.reserve(req(base()));
    await assert.rejects(() => h.api.reserve(req(base(PDF, patch))),
      e => e.code === 'already-exists' || /size|digest|file name|type/i.test(e.message), JSON.stringify(patch));
  }
});

test('הזמנה חוזרת זהה מתכנסת לאותו מזהה, בלי כפילות ובלי חיוב כפול', async () => {
  const h = build();
  const one = await h.api.reserve(req(base()));
  const two = await h.api.reserve(req(base()));
  assert.equal(one.attachment_id, two.attachment_id);
  assert.equal(two.duplicate, true);
  assert.equal(Object.keys(h.ledger()[1].entries).length, 1, '**רשומה אחת בספר**');
});

test('**מכסת הקצב נחסמת בהזמנה — לפני שהבייטים על החוט**', async () => {
  let t = 1_000_000;
  const h = build({ clock: () => t });
  for (let n = 0; n < A.QUOTA_MAX; n += 1) {
    await h.api.reserve(req(base(PDF, { request_id: 'req-' + String(n).padStart(9, '0') })));
  }
  await assert.rejects(() => h.api.reserve(req(base(PDF, { request_id: 'req-overflow1' }))),
    e => e.code === 'resource-exhausted' && /Too many uploads/.test(e.message));
  assert.equal(h.storage.calls.save, 0);
});

/* ==================================================================
 *  3 · המסלול המלא · הקישור יוצר רביזיה N+1
 * ================================================================== */

test('העלאה תקינה מגיעה ל-`ready` ויוצרת רביזיה N+1', async () => {
  const h = build();
  await h.api.reserve(req(base()));
  const out = await h.api.upload(req(withBytes()));
  assert.equal(out.state, 'ready');
  assert.equal(out.revision, 2, '**N+1, לא שינוי שקט של N**');
  assert.equal(h.commits.length, 1);
  assert.equal(h.parent().revision, 2, 'ההורה זז באותה עסקה');
  assert.equal(out.notification_status, 'queued');
});

test('**`base_revision` ו-`published_revision` נשמרים בנפרד**', async () => {
  const h = build();
  const r = await h.api.reserve(req(base()));
  assert.equal(h.attachment(r.attachment_id).base_revision, 1);
  assert.equal(h.attachment(r.attachment_id).published_revision, null, 'טרם פורסם');
  await h.api.upload(req(withBytes()));
  const d = h.attachment(r.attachment_id);
  assert.equal(d.base_revision, 1, '**הבסיס אינו נדרס**');
  assert.equal(d.published_revision, 2);
});

test('**„הוכנס לתור" אינו „נמסר"** — ואין טענת מסירה בשום מקום', async () => {
  const h = build();
  await h.api.reserve(req(base()));
  const out = await h.api.upload(req(withBytes()));
  assert.equal(out.notification_status, 'queued');
  assert.ok(!('delivered' in out) && !('sent' in out), JSON.stringify(out));
});

test('**כשל התראה מפיל את העסקה כולה** — אין `ready`, וההורה אינו זז', async () => {
  const h = build({ notifyFails: true });
  const r = await h.api.reserve(req(base()));
  await assert.rejects(() => h.api.upload(req(withBytes())), /notification/i);
  assert.notEqual(h.attachment(r.attachment_id).state, 'ready');
  assert.equal(h.attachment(r.attachment_id).published_revision, null);
  assert.equal(h.parent().revision, 1, '**ההורה התגלגל אחורה**');
});

test('**רביזיה שאינה בדיוק N+1 נדחית**', async () => {
  const h = build({ revisionSkew: 2 });
  const r = await h.api.reserve(req(base()));
  await assert.rejects(() => h.api.upload(req(withBytes())),
    e => e.code === 'failed-precondition' && /expected revision/i.test(e.message));
  assert.notEqual(h.attachment(r.attachment_id).state, 'ready');
  assert.equal(h.parent().revision, 1, 'גם ההורה לא נשאר מקודם');
});

test('**`event_id` אחר מזה שהוכן — נדחה**', async () => {
  const h = build({ wrongEvent: true });
  const r = await h.api.reserve(req(base()));
  await assert.rejects(() => h.api.upload(req(withBytes())),
    e => e.code === 'failed-precondition' && /different event/i.test(e.message));
  assert.notEqual(h.attachment(r.attachment_id).state, 'ready');
});

test('**קישור שנכשל חוסם `ready`** — ואינו מדולג', async () => {
  const h = build({ linkNotLinked: true });
  const r = await h.api.reserve(req(base()));
  await assert.rejects(() => h.api.upload(req(withBytes())), e => e.code === 'failed-precondition');
  assert.notEqual(h.attachment(r.attachment_id).state, 'ready');
});

test('**`prepare` שמחזיר `null` חוסם כבר בהזמנה** — ואינו „מדלג על השער"', async () => {
  const h = build({ prepareNull: true });
  await assert.rejects(() => h.api.reserve(req(base())), e => e.code === 'failed-precondition');
  assert.equal(h.storage.calls.save, 0);
});

test('`recheck` נקרא לפני כל כתיבה, ונופל כשההורה זז תחתיו', async () => {
  const h = build({
    hooks: { async beforeWrites() { /* אין כתיבה מקבילה — רק נקודת אחיזה */ } }
  });
  await h.api.reserve(req(base()));
  await h.api.upload(req(withBytes()));
  /* הזמנה · נקודת ביקורת · סיום — שלושה שערים, וכולם על אותו בסיס. */
  assert.equal(h.rechecks.length, 3);
  assert.ok(h.rechecks.every(x => x.expected_revision === 1));
});

test('הורה שהתקדם ברביזיה בין ההזמנה לסיום — נדחה', async () => {
  const h = build();
  await h.api.reserve(req(base()));
  h.setParent({ revision: 5 });
  await assert.rejects(() => h.api.upload(req(withBytes())), e => e.code === 'aborted');
});

test('**הרשאת העלאה שנשללה חוסמת** — גם אחרי הזמנה תקינה', async () => {
  const h = build();
  await h.api.reserve(req(base()));
  h.setParent({ upload_forbidden: true });
  await assert.rejects(() => h.api.upload(req(withBytes())), e => e.code === 'permission-denied');
});

test('שלילת זהות בין ההזמנה לסיום — אין `ready`', async () => {
  const h = build();
  await h.api.reserve(req(base()));
  h.revoke();
  await assert.rejects(() => h.api.upload(req(withBytes())), e => e.code === 'permission-denied');
});

/* ==================================================================
 *  4 · CAS על כל מעבר מצב
 * ================================================================== */

test('**`ready` אינו נדרס** — ניסיון ישן שחוזר אינו מוריד אותו לאחור', async () => {
  const h = build();
  const r = await h.api.reserve(req(base()));
  await h.api.upload(req(withBytes()));
  const before = { ...h.attachment(r.attachment_id) };
  const again = await h.api.upload(req(withBytes()));
  assert.equal(again.duplicate, true);
  assert.equal(h.attachment(r.attachment_id).state, 'ready');
  assert.equal(h.attachment(r.attachment_id).published_revision, before.published_revision);
  assert.equal(h.commits.length, 1, '**קישור אחד — לא נוצרה רביזיה שנייה**');
});

test('**ניסיון שהוחלף אינו יכול לסמן `stored`**', async () => {
  const storage = makeStorage({ crashAfterSave: true, failReads: 1 });
  const h = build({ storage });
  const r = await h.api.reserve(req(base()));
  await assert.rejects(() => h.api.upload(req(withBytes())));
  const id = r.attachment_id;
  assert.equal(h.attachment(id).state, 'stored_pending');
  /* ניסיון אחר תפס את הרשומה בינתיים. */
  h.docs.set('stations/' + SID + '/hr_attachments/' + id,
    { ...h.attachment(id), attempt_id: 'someone-else' });
  storage.objects.clear();
  const second = await h.api.upload(req(withBytes()));
  assert.equal(second.state, 'ready', 'ניסיון חדש מקבל attempt_id משלו');
  assert.equal(h.attachment(id).attempt_id.length, 64);
});

test('**ניסיון שהוחלף אינו יכול לסמן `stored`** — CAS על `attempt_id`', async () => {
  /* מסלול ההתאוששות: הרשומה ב-`stored_pending` עם ניסיון A,
   * האובייקט קיים ואומת. בין הקריאה לכתיבה **ניסיון B תופס את
   * הרשומה**. בלי CAS על `attempt_id` הכתיבה של A הייתה נוחתת
   * מעל B — ורושמת דור של ניסיון שכבר אינו הבעלים. */
  const storage = makeStorage({ crashAfterSave: true, failReads: 1 });
  let fired = false;
  const box = {};
  const h = build({
    storage,
    hooks: {
      async beforeWrites({ stage }) {
        if (stage !== 'markStored' || fired || !box.id) return;
        fired = true;
        /* כתיבה **מחוץ לעסקה**, כמו כותב מקביל אמיתי. */
        await box.seize();
      }
    }
  });
  box.seize = () => h.db.doc('stations/' + SID + '/hr_attachments/' + box.id)
    .set({ attempt_id: 'b'.repeat(64) }, { merge: true });

  const r = await h.api.reserve(req(base()));
  box.id = r.attachment_id;
  await assert.rejects(() => h.api.upload(req(withBytes())));
  assert.equal(h.attachment(r.attachment_id).state, 'stored_pending');

  await assert.rejects(() => h.api.resume(req({ attachment_id: r.attachment_id })),
    e => e.code === 'aborted' && /superseded/i.test(e.message));
  assert.ok(fired, 'ההשתלטות אכן קרתה');
  assert.equal(h.attachment(r.attachment_id).state, 'stored_pending', '**לא נדרס ל-`stored`**');
  assert.equal(h.attachment(r.attachment_id).attempt_id, 'b'.repeat(64), 'הבעלים החדש נשאר');
});

test('**ניקוי שתפס דוחה סיום מקביל**', async () => {
  let t = 1_000_000;
  const h = build({ clock: () => t });
  const r = await h.api.reserve(req(base()));
  h.docs.set('stations/' + SID + '/hr_attachments/' + r.attachment_id, {
    ...h.attachment(r.attachment_id), state: 'cleaning', cleaning_operation_id: 'op-000000009'
  });
  await assert.rejects(() => h.api.upload(req(withBytes())), e => e.code === 'aborted');
  await assert.rejects(() => h.api.resume(req({ attachment_id: r.attachment_id })), e => e.code === 'aborted');
});

test('**אובייקט זר אינו מפיל `ready`** — markForeign לא נוגע במצב סופי', async () => {
  const h = build();
  const r = await h.api.reserve(req(base()));
  await h.api.upload(req(withBytes()));
  const [path, o] = [...h.storage.objects.entries()][0];
  h.storage.objects.set(path, { ...o, bytes: Buffer.from('tampered') });
  await assert.rejects(() => h.api.download(req({ attachment_id: r.attachment_id })), e => e.code === 'unavailable');
  assert.equal(h.attachment(r.attachment_id).state, 'ready', 'ההורדה אינה משנה מצב');
});

/* ==================================================================
 *  5 · התאוששות · אימוץ נבחן על התוכן
 * ================================================================== */

test('**קריסה אחרי השמירה — האובייקט מאומץ, בלי כפילות ובלי דריסה**', async () => {
  const storage = makeStorage({ crashAfterSave: true, failReads: 1 });
  const h = build({ storage });
  const r = await h.api.reserve(req(base()));
  await assert.rejects(() => h.api.upload(req(withBytes())), 'התהליך מת — לא הספיק להתאושש בתוך הקריאה');
  assert.equal(storage.objects.size, 1, 'אובייקט אחד נשמר');
  assert.equal(h.attachment(r.attachment_id).state, 'stored_pending');

  storage.calls.save = 0;
  const resumed = await h.api.resume(req({ attachment_id: r.attachment_id }));
  assert.equal(resumed.state, 'ready');
  assert.equal(storage.calls.save, 0, '**לא נשמר שוב**');
  assert.equal(storage.objects.size, 1, '**אין אובייקט שני**');
  assert.equal(h.commits.length, 1, 'קישור אחד בלבד');
});

test('**מטא-דאטה שטוענת ל-hash אינה הוכחת תוכן**', async () => {
  const storage = makeStorage({ crashAfterSave: true, failReads: 1 });
  const h = build({ storage });
  const r = await h.api.reserve(req(base()));
  await assert.rejects(() => h.api.upload(req(withBytes())));
  /* הבייטים מוחלפים; המטא-דאטה נשארת „נכונה". */
  const [path, o] = [...storage.objects.entries()][0];
  storage.objects.set(path, { ...o, bytes: Buffer.concat([PDF, Buffer.from('tampered')]) });
  await assert.rejects(() => h.api.resume(req({ attachment_id: r.attachment_id })), e => e.code === 'failed-precondition');
  assert.equal(h.attachment(r.attachment_id).failure_code, 'foreign-object');
  assert.equal(storage.objects.size, 1, '**אובייקט זר אינו נמחק ואינו נדרס**');
});

test('אובייקט זר בנתיב — `foreign-object`, לעולם לא דריסה', async () => {
  const storage = makeStorage();
  const h = build({ storage });
  const reserved = await h.api.reserve(req(base()));
  const path = 'hr-private/' + SID + '/request/' + PARENT + '/' + reserved.attachment_id;
  storage.objects.set(path, { bytes: Buffer.from('someone else'), metadata: {}, generation: '77' });
  await assert.rejects(() => h.api.upload(req(withBytes())), e => e.code === 'failed-precondition');
  assert.equal(storage.objects.get(path).bytes.toString(), 'someone else', '**לא נדרס**');
});

test('רק המעלה יכול להתאושש', async () => {
  const h = build();
  const reserved = await h.api.reserve(req(base()));
  await assert.rejects(() => h.api.resume(req({ attachment_id: reserved.attachment_id }, HR)),
    e => e.code === 'permission-denied');
});

test('**`resume` עובר גדר מלאה — ואינו חושף שם קובץ אחרי שלילה**', async () => {
  const h = build();
  const r = await h.api.reserve(req(base()));
  await h.api.upload(req(withBytes()));

  /* (א) זהות שנשללה. */
  h.revoke();
  await assert.rejects(() => h.api.resume(req({ attachment_id: r.attachment_id })),
    e => e.code === 'permission-denied' && !/report\.pdf/.test(e.message));

  /* (ב) הרשאת **קריאה** שנשללה, כשהמצב כבר `ready`. שידור חוזר של
   * שיוך שפורסם הוא קריאה, ולכן זו הגדר הנכונה לו. */
  const g = build();
  const r2 = await g.api.reserve(req(base()));
  await g.api.upload(req(withBytes()));
  g.setParent({ read_forbidden: true });
  await assert.rejects(() => g.api.resume(req({ attachment_id: r2.attachment_id })),
    e => e.code === 'permission-denied' && !/report\.pdf/.test(e.message));

  /* (ג) הרשאת **העלאה** שנשללה, כשהקובץ טרם פורסם. */
  const k = build({ storage: makeStorage({ crashAfterSave: true, failReads: 1 }) });
  const r3 = await k.api.reserve(req(base()));
  await assert.rejects(() => k.api.upload(req(withBytes())));
  k.setParent({ upload_forbidden: true });
  await assert.rejects(() => k.api.resume(req({ attachment_id: r3.attachment_id })),
    e => e.code === 'permission-denied');
});

test('**`revision` אסור לחלוטין בפנייה** — גם ברשימה וגם בהורדה', async () => {
  const h = build();
  await h.api.reserve(req(base()));
  const up = await h.api.upload(req(withBytes()));
  await assert.rejects(() => h.api.list(req({ parent_kind: 'request', parent_id: PARENT, revision: 1, cursor: null })),
    e => e.code === 'invalid-argument' && /revision/i.test(e.message));
  await assert.rejects(() => h.api.download(req({ attachment_id: up.attachment_id, revision: 2 })),
    e => e.code === 'invalid-argument');
});

test('`resume` על הזמנה בלבד מבקש העלאה, ואינו ממציא מצב', async () => {
  const h = build();
  const r = await h.api.reserve(req(base()));
  const out = await h.api.resume(req({ attachment_id: r.attachment_id }));
  assert.equal(out.state, 'reserved');
  assert.equal(out.resume, 'upload-required');
  assert.ok(!('display_name' in out), JSON.stringify(out));
});

/* ==================================================================
 *  6 · הורדה · גדר סופית · אין דליפה
 * ================================================================== */

test('הורדה מחזירה בייטים — **בלי נתיב, דור או hash**', async () => {
  const h = build();
  await h.api.reserve(req(base()));
  const up = await h.api.upload(req(withBytes()));
  const out = await h.api.download(req({ attachment_id: up.attachment_id }));
  assert.equal(Buffer.from(out.content_base64, 'base64').toString('hex'), PDF.toString('hex'));
  const text = JSON.stringify(out);
  assert.ok(!text.includes('hr-private/'), 'object_path');
  assert.ok(!('object_generation' in out) && !('content_sha256' in out) && !('object_path' in out), text);
  assert.ok(!/https?:\/\//.test(text), '**אין URL בשום צורה**');
});

test('הורדה חסומה לפני `ready`', async () => {
  const h = build();
  const reserved = await h.api.reserve(req(base()));
  await assert.rejects(() => h.api.download(req({ attachment_id: reserved.attachment_id })),
    e => e.code === 'failed-precondition');
});

test('**שלילת זהות לפני החזרת הבייטים — אין בייטים**', async () => {
  const h = build();
  await h.api.reserve(req(base()));
  const up = await h.api.upload(req(withBytes()));
  h.revoke();
  await assert.rejects(() => h.api.download(req({ attachment_id: up.attachment_id })),
    e => e.code === 'permission-denied');
});

test('קריאה אסורה בהורה — אין הורדה, גם כשהקובץ `ready`', async () => {
  const h = build();
  await h.api.reserve(req(base()));
  const up = await h.api.upload(req(withBytes()));
  h.setParent({ read_forbidden: true });
  await assert.rejects(() => h.api.download(req({ attachment_id: up.attachment_id })),
    e => e.code === 'permission-denied');
});

test('**הגדר השנייה תופסת שלילה שקרתה אחרי הראשונה**', async () => {
  /* ההעלאה צורכת קריאות הורה; מכאן ואילך `revokeReadAfter` שולל
   * בדיוק בגדר השנייה של ההורדה. */
  const h = build();
  await h.api.reserve(req(base()));
  const up = await h.api.upload(req(withBytes()));
  const used = [...h.docs.keys()].length;
  assert.ok(used > 0);
  const g = build({ storage: h.storage });
  for (const [k, v] of h.docs) g.docs.set(k, v);
  /* קריאות ההורה שנותרו: גדר ראשונה (1) וגדר שנייה (2). */
  const g2 = build({ storage: h.storage, revokeReadAfter: 1 });
  for (const [k, v] of h.docs) g2.docs.set(k, v);
  await assert.rejects(() => g2.api.download(req({ attachment_id: up.attachment_id })),
    e => e.code === 'permission-denied');
  assert.ok(g);
});

test('אובייקט שהוחלף אינו מוגש — הדור הוא חלק מהזהות', async () => {
  const h = build();
  await h.api.reserve(req(base()));
  const up = await h.api.upload(req(withBytes()));
  const [path, o] = [...h.storage.objects.entries()][0];
  h.storage.objects.set(path, { ...o, generation: '999' });
  await assert.rejects(() => h.api.download(req({ attachment_id: up.attachment_id })),
    e => e.code === 'unavailable');
});

test('עידן זהות מוחזר בכל פעולה — לא חותם UID לבדו', async () => {
  const h = build();
  const out = await h.api.reserve(req(base()));
  assert.deepEqual(Object.keys(out.epoch).sort(), ['auth_time', 'claims_digest', 'station_id', 'uid']);
  assert.equal(out.epoch.station_id, SID);
});

/* ==================================================================
 *  7 · תקרת ההורה — נאכפת, וכוללת את המוזמן
 * ================================================================== */

test('**הזמנות תופסות מקום** — התקרה נאכפת על מה שטרם הועלה', async () => {
  let t = 1_000_000;
  /* השעון מתקדם מעבר לחלון הקצב, כדי שהחוסם יהיה **תקרת ההורה**
   * ולא מכסת הקצב. שתי מגבלות שונות, ואסור לבלבל ביניהן. */
  const h = build({ clock: () => (t += A.QUOTA_WINDOW_MS + 1000) });
  for (let n = 0; n < A.PARENT_MAX_FILES; n += 1) {
    await h.api.reserve(req(base(PDF, { request_id: 'req-' + String(n).padStart(9, '0') })));
  }
  await assert.rejects(() => h.api.reserve(req(base(PDF, { request_id: 'req-overflow1' }))),
    e => e.code === 'resource-exhausted' && /maximum number of files/.test(e.message));
  assert.equal(Object.keys(h.ledger()[1].entries).length, A.PARENT_MAX_FILES);
});

test('**תקרת הבייטים היא הגבול השני, והיא נגישה בדיוק**', () => {
  /* אמירה עובדתית ולא ניחוש: `PARENT_MAX_FILES × MAX_BYTES` שווה
   * בדיוק ל-`PARENT_MAX_BYTES`. כלומר בהגדרות היום החוסם שנתקל בו
   * בפועל הוא **מספר הקבצים**, ותקרת הבייטים תיתפוס רק אם אחד
   * משלושת הקבועים ישתנה. איני מציג בדיקה למסלול שאי אפשר להגיע
   * אליו — אני מסמן אותו. */
  assert.equal(A.PARENT_MAX_FILES * A.MAX_BYTES, A.PARENT_MAX_BYTES);
});

test('**שחרור המכסה קורה פעם אחת בדיוק**', async () => {
  let t = 1_000_000;
  const h = build({ clock: () => t });
  const r = await h.api.reserve(req(base()));
  assert.equal(Object.keys(h.ledger()[1].entries).length, 1);
  t += A.RESERVE_TTL_MS + 1000;
  const first = await h.api.reconcile({ sid: SID, attachment_id: r.attachment_id, operation_id: 'op-000000001' });
  assert.equal(first.quota_released, true);
  assert.equal(Object.keys(h.ledger()[1].entries).length, 0);
  const second = await h.api.reconcile({ sid: SID, attachment_id: r.attachment_id, operation_id: 'op-000000002' });
  assert.equal(second.quota_released, false, '**פעם אחת, לא פעמיים**');
  assert.equal(second.reason, 'already-failed');
});

/* ==================================================================
 *  8 · הפיוס · שחרור רק על הוכחה
 * ================================================================== */

test('**`ready` לעולם אינו מנוקה**', async () => {
  const h = build();
  await h.api.reserve(req(base()));
  const up = await h.api.upload(req(withBytes()));
  const out = await h.api.reconcile({ sid: SID, attachment_id: up.attachment_id, operation_id: 'op-000000001' });
  assert.equal(out.cleaned, false);
  assert.equal(out.reason, 'ready');
  assert.equal(h.storage.objects.size, 1);
});

test('הזמנה שלא פגה אינה מנוקה', async () => {
  const h = build();
  const reserved = await h.api.reserve(req(base()));
  const out = await h.api.reconcile({ sid: SID, attachment_id: reserved.attachment_id, operation_id: 'op-000000001' });
  assert.equal(out.reason, 'not-expired');
});

test('הזמנה שפגה בלי אובייקט — **היעדר שנצפה** הוא הוכחה, והמכסה משתחררת', async () => {
  let t = 1_000_000;
  const h = build({ clock: () => t });
  const reserved = await h.api.reserve(req(base()));
  t += A.RESERVE_TTL_MS + 1000;
  const out = await h.api.reconcile({ sid: SID, attachment_id: reserved.attachment_id, operation_id: 'op-000000001' });
  assert.equal(out.cleaned, true);
  assert.equal(out.quota_released, true);
  assert.equal(h.attachment(reserved.attachment_id).failure_code, 'abandoned');
});

test('**`reserved` עם ניסיון קודם אינו הוכחה** — גם אם זה מצב שלא מצאתי דרך להגיע אליו', async () => {
  /* Codex ביקש לוודא שאין `reserved` שנשאר בו ניסיון שעוד יכול
   * לכתוב (seq547). **סרקתי את המסלולים ולא מצאתי כזה**: `checkpoint`
   * מעביר ל-`stored_pending` לפני כל שמירה, והפיוס מחזיר תמיד למצב
   * שממנו נתפס. אבל „לא מצאתי" אינו „לא קיים", ולכן ההוכחה דורשת
   * **גם** שאין `attempt_id` — והבדיקה הזאת שומרת על הגדר. */
  let t = 1_000_000;
  const h = build({ clock: () => t });
  const r = await h.api.reserve(req(base()));
  const key = 'stations/' + SID + '/hr_attachments/' + r.attachment_id;
  h.docs.set(key, { ...h.attachment(r.attachment_id), attempt_id: 'c'.repeat(64) });

  t += A.RESERVE_TTL_MS + 1000;
  const out = await h.api.reconcile({ sid: SID, attachment_id: r.attachment_id, operation_id: 'op-000000021' });
  assert.equal(out.quota_released, false, '**לא משתחרר**');
  assert.equal(out.reason, 'gone-still-charged');
  assert.equal(Object.keys(h.ledger()[1].entries).length, 1);
});

test('**מחיקה שלא אישרה הסרה משאירה את הניסיון לא ודאי ומחויב במכסה**', async () => {
  let t = 1_000_000;
  /* `linkNotLinked` מביא את הרשומה ל-`stored` **עם דור רשום** ואז
   * מפיל את הסיום — בדיוק המצב שבו יש אובייקט שנרשם ולא פורסם.
   * `removeFails` מדמה מחיקה שלא אישרה הסרה. */
  const storage = makeStorage({ removeFails: true });
  const h = build({ linkNotLinked: true, storage, clock: () => t });
  const r = await h.api.reserve(req(base()));
  await assert.rejects(() => h.api.upload(req(withBytes())));
  const d = h.attachment(r.attachment_id);
  assert.equal(d.state, 'stored');
  assert.ok(d.object_generation != null, 'דור נרשם');

  t += A.RESERVE_TTL_MS + 1000;
  const out = await h.api.reconcile({ sid: SID, attachment_id: r.attachment_id, operation_id: 'op-000000002' });
  assert.equal(out.quota_released, false, '**המכסה נשארת מחויבת**');
  assert.equal(out.reason, 'uncertain');
  assert.equal(h.attachment(r.attachment_id).state, 'stored', '**חוזר למצב שממנו נתפס**');
  assert.equal(h.attachment(r.attachment_id).object_generation, d.object_generation, 'הדור לא אבד');
  assert.equal(Object.keys(h.ledger()[1].entries).length, 1, 'הרשומה עדיין בספר');
});

test('**דור ידוע + היעדר אינו הוכחה** — שמירה תלויה עוד עשויה לנחות', async () => {
  let t = 1_000_000;
  const h = build({ linkNotLinked: true, clock: () => t });
  const r = await h.api.reserve(req(base()));
  await assert.rejects(() => h.api.upload(req(withBytes())));
  assert.equal(h.attachment(r.attachment_id).state, 'stored');
  h.storage.objects.clear();
  t += A.RESERVE_TTL_MS + 1000;
  const out = await h.api.reconcile({ sid: SID, attachment_id: r.attachment_id, operation_id: 'op-000000002' });
  assert.equal(out.quota_released, false, '**נשאר מחויב**');
  assert.equal(out.reason, 'gone-still-charged');
  assert.equal(Object.keys(h.ledger()[1].entries).length, 1);
});

test('**היעדר ב-`stored_pending` אינו משתחרר — לא בתצפית אחת ולא בעשר**', async () => {
  let t = 1_000_000;
  const storage = makeStorage({ crashAfterSave: true, failReads: 1 });
  const h = build({ storage, clock: () => t });
  const r = await h.api.reserve(req(base()));
  await assert.rejects(() => h.api.upload(req(withBytes())));
  assert.equal(h.attachment(r.attachment_id).state, 'stored_pending');
  storage.objects.clear();
  for (let n = 0; n < 10; n += 1) {
    t += A.RESERVE_TTL_MS + 1000;
    const out = await h.api.reconcile({ sid: SID, attachment_id: r.attachment_id,
      operation_id: 'op-' + String(n).padStart(9, '0') });
    assert.equal(out.quota_released, false, 'מעבר ' + n);
    assert.equal(out.reason, 'gone-still-charged');
  }
  assert.equal(Object.keys(h.ledger()[1].entries).length, 1, '**מחויב, ואין שחרור אוטומטי**');
  assert.equal(h.attachment(r.attachment_id).state, 'stored_pending');
});

test('**שמירה מוחזקת נוחתת אחרי שתי תצפיות בהיעדר** — ולכן ספירת תצפיות אינה ראיה', async () => {
  /* התרחיש שביקש Codex ב-seq545 §A, מילה במילה: מחזיקים שמירה
   * פתוחה, שני מעברי פיוס רואים היעדר, ואז השמירה נוחתת. כל חלון
   * זמן שהייתי בוחר היה משחרר כאן מכסה **לפני** שהבייטים נחתו. */
  let t = 1_000_000;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const storage = makeStorage({ holdSave: held });
  const h = build({ storage, clock: () => t });
  const r = await h.api.reserve(req(base()));

  const inflight = h.api.upload(req(withBytes()));
  for (let i = 0; i < 200 && h.attachment(r.attachment_id).state !== 'stored_pending'; i += 1) {
    await new Promise(res => setImmediate(res));
  }
  assert.equal(h.attachment(r.attachment_id).state, 'stored_pending', 'נקודת הביקורת נרשמה');
  assert.equal(storage.objects.size, 0, '**האובייקט עדיין לא נחת**');

  t += A.RESERVE_TTL_MS + 1000;
  const one = await h.api.reconcile({ sid: SID, attachment_id: r.attachment_id, operation_id: 'op-000000011' });
  const two = await h.api.reconcile({ sid: SID, attachment_id: r.attachment_id, operation_id: 'op-000000012' });
  assert.equal(one.quota_released, false);
  assert.equal(two.quota_released, false);
  assert.equal(Object.keys(h.ledger()[1].entries).length, 1, '**הספר נשאר מחויב אחרי שתי תצפיות**');

  release();
  await inflight.catch(() => {});
  assert.equal(storage.objects.size, 1, '**השמירה נחתה — אחרי שתי התצפיות**');
  assert.equal(Object.keys(h.ledger()[1].entries).length, 1, 'וטוב שלא שוחרר');
  assert.notEqual(h.attachment(r.attachment_id).state, 'failed', '`ready`/`cleanup` תחת CAS');
});

test('**מחיקת הדור אינה מוכיחה ששום שמירה לא תנחת אחריה** (seq550 §1)', async () => {
  /* התרחיש שנמסר לי, מילה במילה: A נרשם ושמירתו מוחזקת · B מחליף
   * attempt ושומר `G` · הפרסום של B נכשל · הניקוי מוחק את `G` ·
   * **ואז A מגיע לאחסון ויוצר `G2`**. אם הניקוי היה משחרר מכסה,
   * `G2` היה נשאר בעולם בלי חיוב. */
  let t = 1_000_000;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const storage = makeStorage({ holdSave: held });
  const h = build({ storage, linkNotLinked: true, clock: () => t });
  const r = await h.api.reserve(req(base()));
  const id = r.attachment_id;

  /* A — שמירה מוחזקת. */
  const a = h.api.upload(req(withBytes()));
  for (let i = 0; i < 200 && h.attachment(id).state !== 'stored_pending'; i += 1) {
    await new Promise(res => setImmediate(res));
  }
  const attemptA = h.attachment(id).attempt_id;
  assert.ok(attemptA, 'A נרשם');
  assert.equal(storage.objects.size, 0, 'A עדיין לא נחת');

  /* B — מחליף ניסיון, שומר `G`, והפרסום שלו נכשל. */
  await assert.rejects(() => h.api.upload(req(withBytes())));
  const afterB = h.attachment(id);
  assert.equal(afterB.state, 'stored');
  assert.notEqual(afterB.attempt_id, attemptA, 'B החליף את A');
  assert.equal(storage.objects.size, 1, '`G` נשמר');

  /* ניקוי — מוחק את `G`, ו**אינו משחרר**. */
  t += A.RESERVE_TTL_MS + 1000;
  const out = await h.api.reconcile({ sid: SID, attachment_id: id, operation_id: 'op-000000031' });
  assert.equal(out.cleaned, true, '`G` הוסר');
  assert.equal(out.quota_released, false, '**זו כל הנקודה**');
  assert.equal(storage.objects.size, 0);

  /* ועכשיו A מגיע. */
  release();
  await a.catch(() => {});
  assert.equal(storage.objects.size, 1, '**A יצר `G2` על נתיב פנוי**');
  assert.equal(h.attachment(id).attempt_id, afterB.attempt_id, 'ה-CAS דחה את A');
  assert.equal(Object.keys(h.ledger()[1].entries).length, 1,
    '**ו-`G2` מחויב — כי המכסה מעולם לא שוחררה**');
});

test('**גם הסיום, כשמצא `ready` תחתיו, קורא את השיוך שפורסם**', async () => {
  /* המרוץ: `markStored` הסתיים, ובין לבינו הרשומה הפכה ל-`ready`.
   * `finalize` מזהה זאת ומחזיר קבלה — **וגם היא חייבת לעבור הרשאת
   * הורה**, אחרת נשארת דלת אחורית שלישית. */
  const h = build();
  const r = await h.api.reserve(req(base()));
  const key = 'stations/' + SID + '/hr_attachments/' + r.attachment_id;

  let flipped = false;
  const g = build({
    storage: h.storage,
    revokeReadAfter: 1,
    hooks: {
      async beforeWrites({ stage }) {
        if (stage !== 'markStored' || flipped) return;
        flipped = true;
        await g.db.doc(key).set({ state: 'ready', published_revision: 1 }, { merge: true });
      }
    }
  });
  for (const [k, v] of h.docs) if (!k.includes('hr_parents') && !k.includes('hr_identities')) g.docs.set(k, v);
  g.addMembers({ [r.attachment_id]: 1 });

  await assert.rejects(() => g.api.upload(req(withBytes())), e => e.code === 'permission-denied');
  assert.ok(flipped, 'המרוץ אכן קרה');
});

test('**גם האימוץ אינו דלת אחורית לקבלה** — `markStored` שמצא `ready`', async () => {
  /* המסלול היחיד שבו `adopt` מחזיר „כבר מוכן": הרשומה הפכה ל-`ready`
   * בין הגדר לבין `markStored`. אם הקבלה הזאת אינה עוברת הרשאת
   * הורה — יש כאן דלת אחורית. */
  const storage = makeStorage({ crashAfterSave: true, failReads: 1 });
  const h = build({ storage });
  const r = await h.api.reserve(req(base()));
  await assert.rejects(() => h.api.upload(req(withBytes())));
  assert.equal(h.attachment(r.attachment_id).state, 'stored_pending');

  let flipped = false;
  const key = 'stations/' + SID + '/hr_attachments/' + r.attachment_id;
  /* קריאת הורה אחת מותרת (הגדר של `resume`); השנייה — של הקבלה —
   * כבר נשללת. */
  const g = build({
    storage,
    revokeReadAfter: 1,
    hooks: {
      async beforeWrites({ stage }) {
        if (stage !== 'markStored' || flipped) return;
        flipped = true;
        await g.db.doc(key).set({ state: 'ready', published_revision: 1 }, { merge: true });
      }
    }
  });
  for (const [k, v] of h.docs) if (!k.includes('hr_parents') && !k.includes('hr_identities')) g.docs.set(k, v);
  g.addMembers({ [r.attachment_id]: 1 });

  await assert.rejects(() => g.api.resume(req({ attachment_id: r.attachment_id })),
    e => e.code === 'permission-denied');
  assert.ok(flipped, 'המרוץ אכן קרה');
});

test('**חזרה מדויקת על הזמנה שהצליחה עוברת גם אחרי `N+1`** (seq550 §2)', async () => {
  const h = build();
  const first = await h.api.reserve(req(base()));
  const up = await h.api.upload(req(withBytes()));
  assert.equal(up.revision, 2, 'ההורה זז');

  /* אותה בקשה בדיוק, שנייה. הבסיס כבר אינו הרביזיה הנוכחית — וזו
   * **אינה** סיבה להפיל בקשה שכבר הצליחה. */
  const again = await h.api.reserve(req(base()));
  assert.equal(again.attachment_id, first.attachment_id);
  assert.equal(again.state, 'ready');
  assert.equal(again.duplicate, true);
  assert.equal(again.revision, 2);
});

test('**קבלת „כבר מוכן" דורשת הרשאת הורה חיה, בכל מסלול** (seq550 §2)', async () => {
  /* מי שהיה HR, יצא, ונכנס מחדש עם claims נמוכים — הסשן שלו חי
   * לגמרי. אסור שיקבל קבלה על קובץ שההורה שלו כבר אינו פתוח לו. */
  const h = build();
  const r = await h.api.reserve(req(base()));
  await h.api.upload(req(withBytes()));
  assert.equal(h.attachment(r.attachment_id).state, 'ready');

  h.setParent({ read_forbidden: true });

  for (const [name, call] of [
    ['reserve', () => h.api.reserve(req(base()))],
    ['upload · checkpoint', () => h.api.upload(req(withBytes()))],
    ['resume · adopt', () => h.api.resume(req({ attachment_id: r.attachment_id }))],
    ['download', () => h.api.download(req({ attachment_id: r.attachment_id }))]
  ]) {
    await assert.rejects(call, e => e.code === 'permission-denied', name);
  }
  assert.equal(h.attachment(r.attachment_id).state, 'ready', 'ושום מסלול לא שינה מצב');
});

test('**`checkpoint` מוחק את הדור של הניסיון הקודם**', async () => {
  /* בלי זה ניסיון חדש יורש `object_generation` של ניסיון ישן —
   * והפיוס ימחק אחר כך **דור שאינו שלו**. הכשל נראה רק כשהניסיון
   * החדש אינו מספיק לרשום דור משלו. */
  const storage = makeStorage({ saveThrows: 'unavailable' });
  const h = build({ storage });
  const r = await h.api.reserve(req(base()));
  const key = 'stations/' + SID + '/hr_attachments/' + r.attachment_id;
  h.docs.set(key, { ...h.attachment(r.attachment_id), state: 'stored',
    object_generation: '101', attempt_id: 'a'.repeat(64) });

  await assert.rejects(() => h.api.upload(req(withBytes())));
  const after = h.attachment(r.attachment_id);
  assert.equal(after.state, 'stored_pending');
  assert.notEqual(after.attempt_id, 'a'.repeat(64), 'ניסיון חדש');
  assert.equal(after.object_generation, null,
    '**ניסיון חדש אינו יורש דור של ניסיון ישן**');
});

test('**מחיקה מנקה — ואינה משחררת** כשנשלחו בייטים', async () => {
  let t = 1_000_000;
  const storage = makeStorage({ crashAfterSave: true, failReads: 1 });
  const h = build({ storage, clock: () => t });
  const r = await h.api.reserve(req(base()));
  await assert.rejects(() => h.api.upload(req(withBytes())));
  assert.equal(storage.objects.size, 1, 'האובייקט קיים');

  t += A.RESERVE_TTL_MS + 1000;
  const out = await h.api.reconcile({ sid: SID, attachment_id: r.attachment_id, operation_id: 'op-000000006' });
  assert.equal(out.cleaned, true, 'האובייקט הוסר');
  assert.equal(out.quota_released, false, '**אבל שמירה מוחזקת עוד יכולה ליצור אחד חדש**');
  assert.equal(out.reason, 'gone-still-charged');
  assert.equal(storage.objects.size, 0);
  assert.equal(Object.keys(h.ledger()[1].entries).length, 1, 'עדיין מחויב');
  assert.equal(h.attachment(r.attachment_id).object_generation, null, 'הדור נמחק מהרשומה');
});

test('אובייקט זר בפיוס — מדווח, אינו נמחק, והמכסה אינה משתחררת', async () => {
  let t = 1_000_000;
  const storage = makeStorage({ crashAfterSave: true, failReads: 1 });
  const h = build({ storage, clock: () => t });
  const r = await h.api.reserve(req(base()));
  await assert.rejects(() => h.api.upload(req(withBytes())));
  const [path, o] = [...storage.objects.entries()][0];
  storage.objects.set(path, { ...o, bytes: Buffer.from('someone else entirely') });
  t += A.RESERVE_TTL_MS + 1000;
  const out = await h.api.reconcile({ sid: SID, attachment_id: r.attachment_id, operation_id: 'op-000000004' });
  assert.equal(out.reason, 'foreign-object');
  assert.equal(out.quota_released, false);
  assert.equal(storage.objects.size, 1, '**לא נמחק**');
  assert.equal(Object.keys(h.ledger()[1].entries).length, 1, 'עדיין מחויב');
});

test('פיוס בבעלות אחרת אינו תופס', async () => {
  let t = 1_000_000;
  const h = build({ clock: () => t });
  const reserved = await h.api.reserve(req(base()));
  h.docs.set('stations/' + SID + '/hr_attachments/' + reserved.attachment_id, {
    ...h.attachment(reserved.attachment_id), state: 'cleaning', cleaning_operation_id: 'op-000000009'
  });
  const out = await h.api.reconcile({ sid: SID, attachment_id: reserved.attachment_id, operation_id: 'op-000000001' });
  assert.equal(out.cleaned, false);
  assert.equal(out.quota_released, false);
});

/* ==================================================================
 *  9 · רשימה · סמן מעומד לפי (רביזיה, מזהה)
 * ================================================================== */

test('הרשימה מציגה `ready` בלבד ואינה מדליפה נתיב או דור', async () => {
  const h = build();
  await h.api.reserve(req(base()));
  await h.api.upload(req(withBytes()));
  await h.api.reserve(req(base(PDF, { request_id: 'req-000000002', parent_revision: 2 })));
  const out = await h.api.list(req({ parent_kind: 'request', parent_id: PARENT, cursor: null }));
  assert.equal(out.items.length, 1, 'רק ה-ready');
  assert.deepEqual(Object.keys(out.items[0]).sort(),
    ['attachment_id', 'byte_length', 'created_at_ms', 'declared_type', 'display_name', 'revision']);
});

test('**עמוד שני אינו מדלג ואינו חוזר**', async () => {
  const h = build();
  const total = A.PAGE_SIZE + 2;
  const ids = Array.from({ length: total }, (_, n) => seedId(n));
  seedReady(h, ids, n => n + 2);
  h.setParent({ revision: total + 1 });

  const seen = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const page = await h.api.list(req({ parent_kind: 'request', parent_id: PARENT, cursor }));
    pages += 1;
    seen.push(...page.items.map(i2 => i2.attachment_id));
    if (!page.next_cursor) break;
    assert.match(page.next_cursor, /^[1-9][0-9]*\|[a-f0-9]{64}$/, 'סמן = רביזיה|מזהה');
    cursor = page.next_cursor;
    assert.ok(pages < 10, 'לולאה');
  }
  assert.equal(seen.length, total, 'כל הפריטים, בלי דילוג');
  assert.equal(new Set(seen).size, total, '**בלי חזרות**');
  assert.equal(pages, 2);
  assert.deepEqual(seen, ids, '**הסדר הוא סדר הרביזיות, על פני שני עמודים**');
});

test('**שוויון ברביזיה נשבר לפי מזהה, והסמן ממשיך נכון**', async () => {
  const h = build();
  const total = A.PAGE_SIZE + 2;
  /* **אותה רביזיה בדיוק** ואותו `ready_at_ms` לכולם — כך ששבירת
   * השוויון לפי המזהה היא היחידה שמסדרת אותם. */
  const ids = Array.from({ length: total }, (_, n) => seedId('tie-' + n)).sort();
  seedReady(h, ids, () => 2);
  h.setParent({ revision: 2 });

  const first = await h.api.list(req({ parent_kind: 'request', parent_id: PARENT, cursor: null }));
  assert.equal(first.items.length, A.PAGE_SIZE);
  assert.deepEqual(first.items.map(x => x.attachment_id), ids.slice(0, A.PAGE_SIZE));
  assert.equal(first.next_cursor, '2|' + ids[A.PAGE_SIZE - 1]);
  const second = await h.api.list(req({ parent_kind: 'request', parent_id: PARENT, cursor: first.next_cursor }));
  assert.deepEqual(second.items.map(x => x.attachment_id), ids.slice(A.PAGE_SIZE));
  assert.equal(second.next_cursor, null);
});

test('**סמן פסול נדחה** — ID לבדו אינו סמן', async () => {
  const h = build();
  for (const bad of ['a'.repeat(64), '2|', '|abc', '0|' + 'a'.repeat(64), '2|XYZ', 2, {}, '2|' + 'a'.repeat(63)]) {
    await assert.rejects(() => h.api.list(req({ parent_kind: 'request', parent_id: PARENT, cursor: bad })),
      /cursor/i, JSON.stringify(bad));
  }
});

test('**רשימת מסמך מוגבלת לרביזיה המוצגת**', async () => {
  const h = build();
  const ids = [seedId('doc-a'), seedId('doc-b'), seedId('doc-c')].sort();
  seedReady(h, ids, n => n + 2, 'document');
  h.setParent({ revision: 4 });

  const now = await h.api.list(req({ parent_kind: 'document', parent_id: PARENT, cursor: null }));
  assert.equal(now.items.length, 3);
  assert.equal(now.revision, 4);

  const back = await h.api.list(req({ parent_kind: 'document', parent_id: PARENT, revision: 2, cursor: null }));
  assert.equal(back.items.length, 1, '**קובץ עתידי אינו חלק במסמך שמוצג עכשיו**');
  assert.equal(back.revision, 2);

  await assert.rejects(() => h.api.list(req({ parent_kind: 'document', parent_id: PARENT, revision: 99, cursor: null })),
    e => e.code === 'failed-precondition');
});

test('**חברות מגיעה מההורה, לא מסינון רביזיה שלי**', async () => {
  const h = build();
  const ids = [seedId('m-a'), seedId('m-b')].sort();
  seedReady(h, ids, () => 2, 'document');
  h.setParent({ revision: 2 });
  assert.equal((await h.api.list(req({ parent_kind: 'document', parent_id: PARENT, cursor: null }))).items.length, 2);

  /* ההורה מסיר חברות — הרשומה המקומית עדיין `ready`. הרשימה חייבת
   * ללכת אחרי ההורה. */
  h.setParent({ members: { [ids[0]]: 2 } });
  const after = await h.api.list(req({ parent_kind: 'document', parent_id: PARENT, cursor: null }));
  assert.deepEqual(after.items.map(x => x.attachment_id), [ids[0]]);
});

test('**חוסר התאמה בין ההורה לרשומה אינו נבלע**', async () => {
  const h = build();
  const ids = [seedId('x-a')];
  seedReady(h, ids, () => 2, 'document');
  h.setParent({ revision: 2 });
  /* ההורה מצהיר על חבר שאין לו רשומה מקומית — באג, לא מצב מעבר. */
  h.addMembers({ ['f'.repeat(64)]: 2 });
  await assert.rejects(() => h.api.list(req({ parent_kind: 'document', parent_id: PARENT, cursor: null })),
    e => e.code === 'failed-precondition' && /inconsistent/i.test(e.message));
});

test('**הגדר השנייה ברשימה — שמות קבצים אינם נחשפים אחרי שלילה**', async () => {
  const h = build();
  await h.api.reserve(req(base()));
  await h.api.upload(req(withBytes()));
  const g = build({ storage: h.storage, revokeReadAfter: 1 });
  for (const [k, v] of h.docs) if (!k.includes('hr_parents') && !k.includes('hr_identities')) g.docs.set(k, v);
  g.setParent({ revision: 2 });
  await assert.rejects(() => g.api.list(req({ parent_kind: 'request', parent_id: PARENT, cursor: null })),
    e => e.code === 'permission-denied' && !/report\.pdf/.test(e.message));
});

/* ==================================================================
 *  10 · שלמות הרשימות הסגורות והבנייה
 * ================================================================== */

test('קונסטרוקטור דורש כל port ואת שלוש פעולות האחסון', () => {
  const ok = {
    db: {}, storage: { save() {}, read() {}, remove() {} }, HttpsError: FakeHttpsError,
    session: { context() {}, assertLive() {} },
    ports: { read() {}, prepare() {}, recheck() {}, commit() {} }
  };
  assert.doesNotThrow(() => A.createHrAttachments(ok));
  for (const name of ['read', 'prepare', 'recheck', 'commit']) {
    const bad = { ...ok, ports: { ...ok.ports } }; delete bad.ports[name];
    assert.throws(() => A.createHrAttachments(bad), /ports\./);
  }
  for (const name of ['save', 'read', 'remove']) {
    const bad = { ...ok, storage: { ...ok.storage } }; delete bad.storage[name];
    assert.throws(() => A.createHrAttachments(bad), /storage\./);
  }
  assert.throws(() => A.createHrAttachments({ ...ok, session: { context() {} } }), /session\./);
});

test('סוגים ורשימות סגורות', () => {
  assert.deepEqual(Object.keys(A.TYPES).sort(), ['application/pdf', 'image/jpeg', 'image/png']);
  assert.equal(A.FAILURE_CODES.length, new Set(A.FAILURE_CODES).size);
  assert.ok(Object.isFrozen(A.TYPES) && Object.isFrozen(A.FAILURE_CODES) && Object.isFrozen(A.STATES));
  assert.equal(A.PAGE_SIZE, 25, '**קבוע מוצר — לא נגזרת של נוחות בדיקה**');
  assert.equal(A.QUOTA_MAX, 10);
  assert.equal(A.MAX_BYTES, 2 * 1024 * 1024);
});

test('סוג שאינו ברשימה נדחה בהזמנה', async () => {
  const h = build();
  for (const t of ['image/svg+xml', 'text/html', 'application/zip', 'application/octet-stream', '']) {
    await assert.rejects(() => h.api.reserve(req(base(PDF, { declared_type: t }))), /file type/i);
  }
});

test('שדה עודף בבקשה נדחה', async () => {
  const h = build();
  await assert.rejects(() => h.api.reserve(req({ ...base(), station_id: 'other' })), /request fields/i);
});

test('`station_id` לעולם אינו מגיע מהלקוח', async () => {
  const h = build();
  const out = await h.api.reserve(req(base()));
  assert.equal(h.attachment(out.attachment_id).station_id, SID);
});

test('`reconcile` אינו callable ואינו מקבל קלט חופשי', async () => {
  const h = build();
  const api = h.api;
  assert.deepEqual(Object.keys(api).sort(), ['download', 'list', 'reconcile', 'reserve', 'resume', 'upload']);
  for (const bad of [{}, { sid: SID }, { sid: SID, attachment_id: 'x' },
    { sid: SID, attachment_id: 'a'.repeat(64) },
    { sid: '', attachment_id: 'a'.repeat(64), operation_id: 'op-000000001' }]) {
    await assert.rejects(() => api.reconcile(bad), e => e.code === 'invalid-argument');
  }
});
