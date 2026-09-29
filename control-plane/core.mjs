// Closed telemetry protocol only; never accept raw terminal or provider text.
export const AGENTS=Object.freeze(['Codex','Grok','Claude','Gemini']);
export const KINDS=Object.freeze(['heartbeat','task_started','test_passed','test_failed','commit_created','task_completed','task_failed']);
export const TASK_LABELS=Object.freeze(['local_tests','git_change','pull_request_review','deployment_check','agent_review_cycle','planner_draft_recovery','swap_race_review','clean_checkout_gates']);
export const STEPS=Object.freeze(['started','running','passed','failed','completed']);
export function validateEvent({agent,kind,task,step}){
 if(!AGENTS.includes(agent)||!KINDS.includes(kind)||!TASK_LABELS.includes(task)||!STEPS.includes(step))throw Error('INVALID_EVENT');
 return Object.freeze({agent,kind,task,step});
}
