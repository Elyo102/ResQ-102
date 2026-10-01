# E06 differential source-runner checkpoint — 2026-10-01

Historical status at first checkpoint: uncommitted integration, NOT release-ready. Parent 458663d retains all prior verified changes. See resolution below.

Only the changed guard-outbox assertion block from tests/schedule-runtime-source.mjs was executed using a temporary Node VM runner. No full source suite was rerun.

1. Initial attempt failed at the obsolete created_at ordering assertion. The assertion was updated to require transactional document-ID ordering, limit100 and startAfter; no safety assertion was removed.
2. Repair1 run reached a missing VM binding: integration. This was a runner defect, not a failed product behavior assertion.
3. Repair2 run reached a missing VM binding: backup. The maximum two repairs is exhausted. No further run, commit, push or deployment was performed.

The temporary runner was not saved into the repository and is abandoned. Do not label this check green or silently reset its attempt count. A future authorized diagnostic plan must inspect the complete callback lexical dependencies before running anything. Do not lower assertions or change product thresholds to hide this harness defect.

Preserved differential evidence:
- Helper:7 native emulator cases previously passed.
- Controlled runtime:3 native cases passed, including unchanged-status tail101 and authority drift rejection before delivery.
- Direct runtime:3 native cases passed across schedule_outbox, guard_notification_jobs and guard_outbox; invalid payload tail101 is cancelled, zero provider calls. This is not positive provider-delivery proof.
- Rules:24 expected permission denials passed for anonymous/member/HR/super, plus valid-super positive control and unchanged cursor.
- Changed controlled synthetic fixtures:6 passed.
- Changed trial/batching fixtures:4 passed.
- Backup classification:2 targeted tests passed; coverage184 paths.

Logs are under C:/Users/User/Documents/Codex/t-hours/ with prefixes unified-outbox-scan-initial-, unified-outbox-controlled-, unified-outbox-runtime- and unified-outbox-rules-, suffix20261001.log. Synthetic results are in this thread's command outputs.

Residual limits: transactional cursor is traversal, not ACK. Crash after cursor advance delays work until wrap. Continuous insertions can postpone wrap; no bounded latency/FIFO/exactly-once claim. Guard traversal ordering changes to document path. Corrupt cursor fails closed. Global cursor requires exclusive fresh emulator fixtures. No live index-readiness, provider, device, or production claim.

Production rollback/backup and final57-item gate remain open. Do not deploy partially. Do not revert other agents' changes or discard passing product work solely because the temporary runner is incomplete.

## Authorized resolution — same day

The owner explicitly authorized a new direct runner repair after the recorded cap. Two independent PRE and POST reviews approved an exact-name CLI selector inside the original source module. The abandoned VM runner is not retried: the original module now supplies all lexical dependencies. No production code changed for this repair.

`node tests/schedule-runtime-source.mjs --check-exact "guard notification outbox is independent from the monthly publication outbox"` passed once. Four new negative cases (unknown name, missing name, unknown flag, extra argument) rejected with exit1 and no success message. No-argument mode still requires all131 checks; gate commands unchanged. This is source compatibility evidence for E06 only, not full-suite success. Historical failures above remain valid history.

Evidence: `C:/Users/User/Documents/Codex/t-hours/unified-outbox-source-authorized-20261001.log`, SHA256 `4bd3fd10c5a2de45430d7c81cc250ada863aa3d3b068d0d3d8294dbcbbae7a98`.

E06 is locally tested and approved for a scoped isolated-branch commit; the full unified release is not frozen or production-approved by this evidence.
