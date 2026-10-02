import { createHrAttachmentsUI } from './hr-attachments-ui.js?v=42h49';

const METHODS = Object.freeze({ reserve:'reserveHrAttachment', upload:'uploadHrAttachment',
  resume:'resumeHrAttachment', list:'listHrAttachments', download:'downloadHrAttachment' });
const EPOCH_KEYS = ['uid','station_id','auth_time','claims_digest'];
const denied = () => Object.assign(new Error('זהות המשתמש או הדיווח השתנו. יש לפתוח מחדש.'), {code:'functions/unauthenticated'});
export function sameOrderEpoch(a,b) {
  return !!a && !!b && EPOCH_KEYS.every(k => a[k] === b[k]);
}
export function orderContext(value) {
  if (!value || value.parent_kind !== 'attendance' || !/^[a-f0-9]{64}$/.test(value.parent_id)
      || !Number.isSafeInteger(value.parent_revision) || value.parent_revision < 1
      || typeof value.can_upload !== 'boolean' || value.can_remove !== false) throw denied();
  return {parent_kind:'attendance',parent_id:value.parent_id,parent_revision:value.parent_revision,
    canUpload:value.can_upload,canRemove:false};
}
// No persistence or public URLs. Every answer is fenced by both actor and viewed row.
export function orderCall(call,currentSession,isCurrent) {
  return async data => {
    const origin=currentSession();
    if (!origin || !isCurrent()) throw denied();
    const response=await call(data);
    if (currentSession() !== origin || !isCurrent() || !sameOrderEpoch(response?.data?.epoch,origin.attachmentEpoch)) throw denied();
    return response.data;
  };
}

export async function openAttendanceOrder({auth,fns,httpsCallable,onIdTokenChanged,target_uid,date,isCurrent}) {
  if (!isCurrent() || !auth.currentUser || typeof target_uid !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw denied();
  const dialog=document.createElement('dialog');
  dialog.dir='rtl'; dialog.setAttribute('aria-labelledby','attendanceOrderTitle');
  dialog.style.cssText='width:min(92vw,680px);max-height:88vh;overflow:auto;border:1px solid var(--line);border-radius:14px;background:var(--card);color:var(--txt);padding:20px';
  const title=document.createElement('h2');title.id='attendanceOrderTitle';title.textContent='צו מילואים · '+date;
  const note=document.createElement('p');note.textContent='קובץ פרטי לדיווח השמור. הצירוף אינו יוצר בקשת היעדרות ואינו משנה שעות.';
  const status=document.createElement('p');status.setAttribute('role','status');status.textContent='בודק הרשאה…';
  const host=document.createElement('section');host.setAttribute('aria-label','קבצים פרטיים לדיווח');
  const close=document.createElement('button');close.type='button';close.className='btn';close.textContent='סגור';
  dialog.append(title,note,status,host,close);document.body.append(dialog);
  let session=null,component=null,closed=false,identityRun=0,contextRun=0;
  let unsubscribe=()=>{};const listeners=new Set();
  const notify=()=>{for(const fn of listeners)fn();};
  const currentSession=()=>!closed && isCurrent() && session && auth.currentUser===session.user ? session : null;
  const contextCall=orderCall(httpsCallable(fns,'getAttendanceOrderContext'),currentSession,isCurrent);
  const calls=Object.fromEntries(Object.entries(METHODS).map(([method,name])=>[method,orderCall(httpsCallable(fns,name),currentSession,isCurrent)]));
  const refreshContext=async()=>{
    const run=++contextRun;
    try {
      const result=await contextCall({target_uid,date});
      if(closed || run!==contextRun)return;
      const next=orderContext(result);
      component.setContext(next);
      status.textContent=next.canUpload?'אפשר לצרף PDF, JPEG או PNG.':'הדיווח נעול לצירוף. קבצים קיימים נשארים זמינים לפי הרשאה.';
    } catch (_) {
      if(!closed && run===contextRun)status.textContent='לא ניתן לאמת את הדיווח. סגרו ופתחו מחדש; אין כאן אישור שהעלאה נכשלה או בוטלה.';
    }
  };
  const identity=async user=>{
    const run=++identityRun;
    // Disconnect immediately on sign-out/identity change; same-user token refresh
    // retains a chosen file only if its complete authoritative epoch is unchanged.
    if(!user || session?.user!==user){session=null;notify();}
    if(!user)return;
    try {
      const {claims}=await user.getIdTokenResult();
      if(closed || run!==identityRun || auth.currentUser!==user || !isCurrent())return;
      if(!Number.isSafeInteger(claims.auth_time) || claims.auth_time<0 || typeof claims.stationId!=='string' || !claims.stationId)throw denied();
      const role=claims.super===true?'super_admin':claims.role;
      if(typeof role!=='string')throw denied();
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([user.uid,claims.stationId,role,claims.super===true])));
      if(closed || run!==identityRun || auth.currentUser!==user || !isCurrent())return;
      const attachmentEpoch={uid:user.uid,station_id:claims.stationId,auth_time:claims.auth_time,
        claims_digest:Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('')};
      if(session?.user===user && sameOrderEpoch(session.attachmentEpoch,attachmentEpoch))return;
      session=Object.freeze({user,uid:user.uid,stationId:claims.stationId,attachmentEpoch});notify();
      if(!component)component=createHrAttachmentsUI(host,{currentSession,subscribeIdentity(fn){listeners.add(fn);return()=>listeners.delete(fn);},
        ...calls,onPublished:refreshContext});
      await refreshContext();
    } catch (_) {if(run===identityRun){session=null;notify();status.textContent='לא ניתן לאמת את זהות המשתמש. סגרו והתחברו מחדש.';}}
  };
  const pending=()=>!!component?.hasPendingWork();
  const requestClose=()=>{
    if(pending()){status.textContent='יש קובץ שנבחר או פעולה שטרם הוכרעה. בטלו בחירה שלא נשלחה או בדקו מה נקלט לפני סגירה.';return;}
    dialog.close();
  };
  const unloading=event=>{if(pending()){event.preventDefault();event.returnValue='';}};
  close.onclick=requestClose;
  dialog.addEventListener('cancel',event=>{event.preventDefault();requestClose();});
  window.addEventListener('beforeunload',unloading);
  const done=new Promise(resolve=>dialog.addEventListener('close',()=>{
    closed=true;identityRun++;contextRun++;unsubscribe();session=null;notify();component?.destroy();
    window.removeEventListener('beforeunload',unloading);dialog.remove();resolve();
  },{once:true}));
  dialog.showModal();
  unsubscribe=onIdTokenChanged(auth,user=>{void identity(user);},()=>{session=null;notify();status.textContent='נדרש חיבור מחדש.';});
  return done;
}
