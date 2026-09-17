'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createStationBackupCapability } = require('./station-backup-capability');
const AT = Date.parse('2026-09-15T20:00:00Z');
const DB = 'projects/station-102/databases/(default)';
const UID = '61be1ad8-c754-4452-a238-19be359d6b6b';
function fixture(change = () => {}, config = {}) {
  const state = {
    database:{name:DB,uid:UID,locationId:'eur3',pointInTimeRecoveryEnablement:'POINT_IN_TIME_RECOVERY_ENABLED',versionRetentionPeriod:'604800s'},
    schedules:{backupSchedules:[
      {name:DB+'/backupSchedules/daily',retention:'8467200s',dailyRecurrence:{}},
      {name:DB+'/backupSchedules/weekly',retention:'8467200s',weeklyRecurrence:{day:'SUNDAY'}}]},
    backups:{backups:[{name:'projects/station-102/locations/eur3/backups/backup',database:DB,databaseUid:UID,
      state:'READY',snapshotTime:'2026-09-15T10:34:26.054040Z',expireTime:'2026-12-22T10:34:26.054040Z'}]}
  };
  change(state);
  const calls = [];
  const method = key => async (params, options) => {
    calls.push({key,params,options});
    if (state.fail === key) throw new Error('unavailable');
    if (state.hang === key) return new Promise(() => {});
    if (state.defer === key) return new Promise(resolve => { state.resolve = () => resolve({data:state[key]}); });
    return {data:state[key]};
  };
  const firestoreApi = {projects:{databases:{get:method('database'),backupSchedules:{list:method('schedules')}},
    locations:{backups:{list:method('backups')}}}};
  return {state,calls,reader:createStationBackupCapability({firestoreApi,projectId:'station-102',now:()=>AT,...config})};
}

test('live policy shape is ready, exact SDK read paths/options only, immutable sanitized result', async () => {
  const f=fixture(); const value=await f.reader.readBackupCapability();
  assert.deepEqual(value,{ready:true,reason:'database-backup-verified'});
  assert.equal(Object.isFrozen(value),true);
  assert.deepEqual(f.calls.map(x=>[x.key,x.params]),[
    ['database',{name:DB}],['schedules',{parent:DB}],['backups',{parent:'projects/station-102/locations/eur3'}]]);
  for(const call of f.calls){assert.equal(call.options.retry,false);assert.equal(call.options.timeout,8000);
    assert.equal(call.options.maxContentLength,1048576);assert.ok(call.options.signal instanceof AbortSignal);}
});

for (const [name,change,reason] of [
  ['wrong database',s=>s.database.name=DB+'-other','database-identity-unverified'],
  ['missing UID',s=>delete s.database.uid,'database-identity-unverified'],
  ['malformed UUID',s=>s.database.uid='-'.repeat(36),'database-identity-unverified'],
  ['bad location',s=>s.database.locationId='../other','database-identity-unverified'],
  ['PITR disabled',s=>s.database.pointInTimeRecoveryEnablement='POINT_IN_TIME_RECOVERY_DISABLED','pitr-policy-unmet'],
  ['short PITR',s=>s.database.versionRetentionPeriod='3600s','pitr-policy-unmet'],
  ['nonfinite duration',s=>s.database.versionRetentionPeriod='9'.repeat(400)+'s','pitr-policy-unmet'],
  ['missing weekly',s=>s.schedules.backupSchedules.pop(),'schedule-policy-unmet'],
  ['short retention',s=>s.schedules.backupSchedules[0].retention='604800s','schedule-policy-unmet'],
  ['foreign schedule',s=>s.schedules.backupSchedules[0].name='projects/other/databases/(default)/backupSchedules/daily','schedule-response-unverified'],
  ['invalid weekly day',s=>s.schedules.backupSchedules[1].weeklyRecurrence.day='UNSPECIFIED','schedule-policy-unmet'],
  ['unexpected schedule page',s=>s.schedules.nextPageToken='next','schedule-response-unverified'],
  ['too many schedules',s=>s.schedules.backupSchedules=Array(33).fill(s.schedules.backupSchedules[0]),'schedule-response-unverified'],
  ['partial location',s=>s.backups.unreachable=['eur3'],'backup-response-unverified'],
  ['unexpected backup page',s=>s.backups.nextPageToken='next','backup-response-unverified'],
  ['too many backups',s=>s.backups.backups=Array(4097).fill(s.backups.backups[0]),'backup-response-unverified'],
  ['foreign database backup',s=>s.backups.backups[0].database=DB+'-other','recent-ready-backup-missing'],
  ['recreated database UID',s=>s.backups.backups[0].databaseUid='other','recent-ready-backup-missing'],
  ['foreign backup location',s=>s.backups.backups[0].name='projects/station-102/locations/us/backups/b','recent-ready-backup-missing'],
  ['not ready',s=>s.backups.backups[0].state='CREATING','recent-ready-backup-missing'],
  ['stale snapshot',s=>s.backups.backups[0].snapshotTime=new Date(AT-48*3600000-1).toISOString(),'recent-ready-backup-missing'],
  ['future snapshot',s=>s.backups.backups[0].snapshotTime=new Date(AT+1).toISOString(),'recent-ready-backup-missing'],
  ['expired backup',s=>s.backups.backups[0].expireTime=new Date(AT).toISOString(),'recent-ready-backup-missing'],
  ['missing timestamp',s=>delete s.backups.backups[0].snapshotTime,'recent-ready-backup-missing']
]) test(name+' fails closed',async()=>assert.deepEqual(await fixture(change).reader.readBackupCapability(),{ready:false,reason}));

for(const key of ['database','schedules','backups']) test(key+' read error does not imply ready',async()=>{
  const f=fixture(s=>s.fail=key);assert.deepEqual(await f.reader.readBackupCapability(),{ready:false,reason:'backup-verification-unavailable'});
  assert.equal(f.calls.filter(x=>x.key===key).length,1);
});
test('total deadline bounds a stalled dependency and aborts its signal',async()=>{
  const f=fixture(s=>s.hang='schedules',{timeoutMs:20});
  assert.deepEqual(await f.reader.readBackupCapability(),{ready:false,reason:'backup-verification-unavailable'});
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].options.signal.aborted,true);
});
test('late response after deadline cannot start another API read',async()=>{
  const f=fixture(s=>s.defer='database',{timeoutMs:20});
  assert.equal((await f.reader.readBackupCapability()).ready,false);
  f.state.resolve();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.length,1);
});
test('48h boundary remains accepted and every invocation obtains fresh metadata',async()=>{
  const f=fixture(s=>s.backups.backups[0].snapshotTime=new Date(AT-48*3600000).toISOString());
  assert.equal((await f.reader.readBackupCapability()).ready,true);
  f.state.database.pointInTimeRecoveryEnablement='POINT_IN_TIME_RECOVERY_DISABLED';
  assert.equal((await f.reader.readBackupCapability()).ready,false);
  assert.equal(f.calls.filter(x=>x.key==='database').length,2);
});
test('factory rejects non-default database and invalid server configuration',()=>{
  assert.throws(()=>fixture(()=>{},{databaseId:'other'}),TypeError);
  assert.throws(()=>fixture(()=>{},{projectId:'../other'}),TypeError);
  assert.throws(()=>fixture(()=>{},{timeoutMs:15001}),TypeError);
  assert.throws(()=>createStationBackupCapability(),TypeError);
});
test('invalid clock fails without reads',async()=>{
  const f=fixture(()=>{},{now:()=>NaN});assert.equal((await f.reader.readBackupCapability()).ready,false);assert.equal(f.calls.length,0);
});
