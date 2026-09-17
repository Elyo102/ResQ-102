'use strict';

// Server-only evidence readers. Never activates a station, links a person,
// assigns a role, or sends notifications. Capability readers must inspect the
// actual configured integrations; provision seed flags are not capabilities.
const { stableHash } = require('./identity-coordinator');
const own = (v,k) => !!v && Object.prototype.hasOwnProperty.call(v,k);
const plain = v => !!v && typeof v === 'object' && [Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact = (v,keys) => plain(v) && keys.every(k=>own(v,k)) && Object.keys(v).every(k=>keys.includes(k));
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const sidValid = v => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(v);
const requestValid = v => typeof v === 'string' && /^[A-Za-z0-9_-]{8,120}$/.test(v);
const hashValid = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const email = v => typeof v==='string'?v.normalize('NFC').trim().toLowerCase():'';
const millis = v => v instanceof Date?v.getTime():v && typeof v.toMillis==='function'?v.toMillis():NaN;
function fail(reason){const e=new Error('Onboarding station gate: '+reason);e.code='failed-precondition';e.reason=reason;throw e;}
function createOnboardingStationGates({db,auth,personContract,invitations,knownDistricts,builtins={},readBackupCapability,readHealthCapability,readSilenceCapability}={}){
  if(!db || typeof auth?.getUser!=='function' || typeof personContract?.normalizeSchedulePerson!=='function'
    || typeof invitations?.verifyStoredFingerprint!=='function' || !Array.isArray(knownDistricts) || !knownDistricts.length
    || !plain(builtins) || [readBackupCapability,readHealthCapability,readSilenceCapability].some(f=>typeof f!=='function')) throw new TypeError('Station gate evidence dependencies required');
  const districts=new Set(knownDistricts);
  const get=async(tx,path)=>{const s=await tx.get(db.doc(path));return s.exists?s.data():null;};
  async function actorLive(actor){
    if(!id(actor?.uid))fail('actor');const a=await auth.getUser(actor.uid);
    if(!a || a.uid!==actor.uid || a.disabled!==false || a.customClaims?.super!==true)fail('actor');
  }
  function stationShape(station,sid,district){
    if(!plain(station) || (own(station,'station_id') && station.station_id!==sid) || station.archived===true || (own(station,'archived') && typeof station.archived!=='boolean')
      || typeof station.active!=='boolean' || station.districtId!==district || !districts.has(district)
      || (own(station,'silent') && typeof station.silent!=='boolean'))fail('station');
    const provisioned=own(station,'template_id') || own(station,'provision_request_id');
    if(provisioned && (station.template_id!=='fire-station-v1' || station.schema_version!==1 || station.station_id!==sid
      || !requestValid(station.provision_request_id) || typeof station.silent!=='boolean'
      || !['provisioning','ready'].includes(station.status)))fail('provision-state');
    if(!provisioned && own(station,'status') && !['ready','active'].includes(station.status))fail('station-status');
    return provisioned;
  }
  async function provisioning(tx,sid,station){
    const p=await get(tx,'stations/'+sid+'/provision_operations/'+station.provision_request_id);
    const intent=p?.first_admin_invitation_intent, association=p?.first_admin_invitation;
    if(!plain(p) || p.schema_version!==1 || p.station_id!==sid || p.request_id!==station.provision_request_id || !hashValid(p.fingerprint)
      || !id(p.actor_uid) || !exact(intent,['station_id','district_id','role','issued_by','provision_request_id'])
      || intent.station_id!==sid || intent.district_id!==station.districtId || intent.role!=='commander' || intent.issued_by!==p.actor_uid
      || intent.provision_request_id!==p.request_id || !exact(association,['schema_version','station_id','provision_request_id','invite_id','invite_fingerprint'])
      || association.schema_version!==1 || association.station_id!==sid || association.provision_request_id!==p.request_id
      || !id(association.invite_id) || !hashValid(association.invite_fingerprint))fail('first-admin-association');
    const invite=await get(tx,'invitations/'+association.invite_id);
    if(!plain(invite) || invite.invite_id!==association.invite_id || invite.station_id!==sid || invite.district_id!==intent.district_id
      || invite.role!==intent.role || invite.issued_by!==intent.issued_by || invite.revoked_at)fail('first-admin-invite');
    invitations.verifyStoredFingerprint(invite,association.invite_fingerprint);
    return{p,intent,association,invite};
  }
  async function boundFirstAdmin(tx,sid,station,uid,assignment){
    const b=await provisioning(tx,sid,station);
    const registry=await get(tx,'onboarding_assignment_links/'+uid);
    if(!exact(registry,['schema_version','uid','station_id','request_id','invite_id','operation_fingerprint']) || registry.schema_version!==1
      || registry.uid!==uid || registry.station_id!==sid || registry.invite_id!==b.association.invite_id || !requestValid(registry.request_id)
      || !hashValid(registry.operation_fingerprint) || b.invite.redeemed_by!==uid || b.invite.redeemed_request_id!==registry.request_id)fail('first-admin-redemption');
    const op=await get(tx,'stations/'+sid+'/onboarding_operations/'+registry.request_id), link=op?.assignment_ref;
    if(!plain(op) || op.schema_version!==1 || ['uid','station_id','request_id','invite_id','operation_fingerprint'].some(k=>op[k]!==registry[k])
      || !['request_created','assignment_completed'].includes(op.stage) || !plain(link) || link.uid!==uid || link.station_id!==sid
      || link.invite_id!==registry.invite_id || link.invite_fingerprint!==b.association.invite_fingerprint || link.registration_request_id!==registry.request_id
      || assignment.role!==b.intent.role || assignment.districtId!==b.intent.district_id || assignment.shift!==b.invite.shift
      || link.role!==assignment.role || link.district_id!==assignment.districtId || link.shift!==assignment.shift
      || own(assignment,'person_id')!==own(link,'person_id') || (own(link,'person_id') && assignment.person_id!==link.person_id))fail('first-admin-link');
    return{...b,registry,op};
  }
  async function optionalPerson(tx,uid,assignment){
    if(!own(assignment,'person_id'))return;
    if(typeof assignment.person_id!=='string' || !/^sp_[a-z0-9][a-z0-9_-]{7,63}$/.test(assignment.person_id))fail('person-id');
    const raw=await get(tx,'stations/'+assignment.stationId+'/schedule_people/'+assignment.person_id);
    const person=personContract.normalizeSchedulePerson(raw);
    if(person.person_id!==assignment.person_id || person.station_id!==assignment.stationId || person.active!==true
      || (person.linked_uid!==null && person.linked_uid!==uid))fail('person-binding');
  }
  async function requireStationPerson({tx,uid,assignment,actor}){
    if(!tx || typeof tx.get!=='function' || !id(uid) || !plain(assignment) || !sidValid(assignment.stationId)
      || !districts.has(assignment.districtId))fail('input');
    await actorLive(actor);
    const sid=assignment.stationId;const stored=await get(tx,'stations/'+sid);
    const station=stored===null && own(builtins,sid)?builtins[sid]:stored;
    const provisioned=stationShape(station,sid,assignment.districtId);
    if(station.active!==true || (provisioned && station.status!=='ready')){
      if(!provisioned || station.active!==false || station.status!=='provisioning' || station.silent!==true)fail('station-inactive');
      await boundFirstAdmin(tx,sid,station,uid,assignment);
    }
    await optionalPerson(tx,uid,assignment);
    await actorLive(actor);
    return true;
  }
  async function verifyReadiness({tx,station_id:sid,station,actor_uid}){
    if(!sidValid(sid) || !tx || typeof tx.get!=='function')fail('input');
    await actorLive({uid:actor_uid});
    const current=await get(tx,'stations/'+sid);
    if(!current || current.provision_request_id!==station?.provision_request_id)fail('station-changed');
    stationShape(current,sid,current.districtId);
    if(!own(current,'provision_request_id'))fail('not-provisioned');
    const hr=await get(tx,'stations/'+sid+'/config/hr');
    const checks={station_document:true,hr_config_seeded:plain(hr) && hr.schema_version===1 && hr.seeded_by_request===current.provision_request_id
      && own(hr,'email') && own(hr,'name') && own(hr,'hour_limit') && (hr.email===null || typeof hr.email==='string')
      && (hr.name===null || typeof hr.name==='string') && (hr.hour_limit===null || (Number.isFinite(hr.hour_limit) && hr.hour_limit>0)),
      backup_registered:false,health_inventory_registered:false,first_admin_active:false,silence_wired:false};
    try{
      const initial=await provisioning(tx,sid,current), uid=initial.invite.redeemed_by;
      if(!id(uid))fail('first-admin-unredeemed');
      const assignment={stationId:sid,districtId:current.districtId,role:initial.intent.role,shift:initial.invite.shift,
        ...(own(initial.invite,'person_id')?{person_id:initial.invite.person_id}:{})};
      const b=await boundFirstAdmin(tx,sid,current,uid,assignment), user=await auth.getUser(uid), claims=user?.customClaims;
      if(!user || user.uid!==uid || user.disabled!==false || user.emailVerified!==true || !plain(claims)
        || !email(user.email) || (email(initial.invite.email) && email(initial.invite.email)!==email(user.email))
        || !Number.isFinite(millis(initial.invite.approved_at))
        || ['stationId','districtId','role','shift'].some(k=>claims[k]!==assignment[k]) || !id(String(claims.emp||''))
        || b.op.stage!=='assignment_completed' || !id(b.op.identity_operation_id)
        || initial.invite.approved_identity_operation_id!==b.op.identity_operation_id)fail('first-admin-not-complete');
      const completed=await get(tx,'identity_operations/'+uid), link=b.op.assignment_ref;
      const source={schema_version:1,uid,registry_path:'onboarding_assignment_links/'+uid,
        operation_path:'stations/'+sid+'/onboarding_operations/'+b.registry.request_id,
        invite_id:b.registry.invite_id,request_id:b.registry.request_id,operation_fingerprint:b.registry.operation_fingerprint,
        invite_fingerprint:link.invite_fingerprint,registration_fingerprint:link.registration_fingerprint};
      const fingerprint=stableHash({assignment,source}), expected={assignment,source,fingerprint};
      if(!plain(completed) || completed.status!=='completed' || completed.target_uid!==uid || completed.op_id!==b.op.identity_operation_id
        || !id(completed.actor_uid) || completed.actor_uid!==initial.invite.approved_by || completed.request_id!==b.registry.request_id
        || !hashValid(link.registration_fingerprint) || !exact(completed.onboarding_authority,['assignment','source','fingerprint'])
        || stableHash(completed.onboarding_authority)!==stableHash(expected)
        || initial.invite.approved_source_fingerprint!==fingerprint)fail('first-admin-completion-receipt');
      const profile=await get(tx,'stations/'+sid+'/users/'+uid), roster=await get(tx,'stations/'+sid+'/roster/'+uid), directory=await get(tx,'directory/'+uid), index=await get(tx,'emp_index/'+claims.emp);
      if(!plain(profile) || profile.stationId!==sid || profile.districtId!==assignment.districtId || profile.role!==assignment.role
        || profile.crew!==assignment.shift || profile.active!==true || profile.is_active!==true || String(profile.employee_number)!==String(claims.emp)
        || !plain(roster) || roster.active!==true || roster.is_active!==true || roster.role!==assignment.role || roster.crew!==assignment.shift
        || !plain(directory) || directory.station!==sid || directory.district!==assignment.districtId || directory.active!==true || directory.is_active!==true
        || directory.role!==assignment.role || directory.crew!==assignment.shift || directory.retired===true
        || !plain(index) || index.uid!==uid || index.stationId!==sid || index.active!==true || index.retired===true)fail('first-admin-profile');
      await optionalPerson(tx,uid,assignment);checks.first_admin_active=true;
    }catch(_){checks.first_admin_active=false;}
    for(const[key,reader]of [['backup_registered',readBackupCapability],['health_inventory_registered',readHealthCapability],['silence_wired',readSilenceCapability]]){
      try{checks[key]=(await reader({tx,station_id:sid,station:current}))===true;}catch(_){checks[key]=false;}
    }
    await actorLive({uid:actor_uid});
    return Object.freeze(checks);
  }
  return Object.freeze({requireStationPerson,verifyReadiness});
}
module.exports={createOnboardingStationGates};
