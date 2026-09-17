'use strict';

// Dormant contract: no runtime consumer or callable imports this module.
const { createHash } = require('node:crypto');
const MAX_RECEIPT_BYTES = 750000;
// Per-operation transaction budget, NOT a limit on retained history.
const MAX_TOUCHED_MONTHS = 400;
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function plain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (plain(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function hash(v) { return createHash('sha256').update(stable(v)).digest('hex'); }
function id(v) { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v)) fail('invalid-id'); return v; }
function date(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v + 'T00:00:00Z'))
      || new Date(v + 'T00:00:00Z').toISOString().slice(0,10) !== v) fail('invalid-date');
  return v;
}
function generation(v) { if (!Number.isSafeInteger(v) || v < 0 || v >= Number.MAX_SAFE_INTEGER) fail('invalid-generation'); return v; }
function signature(v) { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail('invalid-digest'); return v; }
function months(from, to) {
  date(from); date(to); if (from > to) fail('invalid-range');
  if ((Number(to.slice(0,4))-Number(from.slice(0,4)))*12 + Number(to.slice(5,7))-Number(from.slice(5,7))+1 > MAX_TOUCHED_MONTHS) fail('transaction-capacity');
  const out = []; let y = Number(from.slice(0,4)), m = Number(from.slice(5,7));
  while (true) {
    const key = String(y).padStart(4,'0') + '-' + String(m).padStart(2,'0');
    out.push(key); if (key === to.slice(0,7)) return out;
    if (++m === 13) { m = 1; y++; }
  }
}
function monthEnd(month) {
  let y = Number(month.slice(0,4)), m = Number(month.slice(5,7));
  // setUTCFullYear handles years 0000..0099 without Date.UTC's 1900 offset.
  const d = new Date(0); d.setUTCFullYear(y, m, 0); return d.toISOString().slice(0,10);
}
function owner(v, sid, month) {
  if (!plain(v) || Object.keys(v).filter(k=>k!=='activation_id').sort().join(',') !== 'content_digest,coverage_from,coverage_to,month,publication_id,revision,schema_version,station_id'
      || v.schema_version !== 1 || v.station_id !== sid || v.month !== month) fail('invalid-owner');
  id(sid); id(v.publication_id); signature(v.content_digest);
  if (Object.hasOwn(v,'activation_id')) signature(v.activation_id);
  if (!Number.isSafeInteger(v.revision) || v.revision < 1) fail('invalid-revision');
  date(v.coverage_from); date(v.coverage_to);
  if (v.coverage_from > v.coverage_to || v.coverage_from.slice(0,7) !== month || v.coverage_to.slice(0,7) !== month) fail('invalid-coverage');
  return structuredClone(v);
}
function activationId(sid,kind,operation,month) {
  id(sid);id(operation);date(month+'-01');
  if (!['migration','publish','rollback'].includes(kind)) fail('activation-kind');
  return hash({station_id:sid,kind,operation_id:operation,month});
}
function migrationActivation(sid,value) {
  return activationId(sid,'migration',hash({publication_id:value.publication_id,revision:value.revision,content_digest:value.content_digest}),value.month);
}
function tombstone(v,sid,month) {
  if(!plain(v) || Object.keys(v).sort().join(',')!=='activation_id,month,operation_id,operation_publication_id,schema_version,state,station_id'
      || v.schema_version!==2 || v.state!=='unowned' || v.station_id!==sid || v.month!==month)fail('invalid-tombstone');
  id(sid);date(month+'-01');signature(v.activation_id);id(v.operation_id);id(v.operation_publication_id);
  return structuredClone(v);
}
function entry(v,sid,month) {return v && v.state==='unowned'?tombstone(v,sid,month):owner(v,sid,month);}
function publicationOwners(p, sid) {
  if (!plain(p) || p.station_id !== sid) fail('publication-station');
  const out = {};
  for (const month of months(p.from,p.to)) out[month] = owner({ schema_version:1, station_id:sid, month,
    publication_id:p.publication_id, revision:p.revision, content_digest:p.content_digest,
    coverage_from:p.from > month+'-01' ? p.from : month+'-01',
    coverage_to:p.to < monthEnd(month) ? p.to : monthEnd(month) }, sid, month);
  return out;
}
function patch(v, sid) {
  if (!plain(v)) fail('invalid-patch');
  if (Object.keys(v).length > MAX_TOUCHED_MONTHS) fail('transaction-capacity');
  const out = {};
  for (const month of Object.keys(v).sort()) {
    date(month + '-01');
    out[month] = v[month] === null ? null : entry(v[month],sid,month);
  }
  return out;
}
function root(v, sid) {
  if (!plain(v) || v.schema_version !== 1 || v.station_id !== sid || v.migrated !== true) fail('invalid-root');
  generation(v.generation); id(v.last_operation_id);
  if (v.seed_publication_id !== null) id(v.seed_publication_id);
  return structuredClone(v);
}
function receipt(v) {
  if (!plain(v) || v.schema_version !== 1 || !['publish','rollback'].includes(v.kind)) fail('invalid-receipt');
  id(v.station_id); id(v.operation_id); signature(v.fingerprint);
  generation(v.generation_before); generation(v.generation_after);
  if (v.generation_after !== v.generation_before+1) fail('invalid-receipt-generation');
  const before = patch(v.before,v.station_id), after = patch(v.after,v.station_id);
  if (Object.keys(before).join() !== Object.keys(after).join() || !Object.keys(before).length) fail('invalid-receipt-patch');
  const copy = structuredClone(v); delete copy.receipt_digest;
  if (v.receipt_digest !== hash(copy)) fail('invalid-receipt-digest');
  if (Buffer.byteLength(stable(v),'utf8') > MAX_RECEIPT_BYTES) fail('receipt-too-large');
  return structuredClone(v);
}
function makeReceipt(v) { const out = { ...v }; out.receipt_digest = hash(out); return receipt(out); }
module.exports = { MAX_RECEIPT_BYTES, MAX_TOUCHED_MONTHS, fail, stable, hash, id, generation, owner, entry, tombstone, patch, root, publicationOwners, receipt, makeReceipt, activationId, migrationActivation };
