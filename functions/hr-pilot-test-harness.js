'use strict';

/* ======================================================================
 *  hr-pilot-test-harness — כפיל Firestore בזיכרון עבור בדיקות ההסרה
 *
 *  למה הוא קיים: בדיקות ה-integration של מסמכי HR דורשות אמולטור
 *  Firestore, והאמולטור אינו זמין בכל סביבה. בדיקה שרצה רק במקום אחד
 *  היא בדיקה שלא תרוץ ברגע שבו היא נחוצה. הכפיל כאן מאפשר להריץ את
 *  שבע בדיקות ההרשאה וה-soft delete ב-`npm run static`, בכל מכונה,
 *  בלי אמולטור ובלי רשת.
 *
 *  מה הוא **אינו**: הוא אינו מחליף את בדיקות האמולטור. הוא אינו בודק
 *  כללי Firestore, אינו בודק אינדקסים, ואינו מוכיח התנהגות תחת
 *  התנגשות אמיתית. הוא מריץ את **לוגיקת השירות** מול API בצורת
 *  Firestore. מה שנבדק כאן — נבדק כאן; השאר מסומן NOT RUN.
 *
 *  המבנה מבוסס על `saas-test-harness.js` שכבר במאגר, עם תוספת אחת
 *  שחסרה שם: אוסף-בתוך-מסמך (`docRef().collection()`), שבלעדיו אי
 *  אפשר להגיע ל-`stations/{sid}/hr_documents/{id}`.
 *
 *  ----------------------------------------------------------------
 *  ⭐ שלושת המפעילים שהיו חסרים, וזו לא הייתה חוסר-נוחות
 *  ----------------------------------------------------------------
 *  הגרסה הראשונה סיננה `==` בלבד, ו**כל מפעיל אחר החזיר את כל
 *  השורות**: `rows.filter(([, v]) => (op === '==' ? v[f] === val : true))`.
 *  כלומר בדיקה שכותבת `where('from_date', '<=', x)` הייתה עוברת בלי
 *  לסנן דבר — לא כי הקוד נכון, אלא כי הכפיל אמר „כן" לכל שורה.
 *  בדיקה כזו לא נכשלת גם על קוד שבור לגמרי, וזו הצורה הגרועה ביותר
 *  של בדיקה: אחת שמדווחת PASS ואינה בודקת כלום.
 *
 *  עכשיו כל מפעיל מסונן באמת, ומפעיל שאינו מוכר **זורק** במקום
 *  להתעלם. `hr-pilot-harness-fidelity.test.js` מוכיח את שני הדברים:
 *  שהגרסה הקודמת עברה על ריק, ושהנוכחית נופלת.
 *
 *  `getAll` נוסף מאותה סיבה: קריאה מקובצת שאין לה כפיל אינה נבדקת,
 *  והחלופה הייתה להשאיר את N+1 בלי הוכחה שהוא נעלם.
 * ====================================================================== */

const { createHash } = require('node:crypto');

function fakeDb() {
  const store = new Map();
  const versions = new Map();
  /* ⭐ מוני קריאות. „אין N+1" היא טענה על מספר קריאות, ולכן
   * אפשר לבדוק אותה רק אם סופרים אותן. בלי המונים הבדיקה הייתה
   * אומרת „התוצאה נכונה" — וזה נכון גם עם 25 קריאות סדרתיות. */
  const counts = { get: 0, query: 0, getAll: 0, getAllRefs: 0 };
  const clone = (v) => structuredClone(v);
  const bump = (p) => versions.set(p, (versions.get(p) || 0) + 1);
  const snapOf = (path) => ({
    exists: store.get(path) !== undefined,
    id: path.split('/').pop(),
    ref: docRef(path),
    data: () => (store.get(path) === undefined ? undefined : clone(store.get(path)))
  });
  function apply(path, kind, value, options) {
    if (kind === 'create') {
      if (store.has(path)) throw new Error('ALREADY_EXISTS ' + path);
      store.set(path, clone(value));
    } else if (kind === 'set') {
      store.set(path, options && options.merge
        ? Object.assign({}, store.get(path) || {}, clone(value))
        : clone(value));
    } else if (kind === 'update') {
      if (!store.has(path)) throw new Error('NOT_FOUND ' + path);
      store.set(path, Object.assign({}, store.get(path), clone(value)));
    } else if (kind === 'delete') store.delete(path);
    bump(path);
  }
  /* מפעיל שאינו מוכר זורק. כפיל ששותק על מפעיל שהוא אינו מבין הוא
   * כפיל שמאשר שאילתות שלא נבדקו. */
  function matches(field, op, value) {
    if (op === '==') return field === value;
    if (op === '!=') return field !== value;
    if (op === '<') return field !== undefined && field < value;
    if (op === '<=') return field !== undefined && field <= value;
    if (op === '>') return field !== undefined && field > value;
    if (op === '>=') return field !== undefined && field >= value;
    if (op === 'array-contains') return Array.isArray(field) && field.includes(value);
    if (op === 'array-contains-any') return Array.isArray(field) && Array.isArray(value) && value.some((v) => field.includes(v));
    if (op === 'in') return Array.isArray(value) && value.includes(field);
    if (op === 'not-in') return Array.isArray(value) && !value.includes(field);
    throw new Error('unsupported query operator in harness: ' + String(op));
  }
  function query(collection) {
    const q = { _c: collection, _w: [], _o: null, _l: Infinity, _after: undefined, _isQuery: true };
    q.where = (f, op, v) => { q._w.push([f, op, v]); return q; };
    q.orderBy = (f, dir) => { q._o = [f, dir || 'asc']; return q; };
    q.limit = (n) => { q._l = n; return q; };
    q.startAfter = (v) => { q._after = v; return q; };
    q.get = async () => {
      counts.query += 1;
      const prefix = collection + '/';
      let rows = [];
      for (const [p, v] of store) {
        if (p.startsWith(prefix) && p.slice(prefix.length).indexOf('/') === -1) rows.push([p, v]);
      }
      for (const [f, op, val] of q._w) rows = rows.filter(([, v]) => matches(v[f], op, val));
      // `orderBy('__name__')` ממיין לפי מזהה המסמך, כמו ב-Firestore.
      const keyOf = ([p, v]) => (q._o && q._o[0] === '__name__' ? p.split('/').pop() : v[q._o[0]]);
      if (q._o) rows.sort((a, b) => (keyOf(a) > keyOf(b) ? 1 : keyOf(a) < keyOf(b) ? -1 : 0) * (q._o[1] === 'desc' ? -1 : 1));
      if (q._after !== undefined && q._o) rows = rows.filter((row) => (q._o[1] === 'desc' ? keyOf(row) < q._after : keyOf(row) > q._after));
      rows = rows.slice(0, q._l);
      return { docs: rows.map(([p]) => snapOf(p)), size: rows.length, empty: rows.length === 0 };
    };
    return q;
  }
  function collectionRef(path) {
    return Object.assign(query(path), { doc: (id) => docRef(path + '/' + id) });
  }
  function docRef(path) {
    return {
      path,
      // ⭐ `ref.id` הוא חלק מה-API של Firestore, והשירותים מחזירים אותו
      // כמזהה המסמך. בלעדיו כל בדיקה כאן הייתה נכשלת על „מזהה לא תקין"
      // בגלל הכפיל, ולא בגלל הקוד הנבדק.
      id: path.split('/').pop(),
      get: async () => { counts.get += 1; return snapOf(path); },
      set: async (v, o) => apply(path, 'set', v, o),
      update: async (v) => apply(path, 'update', v),
      collection: (name) => collectionRef(path + '/' + name)
    };
  }
  return {
    _store: store,
    _counts: counts,
    _resetCounts() { for (const key of Object.keys(counts)) counts[key] = 0; },
    _put(p, v) { store.set(p, structuredClone(v)); bump(p); },
    _get(p) { const v = store.get(p); return v === undefined ? undefined : structuredClone(v); },
    doc: docRef,
    collection: collectionRef,
    async getAll(...refs) {
      counts.getAll += 1; counts.getAllRefs += refs.length;
      return refs.map((ref) => snapOf(ref.path));
    },
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const reads = new Map();
        const staged = [];
        const tx = {
          async get(ref) {
            if (ref._isQuery) {
              const r = await ref.get();
              r.docs.forEach((s) => reads.set(s.ref.path, versions.get(s.ref.path) || 0));
              return r;
            }
            counts.get += 1;
            reads.set(ref.path, versions.get(ref.path) || 0);
            return snapOf(ref.path);
          },
          async getAll(...refs) {
            counts.getAll += 1; counts.getAllRefs += refs.length;
            for (const ref of refs) reads.set(ref.path, versions.get(ref.path) || 0);
            return refs.map((ref) => snapOf(ref.path));
          },
          create: (ref, v) => staged.push([ref.path, 'create', v]),
          set: (ref, v, o) => staged.push([ref.path, 'set', v, o]),
          update: (ref, v) => staged.push([ref.path, 'update', v]),
          delete: (ref) => staged.push([ref.path, 'delete'])
        };
        const out = await fn(tx);
        let conflict = false;
        for (const [p, ver] of reads) if ((versions.get(p) || 0) !== ver) conflict = true;
        if (conflict) continue;
        for (const [p, kind, v, o] of staged) apply(p, kind, v, o);
        return out;
      }
      throw new Error('transaction contention');
    }
  };
}

class FakeHttpsError extends Error {
  constructor(code, message) { super(message); this.name = 'FakeHttpsError'; this.code = code; }
}

const AUTH_TIME = Date.parse('2026-09-01T00:00:00Z') / 1000;
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** מפעל זהויות: כל אדם הוא claims חתומים + פרופיל תחנה פעיל. */
function people(db, sid) {
  const records = new Map();
  const auth = {
    async getUser(uid) {
      const value = records.get(uid);
      if (!value) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' });
      return structuredClone(value);
    }
  };
  /* הארגומנט השלישי נשאר בוליאני כדי שקוראים קיימים לא יישברו, אבל
   * מקבל גם אובייקט: שם ומשמרת נדרשים עכשיו כדי לבדוק את תיבת משאבי
   * האנוש, ושם שאינו נכתב אינו שם שאפשר לבדוק שהוחזר. */
  function add(uid, role, options = false) {
    const opts = options && typeof options === 'object' ? options : { super: options === true };
    const superUser = opts.super === true;
    const claims = { stationId: sid, ...(superUser ? { super: true } : { role }) };
    records.set(uid, {
      uid, disabled: false, customClaims: claims,
      tokensValidAfterTime: new Date(AUTH_TIME * 1000).toUTCString()
    });
    db._put('stations/' + sid + '/users/' + uid,
      { stationId: sid, role, active: true, employee_number: 'synthetic-' + uid,
        ...(typeof opts.full_name === 'string' ? { full_name: opts.full_name } : {}),
        ...(typeof opts.crew === 'string' ? { crew: opts.crew } : {}) });
    return uid;
  }
  const req = (uid, data) => {
    const record = records.get(uid);
    if (!record) throw new Error('unknown test identity ' + uid);
    return { auth: { uid, token: { ...record.customClaims, auth_time: AUTH_TIME } }, data };
  };
  return { auth, add, req };
}

module.exports = Object.freeze({ fakeDb, FakeHttpsError, people, hash, AUTH_TIME });
