'use strict';
const assert = require('node:assert/strict');
const { createFirestoreHealthPorts, MAX_STATIONS } = require('./system-health-firestore');
const { Firestore } = require('firebase-admin/firestore');
const sdk = new Firestore({ projectId: 'demo-resq-health-inventory' }); // Reference validation only; no network.
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const provision = (id='new_station') => ({schema_version:1,station_id:id,name:'תחנת בדיקה',districtId:'south',active:false,status:'provisioning',silent:true,template_id:'fire-station-v1',provision_request_id:'request_0001'});
function fixture(extra={}) {
  const data = new Map(Object.entries(extra));
  const reads=[],writes=[],queries=[];
  const snap=(path)=>({id:path.split('/').pop(),exists:data.has(path),data:()=>data.get(path)});
  function ref(path){sdk.doc(path);return {path,get:async()=>{reads.push({path,tx:false});return snap(path);}};}
  function query(path,field,value,n){return {path,field,value,n,
    where:(f,op,v)=>{assert.equal(op,'==');return query(path,f,v,n);},
    limit:k=>query(path,field,value,k),
    get:async()=>readQuery({path,field,value,n},false)};}
  function readQuery(q,tx){
    assert.equal(q.n,MAX_STATIONS+1);queries.push({field:q.field,n:q.n,tx});
    const docs=[...data.keys()].filter(p=>p.startsWith(q.path+'/')&&p.split('/').length===2&&data.get(p)[q.field]===q.value).sort().slice(0,q.n).map(snap);
    return {size:docs.length,docs};
  }
  const db={doc:ref,collection:path=>{sdk.collection(path);return query(path);},runTransaction:async fn=>{
    const pending=[];let wrote=false;
    const tx={get:async r=>{assert.equal(wrote,false,'all reads precede transaction writes');if(r.field)return readQuery(r,true);reads.push({path:r.path,tx:true});return snap(r.path);},set:(r,v,o)=>{wrote=true;pending.push([r.path,v,o]);}};
    const answer=await fn(tx);for(const [path,v,o] of pending){writes.push(path);data.set(path,o?.merge?{...data.get(path),...v}:v);}return answer;
  }};
  const ports=createFirestoreHealthPorts({db,FieldValue:{serverTimestamp:()=>new Date(1000)},FieldPath:{documentId:()=> '__name__'},clock:()=>1000,randomId:()=> 'token',builtins:{eilat_102:{active:true,districtId:'south'}},knownDistricts:['south'],activeIndex:()=>true});
  return {ports,db,data,reads,writes,queries};
}
const inventory= f=> f.ports.listStations({deadline_ms:20000});
(async()=>{
  await test('built-in fallback remains enrolled',async()=>{assert.deepEqual(await inventory(fixture()),{complete:true,stations:[{station_id:'eilat_102',silent:false}]});});
  await test('server provisioning station enrolled while inactive and silent',async()=>{const f=fixture({'stations/new_station':provision()});const r=await inventory(f);assert.equal(r.complete,true);assert.deepEqual(r.stations.map(x=>x.station_id),['eilat_102','new_station']);assert.equal(r.stations[1].silent,true);assert.equal(f.queries.length,2);});
  await test('arbitrary inactive station is not enrolled',async()=>{assert.equal((await inventory(fixture({'stations/other':{active:false,districtId:'south'}}))).stations.length,1);});
  for(const [key,bad] of Object.entries({schema_version:2,station_id:'foreign',active:true,silent:false,template_id:'other',provision_request_id:'bad',districtId:'unknown',name:''})){
    await test('malformed provisioning '+key+' makes inventory incomplete',async()=>{const r=await inventory(fixture({'stations/new_station':{...provision(),[key]:bad}}));assert.deepEqual(r,{complete:false,stations:[]});});
  }
  await test('active/builtin deduplication and explicit inactive builtin preserved',async()=>{let f=fixture({'stations/eilat_102':{active:true,districtId:'south'}});assert.equal((await inventory(f)).stations.length,1);f=fixture({'stations/eilat_102':{active:false,districtId:'south'}});assert.equal((await inventory(f)).stations.length,0);});
  await test('active unknown district remains incomplete',async()=>{assert.equal((await inventory(fixture({'stations/other':{active:true,districtId:'bad'}}))).complete,false);});
  await test('combined cap rejects two individually bounded pages',async()=>{const rows={};for(let i=0;i<101;i++){rows['stations/a_'+i]={active:true,districtId:'south'};rows['stations/p_'+i]=provision('p_'+i);}assert.equal((await inventory(fixture(rows))).complete,false);});
  await test('per query overflow fails closed',async()=>{const rows={};for(let i=0;i<202;i++)rows['stations/p_'+i]=provision('p_'+i);assert.equal((await inventory(fixture(rows))).complete,false);});
  await test('deadline and malformed deadline fail closed',async()=>{const f=fixture();assert.equal((await f.ports.listStations({deadline_ms:6000})).complete,false);assert.equal((await f.ports.listStations({deadline_ms:NaN})).complete,false);});
  await test('readiness can read exact same inventory inside its transaction',async()=>{const f=fixture({'stations/new_station':provision()});await f.db.runTransaction(async tx=>{assert.equal((await f.ports.listStations({tx,deadline_ms:20000})).complete,true);});assert.ok(f.reads.every(x=>x.tx));assert.ok(f.queries.every(x=>x.tx));assert.equal(f.writes.length,0);});
  await test('parent silent and legacy silent both honored',async()=>{for(const rows of [{'stations/new_station':provision()},{'stations/new_station/config/mode':{mode:'silent'}},{'stations/new_station/config/mode':{silent:true}}])assert.equal(await fixture(rows).ports.readStationSilent({station_id:'new_station'}),true);assert.equal(await fixture().ports.readStationSilent({station_id:'new_station'}),false);});
  await test('publication uses same provisioning inventory, transaction reads before writes',async()=>{
    const f=fixture({'stations/new_station':provision(),'system_health_cycles/cycle_1':{lease_token:'token',lease_until_ms:10000}});
    const cycle={cycle_id:'cycle_1',total:2,inventory:(await inventory(f)).stations.map(x=>x.station_id)};
    await f.ports.publishComplete({cycle,lease_token:'token',summary:{verdict:'findings'},reports:[]});assert.equal(f.data.get('system_health_cycles/cycle_1').published,true);assert.equal(f.queries.filter(x=>x.tx).length,2);
  });
  await test('provisioning removal between scan and publication refuses all writes',async()=>{
    const f=fixture({'stations/new_station':provision(),'system_health_cycles/cycle_1':{lease_token:'token',lease_until_ms:10000}});
    const cycle={cycle_id:'cycle_1',total:2,inventory:(await inventory(f)).stations.map(x=>x.station_id)};
    f.data.set('stations/new_station',{...provision(),status:'archived'});
    await assert.rejects(f.ports.publishComplete({cycle,lease_token:'token',summary:{},reports:[]}),/inventory-drift/);assert.equal(f.writes.length,0);
  });
  console.log('Health Firestore inventory: '+passed+' PASS (actual SDK references; fake reads/transactions, no emulator).');
})().catch(error=>{console.error(error);process.exitCode=1;});
