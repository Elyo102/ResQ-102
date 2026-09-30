'use strict';
const {createHash}=require('node:crypto');
const {createOperationalProjection,SOURCE}=require('./schedule-operational-projection');
const {createOpsMemberIdentity,MEMBER_ROLES}=require('./ops-member-identity');
const access=require('./schedule-access');
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
// Firestore maps may return in a different key order; arrays retain day order.
const canonical=v=>Array.isArray(v)?v.map(canonical):plain(v)
  ?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const stamp=v=>v&&Number.isSafeInteger(v.seconds)&&Number.isInteger(v.nanoseconds)&&v.nanoseconds>=0&&v.nanoseconds<1e9
  ?{seconds:v.seconds,nanoseconds:v.nanoseconds}:null;
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00Z'))&&new Date(v+'T00:00Z').toISOString().slice(0,10)===v;
const validMonth=v=>typeof v==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const validEmp=v=>typeof v==='string'&&v.length>0&&v.length<=64&&!/[\u0000-\u001f\u007f/]/.test(v);
const KEY=/^[a-f0-9]{64}$/;
const MAX_PERIODS=32;
function createCourseCreditService({db,auth,HttpsError,clock=Date.now}){
  const fail=(code,message)=>{throw new HttpsError(code,message);};
  const identity=createOpsMemberIdentity({db,HttpsError});
  const root=sid=>db.collection('stations').doc(sid);
  const creditRef=(sid,emp,month)=>root(sid).collection('attendance_course_credits').doc(emp+'_'+month);
  function range(from,to){
    if(!date(from)||!date(to)||to<from)fail('failed-precondition','Invalid course period.');
    const result=[];
    for(let at=Date.parse(from+'T00:00Z'),end=Date.parse(to+'T00:00Z');at<=end;at+=86400000){
      result.push(new Date(at).toISOString().slice(0,10));
      if(result.length>400)fail('resource-exhausted','Course period exceeds 400 days.');
    }
    return result;
  }
  function hours(value){
    if(!['number','string'].includes(typeof value)||value==='')fail('failed-precondition','Official course shift hours are missing.');
    const n=Number(value);
    if(!Number.isFinite(n)||n<=0||n>48||!Number.isInteger(n*60))fail('failed-precondition','Official course shift hours are invalid.');
    return n;
  }
  async function employee(tx,sid,uid,allowInactive=false){
    if(!access.validUid(uid))fail('invalid-argument','Invalid employee.');
    const snap=await tx.get(root(sid).collection('users').doc(uid)),p=snap.exists?snap.data():null;
    if(!plain(p)||!access.liveStation(p).ok||access.liveStation(p).stationId!==sid||!MEMBER_ROLES.includes(p.role)
      ||(p.uid!==undefined&&p.uid!==uid)||['active','is_active'].some(k=>p[k]!==undefined&&typeof p[k]!=='boolean'))fail('failed-precondition','Course employee unavailable.');
    const inactive=p.active===false||p.is_active===false;
    if(inactive&&!allowInactive)fail('failed-precondition','Active course employee required.');
    const emp=typeof p.employee_number==='string'||(typeof p.employee_number==='number'&&Number.isFinite(p.employee_number))?String(p.employee_number):'';
    if(!validEmp(emp))fail('failed-precondition','Employee number unavailable.');
    if(!inactive){const i=await tx.get(db.collection('emp_index').doc(emp)),d=await tx.get(db.collection('directory').doc(uid));
    const iv=i.exists?i.data():null,dv=d.exists?d.data():null;
    if(!plain(iv)||iv.uid!==uid||iv.stationId!==sid||iv.active===false||iv.retired===true||iv.status==='retired'
      ||!plain(dv)||!access.activeMember(dv,sid)||(dv.uid!==undefined&&dv.uid!==uid)
      ||(dv.employee_number!==undefined&&String(dv.employee_number)!==emp))fail('failed-precondition','Employee binding changed.');}
    const version=stamp(snap.updateTime);if(!version)fail('failed-precondition','Versioned employee binding required.');
    return {profile:p,emp,version};
  }
  function validateSnapshot(s,uid,emp){
    if(!plain(s)||s.schema!=='course-credit-v1'||s.owner_uid!==uid||s.employee_number!==emp
      ||!Number.isSafeInteger(s.approval_revision)||s.approval_revision<1||!KEY.test(s.source_digest||'')
      ||s.source_label!=='original-crew-cycle-at-hr-approval'||!Array.isArray(s.days)||s.days.length>400
      ||typeof s.crew!=='string'||typeof s.role!=='string'||!plain(s.source)||hash(s.source)!==s.source_digest)fail('failed-precondition','Course approval snapshot unavailable.');
    const dates=range(s.from_date,s.to_date),seen=new Set();let total=0;
    for(const item of s.days){
      if(!plain(item)||!dates.includes(item.date)||seen.has(item.date))fail('failed-precondition','Course credit dates invalid.');
      seen.add(item.date);total+=hours(item.credit_hours);
    }
    if(s.total_hours!==Math.round(total*100)/100)fail('failed-precondition','Course credit total invalid.');
    return s;
  }
  function empty(uid,emp,month){return {schema:'attendance-course-month-v1',owner_uid:uid,employee_number:emp,month,revision:0,days:{},periods:{}};}
  async function readCourseMonth(tx,{sid,uid,emp,month}){
    if(!access.validId(sid)||!access.validUid(uid)||!validEmp(emp)||!validMonth(month))fail('invalid-argument','Invalid course month identity.');
    const snap=await tx.get(creditRef(sid,emp,month));
    if(!snap.exists)return empty(uid,emp,month);
    const d=snap.data();
    if(!plain(d)||d.schema!=='attendance-course-month-v1'||d.owner_uid!==uid||d.employee_number!==emp||d.month!==month
      ||!Number.isSafeInteger(d.revision)||d.revision<1||!plain(d.days)||!plain(d.periods)||Object.keys(d.periods).length>MAX_PERIODS)fail('failed-precondition','Course month index unavailable.');
    const expected={};
    for(const [id,s]of Object.entries(d.periods)){
      if(!KEY.test(id))fail('failed-precondition','Invalid course case identity.');validateSnapshot(s,uid,emp);
      if(month<s.from_date.slice(0,7)||month>s.to_date.slice(0,7))fail('failed-precondition','Course period is outside month.');
      const request=await tx.get(root(sid).collection('hr_requests').doc(id)),approved=request.exists?request.data():null;
      if(!plain(approved)||approved.schema!=='hr-request-v1'||approved.case_id!==id||approved.station_id!==sid
        ||approved.owner_uid!==uid||approved.kind!=='course'||approved.decision!=='approved'
        ||!plain(approved.course_snapshot)||hash(approved.course_snapshot)!==hash(s))fail('failed-precondition','Course index approval is stale.');
      for(const item of s.days.filter(x=>x.date.startsWith(month+'-'))){
        if(expected[item.date])fail('failed-precondition','Conflicting course approvals.');
        expected[item.date]={case_id:id,approval_revision:s.approval_revision,credit_hours:item.credit_hours};
      }
    }
    if(Object.keys(d.days).length!==Object.keys(expected).length||Object.entries(expected).some(([date,value])=>{
      const actual=d.days[date];return !plain(actual)||Object.keys(actual).sort().join(',')!=='approval_revision,case_id,credit_hours'
        ||actual.case_id!==value.case_id||actual.approval_revision!==value.approval_revision||actual.credit_hours!==value.credit_hours;
    }))fail('failed-precondition','Course index does not match approvals.');
    return d;
  }
  async function buildSnapshot(tx,{sid,owner_uid,from_date,to_date,nextRevision},person){
    const dates=range(from_date,to_date),query=await tx.get(root(sid).collection('rotations').limit(21));
    if(!query||!Array.isArray(query.docs)||query.docs.length>20)fail('resource-exhausted','Course rotation coverage unavailable.');
    const rows=query.docs.map(s=>({id:s.id,value:s.data(),version:stamp(s.updateTime)})).sort((a,b)=>a.id.localeCompare(b.id));
    if(rows.some(r=>!plain(r.value)||!r.version))fail('failed-precondition','Versioned course cycle unavailable.');
    const crew=typeof person.profile.crew==='string'?person.profile.crew:person.profile.shift;
    const role=person.profile.role;
    if(typeof crew!=='string'||!crew||typeof role!=='string')fail('failed-precondition','Original employee crew unavailable.');
    let projection;
    try{projection=createOperationalProjection({source:SOURCE.LEGACY,station_id:sid,
      roster:[{uid:owner_uid,crew,active:true}],legacy:{rotations:rows.map(r=>({id:r.id,...r.value})),overrides:[],approved_swaps:[]}});}
    catch(_){fail('failed-precondition','Original course cycle is incomplete or ambiguous.');}
    const active=rows.filter(r=>r.value.is_active!==false),anchor=active[0].value.anchor_date,cycle=active[0].value.cycle_days;
    const days=[];
    for(const day of dates){
      if(!projection.isPersonWorking(owner_uid,day))continue;
      const ordinal=Math.round((Date.parse(day+'T00:00Z')-Date.parse(anchor+'T00:00Z'))/86400000),position=((ordinal%cycle)+cycle)%cycle;
      const selected=active.find(r=>r.value.position_in_cycle===position);
      if(!selected||selected.value.crew!==crew)fail('failed-precondition','Original course day cannot be resolved.');
      days.push({date:day,credit_hours:hours(selected.value[role==='commander'?'commander_shift_hours':'shift_hours'])});
    }
    const source=canonical({employee_version:person.version,crew,role,rotations:rows.map(r=>({id:r.id,version:r.version,
      crew:r.value.crew,anchor_date:r.value.anchor_date,cycle_days:r.value.cycle_days,position_in_cycle:r.value.position_in_cycle,
      is_active:r.value.is_active!==false,shift_hours:r.value.shift_hours,commander_shift_hours:r.value.commander_shift_hours}))});
    return {schema:'course-credit-v1',approval_revision:nextRevision,from_date,to_date,owner_uid,employee_number:person.emp,crew,role,days,
      total_hours:Math.round(days.reduce((n,d)=>n+d.credit_hours,0)*100)/100,source_label:'original-crew-cycle-at-hr-approval',source_digest:hash(source),source};
  }
  async function prepareDecision(tx,{ctx,caseBefore,decision,nextRevision}){
    if(!ctx||(!ctx.super&&ctx.role!=='hr_coordinator')||!plain(caseBefore)||caseBefore.kind!=='course'
      ||caseBefore.station_id!==ctx.sid||caseBefore.owner_uid===ctx.uid||!KEY.test(caseBefore.case_id||'')
      ||!['approved','rejected'].includes(decision)||!Number.isSafeInteger(nextRevision)||nextRevision!==caseBefore.revision+1)fail('permission-denied','Course HR approval authority required.');
    const person=await employee(tx,ctx.sid,caseBefore.owner_uid,decision==='rejected'),dates=range(caseBefore.from_date,caseBefore.to_date);
    const snapshot=decision==='approved'?await buildSnapshot(tx,{sid:ctx.sid,owner_uid:caseBefore.owner_uid,
      from_date:caseBefore.from_date,to_date:caseBefore.to_date,nextRevision},person):null;
    if(snapshot)for(const item of snapshot.days){
      const snap=await tx.get(root(ctx.sid).collection('attendance').doc(person.emp+'_'+item.date));
      if(snap.exists){const row=snap.data();if(!plain(row)||row.uid!==caseBefore.owner_uid||String(row.emp_number)!==person.emp
        ||row.date!==item.date||row.month!==item.date.slice(0,7)||row.day_type!=='regular'||row.status!=='draft')
          fail('failed-precondition','Course credit conflicts with existing attendance; HR must resolve it first.');}
    }
    const months=[...new Set(dates.map(d=>d.slice(0,7)))];if(months.length>15)fail('resource-exhausted','Course month limit exceeded.');
    const changes=[];
    for(const month of months){
      const current=await readCourseMonth(tx,{sid:ctx.sid,uid:caseBefore.owner_uid,emp:person.emp,month});
      const reportSnap=await tx.get(root(ctx.sid).collection('monthly_reports').doc(person.emp+'_'+month));
      if(reportSnap.exists){const report=reportSnap.data();if(!plain(report)||report.status!=='draft'||report.month!==month
        ||String(report.emp_number)!==person.emp||(report.uid!==undefined&&report.uid!==caseBefore.owner_uid))fail('failed-precondition','Reopen the monthly report before changing course credit.');}
      const periods={...current.periods};delete periods[caseBefore.case_id];if(snapshot)periods[caseBefore.case_id]=snapshot;
      if(Object.keys(periods).length>MAX_PERIODS)fail('resource-exhausted','Too many course periods in one month.');
      const days={};
      for(const [id,s]of Object.entries(periods))for(const item of s.days.filter(d=>d.date.startsWith(month+'-'))){
        if(days[item.date])fail('failed-precondition','Approved course periods overlap a paid shift.');
        days[item.date]={case_id:id,approval_revision:s.approval_revision,credit_hours:item.credit_hours};
      }
      if(!Number.isSafeInteger(current.revision+1))fail('failed-precondition','Course revision overflow.');
      changes.push({ref:creditRef(ctx.sid,person.emp,month),value:{...current,revision:current.revision+1,days,periods}});
    }
    let committed=false;
    return Object.freeze({snapshot,commit(currentTx,at){
      if(currentTx!==tx||committed||!Number.isSafeInteger(at)||at<0)fail('failed-precondition','Invalid course approval transaction.');
      committed=true;for(const change of changes)tx.set(change.ref,{...change.value,updated_at_ms:at});
    }});
  }
  async function context(req){
    const ctx=identity.context(req),d=req.data,authTime=req.auth.token.auth_time;
    if(!plain(d)||Object.keys(d).sort().join(',')!=='month,target_uid'||!validMonth(d.month)
      ||!access.validUid(d.target_uid)||(!ctx.super&&ctx.role!=='hr_coordinator'&&ctx.uid!==d.target_uid))fail('permission-denied','Course view authority required.');
    if(!Number.isSafeInteger(authTime)||authTime<0)fail('unauthenticated','Refresh sign-in.');
    async function live(tx){
      let u;try{u=await auth.getUser(ctx.uid);}catch(_){fail('unavailable','Current authentication unavailable.');}
      const c=u?.customClaims;
      if(!u||u.uid!==ctx.uid||u.disabled===true||!plain(c)||c.stationId!==ctx.sid||(c.super===true)!==ctx.super||(!ctx.super&&c.role!==ctx.role))fail('permission-denied','Course authority changed.');
      if(u.tokensValidAfterTime!==undefined){const at=Date.parse(u.tokensValidAfterTime);if(!Number.isFinite(at)||authTime*1000<at)fail('permission-denied','Sign-in revoked.');}
      await identity.requireLive(tx,ctx);
    }
    return db.runTransaction(async tx=>{
      await live(tx);const person=await employee(tx,ctx.sid,d.target_uid,ctx.super||ctx.role==='hr_coordinator'),month=await readCourseMonth(tx,{sid:ctx.sid,uid:d.target_uid,emp:person.emp,month:d.month});
      await live(tx);return {month:d.month,owner_uid:d.target_uid,revision:month.revision,
        periods:Object.entries(month.periods).map(([case_id,s])=>({case_id,...s})),
        epoch:{uid:ctx.uid,station_id:ctx.sid,auth_time:authTime,claims_digest:hash([ctx.uid,ctx.sid,ctx.role||'',ctx.super===true])}};
    });
  }
  return Object.freeze({prepareDecision,readCourseMonth,context});
}
module.exports=Object.freeze({createCourseCreditService});
