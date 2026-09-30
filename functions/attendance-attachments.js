'use strict';

// Private evidence membership only. Never edits attendance, reports or absence cases.
const { createHash } = require('node:crypto');
const { createOpsMemberIdentity } = require('./ops-member-identity');
const { TARGET_ROLES } = require('./attendance-corrections');
const access = require('./schedule-access');
const own = (v,k) => Object.prototype.hasOwnProperty.call(v,k);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype,null].includes(Object.getPrototypeOf(v));
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const KEY = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const stamp = v => v && Number.isSafeInteger(v.seconds) && Number.isInteger(v.nanoseconds)
  && v.nanoseconds >= 0 && v.nanoseconds < 1e9 ? {seconds:v.seconds,nanoseconds:v.nanoseconds} : null;
const millis = v => stamp(v) ? v.seconds*1000+v.nanoseconds/1e6 : NaN;

function createAttendanceAttachments({db,auth,HttpsError,clock=Date.now,monthAt,hooks={}}) {
  if (typeof monthAt !== 'function') throw new TypeError('Trusted monthAt required');
  const identity = createOpsMemberIdentity({db,HttpsError});
  const fail = (code,message) => { throw new HttpsError(code,message); };
  const root = sid => db.collection('stations').doc(sid);
  const parents = sid => root(sid).collection('attendance_order_parents');
  const manager = ctx => ctx.super || ctx.role === 'hr_coordinator';
  function date(value) {
    if (typeof value !== 'string' || !DATE.test(value) || !Number.isFinite(Date.parse(value+'T00:00:00Z'))
        || new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value) fail('invalid-argument','Invalid attendance date.');
    return value;
  }
  function session(input) {
    if (!plain(input) || !plain(input.ctx) || !Number.isSafeInteger(input.authTime)
        || input.authTime < 0 || !Number.isSafeInteger(input.authTime*1000)) fail('unauthenticated','Refresh your sign-in.');
    return {ctx:identity.context({auth:{uid:input.ctx.uid,token:{stationId:input.ctx.sid,
      role:input.ctx.role,super:input.ctx.super}}}),authTime:input.authTime};
  }
  async function live(tx,r) {
    let user;
    try { user=await auth.getUser(r.ctx.uid); }
    catch(e) { fail(e?.code==='auth/user-not-found'?'permission-denied':'unavailable','Current authentication unavailable.'); }
    const c=user?.customClaims;
    if (!user || user.uid!==r.ctx.uid || user.disabled===true || !plain(c) || c.stationId!==r.ctx.sid
        || (c.super===true)!==r.ctx.super || (!r.ctx.super && c.role!==r.ctx.role)) fail('permission-denied','Current authority changed.');
    if (own(user,'tokensValidAfterTime')) {
      const at=typeof user.tokensValidAfterTime==='string'?Date.parse(user.tokensValidAfterTime):NaN;
      if (!Number.isFinite(at)) fail('unavailable','Authentication validity unavailable.');
      if (r.authTime*1000<at) fail('permission-denied','Sign-in revoked.');
    }
    await identity.requireLive(tx,r.ctx);
  }
  async function resolve(tx,r,uid,day) {
    if (!access.validUid(uid) || (!manager(r.ctx) && uid!==r.ctx.uid)) fail('permission-denied','Attendance owner authority required.');
    date(day);
    await live(tx,r);
    const pSnap=await tx.get(root(r.ctx.sid).collection('users').doc(uid)), p=pSnap.exists?pSnap.data():null;
    if (!plain(p) || !access.liveStation(p).ok || access.liveStation(p).stationId!==r.ctx.sid
        || !TARGET_ROLES.includes(p.role) || (own(p,'uid') && p.uid!==uid)
        || ['active','is_active'].some(k=>own(p,k)&&typeof p[k]!=='boolean')) fail('failed-precondition','Employee binding unavailable.');
    const emp=typeof p.employee_number==='string'||(typeof p.employee_number==='number'&&Number.isFinite(p.employee_number))?String(p.employee_number):'';
    if (!emp||emp.length>64||/[\u0000-\u001f\u007f/]/.test(emp)) fail('failed-precondition','Employee number unavailable.');
    const inactive=p.active===false||p.is_active===false;
    if (!inactive) {
      const i=await tx.get(db.collection('emp_index').doc(emp)), d=await tx.get(db.collection('directory').doc(uid));
      const iv=i.exists?i.data():null,dv=d.exists?d.data():null;
      if (!plain(iv)||iv.uid!==uid||iv.stationId!==r.ctx.sid||iv.active===false||iv.retired===true||iv.status==='retired'
          ||!plain(dv)||!access.activeMember(dv,r.ctx.sid)||(own(dv,'uid')&&dv.uid!==uid)
          ||(own(dv,'employee_number')&&String(dv.employee_number)!==emp)) fail('failed-precondition','Active employee binding unavailable.');
    }
    const rowId=emp+'_'+day, rowSnap=await tx.get(root(r.ctx.sid).collection('attendance').doc(rowId));
    const row=rowSnap.exists?rowSnap.data():null,created=stamp(rowSnap.createTime),month=day.slice(0,7);
    if (!plain(row)||!created||row.uid!==uid||String(row.emp_number)!==emp||row.date!==day||row.month!==month
        ||!['reserve','reserve_shift'].includes(row.day_type)) fail('failed-precondition','Existing reserve attendance required.');
    const reportSnap=await tx.get(root(r.ctx.sid).collection('monthly_reports').doc(emp+'_'+month));
    const report=reportSnap.exists?reportSnap.data():null;
    const id=hash(['attendance-order-parent-v1',r.ctx.sid,uid,rowId,created.seconds,created.nanoseconds]);
    return {id,uid,emp,day,month,rowId,created,row,report,inactive};
  }
  function writeGate(v,r) {
    const report=v.report;
    if (report===null && !manager(r.ctx) && !v.inactive && v.row.status==='draft') {
      const now=clock();
      if (Number.isSafeInteger(now)&&now>=0&&monthAt(now)===v.month) return;
    }
    if (!plain(report)||(own(report,'uid')&&report.uid!==v.uid)||String(report.emp_number)!==v.emp||report.month!==v.month
        ||!['draft','submitted'].includes(report.status)||!['draft','submitted','imported'].includes(v.row.status)) fail('failed-precondition','Attendance report must be reopened before uploading.');
    if (!manager(r.ctx) && (v.inactive||v.row.status!=='draft'||report.status!=='draft')) fail('failed-precondition','Draft attendance required.');
    if (v.inactive||v.row.status==='imported') {
      const now=clock(),reopened=millis(report.reopened_at),approved=own(report,'approved_at')?millis(report.approved_at):null;
      if (!Number.isSafeInteger(now)||now<0||!access.validUid(report.reopened_by)||!Number.isFinite(reopened)||reopened<0||reopened>now
          ||(approved!==null&&(!Number.isFinite(approved)||approved>=reopened))) fail('failed-precondition','Historical evidence requires valid reopening.');
    }
  }
  function base(v,sid) { return {schema:'attendance-order-parent-v1',station_id:sid,parent_id:v.id,
    owner_uid:v.uid,employee_number:v.emp,date:v.day,row_id:v.rowId,row_created_at:v.created,revision:1,attachment_ids:[]}; }
  function checked(s,v,sid) {
    const d=s.exists?s.data():null,b=base(v,sid);
    if (!plain(d)||['schema','station_id','parent_id','owner_uid','employee_number','date','row_id'].some(k=>d[k]!==b[k])
        ||JSON.stringify(stamp(d.row_created_at))!==JSON.stringify(v.created)||!Number.isSafeInteger(d.revision)||d.revision<1
        ||!Array.isArray(d.attachment_ids)||d.attachment_ids.length>10||new Set(d.attachment_ids).size!==d.attachment_ids.length
        ||d.attachment_ids.some(x=>typeof x!=='string'||!KEY.test(x))) fail('failed-precondition','Attendance attachment parent unavailable.');
    return d;
  }
  async function context(req) {
    const ctx=identity.context(req),data=req.data;
    if (!plain(data)||Object.keys(data).sort().join(',')!=='date,target_uid') fail('invalid-argument','Target and date required.');
    const r=session({ctx,authTime:req.auth.token.auth_time});
    return db.runTransaction(async tx=>{
      const v=await resolve(tx,r,data.target_uid,data.date),ref=parents(ctx.sid).doc(v.id),snap=await tx.get(ref);
      const d=snap.exists?checked(snap,v,ctx.sid):base(v,ctx.sid);
      let canUpload=true;
      try { writeGate(v,r); } catch(e) { if(e.code!=='failed-precondition')throw e; canUpload=false; }
      // Idempotent metadata initialization permits reading an empty locked row;
      // it grants no upload authority and never changes the attendance record.
      await live(tx,r);
      if (!snap.exists) tx.create(ref,d);
      return {parent_kind:'attendance',parent_id:v.id,parent_revision:d.revision,can_upload:canUpload,can_remove:false,
        epoch:{uid:ctx.uid,station_id:ctx.sid,auth_time:r.authTime,claims_digest:hash([ctx.uid,ctx.sid,ctx.role||'',ctx.super===true])}};
    });
  }
  async function load(tx,input) {
    const r=session(input);
    if (input.parent_kind!=='attendance'||typeof input.parent_id!=='string'||!KEY.test(input.parent_id)||own(input,'revision')) fail('invalid-argument','Invalid attendance parent.');
    const ref=parents(r.ctx.sid).doc(input.parent_id),snap=await tx.get(ref),d=snap.exists?snap.data():null;
    if (!plain(d)) fail('failed-precondition','Attendance attachment context required.');
    const v=await resolve(tx,r,d.owner_uid,d.date);
    if(v.id!==input.parent_id) fail('failed-precondition','Attendance was replaced; refresh context.');
    checked(snap,v,r.ctx.sid);
    if(own(input,'attachment_id')&&!d.attachment_ids.includes(input.attachment_id)) fail('permission-denied','Attachment is not part of this attendance.');
    return {r,v,d,ref};
  }
  const brand=new WeakSet();
  const attachmentPorts=Object.freeze({
    async read(tx,input) {const {d}=await load(tx,input);return {parent_kind:'attendance',parent_id:d.parent_id,revision:d.revision,attachment_ids:d.attachment_ids.slice()};},
    async prepare(tx,input) {
      // Publication attachment is new, not yet a member.
      const {attachment_id:aid,...readInput}=input,original=await load(tx,readInput),{r,v,d,ref}=original;
      if(!KEY.test(aid||'')||!KEY.test(input.event_id||'')||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1) fail('invalid-argument','Invalid attachment publication.');
      writeGate(v,r);
      if(input.expected_revision!==d.revision) fail('aborted','Attendance evidence changed; refresh.');
      if(d.attachment_ids.includes(aid)) fail('already-exists','Attachment already linked.');
      if(d.attachment_ids.length>=10) fail('resource-exhausted','Attachment capacity reached.');
      if(!Number.isSafeInteger(d.revision+1)) fail('failed-precondition','Revision overflow.');
      let ready=false,committed=false;
      const plan=Object.freeze({
        async recheck(currentTx) {
          if(currentTx!==tx||committed) fail('failed-precondition','Invalid attachment transaction.');
          ready=false;if(hooks.beforeAttachmentRecheck)await hooks.beforeAttachmentRecheck();
          const latest=await load(tx,readInput);writeGate(latest.v,r);
          if(latest.d.revision!==d.revision||JSON.stringify(latest.d.attachment_ids)!==JSON.stringify(d.attachment_ids)) fail('aborted','Attendance evidence changed.');
          ready=true;
        },
        commit(currentTx,{at}={}) {
          if(currentTx!==tx||!ready||committed||!Number.isSafeInteger(at)||at<0) fail('failed-precondition','Attachment publication not rechecked.');
          committed=true;tx.set(ref,{...d,revision:d.revision+1,attachment_ids:d.attachment_ids.concat(aid),updated_at_ms:at});
          return {linked:true,revision:d.revision+1,event_id:input.event_id,notification_status:'not_requested'};
        }
      });brand.add(plan);return plan;
    },
    recheck(tx,plan){if(!brand.has(plan))fail('failed-precondition','Invalid attachment plan.');return plan.recheck(tx);},
    commit(tx,plan,options){if(!brand.has(plan))fail('failed-precondition','Invalid attachment plan.');return plan.commit(tx,options);}
  });
  return Object.freeze({context,attachmentPorts});
}
module.exports=Object.freeze({createAttendanceAttachments});
