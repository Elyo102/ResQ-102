// בדיקת עומס לקליטה בקישור קבוצתי — 100 מימושים מלאים דרך מנוע ההזמנות
// האמיתי, ו-3,000 נרשמים בדפדוף. Firestore מזויף (בזיכרון); לכן המספרים
// כאן מודדים את מבנה הקריאות (אין N+1) ואת עלות ה-CPU של החוזה, לא זמן רשת.
// NOT MEASURED here: latency אמיתית של Firestore, App Check, Auth.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const H = require('../functions/join-campaign-test-harness');
const { build, req, authUser, createInput, redeemInput, seedHr } = H;

let passed = 0;
function check(name, value) { assert(value, name); passed++; console.log('PASS ' + name); }
const ms = (t0) => Number((process.hrtime.bigint() - t0) / 1000000n);

// ---------- 100 מימושים ----------
{
  const { db, service } = build(); seedHr(db);
  const created = await service.createJoinCampaign(req('super1', createInput({ station_id: 'eilat', max_registrations: 100 })));
  for (let i = 0; i < 100; i++) authUser('load_w' + i);
  const before = { ...db._stats };
  const t0 = process.hrtime.bigint();
  const results = [];
  for (let i = 0; i < 100; i++) results.push(await service.redeemJoinCampaign(req('load_w' + i, redeemInput(created.token, { shift: ['A', 'B'][i % 2] }))));
  const elapsed = ms(t0);
  const stats = { reads: db._stats.reads - before.reads, writes: db._stats.writes - before.writes, retries: db._stats.retries - before.retries };
  check('100 redemptions succeed, none replayed', results.every((r) => r.ok === true && r.replayed === false));
  check('campaign counter reaches exactly 100 and turns full', db._get('join_campaigns/' + created.campaign_id).accepted_count === 100 && db._get('join_campaigns/' + created.campaign_id).status === 'full');
  check('100 distinct single-use invitations, 100 registries, 100 requests', ['invitations/', 'onboarding_assignment_links/', 'registration_requests/'].every((p) => Array.from(db._store.keys()).filter((k) => k.startsWith(p)).length === 100));
  check('writes per redemption are constant (7 docs)', stats.writes === 700);
  check('reads per redemption are bounded (<= 12, no per-registrant fan-out)', stats.reads / 100 <= 12);
  console.log('  100 redemptions: ' + elapsed + 'ms total, ' + (elapsed / 100).toFixed(2) + 'ms each, reads/redemption=' + (stats.reads / 100).toFixed(1) + ', retries=' + stats.retries);
  const r101 = await service.redeemJoinCampaign(req('load_w0', redeemInput(created.token))).catch((e) => e);
  check('101st account is refused as full (registry-exists for a known uid comes first)', r101 && /campaign-full|onboarding-registry-exists/.test(r101.code));
  authUser('load_extra');
  const r102 = await service.redeemJoinCampaign(req('load_extra', redeemInput(created.token))).catch((e) => e);
  check('new account after quota gets campaign-full', r102 && r102.code === 'campaign-full');
}

// ---------- 3,000 נרשמים בדפדוף ----------
{
  const { db, service } = build();
  const created = await service.createJoinCampaign(req('super1', createInput({ station_id: 'eilat', max_registrations: 500 })));
  // הזרקה ישירה של רשומות (המימוש עצמו נמדד למעלה); מחצית מאושרות, רבע נסגרו.
  const uids = [];
  for (let i = 0; i < 3000; i++) {
    const uid = 'page_w' + i; uids.push(uid); authUser(uid, { emailVerified: i % 7 !== 0 });
    db._put('join_campaigns/' + created.campaign_id + '/registrants/' + uid, {
      schema: 'join-registrant-v1', uid, campaign_id: created.campaign_id, campaign_revision: 1, station_id: 'eilat', request_id: 'req_' + String(i).padStart(14, '0'),
      invite_id: 'inv_' + i, shift: ['A', 'B', 'C'][i % 3], note: '', ack: { correctness: true, terms_version: '2026-09', privacy_version: '2026-09', at_ms: 1 },
      declarations: [{ key: 'driver', declared_at_ms: 1, valid_until_ms: null, reference: null, status: 'declared', verified_by: null, verified_at_ms: null, reject_reason: null, revision: 1 }],
      review_state: i % 11 === 0 ? 'returned' : 'none', review_note: '', review_at_ms: null, revision: 1, created_at_ms: 1_800_000_000_000 + i, updated_at_ms: 1
    });
    if (i % 2 === 0) db._put('registration_requests/' + uid, { request_id: 'req_' + String(i).padStart(14, '0'), full_name: 'בודק ' + i, email: uid + '@example.test', phone: '0500000000', districtId: 'south', stationId: 'eilat', shift: 'A', status: 'pending', server_generation: 'g' + i });
    else if (i % 4 === 1) db._put('stations/eilat/users/' + uid, { role: 'firefighter', active: true, is_active: true, stationId: 'eilat', name: 'בודק ' + i });
  }
  const before = { ...db._stats };
  const t0 = process.hrtime.bigint();
  let cursor, pages = 0, rows = 0, maxReadsPerPage = 0;
  do {
    const r0 = db._stats.reads;
    const page = await service.getJoinCampaignRegistrants(req('super1', { campaign_id: created.campaign_id, cursor, limit: 50 }));
    pages++; rows += page.rows.length; cursor = page.next_cursor;
    maxReadsPerPage = Math.max(maxReadsPerPage, db._stats.reads - r0);
  } while (cursor);
  const elapsed = ms(t0);
  check('3,000 registrants paged completely (60 full pages + one empty tail page)', pages === 61 && rows === 3000);
  check('each page costs one query + three batched reads (<= 152 doc reads, never per-row callables)', maxReadsPerPage <= 152);
  check('derived statuses are consistent with the underlying mechanism', (await service.getJoinCampaignRegistrants(req('super1', { campaign_id: created.campaign_id, limit: 8 }))).rows.map((r) => r.request_status).join(',') === 'pending,approved,pending,closed,pending,approved,pending,closed');
  console.log('  3000 registrants: ' + pages + ' pages in ' + elapsed + 'ms, max reads/page=' + maxReadsPerPage + ', total reads=' + (db._stats.reads - before.reads));
  // סינון בלקוח על 3,000 שורות אינו נמדד כאן — הוא DOM; ראו join-campaign-browser.mjs.
}

console.log('\nJoin campaign load: ' + passed + ' PASS. NOT MEASURED: real Firestore/Auth/App Check latency; live transaction contention beyond the simulated race in join-campaign-service.test.js.');
