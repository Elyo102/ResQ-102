'use strict';
// Pure persisted-receipt validation shared by reads and the future dispatcher.
const access = require('./schedule-access');
const {monthKey,HrHoursInputError} = require('./hr-hours-model');
const {createHash} = require('node:crypto');
const reviewHash = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype,null].includes(Object.getPrototypeOf(v));
const safeTime = v => Number.isSafeInteger(v) && v >= 0 && Number.isFinite(new Date(v).getTime());
function validReview(v) {
  if(!plain(v) || !['hr-hours-review-v1','hr-hours-review-v2'].includes(v.schema))return false;
  const fields=['schema','review_id','station_id','actor_uid','owner_uid','employee_number','month','request_id','fingerprint','reviewed_revision','reviewed_at'];
  if(v.schema==='hr-hours-review-v2'){
    fields.push('actor_auth_time','created_at_ms');
    if(!Number.isSafeInteger(v.actor_auth_time) || v.actor_auth_time<0 || !Number.isSafeInteger(v.actor_auth_time*1000)
      || !safeTime(v.created_at_ms) || !safeTime(v.created_at_ms+86400000))return false;
  }
  if(Object.keys(v).sort().join(',')!==fields.sort().join(',')
    || typeof v.station_id!=='string' || !access.validId(v.station_id)
    || !access.validUid(v.actor_uid) || !access.validUid(v.owner_uid)
    || typeof v.employee_number!=='string' || !v.employee_number.length || v.employee_number.length>64 || /[\u0000-\u001f\u007f/]/.test(v.employee_number)
    || typeof v.request_id!=='string' || !/^[A-Za-z0-9_-]{8,120}$/.test(v.request_id)
    || typeof v.reviewed_revision!=='string' || !/^[a-f0-9]{64}$/.test(v.reviewed_revision)
    || !v.reviewed_at || !Number.isSafeInteger(v.reviewed_at.seconds) || v.reviewed_at.seconds < -62135596800 || v.reviewed_at.seconds > 253402300799
    || !Number.isInteger(v.reviewed_at.nanoseconds) || v.reviewed_at.nanoseconds<0 || v.reviewed_at.nanoseconds>999999999)return false;
  try{monthKey(v.month);}catch(e){if(e instanceof HrHoursInputError)return false;throw e;}
  return v.review_id===reviewHash(['hr-review-event-v1',v.actor_uid,v.request_id])
    && v.fingerprint===reviewHash(['hr-review-intent-v1',v.station_id,v.actor_uid,v.owner_uid,v.month,v.reviewed_revision]);
}
module.exports=Object.freeze({validReview,reviewHash});
