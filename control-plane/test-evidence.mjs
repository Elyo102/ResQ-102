import {createHash} from 'node:crypto';
const hash=v=>createHash('sha256').update(v).digest('hex');
const sha=/^[a-f0-9]{64}$/;
export function evidenceKey(context){
 const keys=['commit','treeDigest','commandDigest','environmentDigest','toolchainDigest','workflowDigest'];
 if(!context||Object.keys(context).length!==keys.length||keys.some(k=>!Object.hasOwn(context,k))
  ||!/^[a-f0-9]{40}$/.test(context.commit)||keys.slice(1).some(k=>!sha.test(context[k])))throw Error('INVALID_EVIDENCE_CONTEXT');
 return hash(JSON.stringify(keys.map(k=>context[k])));
}
export function successEvidence(context,{exitCode,failures,warnings,finishedAt}){
 if(exitCode!==0||failures!==0||warnings!==0||!Number.isSafeInteger(finishedAt)||finishedAt<0)throw Error('UNSUCCESSFUL_EVIDENCE');
 const record={version:1,key:evidenceKey(context),finishedAt,result:'PASS'};
 return {...record,digest:hash(JSON.stringify(record))};
}
export function inspectEvidence(record,context,now){
 const miss=()=>({match:false,maySkipRequiredGate:false});
 try{
  if(!record||Object.keys(record).sort().join(',')!=='digest,finishedAt,key,result,version'||record.version!==1||record.result!=='PASS'
   ||record.key!==evidenceKey(context)||!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(record.finishedAt)
   ||record.finishedAt<0||record.finishedAt>now||now-record.finishedAt>21600000)return miss();
  const core={version:1,key:record.key,finishedAt:record.finishedAt,result:'PASS'};
  if(record.digest!==hash(JSON.stringify(core)))return miss();
  // Digest detects accidental corruption, not malicious forgery. This is not an
  // attestation or permission to skip CI, Rules, release or protected SHA gates.
  return {match:true,maySkipRequiredGate:false,mode:'ADVISORY_ONLY'};
 }catch{return miss();}
}
