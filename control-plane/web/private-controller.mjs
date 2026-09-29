// Injected, local-testable controller. No SDK, credentials or persistent cache.
// This UI identity check does NOT replace deployed Firestore authorization.
const names = ['Codex','Grok','Claude','Gemini'];
const kinds = ['heartbeat','task_started','test_passed','test_failed','commit_created','task_completed','task_failed'];
export const TELEMETRY_TASKS = Object.freeze(['local_tests','git_change','pull_request_review','deployment_check','agent_review_cycle','planner_draft_recovery','swap_race_review','clean_checkout_gates']);
const tasks = TELEMETRY_TASKS;
const steps = ['started','running','passed','failed','completed'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function createPrivateController({ subscribe, render, now=Date.now,
  schedule=fn=>setInterval(fn,1000), cancel=clearInterval }) {
  if (typeof subscribe!=='function' || typeof render!=='function') throw Error('INVALID_ADAPTER');
  let disposed=false, visible=true, identity=null, revision=0, detach=null, events=[], phase='signed_out', sessionStart=0;
  const lastBeat=new Map(), taskFloor=new Map();
  function clock() { const t=now(); if(!Number.isSafeInteger(t)||t<0||t>8e15)throw Error('INVALID_CLOCK');return t; }
  function owner(user) { return typeof user?.uid==='string' && user.uid.length>0 && user.backendAuthorized===true; }
  function view() {
    let t;try{t=clock();}catch{t=null;}
    const agents=names.map(agent=>{
      const own=events.filter(e=>e.agent===agent);
      const heartbeats=own.filter(e=>e.kind==='heartbeat');
      const heartbeat=heartbeats.at(-1);
      const live=phase==='connected' && t!==null && heartbeat && t>=heartbeat.at && t-heartbeat.at<=90000;
      const prior=lastBeat.get(agent);
      if(prior!==undefined && ((heartbeat && heartbeat.at-prior>90000) || (t!==null && t-prior>90000))){
        taskFloor.set(agent,Math.max(taskFloor.get(agent)||sessionStart,prior+90000));
      }
      if(heartbeat && (prior===undefined||heartbeat.at>prior))lastBeat.set(agent,heartbeat.at);
      const lifecycle=own.filter(e=>['task_started','task_completed','task_failed'].includes(e.kind) && e.at>=Math.max(sessionStart,taskFloor.get(agent)||0)).at(-1);
      return {agent,status:!live?'DISCONNECTED':lifecycle?.kind==='task_started'?'RUNNING':'CONNECTED',
        task:live && lifecycle?.kind==='task_started'?lifecycle.task:null};
    });
    render({phase,agents,events:events.map(e=>({...e}))});
  }
  function reset(next) {
    revision++;const unsubscribe=detach;detach=null;events=[];lastBeat.clear();taskFloor.clear();phase=next;
    try{unsubscribe?.();}catch{/* Cleanup failure never restores private state. */}
    view();
  }
  function batch(raw) {
    if(!Array.isArray(raw)||raw.length>50)throw Error('INVALID_BATCH');
    const t=clock(), ids=new Set();
    const clean=raw.map(e=>{
      if(!e || Object.getPrototypeOf(e)!==Object.prototype)throw Error('INVALID_EVENT');
      const d=Object.getOwnPropertyDescriptors(e), keys=['id','agent','kind','task','step','at'];
      if(Reflect.ownKeys(d).length!==keys.length || keys.some(k=>!d[k]||!('value' in d[k])))throw Error('INVALID_EVENT');
      const x=Object.fromEntries(keys.map(k=>[k,d[k].value]));
      if(!uuid.test(x.id)||!names.includes(x.agent)||!kinds.includes(x.kind)||!tasks.includes(x.task)||!steps.includes(x.step)
        ||!Number.isSafeInteger(x.at)||x.at<0||x.at>t||ids.has(x.id))throw Error('INVALID_EVENT');
      ids.add(x.id);return Object.freeze(x);
    });
    return clean.sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
  }
  function connect() {
    if(disposed||!visible||!owner(identity))return;
    reset('connecting');const fence=revision;
    try {
      sessionStart=clock();
      const stop=subscribe({limit:50,
        next(raw,{fromCache}={}) {
          if(disposed||fence!==revision)return;
          // Firestore may emit cache first and then server data on this listener.
          // Hide cached private content but retain the fenced subscription.
          if(fromCache!==false){events=[];phase='offline';view();return;}
          try{events=batch(raw);phase='connected';view();}catch{reset('error');}
        },
        error(){if(!disposed&&fence===revision)reset('error');}
      });
      if(typeof stop!=='function')throw Error('INVALID_SUBSCRIPTION');
      if(disposed||fence!==revision)stop();else detach=stop;
    }catch{if(!disposed&&fence===revision)reset('error');}
  }
  const timer=schedule(()=>{if(!disposed)view();});
  view();
  return Object.freeze({
    setIdentity(user){if(disposed)return;identity=owner(user)?{uid:user.uid,backendAuthorized:true}:null;
      reset(identity?'connecting':user?'denied':'signed_out');if(identity)connect();},
    setVisible(value){if(disposed)return;visible=value===true;reset(identity?(visible?'connecting':'paused'):'signed_out');if(visible)connect();},
    reconnect(){if(!disposed)connect();},
    dispose(){if(disposed)return;disposed=true;identity=null;cancel(timer);reset('signed_out');}
  });
}
