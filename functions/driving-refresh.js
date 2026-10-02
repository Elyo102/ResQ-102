'use strict';
const { createHash } = require('node:crypto');
const { createOpsMemberIdentity } = require('./ops-member-identity');
const access = require('./schedule-access');
const CREWS = ['A', 'B', 'C'];
const PAGE = 25, YEAR_LIMIT = 5000, PEOPLE_LIMIT = 500;
function israelDate(ms) { return new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms)); }
function createDrivingRefresh({db, HttpsError, clock=Date.now}) {
  const identity = createOpsMemberIdentity({db,HttpsError});
  const fail=(code,message)=>{throw new HttpsError(code,message);};
  const root=sid=>db.collection('stations').doc(sid);
  const reports=sid=>root(sid).collection('driving_refresh_reports');
  const hash=s=>createHash('sha256').update(s).digest('hex');
  const id=v=>typeof v==='string' && /^[A-Za-z0-9_-]{8,100}$/.test(v);
  function input(req,keys) {const d=req.data===undefined?{}:req.data;if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!keys.includes(k)))fail('invalid-argument','שדות דיווח לא תקינים.');return d;}
  function scope(member) {return member.role==='station_commander'||member.role==='super_admin'?'station':['commander','deputy'].includes(member.role)&&CREWS.includes(member.crew)?'shift':'self';}
  const live=ctx=>db.runTransaction(tx=>identity.requireLive(tx,ctx));
  async function stable(ctx,member) {const fresh=await live(ctx);if(fresh.crew!==member.crew||fresh.role!==member.role)fail('permission-denied','שיוך המשמרת השתנה. יש לטעון מחדש.');}
  function publicRow(doc) {const r=doc.data();return {id:doc.id,uid:r.uid,name:r.name,crew:r.crew,vehicle:r.vehicle,hours:r.hours,created_at:r.created_at,local_date:r.local_date,revision:r.revision,edited_at:r.edited_at||null};}
  async function context(req) {const ctx=identity.context(req);input(req,[]);const member=await live(ctx),now=clock(),year=israelDate(now).slice(0,4);const yearly=await reports(ctx.sid).where('uid','==',ctx.uid).where('local_date','>=',year+'-01-01').where('local_date','<=',year+'-12-31').limit(1).get();await stable(ctx,member);return {name:member.full_name,crew:member.crew,scope:scope(member),annual:yearly.docs.length>0,year,server_time:new Date(now).toISOString()};}
  async function save(req) {
    const ctx=identity.context(req),d=input(req,['request_id','report_id','revision','vehicle','hours']);
    if(!id(d.request_id)||!Number.isInteger(d.hours)||d.hours<1||d.hours>12||typeof d.vehicle!=='string'||!d.vehicle.trim()||d.vehicle.trim().length>120||/[\u0000-\u001f\u007f]/.test(d.vehicle))fail('invalid-argument','נדרש שם רכב ובחירה של 1–12 שעות.');
    const editing=d.report_id!==undefined;
    if(editing&&(!id(d.report_id)||!Number.isSafeInteger(d.revision)||d.revision<1))fail('invalid-argument','גרסת דיווח לא תקינה.');
    if(!editing&&d.revision!==undefined)fail('invalid-argument','גרסה אינה מותרת בדיווח חדש.');
    const reportId=editing?d.report_id:hash(ctx.uid+'|'+d.request_id);
    const ref=reports(ctx.sid).doc(reportId);
    const event=ref.collection('edits').doc(hash(ctx.uid+'|'+d.request_id));
    const payload=hash(JSON.stringify({reportId,revision:d.revision||0,vehicle:d.vehicle.trim(),hours:d.hours}));
    return db.runTransaction(async tx=>{
      const member=await identity.requireLive(tx,ctx);
      if(!member.full_name||!CREWS.includes(member.crew))fail('failed-precondition','נדרש שם ושיוך משמרת פעיל לפני דיווח.');
      const prior=await tx.get(ref), receipt=await tx.get(event);
      if(receipt.exists){const r=receipt.data();if(r.uid!==ctx.uid||r.payload!==payload)fail('already-exists','מזהה הבקשה כבר שימש לדיווח אחר.');return {id:reportId,revision:r.revision,replayed:true};}
      const now=clock();if(!Number.isSafeInteger(now)||now<0)fail('internal','שעון השרת אינו זמין.');
      const old=prior.exists?prior.data():null;
      if(editing){if(!old)fail('not-found','הדיווח לא נמצא.');if(old.uid!==ctx.uid)fail('permission-denied','ניתן לערוך רק את הדיווחים שלך.');if(old.revision!==d.revision)fail('aborted','הדיווח השתנה. טען מחדש לפני עריכה.');}
      else if(old)fail('already-exists','הדיווח כבר קיים.');
      const revision=editing?old.revision+1:1;
      const row=editing?{...old,vehicle:d.vehicle.trim(),hours:d.hours,revision,edited_at:new Date(now).toISOString()}:{schema_version:1,uid:ctx.uid,name:member.full_name,crew:member.crew,vehicle:d.vehicle.trim(),hours:d.hours,revision,created_at:new Date(now).toISOString(),local_date:israelDate(now)};
      if(editing)tx.update(ref,{vehicle:row.vehicle,hours:row.hours,revision,edited_at:row.edited_at});else tx.create(ref,row);
      tx.create(event,{uid:ctx.uid,payload,revision,at:new Date(now).toISOString(),kind:editing?'edit':'create',before:editing?{hours:old.hours,vehicle:old.vehicle}:null,after:{hours:row.hours,vehicle:row.vehicle}});
      return {id:reportId,revision,replayed:false};
    });
  }
  async function list(req) {
    const ctx=identity.context(req),d=input(req,['uid','crew','cursor']);const member=await live(ctx),kind=scope(member);
    const uid=d.uid===undefined?ctx.uid:d.uid;
    if(!access.validUid(uid))fail('invalid-argument','מזהה נהג לא תקין.');
    let crew=null,targetCrewAtRead=null;
    if(uid!==ctx.uid){
      if(kind==='self')fail('permission-denied','אין הרשאה לדיווחי נהגים אחרים.');
      const target=await root(ctx.sid).collection('users').doc(uid).get();
      const value=target.exists?target.data():null;
      const targetCrew=value&&(value.crew||value.shift);
      targetCrewAtRead=targetCrew;
      if(!access.activeMember(value,ctx.sid)||!CREWS.includes(targetCrew))fail('permission-denied','הנהג אינו משויך לתחנה.');
      if(kind==='shift'){if(targetCrew!==member.crew)fail('permission-denied','אין גישה למשמרת אחרת.');crew=member.crew;}
    }
    if(d.crew!==undefined){if(!CREWS.includes(d.crew)||kind==='self'||(kind==='shift'&&d.crew!==member.crew))fail('permission-denied','משמרת לא מורשית.');crew=d.crew;}
    let query=reports(ctx.sid).where('uid','==',uid);if(crew)query=query.where('crew','==',crew);
    query=query.orderBy('created_at','desc').orderBy('__name__','desc');
    if(d.cursor!==undefined){const c=d.cursor;if(!c||typeof c!=='object'||Object.keys(c).some(k=>!['at','id'].includes(k))||!id(c.id)||typeof c.at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c.at))fail('invalid-argument','סמן דפדוף לא תקין.');query=query.startAfter(c.at,c.id);}
    const snap=await query.limit(PAGE+1).get();await stable(ctx,member);
    if(uid!==ctx.uid){await db.runTransaction(async tx=>{const fresh=await identity.requireLive(tx,ctx),target=await tx.get(root(ctx.sid).collection('users').doc(uid)),u=target.exists?target.data():null;if(fresh.crew!==member.crew||!access.activeMember(u,ctx.sid)||(u.crew||u.shift)!==targetCrewAtRead)fail('permission-denied','שיוך הנהג השתנה במהלך הטעינה.');});}
    const rows=snap.docs.slice(0,PAGE).map(publicRow),last=rows.at(-1);
    return {rows,next:snap.docs.length>PAGE?{at:last.created_at,id:last.id}:null};
  }
  async function summary(req) {
    const ctx=identity.context(req),d=input(req,['month','crew']);
    if(typeof d.month!=='string'||!/^20\d\d-(0[1-9]|1[0-2])$/.test(d.month))fail('invalid-argument','חודש לא תקין.');
    const member=await live(ctx),kind=scope(member);
    if(kind==='self')fail('permission-denied','דוח מעקב מיועד למפקדי וסגני ראש משמרת.');
    const crew=d.crew===undefined?(kind==='shift'?member.crew:null):d.crew;
    if(crew!==null&&(!CREWS.includes(crew)||(kind==='shift'&&crew!==member.crew)))fail('permission-denied','אין גישה למשמרת אחרת.');
    let rq=reports(ctx.sid).where('local_date','>=',d.month.slice(0,4)+'-01-01').where('local_date','<=',d.month.slice(0,4)+'-12-31');
    if(crew)rq=rq.where('crew','==',crew);
    const [rs,us]=await Promise.all([rq.limit(YEAR_LIMIT+1).get(),root(ctx.sid).collection('users').limit(PEOPLE_LIMIT+1).get()]);
    if(rs.docs.length>YEAR_LIMIT||us.docs.length>PEOPLE_LIMIT)fail('resource-exhausted','הדוח גדול מדי לסיכום מלא; נדרש סיכום מדורג. לא מוצג סיכום חלקי.');
    const roster=new Map();for(const doc of us.docs){const u=doc.data(),c=u.crew||u.shift;if(access.activeMember(u,ctx.sid)&&CREWS.includes(c)&&(!crew||c===crew))roster.set(doc.id,{uid:doc.id,name:u.full_name||'',crew:c,annual:false,hours:0,count:0,today_hours:0,last_at:null});}
    const byCrew=Object.fromEntries(CREWS.map(c=>[c,{hours:0,count:0}]));let hours=0,count=0;const today=israelDate(clock());
    for(const doc of rs.docs){const r=doc.data();if(!CREWS.includes(r.crew)||!Number.isInteger(r.hours)||r.hours<1||r.hours>12)fail('failed-precondition','נמצא דיווח לא תקין. לא חושב סיכום חלקי.');const p=roster.get(r.uid);if(p&&p.crew===r.crew)p.annual=true;if(r.local_date.slice(0,7)!==d.month)continue;hours+=r.hours;count++;byCrew[r.crew].hours+=r.hours;byCrew[r.crew].count++;if(p&&p.crew===r.crew){p.hours+=r.hours;p.count++;if(r.local_date===today)p.today_hours+=r.hours;if(!p.last_at||r.created_at>p.last_at)p.last_at=r.created_at;}}
    await stable(ctx,member);
    return {month:d.month,crew,scope:kind,hours,count,by_crew:byCrew,people:[...roster.values()].sort((a,b)=>a.name.localeCompare(b.name,'he')),note:'הסיכום כולל דיווחים לפי המשמרת בעת יצירתם; רשימת הנהגים מציגה שיוך פעיל נוכחי. דיווח שנתי אינו אישור כשירות.'};
  }
  return {context,save,list,summary};
}
module.exports={createDrivingRefresh,israelDate,PAGE,YEAR_LIMIT,PEOPLE_LIMIT};
