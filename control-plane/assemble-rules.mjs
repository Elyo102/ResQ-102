// Deterministic local artifact assembly; no credentials, network or deployment.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export const CAPTURE_SHA256='8c0eb6571dd04f2100c4e9988a32457a039b31bb23e77275298a435b3ce51454';
const hash=b=>createHash('sha256').update(b).digest('hex');
const OLD="['local_tests','git_change','pull_request_review','deployment_check']";
const NEW="['local_tests','git_change','pull_request_review','deployment_check','agent_review_cycle','planner_draft_recovery','swap_race_review','clean_checkout_gates']";
export function assembleRules(capture,fragment){
 if(hash(capture)!==CAPTURE_SHA256)throw Error('CAPTURE_HASH_MISMATCH');
 const source=capture.toString('utf8'),start=source.indexOf('    // Budget credentials'),end=source.indexOf('    match /{document=**}');
 if(start<0||end<=start||source.indexOf(OLD)!==source.lastIndexOf(OLD)||!source.includes(OLD))throw Error('CAPTURE_SPLICE_MISMATCH');
 if(/rules_version\s*=|service cloud\.firestore|match \/events/.test(fragment))throw Error('BUDGET_FRAGMENT_REQUIRED');
 const prefix=source.slice(0,start),suffix=source.slice(end),newPrefix=prefix.replace(OLD,NEW);
 const eol=source.includes('\r\n')?'\r\n':'\n';
 const normalized=fragment.replace(/\r\n/g,'\n').trimEnd().replace(/\n/g,eol)+eol;
 const result=Buffer.from(newPrefix+normalized+suffix);
 return {result,provenance:{schemaVersion:1,project:'resq-agent-control-20260928',service:'cloud.firestore',
  releaseName:'projects/resq-agent-control-20260928/releases/cloud.firestore',
  rulesetName:'projects/resq-agent-control-20260928/rulesets/427c5744-bdfc-4da7-baaa-8f7277c64322',
  releaseUpdateTime:'2026-09-28T21:16:51.349144Z',captureTime:'2026-09-29T16:24:26.044Z',
  sourceSha256:CAPTURE_SHA256,fragmentSha256:hash(Buffer.from(fragment.replace(/\r\n/g,'\n'))),fragmentHashEncoding:'utf8-lf',assembledSha256:hash(result),
  originalPrefixSha256:hash(Buffer.from(prefix)),originalSuffixSha256:hash(Buffer.from(suffix)),
  changes:['Replace entire legacy budget block; no overlapping legacy allow remains','Retain currentPrincipal revocation and server month blackout','Add exactly four approved event task labels'],
  newEventTasks:['agent_review_cycle','planner_draft_recovery','swap_race_review','clean_checkout_gates'],
  status:'LOCAL_CANDIDATE_NOT_DEPLOYED'}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const input=process.argv[2];if(!input)throw Error('CAPTURE_PATH_REQUIRED');
 const fragment=readFileSync(new URL('./firestore-budget.rules.fragment',import.meta.url),'utf8');
 const {result,provenance}=assembleRules(readFileSync(input),fragment);
 writeFileSync(new URL('./firestore.rules',import.meta.url),result);
 writeFileSync(new URL('./firestore-rules-provenance.json',import.meta.url),JSON.stringify(provenance,null,2)+'\n');
 console.log(JSON.stringify({status:provenance.status,sourceSha256:provenance.sourceSha256,assembledSha256:provenance.assembledSha256}));
}
