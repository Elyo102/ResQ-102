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
// Dispatch-only deploy artifact (separate mode, separate provenance). The live capture is kept
// byte-identical; the ONLY change is inserting the dispatch fragment before the final deny-all match.
// No budget fragment, no event-task changes. Never writes control-plane/firestore.rules.
export const DISPATCH_ANCHOR='    match /{document=**}';
export function assembleDispatchRules(capture,fragment){
 if(hash(capture)!==CAPTURE_SHA256)throw Error('CAPTURE_HASH_MISMATCH');
 const source=capture.toString('utf8');
 if(source.includes('\r'))throw Error('CAPTURE_EOL_UNEXPECTED');
 const at=source.indexOf(DISPATCH_ANCHOR);
 if(at<0||at!==source.lastIndexOf(DISPATCH_ANCHOR))throw Error('CAPTURE_ANCHOR_MISMATCH');
 const block=fragment.replace(/\r\n/g,'\n').trimEnd()+'\n';
 if(/rules_version\s*=|service cloud\.firestore|match \/\{document=\*\*\}|match \/events|budget|tasks\(\)|aid\(\)|policy\(\)/i.test(block)||!block.includes('match /dispatchRequests/{id}'))throw Error('DISPATCH_FRAGMENT_REQUIRED');
 const offset=Buffer.byteLength(source.slice(0,at));
 const prefix=capture.subarray(0,offset),suffix=capture.subarray(offset),inserted=Buffer.from(block);
 const result=Buffer.concat([prefix,inserted,suffix]);
 return {result,provenance:{schemaVersion:1,kind:'dispatch-only-deploy-artifact',project:'resq-agent-control-20260928',service:'cloud.firestore',
  releaseName:'projects/resq-agent-control-20260928/releases/cloud.firestore',
  baseRulesetName:'projects/resq-agent-control-20260928/rulesets/427c5744-bdfc-4da7-baaa-8f7277c64322',
  baseReleaseUpdateTime:'2026-09-28T21:16:51.349144Z',baseCaptureTime:'2026-09-29T16:24:26.044Z',
  captureSha256:CAPTURE_SHA256,fragment:'control-plane/firestore-dispatch.rules.fragment',fragmentSha256:hash(inserted),fragmentHashEncoding:'utf8-lf-trimmed-plus-lf',
  insertionOffsetBytes:offset,insertedBytes:inserted.length,prefixSha256:hash(prefix),suffixSha256:hash(suffix),
  artifact:'control-plane/deploy/firestore.dispatch.rules',artifactSha256:hash(result),artifactBytes:result.length,
  changes:['Insert dispatchRequests block before the final deny-all match; capture bytes otherwise unchanged'],
  excluded:['budget fragment','new event task labels'],
  status:'LOCAL_ARTIFACT_NOT_DEPLOYED'}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv[2]==='--dispatch'){
 const input=process.argv[3];if(!input)throw Error('CAPTURE_PATH_REQUIRED');
 const fragment=readFileSync(new URL('./firestore-dispatch.rules.fragment',import.meta.url),'utf8');
 const {result,provenance}=assembleDispatchRules(readFileSync(input),fragment);
 writeFileSync(new URL('./deploy/firestore.dispatch.rules',import.meta.url),result);
 writeFileSync(new URL('./deploy/firestore-dispatch-provenance.json',import.meta.url),JSON.stringify(provenance,null,2)+'\n');
 console.log(JSON.stringify({status:provenance.status,captureSha256:provenance.captureSha256,artifactSha256:provenance.artifactSha256}));
}else if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const input=process.argv[2];if(!input)throw Error('CAPTURE_PATH_REQUIRED');
 const fragment=readFileSync(new URL('./firestore-budget.rules.fragment',import.meta.url),'utf8');
 const {result,provenance}=assembleRules(readFileSync(input),fragment);
 writeFileSync(new URL('./firestore.rules',import.meta.url),result);
 writeFileSync(new URL('./firestore-rules-provenance.json',import.meta.url),JSON.stringify(provenance,null,2)+'\n');
 console.log(JSON.stringify({status:provenance.status,sourceSha256:provenance.sourceSha256,assembledSha256:provenance.assembledSha256}));
}
