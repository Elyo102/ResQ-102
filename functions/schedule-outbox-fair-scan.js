'use strict';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const STATE_COLLECTION = 'schedule_runtime_workers';
const STATE_DOCUMENT = 'outbox_resume';
const SAFE_KEY_RE = /^[a-z0-9_]{1,120}$/;

/**
 * Claims the next deterministic collection-group page by advancing a durable,
 * server-owned cursor in the same transaction that reads it. Concurrent
 * schedulers may process adjacent pages; the outbox lease/CAS remains the
 * authority for delivery ownership.
 */
async function takeFairPage(options) {
  const input = options && typeof options === 'object' ? options : {};
  const db = input.db;
  const FieldPath = input.FieldPath;
  const collection = String(input.collection || '');
  const status = String(input.status || '');
  const cursorKey = collection + '_' + status;
  const pageSize = Number.isSafeInteger(input.pageSize)
      && input.pageSize >= 1 && input.pageSize <= MAX_PAGE_SIZE
    ? input.pageSize : DEFAULT_PAGE_SIZE;
  if (!db || typeof db.collectionGroup !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('outbox fair scan requires Firestore');
  }
  if (!FieldPath || typeof FieldPath.documentId !== 'function') {
    throw new TypeError('outbox fair scan requires FieldPath');
  }
  if (!SAFE_KEY_RE.test(collection) || !SAFE_KEY_RE.test(status)
      || !SAFE_KEY_RE.test(cursorKey)) {
    throw new TypeError('outbox fair scan key is invalid');
  }

  const stateRef = db.collection(STATE_COLLECTION).doc(STATE_DOCUMENT);
  return db.runTransaction(async (tx) => {
    const stateSnap = await tx.get(stateRef);
    const state = stateSnap.exists ? (stateSnap.data() || {}) : {};
    const cursors = state.cursors && typeof state.cursors === 'object' ? state.cursors : {};
    const cursorPath = typeof cursors[cursorKey] === 'string' ? cursors[cursorKey] : '';
    let query = db.collectionGroup(collection)
      .where('status', '==', status)
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    if (cursorPath) query = query.startAfter(db.doc(cursorPath));
    let page = await tx.get(query);
    let wrapped = false;
    if (page.empty && cursorPath) {
      wrapped = true;
      page = await tx.get(db.collectionGroup(collection)
        .where('status', '==', status)
        .orderBy(FieldPath.documentId())
        .limit(pageSize));
    }
    const last = page.docs.length ? page.docs[page.docs.length - 1].ref.path : null;
    tx.set(stateRef, {
      cursors: { [cursorKey]: last },
      updated_at: new Date(),
      last_collection: collection,
      last_status: status
    }, { merge: true });
    return { docs: page.docs, cursor: last, wrapped };
  });
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  STATE_COLLECTION,
  STATE_DOCUMENT,
  takeFairPage
};
