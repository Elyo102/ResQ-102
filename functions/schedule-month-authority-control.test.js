'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {classify}=require('./schedule-month-authority-control');
const root={schema_version:1,station_id:'s1',generation:0,migrated:true,seed_publication_id:null,last_operation_id:'migration'};
const disabled={schema_version:1,station_id:'s1',enabled:false};
const enabled={...disabled,enabled:true,release_id:'42H.19.1',activation_id:'a'.repeat(64),activated_by:'super',activated_at:'2026-08-25T00:00:00.000Z'};
test('strict authority matrix has only two accepted modes, never root-presence activation',()=>{
  assert.equal(classify('s1',null,null).mode,'compatibility');
  assert.equal(classify('s1',null,disabled).mode,'compatibility');
  assert.equal(classify('s1',root,enabled).mode,'monthly');
  for(const pair of [[root,null],[root,disabled],[null,enabled],[{},enabled],[root,{...enabled,enabled:'true'}],[null,{...disabled,enabled:0}],[root,{...enabled,station_id:'s2'}]])assert.throws(()=>classify('s1',...pair));
});
test('selection identity distinguishes control epochs without binding owner generation',()=>{
  assert.deepEqual(classify('s1',root,enabled),classify('s1',{...root,generation:42},enabled));
  assert.notDeepEqual(classify('s1',root,enabled),classify('s1',root,{...enabled,activation_id:'b'.repeat(64)}));
  for(const change of [{extra:true},{activated_by:''},{activated_at:'bad'},{activation_id:'bad'},{release_id:''}])assert.throws(()=>classify('s1',root,{...enabled,...change}));
});
