'use strict';

/* Firestore מזויף לבדיקות יחידה — מספיק ל-incident-log ול-feedback:
 * doc/collection/get/set(merge)/runTransaction, ושלושת ה-FieldValue
 * שהמודולים משתמשים בהם: serverTimestamp, increment, arrayUnion.
 * הטרנזקציה כותבת רק בסיום (כמו Firestore) ומונה קריאות אחרי כתיבה
 * כדי לתפוס „read after write" — Firestore האמיתי זורק על זה. */

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const SENTINEL = Symbol('fv');

const FieldValue = Object.freeze({
  serverTimestamp: () => ({ [SENTINEL]: 'serverTimestamp' }),
  increment: (n) => ({ [SENTINEL]: 'increment', n }),
  arrayUnion: (...items) => ({ [SENTINEL]: 'arrayUnion', items })
});

function isSentinel(value) {
  return !!value && typeof value === 'object' && SENTINEL in value;
}

function applyValue(previous, value, now) {
  if (!isSentinel(value)) {
    return value instanceof Date ? value.toISOString() : clone(value);
  }
  if (value[SENTINEL] === 'serverTimestamp') return now;
  if (value[SENTINEL] === 'increment') return Number(previous || 0) + value.n;
  if (value[SENTINEL] === 'arrayUnion') {
    const list = Array.isArray(previous) ? previous.slice() : [];
    value.items.forEach((item) => { if (list.indexOf(item) === -1) list.push(item); });
    return list;
  }
  throw new Error('unknown sentinel');
}

function createFakeFirestore(seed) {
  const store = new Map();
  Object.keys(seed || {}).forEach((path) => store.set(path, clone(seed[path])));
  let clockValue = '2026-09-03T10:00:00.000Z';
  const log = [];

  function docRef(path) {
    return {
      path,
      id: path.split('/').pop(),
      collection(name) { return collectionRef(path + '/' + String(name)); },
      async get() { return snapshot(this); }
    };
  }
  function snapshot(ref) {
    const exists = store.has(ref.path);
    return { exists, ref, id: ref.id, data: () => (exists ? clone(store.get(ref.path)) : undefined) };
  }
  function collectionRef(path, filters = [], ordering = null, maximum = null) {
    return {
      path,
      doc(id) { return docRef(path + '/' + String(id)); },
      where(field, op, value) { return collectionRef(path, filters.concat({ field, op, value }), ordering, maximum); },
      orderBy(field, direction) { return collectionRef(path, filters, { field, direction }, maximum); },
      limit(value) { return collectionRef(path, filters, ordering, value); },
      async get() {
        const depth = path.split('/').length + 1;
        let docs = [];
        for (const [key] of store) {
          if (key.startsWith(path + '/') && key.split('/').length === depth) docs.push(snapshot(docRef(key)));
        }
        for (const filter of filters) {
          docs = docs.filter((doc) => {
            const value = doc.data()[filter.field];
            if (filter.op === '>=') return value >= filter.value;
            if (filter.op === '==') return value === filter.value;
            throw new Error('unsupported fake query');
          });
        }
        if (ordering) {
          docs = docs.filter((doc) => doc.data()[ordering.field] !== undefined);
          docs.sort((a, b) => String(a.data()[ordering.field]).localeCompare(String(b.data()[ordering.field]))
            * (ordering.direction === 'desc' ? -1 : 1));
        }
        if (maximum !== null) docs = docs.slice(0, maximum);
        return { docs, size: docs.length };
      }
    };
  }
  function applySet(path, value, options) {
    const merge = !!(options && options.merge);
    const prev = store.has(path) ? store.get(path) : {};
    const next = merge ? Object.assign({}, prev) : {};
    Object.keys(value).forEach((key) => {
      next[key] = applyValue(merge ? prev[key] : undefined, value[key], clockValue);
    });
    store.set(path, next);
    log.push({ path, merge, keys: Object.keys(value) });
  }

  return {
    FieldValue,
    collection: collectionRef,
    doc: docRef,
    async runTransaction(work) {
      const writes = [];
      let wrote = false;
      const tx = {
        get: async (ref) => {
          if (wrote) throw new Error('read after write inside transaction');
          return snapshot(ref);
        },
        set: (ref, value, options) => { wrote = true; writes.push({ ref, value, options }); },
        create: (ref, value) => {
          wrote = true;
          if (store.has(ref.path)) throw new Error('already-exists');
          writes.push({ ref, value, options: null });
        }
      };
      const result = await work(tx);
      writes.forEach((w) => applySet(w.ref.path, w.value, w.options));
      return result;
    },
    read(path) { return store.has(path) ? clone(store.get(path)) : null; },
    write(path, value) { store.set(path, clone(value)); },
    keys() { return Array.from(store.keys()).sort(); },
    setClock(iso) { clockValue = iso; },
    writes: log
  };
}

module.exports = { createFakeFirestore, FieldValue, clone };
