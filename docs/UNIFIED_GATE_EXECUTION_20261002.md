# Actual integrated execution, 2026-10-02

Base: a5cd149345362b36245f9d73a59be9622208b77d. Reviewed runner/identity
fixture repair commit: fed4775. Subsequent scoped repairs are recorded below.
This document is NOT a frozen-candidate attestation or a 57/57 release result.

## Commands and results

- Actual `npm --prefix tests run release:validate` under Node22 exited1 with
  GATE_KEYS. The historical registry omitted the approved additional tests.
- Fixed additive registry retains every historical command, order and multiplicity.
  Exact registry equality, native branches, network ledger and unchanged-tree
  attestation requirements remain. Targeted contract:14/14 PASS.
- Actual contained application branch reached onboarding and exposed stale doubles:
  numeric audit timestamp, then missing tx.create. Test-only atomic staging,
  collision rejection and replay checks passed23 and31 respectively. Earlier
  Auth operations are not represented as rolled back by Firestore failure.
- The independent sanitized native branch passed3/3 suites, including local
  Git/archive/restore fixtures. This is NOT a production backup or project-loss DR.
- Full rules-test pretest and test scripts ran in a fresh demo-resq Firestore
  emulator on loopback8199, exit0. Expected permission-denial diagnostics and
  expression-limit denials remain in the log; this is not zero-warning evidence.
- The remaining registered application plan was executed once with failure
  collection:143 steps PASS,12 FAIL initially. Failed steps were not skipped or
  converted to passing. This aggregate was executed across a working repair tree,
  not a frozen source tree; no attestation was issued.
- Unexecuted inventory tail:23 command leaves PASS,0 FAIL. Earlier successful
  inventory leaves were not needlessly replayed for each fixture repair.
- Previously unreached browser tail completed:47 command leaves PASS,0 FAIL,
  exit0, including phonesweep at320/360/390. No final attestation was issued.

## Differential repairs and evidence

- UX source assertion follows current-cache fallback rather than requiring unsafe
  global cache lookup. UX pass includes30/30 PWA lifecycle checks.
- Calendar isolated mutation fixture copies its exact new dependencies; all53
  mutants retained/caught. Policy/mode fake transactions support atomic create:
  73 and128 assertions PASS. Hidden-authority inventory explicitly verifies
  replication delegation and both manager gates:203 PASS.
- Source EOL regression:46/46 PASS,14 probes on LF and actual CRLF copies.
- Telemetry allowlists explicitly add previewScheduleReplication on client/server;
  no arbitrary callable admission. Ops contract PASS; security289/289 PASS.
- Fleet worker double supports staged addAll, cache match, timers and waitUntil:
  18 PASS. It remains a simplified single-cache fixture.
- HR incomplete-generation test now supplies a matching digest, so the separate
  digest guard cannot hide a missing completion guard. Complementary digest
  negatives and positive control retained:45 PASS. Updated exact N+1 mutation
  needle preserves transaction authority:19 mutants caught,0 survived.
- Report keyboard repair1 (bounded wait alone) FAILED and is preserved. Controlled
  A/B evidence isolated first-paint/input readiness: immediate key remained at0;
  fonts+two animation frames allowed one trusted ArrowLeft to reach negative scroll.
  Repair2 retains one key, focus/overflow/movement and column-reachability checks:
  38/38 PASS, zero captured browser warnings/errors; not physical Safari evidence.
- Historical preflight test accepts only exact reviewed option deltas for two
  App Check additions and recordMetrics HMAC binding; all other options remain
  exact.83/83 PASS. Production preflight readiness logic is unchanged.

## Evidence locations and outstanding boundary

Logs retained in the parent work directory: unified-gate-a5cd149-20261002.log,
unified-gate-contract-repair1-20261002.log, unified-application-a5cd149-repair1-20261002.log,
unified-application-a5cd149-repair2-20261002.log,
unified-application-onboarding-repair1-20261002.log, unified-native-a5cd149-20261002.log,
unified-rules-a5cd149-20261002.log, unified-remainder-20261002.log,
unified-inventory-tail-20261002.log, unified-eol-repair1-20261002.log,
unified-fleet-repair1-20261002.log, unified-report-scroll-repair1-20261002.log,
unified-report-scroll-repair2-20261002.log and unified-browser-tail-20261002.log.
Some child-agent targeted runs are preserved in tool output rather than standalone
repository logs. The browser tail terminal result was captured from the original
running process and its retained log; it was not rerun to obtain this result.

BackupSealMaterialAvailable=false was checked without revealing any value. No
encrypted readback-verified production rollback archive has been created. The
bounded ops/release source inspection found only direct environment/options
injection for RESQ_BACKUP_SEAL_PASSPHRASE, not an established Secret Manager/KMS/
DPAPI resolver or recoverable key escrow. Synthetic fixture keys were not used
as production recovery material. A protected recoverable value or an explicitly
configured recovery-secret reference is still required; never send it in chat.
The
79-target manifest is still non-executable pending real baseline/rollback and all
57 acceptance requirements. Existing open feature/device/Auth/DR requirements
remain in the authoritative ledger; passing these tests cannot erase them.

No production deployment, employee mutation, secret payload read or paid API call.
No blanket source freeze, no final57 acceptance and no new release receipt.
The requested AGENTS reporting-section removal was denied by the permission
reviewer even after independent verification of the human message; it was not
bypassed and AGENTS.md remains unchanged.
