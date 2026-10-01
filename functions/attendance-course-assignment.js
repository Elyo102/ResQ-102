'use strict';
// Server-only payroll evidence reader. Every read participates in the caller's
// HR transaction; this module never writes schedule, attendance or authority.
const {createHash}=require('node:crypto');
const {createOperationalProjection}=require('./schedule-operational-projection');
const C=require('./schedule-month-authority');
const {classify}=require('./schedule-month-authority-control');
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const order=(a,b)=>a<b?-1:a>b?1:0;
// Identical to schedule-runtime's snapshot digest encoding, including missing
// historic optional contract values (encoded as null, never silently omitted).
const stable=v=>Array.isArray(v)?'['+v.map(stable).join(',')+']':plain(v)
  ?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}'
  :JSON.stringify(v===undefined?null:v);
const hash=v=>createHash('sha256').update(stable(v)).digest('hex');
const LABEL='assigned-schedule-at-hr-approval-v2';
const fail=code=>{const e=new Error(code);e.code='failed-precondition';throw e;};
const date=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail('Invalid course source date');return value;};
const timestamp=s=>{
  const t=s.updateTime;
  if(!t||!Number.isSafeInteger(t.seconds)||!Number.isInteger(t.nanoseconds)||t.nanoseconds<0||t.nanoseconds>=1e9)fail('Unversioned course source');
  return {seconds:t.seconds,nanoseconds:t.nanoseconds};
};
function createCourseAssignmentReader({db}){
  if(!db||typeof db.collection!=='function')throw new TypeError('Course source database required');
  return async function readCourseAssignmentBasis(tx,{sid,uid,from,to,crew,role}){
    C.id(sid);date(from);date(to);
    if(typeof uid!=='string'||!uid||/[\u0000-\u001f\u007f/]/.test(uid)||typeof crew!=='string'||!crew||typeof role!=='string')fail('Invalid course source identity');
    const dates=[];
    for(let day=Date.parse(from+'T00:00Z');day<=Date.parse(to+'T00:00Z');day+=86400000){dates.push(new Date(day).toISOString().slice(0,10));if(dates.length>400)fail('Course source range exceeds limit');}
    if(!dates.length)fail('Invalid course source range');
    const root=db.collection('stations').doc(sid),evidence=[],publications=new Map();let readCount=0,byteCount=0;
    function record(s){
      if(++readCount>5000)fail('Course source read limit exceeded');
      if(!s.exists){evidence.push({path:s.ref.path,exists:false});return null;}
      const value=s.data();byteCount+=Buffer.byteLength(stable(value));if(byteCount>4*1024*1024)fail('Course source byte limit exceeded');
      evidence.push({path:s.ref.path,version:timestamp(s),digest:hash(value)});return value;
    }
    const get=async ref=>{const snap=await tx.get(ref);return {snap,value:record(snap)};};
    async function query(ref,limit){const q=await tx.get(ref.limit(limit+1));if(!q||!Array.isArray(q.docs)||q.docs.length>limit)fail('Course source collection exceeds limit');return q.docs.map(s=>({id:s.id,value:record(s)}));}
    const state=root.collection('schedule_state');
    const runtime=(await get(state.doc('runtime'))).value;
    if(runtime!==null&&(!plain(runtime)||!['off','shadow','new'].includes(runtime.mode)))fail('Unknown course schedule mode');
    const mode=runtime===null?'off':runtime.mode;
    const authority=(await get(state.doc('publication_authority'))).value;
    const control=(await get(state.doc('publication_authority_control'))).value;
    const selection=classify(sid,authority,control);
    const rotations=await query(root.collection('rotations'),20);
    const active=rotations.filter(r=>plain(r.value)&&r.value.is_active!==false);
    if(!active.length)fail('Official course standard unavailable');
    const field=role==='commander'?'commander_shift_hours':'shift_hours';
    function standard(assignedCrew){
      const applicable=active.filter(r=>r.value.crew===assignedCrew);
      if(!applicable.length)fail('Official course crew standard unavailable');
      const values=applicable.map(r=>{
        const v=r.value[field];if(!['number','string'].includes(typeof v)||String(v).trim()==='')fail('Official course hours missing');
        const n=Number(v);if(!Number.isFinite(n)||n<=0||n>48||!Number.isInteger(n*60))fail('Official course hours invalid');return n;
      });
      if(values.some(v=>v!==values[0]))fail('Ambiguous official course hours');
      return values[0];
    }
    const days=[];
    if(mode==='off'||(mode==='shadow'&&selection.mode==='compatibility'&&!(await get(state.doc('active'))).value?.publication_id)){
      const people=await query(root.collection('roster'),1000);
      const roster=people.map(({id,value:v})=>{
        if(!plain(v)||['stationId','station_id','station'].some(k=>v[k]!==undefined&&v[k]!==null&&v[k]!==''&&v[k]!==sid))fail('Invalid course roster station');
        return {id,station_id:sid,full_name:v.full_name,name:v.name,crew:v.crew,active:v.active,is_active:v.is_active};
      });
      const person=roster.find(r=>r.id===uid);if(!person||person.crew!==crew||person.active===false||person.is_active===false)fail('Course roster binding unavailable');
      const overrides={},swaps=new Map();
      for(const date of dates){const v=(await get(root.collection('shift_overrides').doc(date))).value;if(v!==null){if(!plain(v)||(v.date!==undefined&&v.date!==null&&v.date!==''&&v.date!==date))fail('Course override date mismatch');overrides[date]={...v,date};}}
      for(let i=0;i<dates.length;i+=30)for(const field of ['from_date','to_date']){
        const rows=await query(root.collection('swaps').where(field,'in',dates.slice(i,i+30)),2000);
        for(const row of rows)swaps.set(row.id,row.value);if(swaps.size>2000)fail('Course swap limit exceeded');
      }
      const projection=createOperationalProjection({source:'legacy',station_id:sid,roster,legacy:{rotations:rotations.map(r=>r.value),overrides,swaps:[...swaps].sort(([a],[b])=>order(a,b)).map(([,v])=>v)}});
      for(let i=0;i<dates.length;i+=93){const window=projection.stationWindow({from:dates[i],to:dates[Math.min(i+92,dates.length-1)]});
        for(const day of window.days){if(day.anomaly_codes?.length)fail('Ambiguous course assignment');const assigned=day.assignments.find(p=>p.uid===uid);if(assigned)days.push({date:day.date,credit_hours:standard(assigned.crew)});}}
    }else{
      async function publication(owner){
        if(!owner||owner.state==='unowned')fail('Course publication coverage unavailable');
        C.id(owner.publication_id);
        let result=publications.get(owner.publication_id);
        if(!result){
          const ref=root.collection('schedule_publications').doc(owner.publication_id),meta=(await get(ref)).value;
          if(!plain(meta)||meta.station_id!==sid||meta.status!=='active'||meta.snapshot_complete!==true||!Number.isSafeInteger(meta.revision)||meta.revision<1||!/^[a-f0-9]{64}$/.test(meta.content_digest||''))fail('Course publication unavailable');
          date(meta.from);date(meta.to);
          const rows=(await query(ref.collection('rows'),2000)).map(r=>r.value.row).sort((a,b)=>order(a.date+'|'+a.sub_station,b.date+'|'+b.sub_station));
          const events=(await query(ref.collection('events'),1000)).map(r=>r.value).sort((a,b)=>order(a.id,b.id));
          const people=(await query(ref.collection('people'),1000)).map(r=>r.value).sort((a,b)=>order(a.id,b.id));
          const seenAbsences=new Set();
          const absences=(await query(ref.collection('absences'),400)).flatMap(r=>{if(!Array.isArray(r.value.entries))fail('Invalid course absence snapshot');return r.value.entries;}).map(a=>{
            if(!plain(a)||typeof a.uid!=='string'||!a.uid||!['sick','reserve','course','leave','unknown'].includes(a.kind))fail('Invalid course absence');date(a.date);
            const value={date:a.date,uid:a.uid,kind:a.kind};
            if(a.location!==undefined&&a.location!==null){if(a.kind!=='leave'||!['abroad','north','eilat'].includes(a.location))fail('Invalid course absence location');value.location=a.location;}
            const key=JSON.stringify([value.date,value.uid,value.kind,value.location||'']);if(seenAbsences.has(key))fail('Duplicate course absence');seenAbsences.add(key);return value;
          }).sort((a,b)=>order(a.date,b.date)||order(a.uid,b.uid)||order(a.kind,b.kind));
          if(rows.length!==meta.row_count||events.length!==meta.event_count||people.length!==Number(meta.person_count||0)||absences.length!==Number(meta.absence_count||0))fail('Incomplete course snapshot');
          const contract=Object.fromEntries(['station_id','source_snapshot','source_version','source_revision','source_digest','policy_version','policy_digest','source_complete'].map(k=>[k,meta[k]]));
          contract.source_complete=meta.source_complete===true;
          const basis={contract,rows,events,people};if(absences.length)basis.absences=absences;
          if(meta.absence_coverage!==undefined&&meta.absence_coverage!==null){
            const coverage=meta.absence_coverage,keys=['course','leave','reserve','sick'];
            if(!plain(coverage)||stable(Object.keys(coverage).sort())!==stable(keys)||keys.some(k=>!['ready','missing'].includes(coverage[k])))fail('Invalid course absence coverage');
            basis.absence_coverage=coverage;
          }
          if(meta.affected_months){basis.affected_months=meta.affected_months;basis.month_edit_base=meta.month_edit_base;}
          if(hash(basis)!==meta.content_digest)fail('Course snapshot digest mismatch');
          const employee=people.find(p=>p.id===uid);
          if(!employee||employee.active===false||employee.is_active===false||employee.crew!==crew)fail('Course snapshot employee binding unavailable');
          const plan={...contract,kind:'schedule-plan',from:meta.from,to:meta.to,rows};
          result={meta,absences,projection:createOperationalProjection({source:'v2',station_id:sid,roster:people,plan})};publications.set(owner.publication_id,result);
        }
        if(result.meta.revision!==owner.revision||result.meta.content_digest!==owner.content_digest)fail('Course publication pointer mismatch');
        return result;
      }
      const owners={};
      if(selection.mode==='monthly'){
        for(const month of [...new Set(dates.map(d=>d.slice(0,7)))]){const raw=(await get(root.collection('schedule_publication_months').doc(month))).value;if(!raw)fail('Missing course month owner');owners[month]=C.entry(raw,sid,month);}
      }else{
        const pointer=(await get(state.doc('active'))).value;if(!plain(pointer)||!pointer.publication_id)fail('Missing course publication');
        for(const month of [...new Set(dates.map(d=>d.slice(0,7)))])owners[month]=pointer;
      }
      for(const day of dates){const owner=owners[day.slice(0,7)],p=await publication(owner);
        if(selection.mode==='monthly'){
          const expected=C.publicationOwners({station_id:sid,publication_id:owner.publication_id,revision:p.meta.revision,content_digest:p.meta.content_digest,from:p.meta.from,to:p.meta.to},sid)[day.slice(0,7)];
          if(expected&&owner.activation_id!==undefined)expected.activation_id=owner.activation_id;
          if(stable(expected)!==stable(owner)||day<owner.coverage_from||day>owner.coverage_to)fail('Course month coverage mismatch');
        }
        if(day<p.meta.from||day>p.meta.to)fail('Course range outside publication');
        const assignment=p.projection.stationWindow({from:day,to:day}).days[0].assignments.find(p=>p.uid===uid);
        if(!assignment){if(p.absences.some(a=>a.uid===uid&&a.date===day&&a.kind==='course'))fail('Original course assignment unavailable');continue;}
        // The employee's live, transaction-bound crew is the explicit binding
        // for official standards; the slot proves work, never guessed hours.
        days.push({date:day,credit_hours:standard(crew)});
      }
    }
    const source={schema:'course-assignment-basis-v2',mode,authority_mode:selection.mode,crew,role,from,to,
      documents:evidence.sort((a,b)=>order(a.path,b.path)),assigned_dates:days.map(d=>d.date)};
    if(Buffer.byteLength(stable(source))>256*1024)fail('Course source proof exceeds limit');
    return {source_label:LABEL,days,source};
  };
}
module.exports=Object.freeze({createCourseAssignmentReader,LABEL});
