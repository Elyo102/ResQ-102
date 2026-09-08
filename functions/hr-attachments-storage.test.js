'use strict';

/* ====================================================================
 *  hr-attachments-storage · בדיקות המתאם.
 *
 *  שני הכשלים שנמסרו ב-seq542 §2 נבדקים כאן **על ידי שחזור הכשל**,
 *  ולא על ידי בדיקה שהקוד „נראה נכון":
 *
 *  1 · **החלפת דור בין המטא-דאטה לבייטים.** הדלי המזויף מחליף את
 *      האובייקט בדיוק בין `getMetadata()` ל-`createReadStream()`.
 *      מתאם שאינו נועץ את הדור שנצפה יחזיר את **המטא-דאטה הישנה עם
 *      הבייטים החדשים** — כלומר ראיה מזויפת למודול הטהור.
 *
 *  2 · **`size` שמשקר.** המטא-דאטה מצהירה על 10 בייטים והזרם פולט
 *      מיליונים. מתאם שאוגר ואז מודד — אוגר את הכול.
 *
 *  ⚠ **הדלי כאן מזויף.** הבדיקות האלה מוכיחות את הלוגיקה של המתאם,
 *  ו**אינן** מוכיחות התנהגות מול GCS או מול אמולטור ה-Storage. אותו
 *  אמולטור לא הורץ — ה-jar אינו במטמון ומשיכתו דורשת רשת שאין לי.
 * ==================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const S = require('./hr-attachments-storage');

const err = (code, message) => Object.assign(new Error(message || 'x'), { code });

/**
 * דלי מזויף עם **דורות אמיתיים**: כל כתיבה יוצרת דור חדש, וקריאה
 * לפי דור מחזירה בדיוק אותו דור או `404`.
 */
function makeBucket(opts = {}) {
  /** path → Map<generation, {bytes, metadata, size}> */
  const gens = new Map();
  /** path → generation נוכחי */
  const head = new Map();
  let seq = 1000;
  const calls = { getMetadata: 0, stream: 0, download: 0, del: 0, save: 0 };

  const put = (path, bytes, metadata, sizeLie) => {
    seq += 1;
    const g = String(seq);
    if (!gens.has(path)) gens.set(path, new Map());
    /* **דלי ללא versioning — וזו ברירת המחדל ב-GCS.** דור שנדרס
     * חדל להתקיים; קריאה לפיו מחזירה `404`. זה בדיוק מה שהופך את
     * הנעיצה למגן: או הבייטים הנכונים, או כלום. */
    if (!opts.versioned) gens.get(path).clear();
    gens.get(path).set(g, {
      bytes: Buffer.from(bytes), metadata: { ...metadata },
      size: sizeLie == null ? bytes.length : sizeLie, generation: g
    });
    head.set(path, g);
    return g;
  };

  const at = (path, generation) => {
    const g = generation == null ? head.get(path) : String(generation);
    if (g == null) return null;
    const m = gens.get(path);
    return (m && m.get(g)) || null;
  };

  function file(path, options) {
    const pinned = options && options.generation != null ? String(options.generation) : null;
    const handle = {
      metadata: null,
      async getMetadata() {
        calls.getMetadata += 1;
        const o = at(path, pinned);
        if (!o) throw err(404, 'No such object');
        if (typeof opts.afterMetadata === 'function') opts.afterMetadata(api);
        return [{ generation: o.generation, size: String(o.size), metadata: { ...o.metadata } }];
      },
      createReadStream() {
        calls.stream += 1;
        const o = at(path, pinned);
        if (!o) {
          const s = new Readable({ read() {} });
          process.nextTick(() => s.emit('error', err(404, 'No such object')));
          return s;
        }
        let sent = 0;
        const chunk = 64 * 1024;
        let destroyed = false;
        const s = new Readable({
          read() {
            if (destroyed) return;
            if (sent >= o.bytes.length) { this.push(null); return; }
            const end = Math.min(sent + chunk, o.bytes.length);
            this.push(o.bytes.subarray(sent, end));
            sent = end;
          },
          destroy(e, cb) { destroyed = true; calls.destroyedAt = sent; cb(e); }
        });
        return s;
      },
      async save(bytes, options) {
        calls.save += 1;
        const pre = options && options.preconditionOpts;
        if (pre && pre.ifGenerationMatch === 0 && head.has(path)) throw err(412, 'Precondition Failed');
        const meta = (options && options.metadata && options.metadata.metadata) || {};
        const g = put(path, bytes, meta);
        handle.metadata = opts.saveWithoutGeneration ? {} : { generation: g };
        return [handle.metadata];
      },
      async delete(options) {
        calls.del += 1;
        const want = options && options.ifGenerationMatch != null ? String(options.ifGenerationMatch) : pinned;
        const cur = head.get(path);
        if (cur == null) throw err(404, 'No such object');
        if (want != null && want !== cur) throw err(412, 'Precondition Failed');
        gens.get(path).delete(cur);
        head.delete(path);
        return [];
      }
    };
    return handle;
  }

  const api = { file, calls, put, gens, head, remove: p => head.delete(p) };
  return api;
}

const META = {
  'resq-schema': 'hr-attachment-object-v1',
  'resq-attachment': 'a'.repeat(64)
};

/* ================================================================== */

test('קריאה רגילה מחזירה בייטים, מטא-דאטה ודור', async () => {
  const bucket = makeBucket();
  const g = bucket.put('p/1', Buffer.from('hello'), META);
  const store = S.createHrAttachmentsStorage({ bucket });
  const out = await store.read({ path: 'p/1' });
  assert.equal(out.bytes.toString(), 'hello');
  assert.equal(out.generation, g);
  assert.equal(out.metadata['resq-schema'], 'hr-attachment-object-v1');
});

test('אובייקט חסר — `null`, לא חריגה', async () => {
  const store = S.createHrAttachmentsStorage({ bucket: makeBucket() });
  assert.equal(await store.read({ path: 'p/missing' }), null);
});

test('דור שנמסר ואינו קיים — `null`', async () => {
  const bucket = makeBucket();
  bucket.put('p/1', Buffer.from('hello'), META);
  const store = S.createHrAttachmentsStorage({ bucket });
  assert.equal(await store.read({ path: 'p/1', generation: '999999' }), null);
});

test('**החלפת דור בין המטא-דאטה לבייטים — אין הגשה** (seq542 §2)', async () => {
  const bucket = makeBucket({
    /* בדיוק החלון: המטא-דאטה כבר נקראה, הבייטים עוד לא. */
    afterMetadata: api => { api.put('p/1', Buffer.from('ATTACKER'), { 'resq-schema': 'other' }); }
  });
  bucket.put('p/1', Buffer.from('original'), META);
  const store = S.createHrAttachmentsStorage({ bucket });
  const out = await store.read({ path: 'p/1' });
  assert.equal(out, null, '**המטא-דאטה של דור אחד עם הבייטים של אחר — לעולם לא**');
});

test('החלפת דור כשהקורא נעץ דור מפורש — גם כן אין הגשה', async () => {
  const bucket = makeBucket({
    afterMetadata: api => { api.put('p/1', Buffer.from('ATTACKER'), { 'resq-schema': 'other' }); }
  });
  const g = bucket.put('p/1', Buffer.from('original'), META);
  const store = S.createHrAttachmentsStorage({ bucket });
  assert.equal(await store.read({ path: 'p/1', generation: g }), null);
});

test('**בדלי עם versioning — הבייטים והמטא-דאטה תמיד מאותו דור**', async () => {
  const bucket = makeBucket({
    versioned: true,
    afterMetadata: api => { api.put('p/1', Buffer.from('ATTACKER'), { 'resq-schema': 'other' }); }
  });
  bucket.put('p/1', Buffer.from('original'), META);
  const store = S.createHrAttachmentsStorage({ bucket });
  const out = await store.read({ path: 'p/1' });
  /* כאן הדור הישן עדיין קריא, ולכן התשובה אינה `null` — אבל היא
   * **עקבית**: הבייטים, הדור והמטא-דאטה שייכים כולם לאותו אובייקט.
   * בלי הנעיצה היו כאן הבייטים של התוקף עם המטא-דאטה המקורית. */
  assert.equal(out.bytes.toString(), 'original');
  assert.equal(out.metadata['resq-schema'], 'hr-attachment-object-v1');
  assert.equal(out.generation, bucket.gens.get('p/1').get(out.generation).generation);
});

test('**`size` שמשקר אינו עוקף את התקרה** — הזרם נקטע', async () => {
  const bucket = makeBucket();
  const big = Buffer.alloc(600 * 1024, 0x41);
  /* המטא-דאטה מצהירה 10; הזרם פולט 600KiB. */
  bucket.put('p/1', big, META, 10);
  const store = S.createHrAttachmentsStorage({ bucket });
  const out = await store.read({ path: 'p/1', maxBytes: 128 * 1024 });
  assert.equal(out.oversize, true);
  assert.equal(out.bytes, null, '**הבייטים אינם מוחזרים**');
  assert.ok(bucket.calls.destroyedAt <= 256 * 1024,
    'הזרם נקטע קרוב לתקרה, ולא אחרי אגירת הכול — נקטע ב-' + bucket.calls.destroyedAt);
});

test('`size` מוצהר מעל התקרה — נחסך גם המשיכה', async () => {
  const bucket = makeBucket();
  bucket.put('p/1', Buffer.alloc(4096, 1), META);
  const store = S.createHrAttachmentsStorage({ bucket });
  const out = await store.read({ path: 'p/1', maxBytes: 100 });
  assert.equal(out.oversize, true);
  assert.equal(bucket.calls.stream, 0, '**לא נפתח זרם בכלל**');
});

test('התקרה המוחלטת חוסמת גם `maxBytes` מופרז', async () => {
  const bucket = makeBucket();
  bucket.put('p/1', Buffer.alloc(S.MAX_READ_BYTES + 1024, 1), META);
  const store = S.createHrAttachmentsStorage({ bucket });
  const out = await store.read({ path: 'p/1', maxBytes: Number.MAX_SAFE_INTEGER });
  assert.equal(out.oversize, true);
});

test('בדיוק בתקרה — עובר; תקרה ועוד בייט — נחסם', async () => {
  const bucket = makeBucket();
  bucket.put('exact', Buffer.alloc(1024, 7), META, 0);
  bucket.put('over', Buffer.alloc(1025, 7), META, 0);
  const store = S.createHrAttachmentsStorage({ bucket });
  assert.equal((await store.read({ path: 'exact', maxBytes: 1024 })).bytes.length, 1024);
  assert.equal((await store.read({ path: 'over', maxBytes: 1024 })).oversize, true);
});

test('שגיאת זרם שאינה 404 מתפשטת ואינה מתחזה ל„אין אובייקט"', async () => {
  const bucket = makeBucket();
  bucket.put('p/1', Buffer.from('x'), META);
  const real = bucket.file;
  bucket.file = (path, o) => {
    const h = real(path, o);
    const orig = h.createReadStream;
    h.createReadStream = () => {
      const s = orig.call(h);
      process.nextTick(() => s.emit('error', err(500, 'Backend error')));
      return s;
    };
    return h;
  };
  const store = S.createHrAttachmentsStorage({ bucket });
  await assert.rejects(() => store.read({ path: 'p/1' }), e => Number(e.code) === 500);
});

/* ---------- שמירה ---------- */

test('שמירה היא **יצירה בלבד**, ו-412 מתורגם ל-`precondition-failed`', async () => {
  const bucket = makeBucket();
  const store = S.createHrAttachmentsStorage({ bucket });
  const first = await store.save({ path: 'p/1', bytes: Buffer.from('a'), contentType: 'application/pdf', metadata: META });
  assert.ok(first.generation);
  await assert.rejects(() => store.save({ path: 'p/1', bytes: Buffer.from('b'), contentType: 'application/pdf', metadata: META }),
    e => e.code === 'precondition-failed');
  assert.equal(bucket.gens.get('p/1').size, 1, '**לא נדרס**');
});

test('**הדור נלקח מתשובת ההעלאה**, ולא מקריאת מטא-דאטה שנייה', async () => {
  const bucket = makeBucket();
  const store = S.createHrAttachmentsStorage({ bucket });
  await store.save({ path: 'p/1', bytes: Buffer.from('a'), contentType: 'application/pdf', metadata: META });
  assert.equal(bucket.calls.getMetadata, 0, 'אין קריאה שנייה שיכולה לצפות בדור של כותב אחר');
});

test('תשובת העלאה בלי דור — `null`, והמודול הטהור פותר דרך האימוץ', async () => {
  const bucket = makeBucket({ saveWithoutGeneration: true });
  const store = S.createHrAttachmentsStorage({ bucket });
  const out = await store.save({ path: 'p/1', bytes: Buffer.from('a'), contentType: 'application/pdf', metadata: META });
  assert.equal(out.generation, null);
});

test('שמירה אינה כותבת `firebaseStorageDownloadTokens` ואינה מייצרת URL', async () => {
  const bucket = makeBucket();
  let seen = null;
  const real = bucket.file;
  bucket.file = (p, o) => {
    const h = real(p, o);
    const s = h.save.bind(h);
    h.save = (b, options) => { seen = options; return s(b, options); };
    return h;
  };
  const store = S.createHrAttachmentsStorage({ bucket });
  await store.save({ path: 'p/1', bytes: Buffer.from('a'), contentType: 'application/pdf', metadata: META });
  const text = JSON.stringify(seen);
  assert.ok(!/DownloadTokens/i.test(text), text);
  assert.equal(seen.metadata.cacheControl, 'private, no-store');
  assert.equal(seen.metadata.contentDisposition, 'attachment');
  assert.equal(seen.resumable, false);
});

/* ---------- מחיקה ---------- */

test('**בלי דור אין מחיקה**', async () => {
  const bucket = makeBucket();
  bucket.put('p/1', Buffer.from('a'), META);
  const store = S.createHrAttachmentsStorage({ bucket });
  const out = await store.remove({ path: 'p/1' });
  assert.deepEqual(out, { removed: false, reason: 'no-generation' });
  assert.equal(bucket.calls.del, 0, 'לא נשלחה מחיקה בכלל');
});

test('מחיקה של הדור המדויק מאשרת הסרה', async () => {
  const bucket = makeBucket();
  const g = bucket.put('p/1', Buffer.from('a'), META);
  const store = S.createHrAttachmentsStorage({ bucket });
  assert.deepEqual(await store.remove({ path: 'p/1', generation: g }), { removed: true });
});

test('**„הוחלף" ו„אינו קיים" הן שתי תשובות שונות**', async () => {
  const bucket = makeBucket();
  const g = bucket.put('p/1', Buffer.from('a'), META);
  bucket.put('p/1', Buffer.from('b'), META);
  const store = S.createHrAttachmentsStorage({ bucket });
  assert.deepEqual(await store.remove({ path: 'p/1', generation: g }),
    { removed: false, reason: 'generation-mismatch' });
  assert.deepEqual(await store.remove({ path: 'p/2', generation: '1' }),
    { removed: false, reason: 'not-found' });
  assert.equal(bucket.head.get('p/1') != null, true, '**האובייקט החדש לא נמחק**');
});

test('הדלי מוזרק, ואינו מגיע מהקורא', () => {
  assert.throws(() => S.createHrAttachmentsStorage({}), /bucket is required/);
  assert.throws(() => S.createHrAttachmentsStorage({ bucket: {} }), /bucket is required/);
  const api = S.createHrAttachmentsStorage({ bucket: makeBucket() });
  assert.deepEqual(Object.keys(api).sort(), ['read', 'remove', 'save']);
  assert.ok(Object.isFrozen(api));
});
