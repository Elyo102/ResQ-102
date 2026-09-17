'use strict';
// Dormant: caller must supply full signed snapshot verification and live context
// checks. No publication policies, people dictionaries or plans are combined.
const C = require('./schedule-month-authority');
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function offset(date,n) { const d=new Date(date+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10); }
function createMonthAuthorityReader({authorityStore,verifySnapshot,verifyContext}) {
  if (!authorityStore || typeof authorityStore.read!=='function' || typeof verifySnapshot!=='function' || typeof verifyContext!=='function') throw new TypeError('reader dependencies');
  const handles=new WeakMap();
  async function finalCheck(state) {
    await verifyContext({station_id:state.station_id,phase:'final',expected_context:state.context});
    const current=await authorityStore.read(state.station_id,[]);
    C.root(current.root,state.station_id);
    if(current.root.generation!==state.generation) C.fail('authority-stale');
  }
  async function readRange({station_id:sid,from,to}) {
    C.id(sid);
    const range=C.publicationOwners({station_id:sid,publication_id:'range',revision:1,content_digest:'0'.repeat(64),from,to},sid);
    const context=await verifyContext({station_id:sid,phase:'initial'});
    const loaded=await authorityStore.read(sid,Object.keys(range));
    const root=C.root(loaded.root,sid), owners=C.patch(loaded.owners,sid);
    if(Object.keys(owners).join()!==Object.keys(range).join())C.fail('reader-months');
    const cache=new Map(), segments=[];
    function add(start,end,owner,snapshot) {
      if(start>end)return;
      segments.push({from:start,to:end,available:owner!==null,owner,snapshot,
        provenance:owner ? {month:owner.month,publication_id:owner.publication_id,revision:owner.revision,content_digest:owner.content_digest,
          ...(owner.activation_id ? {activation_id:owner.activation_id} : {})} : null});
    }
    for(const month of Object.keys(range)) {
      const requested=range[month], owner=owners[month];
      if(owner===null || owner.state==='unowned'){add(requested.coverage_from,requested.coverage_to,null,null);continue;}
      let snapshot=cache.get(owner.publication_id);
      if(!snapshot) {
        snapshot=structuredClone(await verifySnapshot({station_id:sid,publication_id:owner.publication_id}));
        if(!snapshot || snapshot.publication_id!==owner.publication_id || snapshot.station_id!==sid
            || !snapshot.plan || !Array.isArray(snapshot.plan.rows) || !Array.isArray(snapshot.events) || !Array.isArray(snapshot.roster)
            || snapshot.plan.station_id!==sid || snapshot.plan.from!==snapshot.from || snapshot.plan.to!==snapshot.to) C.fail('reader-snapshot');
        freeze(snapshot);cache.set(owner.publication_id,snapshot);
      }
      const expected=C.publicationOwners(snapshot,sid)[month];
      if(expected && owner.activation_id)expected.activation_id=owner.activation_id;
      if(!expected || C.stable(expected)!==C.stable(owner))C.fail('reader-owner-mismatch');
      const start=owner.coverage_from>requested.coverage_from?owner.coverage_from:requested.coverage_from;
      const end=owner.coverage_to<requested.coverage_to?owner.coverage_to:requested.coverage_to;
      if(start>end){add(requested.coverage_from,requested.coverage_to,null,null);continue;}
      if(requested.coverage_from<start)add(requested.coverage_from,offset(start,-1),null,null);
      add(start,end,owner,snapshot);
      if(end<requested.coverage_to)add(offset(end,1),requested.coverage_to,null,null);
    }
    const state={station_id:sid,generation:root.generation,context};
    await finalCheck(state);
    const result=freeze({station_id:sid,from,to,generation:root.generation,segments});
    handles.set(result,state);return result;
  }
  async function projectRange(resolved,projectSegment) {
    const state=handles.get(resolved);
    if(!state || typeof projectSegment!=='function')C.fail('reader-handle');
    const projected=[];
    for(const segment of resolved.segments) {
      // An unavailable interval never invokes a projector with another source.
      projected.push({from:segment.from,to:segment.to,available:segment.available,provenance:segment.provenance,
        value:segment.available ? await projectSegment(segment) : null});
    }
    await finalCheck(state);
    return freeze({station_id:state.station_id,generation:state.generation,segments:projected});
  }
  return Object.freeze({readRange,projectRange});
}
module.exports={createMonthAuthorityReader};
