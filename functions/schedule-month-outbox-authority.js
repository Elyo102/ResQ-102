'use strict';
// Pure ownership gate only. Trial suppression, live recipient authorization,
// leases and delivery policy remain independent mandatory runtime gates.
const C=require('./schedule-month-authority');
const TUPLE=['month','publication_id','revision','content_digest'];
function eligibility({station_id,job,owner,phase,legacyMigration,operationEnvelope,receipt}) {
  const denied=reason=>Object.freeze({eligible:false,reason});
  if(!['claim','pre_sdk'].includes(phase))return denied('invalid-phase');
  if(!job || typeof job!=='object' || Array.isArray(job))return denied('invalid-job');
  if(Object.hasOwn(job,'station_id') && job.station_id!==station_id)return denied('station-mismatch');
  try {C.id(station_id);C.patch({[job.month]:null},station_id);}catch(_){return denied('invalid-job');}
  if(!owner)return denied('month-unowned');
  if(owner.state==='unowned') {
    try {
      C.tombstone(owner,station_id,job.month);
      const verified=C.receipt(receipt), envelope=operationEnvelope;
      if(job.authority_state!=='unowned' || job.activation_id!==owner.activation_id || job.operation_id!==owner.operation_id
          || job.operation_publication_id!==owner.operation_publication_id) return denied('tombstone-changed');
      if(!envelope || envelope.status!=='completed' || envelope.station_id!==station_id
          || envelope.operation_id!==owner.operation_id || envelope.operation_publication_id!==owner.operation_publication_id
          || envelope.receipt_digest!==verified.receipt_digest) return denied('operation-incomplete');
      if(verified.kind!=='rollback' || verified.station_id!==station_id || verified.operation_id!==owner.operation_id
          || verified.operation_publication_id!==owner.operation_publication_id
          || C.stable(verified.after[job.month])!==C.stable(owner))return denied('receipt-mismatch');
      const prior=C.owner(verified.before[job.month],station_id,job.month);
      if(!Array.isArray(job.removed_dates) || !job.removed_dates.length || new Set(job.removed_dates).size!==job.removed_dates.length)return denied('removal-dates');
      for(const date of job.removed_dates) {
        if(typeof date!=='string' || date<prior.coverage_from || date>prior.coverage_to)return denied('removal-dates');
        const d=new Date(date+'T00:00:00Z');
        if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(d.getTime()) || d.toISOString().slice(0,10)!==date)return denied('removal-dates');
      }
      return Object.freeze({eligible:true,reason:'unowned-removal'});
    }catch(_){return denied('invalid-removal-authority');}
  }
  try {C.owner(owner,station_id,job.month);}catch(_){return denied('invalid-owner');}
  if(!owner.activation_id)return denied('owner-activation-missing');
  if(TUPLE.some(k=>job[k]!==owner[k]))return denied('owner-changed');
  if(typeof job.activation_id==='string' && job.activation_id===owner.activation_id)return Object.freeze({eligible:true,reason:'owned'});
  // Old jobs are accepted only against the exact deterministic migration
  // activation and an explicit, server-derived tuple mapping. A boolean flag
  // alone cannot turn missing activation into general backwards compatibility.
  if(!Object.hasOwn(job,'activation_id') && legacyMigration && legacyMigration.enabled===true
      && legacyMigration.station_id===station_id && TUPLE.every(k=>legacyMigration[k]===owner[k])
      && legacyMigration.activation_id===owner.activation_id
      && owner.activation_id===C.migrationActivation(station_id,owner))return Object.freeze({eligible:true,reason:'explicit-legacy-migration'});
  return denied('activation-changed');
}
module.exports={eligibility};
