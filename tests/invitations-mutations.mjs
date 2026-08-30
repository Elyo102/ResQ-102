import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, '..', 'functions', 'invitations.js');
const testPath = path.join(here, '..', 'functions', 'invitations.test.js');
const originalSource = fs.readFileSync(sourcePath, 'utf8');
const originalTests = fs.readFileSync(testPath, 'utf8');

const mutations = [
  {
    name: 'email verification disabled',
    find: 'if (auth.email_verified !== true) {',
    replace: 'if (false) {',
    expected: 'caught'
  },
  {
    name: 'approval ignores revocation',
    find: "invite.revoked_at || !invite.redeemed_by ||\n        !Number.isFinite(toMillis(invite.expires_at))",
    replace: "false || !invite.redeemed_by ||\n        !Number.isFinite(toMillis(invite.expires_at))",
    expected: 'caught'
  },
  {
    name: 'approval ignores expiry',
    find: "!Number.isFinite(toMillis(invite.expires_at)) || toMillis(invite.expires_at) <= when",
    replace: 'false',
    expected: 'caught'
  },
  {
    name: 'single-use guard removed',
    find: "invite.max_uses !== 1 ||\n        invite.revoked_at || invite.redeemed_by ||",
    replace: "false ||\n        invite.revoked_at || invite.redeemed_by ||",
    expected: 'caught'
  },
  {
    name: 'client role overrides invitation role',
    find: 'role: cleanRole(invite.role),',
    replace: "role: cleanRole((clientInput || {}).role || invite.role),",
    expected: 'caught'
  },
  {
    name: 'foreign station is silently forced into issuer scope',
    find: "if (supplied !== scopedValue) {\n      throw new InvitationError('out-of-scope', key + ' differs from issuer scope');\n    }\n    return supplied;",
    replace: 'return scopedValue;',
    expected: 'caught'
  },
  {
    name: 'role ceiling call removed',
    find: "d.assertMayAssign(gate, role, {}, '', false, desired);",
    replace: 'void desired;',
    expected: 'caught'
  },
  {
    name: 'scope guard call removed',
    find: 'if (!d.withinRoleSetterScope(gate, {}, desired)) {',
    replace: 'if (false) {',
    expected: 'caught'
  },
  {
    name: 'transaction verification ignores prior redemption',
    find: 'invite.revoked_at || invite.redeemed_by ||',
    replace: 'invite.revoked_at || false ||',
    expected: 'caught'
  },
  {
    name: 'inspect reveals internal failure code',
    find: 'return { ok:INVALID_PUBLIC_RESULT.ok, error:INVALID_PUBLIC_RESULT.error };',
    replace: "return { ok:false, error:String(_.code || 'invalid') };",
    expected: 'caught'
  },
  {
    name: 'plain invitation secret is stored',
    find: 'secret_hash: hashSecret(secret),',
    replace: 'secret_hash: hashSecret(secret),\n      secret: secret,',
    expected: 'caught'
  },
  {
    name: 'super-admin role is allowed',
    find: "if (role === 'super_admin') {",
    replace: 'if (false) {',
    expected: 'caught'
  },
  {
    name: 'constant-time equality replaced by ordinary equality',
    find: 'return a.length > 0 && d.timingSafeEqual(a, b);',
    replace: 'return a.length > 0 && a.equals(b);',
    expected: 'survived'
  }
];

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-invite-mutations-'));
let caught = 0;
let survived = 0;

try {
  mutations.forEach(function (mutation, index) {
    assert.ok(originalSource.includes(mutation.find),
      'mutation target missing: ' + mutation.name);
    const dir = path.join(tempRoot, String(index + 1));
    fs.mkdirSync(dir, { recursive:true });
    fs.writeFileSync(path.join(dir, 'invitations.js'),
      originalSource.replace(mutation.find, mutation.replace));
    fs.writeFileSync(path.join(dir, 'invitations.test.js'), originalTests);
    const result = spawnSync(process.execPath, ['invitations.test.js'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true
    });
    const actual = result.status === 0 ? 'survived' : 'caught';
    assert.equal(actual, mutation.expected,
      mutation.name + '\nstdout:\n' + result.stdout + '\nstderr:\n' + result.stderr);
    if (actual === 'caught') caught++;
    else survived++;
    console.log('✓ ' + mutation.name + ': ' + actual);
  });
} finally {
  fs.rmSync(tempRoot, { recursive:true, force:true });
}

assert.equal(caught, 12);
assert.equal(survived, 1);
console.log('\n12 security mutations caught; 1 timing-only mutation survived as declared.');
