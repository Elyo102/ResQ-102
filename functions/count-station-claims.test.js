'use strict';

const assert = require('node:assert/strict');
const claimsAudit = require('./count-station-claims');

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log('✓ ' + label);
}

function authUser(claims, extra) {
  return Object.assign({
    disabled: false,
    customAttributes: claims === undefined ? '' : JSON.stringify(claims)
  }, extra || {});
}

(function run() {
  test('empty input is a passing empty aggregate', function () {
    const out = claimsAudit.summarizeUsers([]);
    assert.equal(out.total_accounts, 0);
    assert.equal(out.release_gate_42b, 'PASS');
  });

  test('approved role with valid station passes', function () {
    const out = claimsAudit.summarizeUsers([
      authUser({ role:'firefighter', stationId:'eilat_102' })
    ]);
    assert.equal(out.approved_accounts, 1);
    assert.equal(out.valid_station_claim, 1);
    assert.equal(out.release_gate_42b, 'PASS');
  });

  test('approved role without station blocks', function () {
    const out = claimsAudit.summarizeUsers([authUser({ role:'firefighter' })]);
    assert.equal(out.approved_missing_station_claim, 1);
    assert.equal(out.release_gate_42b, 'BLOCK');
  });

  test('super without station blocks and is counted separately', function () {
    const out = claimsAudit.summarizeUsers([authUser({ super:true })]);
    assert.equal(out.super_accounts, 1);
    assert.equal(out.super_missing_station_claim, 1);
    assert.equal(out.release_gate_42b, 'BLOCK');
  });

  test('super with valid station passes', function () {
    const out = claimsAudit.summarizeUsers([
      authUser({ super:true, stationId:'eilat_102' })
    ]);
    assert.equal(out.super_missing_station_claim, 0);
    assert.equal(out.release_gate_42b, 'PASS');
  });

  test('an unassigned account remains pending', function () {
    const out = claimsAudit.summarizeUsers([authUser({})]);
    assert.equal(out.pending_accounts, 1);
    assert.equal(out.approved_accounts, 0);
    assert.equal(out.release_gate_42b, 'PASS');
  });

  test('pending account with station is visible but does not become approved', function () {
    const out = claimsAudit.summarizeUsers([authUser({ stationId:'eilat_102' })]);
    assert.equal(out.pending_accounts, 1);
    assert.equal(out.pending_with_station_claim, 1);
    assert.equal(out.release_gate_42b, 'PASS');
  });

  test('trailing ASCII space is invalid, never trimmed silently', function () {
    const out = claimsAudit.summarizeUsers([
      authUser({ role:'firefighter', stationId:'eilat_102 ' })
    ]);
    assert.equal(out.approved_invalid_station_claim, 1);
    assert.equal(out.release_gate_42b, 'BLOCK');
  });

  test('leading ASCII space is invalid', function () {
    const out = claimsAudit.summarizeUsers([
      authUser({ role:'firefighter', stationId:' eilat_102' })
    ]);
    assert.equal(out.approved_invalid_station_claim, 1);
  });

  test('non-breaking space is invalid', function () {
    const out = claimsAudit.summarizeUsers([
      authUser({ role:'firefighter', stationId:'eilat_102\u00a0' })
    ]);
    assert.equal(out.approved_invalid_station_claim, 1);
  });

  test('zero-width space is invalid', function () {
    const out = claimsAudit.summarizeUsers([
      authUser({ role:'firefighter', stationId:'eilat_\u200b102' })
    ]);
    assert.equal(out.approved_invalid_station_claim, 1);
  });

  test('uppercase station id is invalid under the live contract', function () {
    const out = claimsAudit.summarizeUsers([
      authUser({ role:'firefighter', stationId:'EILAT_102' })
    ]);
    assert.equal(out.approved_invalid_station_claim, 1);
  });

  test('too-short station id is invalid', function () {
    const out = claimsAudit.summarizeUsers([
      authUser({ role:'firefighter', stationId:'x' })
    ]);
    assert.equal(out.approved_invalid_station_claim, 1);
  });

  test('too-long station id is invalid', function () {
    const out = claimsAudit.summarizeUsers([
      authUser({ role:'firefighter', stationId:'x'.repeat(81) })
    ]);
    assert.equal(out.approved_invalid_station_claim, 1);
  });

  test('non-string station claim is treated as missing', function () {
    const out = claimsAudit.summarizeUsers([
      authUser({ role:'firefighter', stationId:102 })
    ]);
    assert.equal(out.approved_missing_station_claim, 1);
  });

  test('invalid custom claims JSON blocks the release gate', function () {
    const out = claimsAudit.summarizeUsers([{
      disabled:false, customAttributes:'{not-json'
    }]);
    assert.equal(out.invalid_custom_claims_json, 1);
    assert.equal(out.release_gate_42b, 'BLOCK');
  });

  test('disabled accounts remain included in safety totals', function () {
    const out = claimsAudit.summarizeUsers([
      authUser({ role:'firefighter' }, { disabled:true })
    ]);
    assert.equal(out.disabled_accounts, 1);
    assert.equal(out.approved_missing_station_claim, 1);
  });

  test('mixed aggregate remains exact', function () {
    const out = claimsAudit.summarizeUsers([
      authUser({ role:'firefighter', stationId:'eilat_102' }),
      authUser({ role:'commander' }),
      authUser({}),
      authUser({ super:true, stationId:'eilat_102' })
    ]);
    assert.equal(out.total_accounts, 4);
    assert.equal(out.approved_accounts, 3);
    assert.equal(out.pending_accounts, 1);
    assert.equal(out.valid_station_claim, 2);
    assert.equal(out.approved_missing_station_claim, 1);
  });

  test('reveal escapes an ASCII space instead of hiding it', function () {
    assert.equal(claimsAudit.reveal('eilat_102 '), 'eilat_102\\u{20}');
  });

  test('reveal escapes NBSP explicitly', function () {
    assert.equal(claimsAudit.reveal('eilat_102\u00a0'), 'eilat_102\\u{A0}');
  });

  test('reveal escapes zero-width characters explicitly', function () {
    assert.equal(claimsAudit.reveal('eilat_\u200b102'), 'eilat_\\u{200B}102');
  });

  test('reveal escapes backslash to keep output unambiguous', function () {
    assert.equal(claimsAudit.reveal('a\\b'), 'a\\u{5C}b');
  });

  test('reveal preserves safe station characters', function () {
    assert.equal(claimsAudit.reveal('north_17-a'), 'north_17-a');
  });

  test('aggregate output contains no account details', function () {
    const out = claimsAudit.summarizeUsers([
      Object.assign(authUser({ role:'firefighter', stationId:'bad value' }), {
        uid:'secret-uid', email:'person@example.com', phoneNumber:'0500000000'
      })
    ]);
    const serialized = JSON.stringify(out);
    for (const value of ['secret-uid', 'person@example.com', '0500000000', 'bad value']) {
      assert.equal(serialized.includes(value), false, value);
    }
  });

  test('input users are not mutated', function () {
    const users = [authUser({ role:'firefighter', stationId:'eilat_102' })];
    const before = JSON.stringify(users);
    claimsAudit.summarizeUsers(users);
    assert.equal(JSON.stringify(users), before);
  });

  assert.equal(passed, 25);
  console.log('\n25 station-claim checks passed.');
})()
