import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8');
const helper = source.match(/async function requireFreshRegistrationReviewer\(req, input\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(helper, 'station registration reviewer helper exists');

class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const campaignId = 'ABCDEFGHIJKLMNOP';
const uid = 'candidate_1', sid = 'eilat_102', requestId = 'request_1';

function fixture(patch = {}) {
  const docs = new Map([
    ['join_registrant_index/' + uid, { uid, station_id:sid, request_id:requestId, campaign_id:campaignId }],
    ['join_campaigns/' + campaignId, { schema:'join-campaign-v1', campaign_id:campaignId, station_id:sid, district_id:'south', status:'active' }],
    ['join_campaigns/' + campaignId + '/registrants/' + uid, { uid, request_id:requestId, shift:'A' }],
    ['registration_requests/' + uid, { uid, request_id:requestId, status:'pending' }],
    ['stations/' + sid + '/onboarding_operations/' + requestId, { provenance:{ kind:'join_campaign', campaign_id:campaignId } }]
  ]);
  Object.entries(patch.docs || {}).forEach(([key, value]) => value === null ? docs.delete(key) : docs.set(key, value));
  const reads = [];
  const context = {
    HttpsError, JOIN_CAMPAIGN_ID_RE:/^[A-Za-z0-9_-]{16}$/,
    joinCampaignContract:{ SCHEMA:'join-campaign-v1' },
    db:{ doc(p){ return { async get(){ reads.push(p); const value = docs.get(p); return { exists:value !== undefined, data:() => value }; } }; } },
    joinCampaignService:{ async _managementActor(){ return patch.actor || { role:'hr_coordinator', station_id:sid,
      auth:{ uid:'hr_1', token:{ role:'hr_coordinator', stationId:sid, email:'hr@example.test' } } }; } },
    requireFreshOnboardingSuper:async req => ({ ...req.auth, token:{ super:true, email:'super@example.test' } })
  };
  vm.createContext(context);
  vm.runInContext(helper + '\nthis.review=requireFreshRegistrationReviewer;', context);
  return { review:context.review, reads };
}

{
  const f = fixture();
  const out = await f.review({ auth:{ uid:'hr_1', token:{ role:'hr_coordinator', stationId:sid } } },
    { uid, request_id:requestId });
  assert.equal(out.hr, true);
  assert.deepEqual(JSON.parse(JSON.stringify(out.authority)), {
    stationId:sid, districtId:'south', role:'firefighter', shift:'A'
  });
}
{
  const f = fixture({ docs:{ ['join_registrant_index/' + uid]:{ uid, station_id:'other_station', request_id:requestId, campaign_id:campaignId } } });
  await assert.rejects(() => f.review({ auth:{ uid:'hr_1', token:{} } }, { uid, request_id:requestId }),
    error => error.code === 'permission-denied');
}
{
  const f = fixture({ docs:{ ['join_campaigns/' + campaignId]:{ schema:'join-campaign-v1', campaign_id:campaignId,
    station_id:sid, district_id:'south', status:'revoked' } } });
  await assert.rejects(() => f.review({ auth:{ uid:'hr_1', token:{} } }, { uid, request_id:requestId }),
    error => error.code === 'permission-denied');
}
{
  const f = fixture({ docs:{ ['stations/' + sid + '/onboarding_operations/' + requestId]:{
    provenance:{ kind:'invitation', campaign_id:campaignId } } } });
  await assert.rejects(() => f.review({ auth:{ uid:'hr_1', token:{} } }, { uid, request_id:requestId }),
    error => error.code === 'permission-denied');
}
{
  const f = fixture();
  const out = await f.review({ auth:{ uid:'super_1', token:{ super:true } } }, { uid, request_id:requestId });
  assert.equal(out.hr, false);
  assert.equal(f.reads.length, 0);
}

assert.match(source, /const reviewer = await requireFreshRegistrationReviewer\(req, d\)/);
assert.match(helper, /role: 'firefighter'/);
assert.match(source, /if \(reviewer\.hr\)/);
console.log('HR station registration reviewer: same-station join campaign only; forced firefighter; super path preserved.');
