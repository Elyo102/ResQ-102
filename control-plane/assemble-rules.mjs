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
// Active tasks: appended on top of the LIVE dispatch artifact (f30d3d85, ruleset 569cfc0c). The live bytes stay
// byte-identical; the only change is inserting the active-tasks fragment before the final deny-all match.
// Function names must not collide with any existing function in the live rules (tasks(), aid(), policy(), ...).
export const LIVE_BASE_SHA256='f30d3d85142e21abae4e3a2c53938242d105be8f9dbffc71e5633301f3b94e16';
export const LIVE_BASE_RULESET='projects/resq-agent-control-20260928/rulesets/569cfc0c-a798-45b6-b8f6-d3bd501369ba';
// Previous active-tasks artifact (live since 30/09/2026, ruleset f7f2d208): the push-trigger diff is taken against it.
export const PREVIOUS_ACTIVE_ARTIFACT_SHA256='358b4c0cf9bef8a49508828f1d4060864583677544ff0a449dbb545246691c7f';
export function assembleActiveTasksRules(base,fragment){
 if(hash(base)!==LIVE_BASE_SHA256)throw Error('LIVE_BASE_HASH_MISMATCH');
 const source=base.toString('utf8');
 if(source.includes('\r'))throw Error('BASE_EOL_UNEXPECTED');
 const at=source.indexOf(DISPATCH_ANCHOR);
 if(at<0||at!==source.lastIndexOf(DISPATCH_ANCHOR))throw Error('BASE_ANCHOR_MISMATCH');
 const block=fragment.replace(/\r\n/g,'\n').trimEnd()+'\n';
 if(/rules_version\s*=|service cloud\.firestore|match \/\{document=\*\*\}|match \/events|match \/dispatchRequests|match \/private_|match \/[a-z_]*budget|\btasks\(\)|\baid\(\)|\bpolicy\(\)/i.test(block)
   ||!block.includes('match /active_tasks/{taskId}')||!block.includes('match /task_listeners/{agentKey}'))throw Error('ACTIVE_FRAGMENT_REQUIRED');
 const existing=new Set([...source.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g)].map(m=>m[1]));
 const added=[...block.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g)].map(m=>m[1]);
 if(new Set(added).size!==added.length||added.some(n=>existing.has(n)))throw Error('ACTIVE_FUNCTION_NAME_COLLISION');
 const offset=Buffer.byteLength(source.slice(0,at));
 const prefix=base.subarray(0,offset),suffix=base.subarray(offset),inserted=Buffer.from(block);
 const result=Buffer.concat([prefix,inserted,suffix]);
 return {result,provenance:{schemaVersion:1,kind:'control-plane-active-tasks-deploy-artifact',project:'resq-agent-control-20260928',service:'cloud.firestore',
  releaseName:'projects/resq-agent-control-20260928/releases/cloud.firestore',
  base:'control-plane/deploy/firestore.dispatch.rules',baseSha256:LIVE_BASE_SHA256,baseRulesetName:LIVE_BASE_RULESET,baseReleaseUpdateTime:'2026-09-30T13:19:16.668156Z',
  fragment:'control-plane/firestore-active-tasks.rules.fragment',fragmentSha256:hash(inserted),fragmentHashEncoding:'utf8-lf-trimmed-plus-lf',
  functionsAdded:added,insertionOffsetBytes:offset,insertedBytes:inserted.length,prefixSha256:hash(prefix),suffixSha256:hash(suffix),
  artifact:'control-plane/deploy/firestore.control-plane.rules',artifactSha256:hash(result),artifactBytes:result.length,
  rulesDiff:'control-plane/deploy/firestore-active-tasks.diff',
  changes:['Insert active_tasks, task_listeners and control/ack_switch blocks before the final deny-all match; live f30d3d85 bytes otherwise unchanged',
   'Push trigger (t175u/t176u): kind TASK|MESSAGE + NOTIFY target, acks[own key] (LIT/UNDERSTOOD/UNREADABLE, summary <= 280), owner-only IN_PROGRESS/COMPLETED, listener READY/REJECTED only, heartbeat ack/mode fields'],
  supersedesArtifactSha256:PREVIOUS_ACTIVE_ARTIFACT_SHA256,
  rollback:'PATCH re-release of the live ruleset f7f2d208 (= artifact 358b4c0c); the full ruleset name is read from the live release at deploy time',
  pushTriggerDiff:'control-plane/deploy/firestore-push-trigger.diff',
  excluded:['events rules','dispatchRequests rules','budget rules','indexes'],
  status:'LOCAL_ARTIFACT_NOT_DEPLOYED'}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv[2]==='--active'){
 const base=readFileSync(new URL('./deploy/firestore.dispatch.rules',import.meta.url));
 const fragment=readFileSync(new URL('./firestore-active-tasks.rules.fragment',import.meta.url),'utf8');
 const {result,provenance}=assembleActiveTasksRules(base,fragment);
 writeFileSync(new URL('./deploy/firestore.control-plane.rules',import.meta.url),result);
 writeFileSync(new URL('./deploy/firestore-active-tasks-provenance.json',import.meta.url),JSON.stringify(provenance,null,2)+'\n');
 console.log(JSON.stringify({status:provenance.status,baseSha256:provenance.baseSha256,artifactSha256:provenance.artifactSha256}));
}else if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv[2]==='--dispatch'){
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
