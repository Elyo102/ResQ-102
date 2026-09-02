import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transfer = fs.readFileSync(path.join(root, 'functions', 'station-transfer.js'), 'utf8');
const coordinator = fs.readFileSync(
  path.join(root, 'functions', 'identity-coordinator.js'), 'utf8');

let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) {
    passed += 1;
    console.log('✓ ' + message);
  } else {
    failed += 1;
    console.error('✗ ' + message);
  }
}

function region(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  if (start === -1 || end === -1 || end <= start) return '';
  return source.slice(start, end);
}

const approvalRegion = region(
  transfer, 'async function claimApproval', 'async function cancel');
const claimRegion = region(
  transfer, 'async function claimApproval', 'async function markFailed');
const lockOwnershipRegion = region(
  transfer, 'function lockOwnedBy', 'function canonicalLock');
const failedRegion = region(
  transfer, 'async function markFailed', 'async function completeApproval');
const completionRegion = region(
  transfer, 'async function completeApproval', 'async function decide');
const decideRegion = region(
  transfer, 'async function decide', 'async function cancel');

// A destination can be disabled after source HR opens the request.  Creation
// validation is not enough: the approval path must consult the authoritative
// resolver again before any identity side effect.
check(
  /await\s+resolveStation\s*\(/.test(approvalRegion),
  'approval re-resolves the destination station after request creation'
);
check(
  /target[^\n]{0,120}active|active[^\n]{0,120}target|תחנת היעד אינה פעילה/u.test(approvalRegion),
  'approval rejects a destination that is no longer active'
);

// transfer_station is a profile-first assignment, like approve and set_role.
// If it is omitted here, the coordinator leaves Auth on the source station.
check(
  /op\.kind\s*!==\s*['"]transfer_station['"]/.test(coordinator),
  'identity coordinator advances Auth for transfer_station assignments'
);

// Once an identity plan exists, a retry must resume that exact plan instead of
// demanding that the already-retired source profile still be active.
check(
  /identityCoordinator\.resumeOperation\s*\(/.test(approvalRegion),
  'transfer recovery resumes the exact durable identity operation'
);
check(
  /operation\.status\s*===\s*['"]completed['"]/.test(failedRegion),
  'a completed identity operation is preserved for request finalization retry'
);

// The request lock is the single per-user concurrency fence.  Both identifiers
// must match before approval, and it may be removed only after the durable
// identity operation is known to be complete.
check(
  /lock\.request_id/.test(lockOwnershipRegion) &&
    /lock\.target_uid/.test(lockOwnershipRegion) &&
    /lockOwnedBy\s*\(lock,\s*requestId,\s*current\.target_uid\)/.test(claimRegion) &&
    /soleActiveRequest\s*\(activeSnap,\s*requestId,\s*current\.target_uid\)/
      .test(claimRegion),
  'approval verifies both request id and UID on the transfer lock'
);
const identityCompletedAt = completionRegion.indexOf("finished.status !== 'completed'");
const ownershipCheckedAt = completionRegion.indexOf(
  'lockOwnedBy(lock, value.request_id, value.target_uid)');
const lockDeletedAt = completionRegion.indexOf('tx.delete(transferLockRef)');
check(
  identityCompletedAt !== -1 && ownershipCheckedAt > identityCompletedAt &&
    lockDeletedAt > ownershipCheckedAt,
  'completion deletes the transfer lock only after identity completion is verified'
);

// Completed approval replay must return the stored result before attempting to
// claim the lock or run identity work again.
const replayAt = decideRegion.indexOf("initial.status === 'completed'");
const claimAt = decideRegion.indexOf('claimApproval(');
check(
  replayAt !== -1 && claimAt > replayAt,
  'completed approval replay returns before claiming or rerunning the transfer'
);

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
