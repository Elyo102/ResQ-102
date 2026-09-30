'use strict';
// Packaged server authority only. Rollback disables new admissions, not readers.
const KEYS=Object.freeze(['reserveV2Admission','courseApprovalAdmission','attendanceOrderAdmission']);
function normalize(value){
  const valid=value&&typeof value==='object'&&!Array.isArray(value)
    &&Object.keys(value).length===KEYS.length&&KEYS.every(k=>Object.hasOwn(value,k)&&typeof value[k]==='boolean');
  return Object.freeze(Object.fromEntries(KEYS.map(k=>[k,valid?value[k]:false])));
}
let configured;
try { configured=require('./hours-rollout-policy.json'); } catch (_) { configured=null; }
const policy=normalize(configured);
function assertAdmission(key,value=policy){
  if(!KEYS.includes(key)||normalize(value)[key]!==true){
    const error=new Error('הפעולה החדשה מושבתת זמנית. הנתונים הקיימים נשמרים.');
    error.code='failed-precondition';throw error;
  }
}
module.exports=Object.freeze({policy,normalize,assertAdmission});
