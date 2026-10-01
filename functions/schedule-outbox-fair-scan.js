'use strict';
// Traversal only. Claims/leases remain the authority for delivery. A crash
// after cursor commit delays this page until wrap; this is not delivery ACK.
const STATE_COLLECTION='schedule_runtime_workers';
const STATE_DOCUMENT='outbox_resume';
const STATES=Object.freeze({schedule_outbox:['retry','sending','queued','blocked'],
  guard_notification_jobs:['queued','sending'],guard_outbox:['retry','sending','queued']});
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(v));
const id=v=>typeof v==='string'&&v.length>0&&v.length<=1500&&!/[\x00-\x1f\x7f/]/.test(v);
function validPath(path,collection){
  if(typeof path!=='string'||path.length>6144)return false;
  const p=path.split('/');
  return collection==='schedule_outbox'
    ?p.length===6&&p[0]==='stations'&&p[2]==='schedule_publications'&&p[4]===collection&&[p[1],p[3],p[5]].every(id)
    :p.length===4&&p[0]==='stations'&&p[2]===collection&&[p[1],p[3]].every(id);
}
async function takeFairPage({db,FieldPath,collection,status}){
  if(!Object.hasOwn(STATES,collection)||!STATES[collection].includes(status))throw new TypeError('outbox-scan-key-invalid');
  const key=collection+'_'+status;
  const ref=db.collection(STATE_COLLECTION).doc(STATE_DOCUMENT);
  return db.runTransaction(async tx=>{
    const snap=await tx.get(ref),state=snap.exists?snap.data():{};
    if(!plain(state)|| (state.cursors!==undefined&&!plain(state.cursors)))throw new TypeError('outbox-scan-cursor-invalid');
    const cursors=state.cursors||{};
    for(const [k,v]of Object.entries(cursors)){
      const group=Object.keys(STATES).find(c=>STATES[c].some(s=>c+'_'+s===k));
      if(!group||(v!==null&&!validPath(v,group)))throw new TypeError('outbox-scan-cursor-invalid');
    }
    const cursor=cursors[key]||null;
    const base=()=>db.collectionGroup(collection).where('status','==',status).orderBy(FieldPath.documentId()).limit(100);
    let q=base();if(cursor)q=q.startAfter(db.doc(cursor));
    let page=await tx.get(q),wrapped=false;
    if(page.empty&&cursor){wrapped=true;page=await tx.get(base());}
    const last=page.docs.length?page.docs[page.docs.length-1].ref.path:null;
    if(last!==null&&!validPath(last,collection))throw new TypeError('outbox-scan-row-path-invalid');
    tx.set(ref,{cursors:{[key]:last},updated_at:new Date(),last_collection:collection,last_status:status},{merge:true});
    return {docs:page.docs,cursor:last,wrapped};
  });
}
module.exports=Object.freeze({takeFairPage,STATE_COLLECTION,STATE_DOCUMENT});
