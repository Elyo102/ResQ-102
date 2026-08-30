import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { MEMBER_ROLES } from '../roles.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '..', 'functions', 'schedule-autofill.js');
const source = fs.readFileSync(file, 'utf8');
const require = createRequire(import.meta.url);
const engine = require(file);

const forbidden = [
  /\brequire\(['"]firebase(?:-admin)?/i,
  /\bfrom\s+['"]firebase(?:-admin)?/i,
  /\brequire\(['"](?:node:)?(?:https?|http2|net|tls|dns|dgram|child_process|worker_threads|fs(?:\/promises)?)['"]\)/,
  /\bfetch\s*\(/,
  /\b(?:setDoc|updateDoc|addDoc|deleteDoc|writeBatch|runTransaction)\s*\(/,
  /\bDate\.now\s*\(/,
  /\bMath\.random\s*\(/,
  /\blocaleCompare\s*\(/,
  /\bSTATION_ID\b/,
  /eilat_102/i
];

forbidden.forEach((pattern) => {
  assert.equal(pattern.test(source), false, `forbidden source pattern: ${pattern}`);
});

assert.match(source, /TARGET_KIND = 'static_crew_board_v1'/);
assert.match(source, /MAX_MEMBERS = 5000/);
assert.match(source, /MAX_SLOTS = 500/);
assert.match(source, /CANDIDATE_EDGE_LIMIT_EXCEEDED/);
assert.match(source, /LOCKED_ASSIGNMENT_INVALID/);
assert.match(source, /STATION_MISMATCH/);
assert.match(source, /SNAPSHOT_MISMATCH/);
assert.match(source, /PII_FIELD_FORBIDDEN/);
assert.match(source, /proposal_digest/);
assert.match(source, /source_digest/);
assert.match(source, /assignment_explanations/);
assert.match(source, /REST_NOT_EVALUATED_STATIC_BOARD/);
assert.deepEqual(engine.MEMBER_ROLE_IDS, MEMBER_ROLES,
  'schedule role ids must stay aligned with the canonical member roles');

console.log('schedule-autofill source: 21/21 PASS');
