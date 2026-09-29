'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { createInvitations } = require('./invitations');
const { createHrPersonalInvitationService } = require('./hr-personal-invitation-service');
function fixture() {
  let now = 1790000000000, guardCalls = 0, denyAt = 0, tail = Promise.resolve();
  const store = new Map([['stations/eilat_102', { active:true, districtId:'south' }]]), writes = [];
  const snap = path => ({ exists:store.has(path), data:() => structuredClone(store.get(path)) });
  const db = { doc:path => ({ path, get:async () => snap(path) }), runTransaction(fn) {
    const run = tail.then(async () => {
      const pending = []; let written = false;
      const result = await fn({ get:async ref => { assert.equal(written, false); return snap(ref.path); },
        create(ref, data) { written=true; pending.push({ path:ref.path, data, create:true }); },
        set(ref, data, options) { written=true; pending.push({ path:ref.path, data, merge:options?.merge }); } });
      for (const p of pending) if (p.create) assert.equal(store.has(p.path), false);
      for (const p of pending) { store.set(p.path, structuredClone(p.merge ? { ...store.get(p.path), ...p.data } : p.data)); writes.push(p.path); }
      return result;
    }); tail = run.catch(() => {}); return run;
  } };
  const engine = createInvitations({ clock:() => now, randomBytes:crypto.randomBytes,
    createHash:s => crypto.createHash('sha256').update(s).digest('hex'), timingSafeEqual:crypto.timingSafeEqual,
    assertMayAssign(gate, role) { assert.equal(gate.cap, Infinity); assert.equal(role, 'hr_coordinator'); }, withinRoleSetterScope:() => true });
  const service = createHrPersonalInvitationService({ db, invitations:engine, knownDistricts:['south'], clock:() => now,
    requireSuperAdmin:async req => { guardCalls++; if (req.auth?.uid !== 'owner' || guardCalls === denyAt) throw Error('denied'); return req.auth; },
    fail:(code, message) => { throw Object.assign(Error(message), { code }); } });
  const req = { auth:{ uid:'owner' }, data:{ request_id:'hr_request_00000001', station_id:'eilat_102', full_name:'ליסה', email:'Lisaa@example.test' } };
  return { service, engine, req, store, writes, advance:() => { now+=61000; }, deny:n => { denyAt=n; } };
}
test('one HR invitation binds email, station and empty shift; secret absent from storage; replay has no secret', async () => {
  const f=fixture(), out=await f.service.issueHrInvitation(f.req), stored=f.store.get('invitations/'+out.invite_id);
  assert.equal(stored.role, 'hr_coordinator'); assert.equal(stored.shift, ''); assert.equal(stored.email, 'lisaa@example.test');
  assert.equal(stored.station_id, 'eilat_102'); assert.equal(stored.max_uses, 1);
  assert.equal(out.expires_at_ms - stored.issued_at.getTime(), 72*3600000);
  assert.equal(JSON.stringify([...f.store]).includes(out.secret), false);
  const replay=await f.service.issueHrInvitation(f.req);
  assert.equal(replay.invite_id, out.invite_id); assert.equal(replay.secret_available, false); assert.equal(f.writes.length, 3);
  assert.equal(f.engine.inspect(stored, out.secret).ok, true);
  assert.equal(f.engine.inspect(stored, 'wrong').ok, false);
});
test('concurrent retries create only one invitation', async () => {
  const f=fixture(), results=await Promise.all([f.service.issueHrInvitation(f.req),f.service.issueHrInvitation(f.req)]);
  assert.equal(results[0].invite_id, results[1].invite_id); assert.equal(results.filter(r=>r.secret_available).length,1);
  assert.equal(f.writes.length,3);
});
test('legacy active is supported but provisioned stations require full ready shape',async()=>{
  const f=fixture();f.store.get('stations/eilat_102').status='active';await f.service.issueHrInvitation(f.req);
  for(const data of [{template_id:'fire-station-v1',status:'active'},{template_id:'fire-station-v1',status:'ready'}]){
    const g=fixture();Object.assign(g.store.get('stations/eilat_102'),data);await assert.rejects(g.service.issueHrInvitation(g.req));assert.equal(g.writes.length,0);
  }
});
for (const mutate of [f=>f.req.auth.uid='hr', f=>f.deny(2), f=>f.req.data.role='super', f=>f.req.data.shift='A',
  f=>f.req.data.email='', f=>f.store.get('stations/eilat_102').active=false]) {
  test('invalid or revoked authority makes no writes: '+String(mutate), async () => {
    const f=fixture(); mutate(f); await assert.rejects(f.service.issueHrInvitation(f.req)); assert.equal(f.writes.length,0);
  });
}
test('changed intent and duplicate new operation rejected', async () => {
  const f=fixture(); await f.service.issueHrInvitation(f.req);
  await assert.rejects(f.service.issueHrInvitation({ ...f.req, data:{ ...f.req.data, full_name:'Different' } }));
  const recovered=await f.service.issueHrInvitation({ ...f.req, data:{ ...f.req.data, request_id:'hr_request_00000002' } });
  assert.equal(recovered.existing,true); assert.equal(recovered.secret_available,false); assert.ok(recovered.invite_id);
  assert.equal(f.writes.length,3);
});
test('revoke is idempotent, old link invalid, new request after cooldown permitted', async () => {
  const f=fixture(), out=await f.service.issueHrInvitation(f.req), req={auth:f.req.auth,data:{invite_id:out.invite_id}};
  await f.service.revokeHrInvitation(req); await f.service.revokeHrInvitation(req);
  assert.equal(f.engine.inspect(f.store.get('invitations/'+out.invite_id),out.secret).ok,false);
  f.advance(); f.req.data.request_id='hr_request_00000002';
  assert.notEqual((await f.service.issueHrInvitation(f.req)).invite_id,out.invite_id);
});
test('cannot revoke redeemed account invitation or create identity data', async () => {
  const f=fixture(), out=await f.service.issueHrInvitation(f.req);
  f.store.get('invitations/'+out.invite_id).redeemed_by='lisa';
  await assert.rejects(f.service.revokeHrInvitation({auth:f.req.auth,data:{invite_id:out.invite_id}}));
  assert.ok(f.writes.every(p=>/^(invitations|hr_invitation_operations|hr_invitation_recipients)\//.test(p)));
});

test('real invitation redemption and actual approval planner preserve HR without shift', async () => {
  const f=fixture(), issued=await f.service.issueHrInvitation(f.req), invite=f.store.get('invitations/'+issued.invite_id);
  const member={uid:'lisa',email:invite.email,email_verified:true};
  assert.throws(()=>f.engine.redeem(invite,issued.secret,{...member,email_verified:false},{}));
  assert.throws(()=>f.engine.redeem(invite,issued.secret,{...member,email:'other@example.test'},{}));
  const redeemed=f.engine.redeem(invite,issued.secret,member,{});
  const contract=require('./invitation-onboarding-contract');
  const split=contract.splitRedemption({source:'server_document',invite,redeemed,auth:member,
    recomputed_fingerprint:redeemed.invite_fingerprint,request_id:'redeem_request_000001'});
  assert.equal(split.registration_request.shift,''); assert.equal(split.registration_request.role,undefined);
  const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'index.js'),'utf8').replace(/\r\n/g,'\n');
  const start=source.indexOf('makePlan: function (emp, r, authority)', source.indexOf('exports.approveRegistration'));
  const end=source.indexOf('\n    }\n  });',start);
  assert.ok(start>0&&end>start);
  const makePlan=require('node:vm').runInNewContext('('+source.slice(start+'makePlan: '.length,end)+'\n    })',{
    VALID_ROLES:['hr_coordinator','firefighter','commander'],VALID_SHIFTS:['A','B','C'],KNOWN_DISTRICTS:['south'],
    HttpsError:Error,namePrefixes:()=>[],d:{},user:{email:invite.email}
  });
  const assignment={stationId:'eilat_102',districtId:'south',role:'hr_coordinator',shift:''};
  const plan=makePlan('407',split.registration_request,{assignment});
  assert.equal(plan.desiredClaims.role,'hr_coordinator'); assert.equal(plan.desiredClaims.shift,'');
  assert.equal(plan.desiredClaims.super,undefined); assert.equal(plan.desiredClaims.emp,'407');
  for(const role of ['firefighter','commander'])assert.throws(()=>makePlan('407',split.registration_request,{assignment:{...assignment,role}}));
  for(const shift of ['A','B','C'])assert.equal(makePlan('407',split.registration_request,{assignment:{...assignment,role:'firefighter',shift}}).desiredClaims.shift,shift);
});
