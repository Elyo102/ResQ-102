'use strict';
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

function createOwnerSetupMailService({ db, auth, requireSuperAdmin, fail, clock=Date.now }) {
  function reject(reason, code='failed-precondition') { fail(code, 'מייל כניסה: '+reason); throw Error(reason); }
  async function fresh(req, uid) { const actor=await requireSuperAdmin(req); if(!actor?.uid||(uid&&actor.uid!==uid))reject('actor-changed','permission-denied');return actor; }
  async function target(uid, tx) {
    const user=await auth.getUser(uid), c=user?.customClaims||{}, email=normalize(user?.email), emp=String(c.emp||''), stationId=c.stationId;
    if(user?.uid!==uid||user.disabled!==false||c.super===true||!c.role||!email||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || !/^[1-9][0-9]{0,5}$/.test(emp)||typeof stationId!=='string'||!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(stationId))reject('account-not-ready');
    const get=async path=>{const ref=db.doc(path),s=await(tx?tx.get(ref):ref.get());return s.exists?s.data():null;};
    const [profile,index,station]=await Promise.all([get('stations/'+stationId+'/users/'+uid),get('emp_index/'+emp),get('stations/'+stationId)]);
    if(!profile||profile.active!==true||profile.is_active===false||profile.stationId!==stationId||profile.role!==c.role
      ||String(profile.employee_number||'')!==emp||normalize(profile.email)!==email
      ||!index||index.uid!==uid||index.stationId!==stationId||normalize(index.email)!==email
      ||index.active===false||index.retired===true||index.status==='retired'
      ||!station||station.active!==true||station.archived===true)reject('identity-mismatch');
    const snapshot={uid,email,emp,station_id:stationId,role:c.role};
    return {...snapshot,full_name:String(profile.full_name||''),fingerprint:digest(snapshot)};
  }
  function input(req) {
    const d=req.data;
    if(!d||!['preview','send','status'].includes(d.action)||!Array.isArray(d.uids)||d.uids.length<1||d.uids.length>20
      ||d.uids.some(uid=>!validId(uid))||new Set(d.uids).size!==d.uids.length
      ||Object.keys(d).some(k=>!['action','uids','request_id','expected'].includes(k)))reject('input','invalid-argument');
    if(d.action!=='preview'&&(!/^[A-Za-z0-9_-]{16,100}$/.test(d.request_id||'')))reject('request-id','invalid-argument');
    if(d.action==='send'&&(!d.expected||typeof d.expected!=='object'||Array.isArray(d.expected)
      ||Object.keys(d.expected).length!==d.uids.length||d.uids.some(uid=>!/^[a-f0-9]{64}$/.test(d.expected[uid]||''))))reject('preview-required','invalid-argument');
    return d;
  }
  async function handle(req) {
    const actor=await fresh(req), d=input(req), uids=[...d.uids].sort(), rows=[];
    if(d.action==='preview') {
      for(const uid of uids) { try{rows.push({...(await target(uid)),eligible:true});}catch(_){rows.push({uid,eligible:false,state:'NOT_ELIGIBLE'});} }
      await fresh(req,actor.uid); return {ok:true,rows};
    }
    const operationId=digest([actor.uid,d.request_id]), operationRef=db.doc('setup_mail_operations/'+operationId);
    const intent=digest(uids);
    if(d.action==='send') await db.runTransaction(async tx=>{
      const old=await tx.get(operationRef); if(old.exists&&old.data().intent!==intent)reject('request-conflict');
      await fresh(req,actor.uid); if(!old.exists)tx.create(operationRef,{actor_uid:actor.uid,intent,created_at:new Date(clock())});
    });
    else {const old=await operationRef.get();if(!old.exists||old.data().intent!==intent)reject('operation-not-found');}
    for(const uid of uids) {
      const jobId='setup-'+digest([operationId,uid]), receiptRef=db.doc('setup_mail_receipts/'+jobId), mailRef=db.doc('mail/'+jobId);
      try {
        if(d.action==='status') {const [r,m]=await Promise.all([receiptRef.get(),mailRef.get()]);const receipt=r.data();rows.push({uid,state:m.exists?(m.data().delivery?.state||'PENDING'):(r.exists?(receipt.state==='PREPARING'&&receipt.lease_until<=clock()?'RETRY_READY':receipt.state):'NOT_STARTED')});continue;}
        const resolved=await target(uid);
        if(resolved.fingerprint!==d.expected[uid]){rows.push({uid,state:'PREVIEW_CHANGED'});continue;}
        const lease=crypto.randomBytes(16).toString('hex'), cooldownRef=db.doc('setup_mail_cooldowns/'+digest(uid));
        const rateRef=db.doc('setup_mail_rates/'+digest([actor.uid,Math.floor(clock()/3600000)]));
        const reservation=await db.runTransaction(async tx=>{
          const [r,m,c,rate]=await Promise.all([tx.get(receiptRef),tx.get(mailRef),tx.get(cooldownRef),tx.get(rateRef)]);
          if(m.exists)return {state:m.data().delivery?.state||'PENDING'};
          if(r.exists&&r.data().fingerprint!==resolved.fingerprint)reject('recipient-changed');
          if(r.exists&&r.data().state==='PREPARING'&&r.data().lease_until>clock())return {state:'PREPARING'};
          if(!r.exists&&c.exists&&c.data().until>clock())return {state:'COOLDOWN'};
          if(!r.exists&&Number(rate.data()?.count||0)>=100)return {state:'RATE_LIMITED'};
          if(r.exists&&Number(r.data().attempts||0)>=3)return {state:'RETRY_LIMIT'};
          const checked=await target(uid,tx);if(checked.fingerprint!==resolved.fingerprint)reject('recipient-changed');
          await fresh(req,actor.uid);
          tx.set(receiptRef,{state:'PREPARING',fingerprint:resolved.fingerprint,lease,lease_until:clock()+120000,attempts:Number(r.data()?.attempts||0)+1});
          if(!r.exists){tx.set(cooldownRef,{until:clock()+3600000});tx.set(rateRef,{count:Number(rate.data()?.count||0)+1});}
          return {reserved:true};
        });
        if(!reservation.reserved){rows.push({uid,state:reservation.state});continue;}
        // Credential creation is deliberately outside a retrying database transaction.
        const reset=await auth.generatePasswordResetLink(resolved.email);
        const resetUrl=new URL(reset);if(resetUrl.protocol!=='https:')reject('reset-link-invalid');
        const state=await db.runTransaction(async tx=>{
          const [r,m]=await Promise.all([tx.get(receiptRef),tx.get(mailRef)]);
          if(m.exists)return m.data().delivery?.state||'PENDING';
          if(!r.exists||r.data().lease!==lease||r.data().lease_until<=clock())return 'PREPARING';
          const checked=await target(uid,tx);if(checked.fingerprint!==resolved.fingerprint)reject('recipient-changed');
          await fresh(req,actor.uid);
          tx.create(mailRef,{to:[resolved.email],station_id:resolved.station_id,created_at:new Date(clock()),
            setup_authority:{schema:1,uid,actor_uid:actor.uid,fingerprint:resolved.fingerprint},
            message:{subject:'ResQ — מספר העובד שלך ובחירת סיסמה',text:'מספר העובד שלך ב־ResQ: '+resolved.emp+'\nלבחירת סיסמה אישית:\n'+reset+'\nאין להעביר את הקישור לאחרים. הסיסמה עצמה אינה נשלחת במייל. בכניסה הראשונה יש לאשר את התקנון.'}});
          tx.set(receiptRef,{state:'PENDING',lease:'',lease_until:0},{merge:true});return 'PENDING';
        });
        rows.push({uid,state});
      } catch(_) { rows.push({uid,state:'UNKNOWN',message:'הפעולה לא אומתה. בדקו מצב לפני ניסיון חוזר, ושמרו את אותה פעולה.'}); }
    }
    await fresh(req,actor.uid);return {ok:true,rows};
  }
  async function validateDelivery(job) {
    const a=job.setup_authority;
    if(!a||a.schema!==1||!validId(a.uid)||!validId(a.actor_uid))return false;
    const owner=await auth.getUser(a.actor_uid);
    if(owner?.disabled!==false||owner.customClaims?.super!==true)return false;
    const current=await target(a.uid);
    return current.fingerprint===a.fingerprint&&job.station_id===current.station_id
      &&Array.isArray(job.to)&&job.to.length===1&&normalize(job.to[0])===current.email&&!job.cc&&!job.bcc;
  }
  return { handle, validateDelivery };
}
module.exports={createOwnerSetupMailService};
