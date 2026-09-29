import {validateEvent} from './core.mjs';
// Transport only; no credentials, network defaults, retries or invented heartbeat.
export function createEmitter({agent,transport}){
 if(typeof transport!=='function')throw Error('INVALID_EMITTER');
 return Object.freeze({async emit(kind,step,task){
  const event=validateEvent({agent,kind,step,task});
  return transport(event);
 }});
}
