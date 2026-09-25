'use strict';

// M2 / H5 (hardening): server-side swap helpers.
//
// resolveSwapNames: the names that go into the shift log and push texts come
// from a server-written source, never from the client-written swap fields.
// Order of truth (H5 "directory/roster with fallback to registration name"):
//   1. stations/{sid}/roster/{uid}.full_name   (written at assignment)
//   2. stations/{sid}/users/{uid}.full_name    (written by server / HR)
//   3. registration_requests/{uid}.full_name   (approved registration)
//   4. the generic label used before (never the client string)
// The roster is written only at assignment (identity-coordinator), so a person
// assigned before the roster existed still resolves through (2)/(3).
//
// approvedSwapsFor: the rest-rule check only needs approved swaps that involve
// the two people of the swap being approved. Two equality/in queries replace
// the old unbounded scan of every approved swap in the station; the result set
// for restBreaks is identical (it only reads swaps with from_uid/to_uid in the
// pair), and equality filters need no composite index.

const NAME_FIELDS = Object.freeze([
  ['from_uid', 'from_name'], ['to_uid', 'to_name'],
  ['from_appr_uid', 'from_appr_name'], ['to_appr_uid', 'to_appr_name'],
  ['reject_uid', 'reject_name']
]);

function cleanName(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s.length <= 80 ? s : '';
}

async function readName(db, path) {
  try {
    const snap = await db.doc(path).get();
    return snap && snap.exists ? cleanName((snap.data() || {}).full_name) : '';
  } catch (e) {
    return '';
  }
}

async function serverNameOf(db, sid, uid) {
  if (!uid || typeof uid !== 'string' || uid.indexOf('/') !== -1) return '';
  return (await readName(db, 'stations/' + sid + '/roster/' + uid)) ||
         (await readName(db, 'stations/' + sid + '/users/' + uid)) ||
         (await readName(db, 'registration_requests/' + uid));
}

async function resolveSwapNames(db, sid, swap) {
  const s = swap || {};
  const out = Object.assign({}, s);
  const cache = new Map();
  for (const [uidField, nameField] of NAME_FIELDS) {
    const uid = s[uidField];
    if (!uid) { if (nameField in out) out[nameField] = ''; continue; }
    if (!cache.has(uid)) cache.set(uid, await serverNameOf(db, sid, uid));
    out[nameField] = cache.get(uid);
  }
  // Peer-consent / cancel names are written without a uid field; the person
  // is the counterpart, so reuse the resolved counterpart names.
  if ('peer_name' in out) out.peer_name = out.to_name || '';
  return out;
}

async function approvedSwapsFor(db, sid, uids, excludeId) {
  const people = [...new Set((uids || []).filter((u) => typeof u === 'string' && u))].slice(0, 10);
  if (!people.length) return [];
  const col = db.collection('stations/' + sid + '/swaps');
  const [a, b] = await Promise.all([
    col.where('status', '==', 'approved').where('from_uid', 'in', people).get(),
    col.where('status', '==', 'approved').where('to_uid', 'in', people).get()
  ]);
  const seen = new Map();
  for (const snap of [a, b]) {
    snap.forEach((d) => { if (d.id !== excludeId && !seen.has(d.id)) seen.set(d.id, d.data() || {}); });
  }
  return [...seen.values()];
}

module.exports = { NAME_FIELDS, resolveSwapNames, approvedSwapsFor, serverNameOf };
