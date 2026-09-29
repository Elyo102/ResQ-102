# Reserve duty shift — 42H.44 integration

Local-only candidate. No cloud, push, deployment or worker-data access.

## Provenance and scope

- Full source baseline: `efbe5ce34147422901bb777ce5b9eafd0ca38445` (42H.44).
- Branch: `codex/reserve-shift-42h44`.
- Feature source: `1d4e8e9dd93f17508efc79e03c6a60693390ac3d`.
- Semantic port only: reserve_shift product behavior and its tests.
- Excluded: old 42H.30 baseline fixture repairs, provider receipt and CI setup.
- Two connected internal reviewers independently approved the pre-port plan.
  They are not evidence of external Claude/Grok/Gemini participation.

## Preserved baseline contracts

42H.44 rejects equal clocks without an explicit later-day offset. This port does
not restore the older implicit-24-hour inference. Ordinary full-day UI consent,
configured schedule offsets, dual-super/live-employee authorization, asynchronous
freshness checks, existing HR refresh and release version remain unchanged.

The new type defaults to 07:00–07:00 with explicit end_day=1; editable single
interval, positive duration up to 24 civil/wall-clock hours, including DST dates.
Existing reserve absence remains 8.5 hours. No migration or new role permission.
Transactional overlap checks read only canonical same-employee neighbors within
two dates; adjacent intervals are allowed. Receipts/CAS and server timestamps stay.

## Prospective release manifest — NOT release authorization

Hosting product files: attendance.html, hours.js, report.js.
Function source files: attendance-hours-calculator.js, attendance-self-service.js,
attendance-corrections.js, new attendance-reserve-overlap.js (under functions/).
Affected mutator exports: mutateMyAttendanceDay, mutateMyAttendanceMonth,
correctAttendanceDay, correctAttendanceMonth; current region europe-west1.
No Rules/index/Storage change, unrelated Functions or worker-data backfill.
Version/SW release stamping is not included in this local integration.

The full 42H.44 baseline above is rollback provenance, not GitHub main and not
the filtered public Pages commit. A plain baseline rollback is only safe before
new reserve_shift records are written. Once such records exist, its old
calculator/UI do not support the new type: do not blindly restore that baseline.
A separately approved and tested compatibility rollback must disable new entry
while retaining reserve_shift reading/calculation support (or provide another
data-compatible plan). No such rollback bridge is implemented by this local
port. Do not delete, migrate or reinterpret existing worker records to roll back.
Before any future release, clean reauthentication,
fresh generation-pinned Function/config capture, scoped rollback archive and
the clean-tree release:validate attestation are still required. No prior archive
or historical live asset match substitutes for that fresh release preflight.

## Validation

Feature tests are registered additively in the existing attendance:corrections,
browser and Rules chains. 42H.44 has no test:all/Playwright CI aggregate; the local
equivalent is the complete existing Rules chain plus existing browser chain.
The mandatory release:validate script is unchanged. Results recorded below only
after execution; local mock/emulator checks do not prove real-device or live
authenticated callable behavior.

- Locked offline dependency installation: passed; inherited dependency
  deprecation warnings were emitted (node-domexception, uuid, glob).
- Initial focused pure/mock tests: 82/82 passed.
- Initial native emulator run: first 9 checks passed; authorized read fixture
  failed because the synthetic users lacked current terms-consent markers.
  Both reviewers approved fixture-only seed/cleanup correction; Rules unchanged.
- Native emulator rerun: 11/11 passed, including real transaction concurrency,
  month-boundary overlap, replay/CAS, owner/HR read and direct-write denial.
- Complete Rules registry: 16/16 suite entries exited 0 (includes native reserve).
- Actual-source browser harness: 30/30 passed at 360/1280 under pinned Node 22;
  synthetic transport, no actual iPhone or authenticated cloud execution.
- Complete attendance:corrections chain passed, including preserved super-account
  live-employee authorization tests and new feature tests.
- Full all attempt 1: failed in unchanged HR invitation test (12/13). The test
  used an LF-only extraction delimiter against CRLF index.js. Both baseline blob
  hashes matched efbe5ce. Both reviewers approved one in-memory newline
  normalization in hr-personal-invitation-service.test.js; all assertions intact.
  Its focused rerun passed 13/13. No old 42H.30 repairs were imported.
- Full all attempt 2: earlier groups through browser/mobile/HR/maintenance passed;
  failed late in saas:capacity at release-preflight-42h42.test.mjs because raw
  Function options from CRLF working tree were compared with LF git-show text.
  Both unchanged baseline blobs were verified; two reviewers approved only
  in-memory currentSource newline normalization. Exact options and security
  assertions remain. Its focused rerun passed 83/83.
- Those two test-only newline normalizations are the only baseline fixture
  repairs; no product, provider receipt or old 42H.30 fixture was changed.
- Static: complete, exit 0. Full all attempt 3: completed with literal exit 0
  on the frozen executable inputs, including the complete browser/mobile chain.
  This is a full run, not a composed prefix/suffix result. No attempt 4 ran.
- The local test:all equivalent is complete: existing Rules registry 16/16
  plus existing browser chain within the successful full all run. No literal
  npm run test:all command exists on this baseline or is claimed to have run.
- Both independent internal final reviews approved the unchanged code and the
  two assertion-preserving fixture repairs, conditional on full all exit 0;
  that condition is now met. Only this factual documentation changed afterward.
- No release attestation, push, deployment or real-device verification occurred.

Completed log SHA-256 fingerprints (logs retained locally, not publication assets):
- Evidence directory: ../../outputs/reserve-shift-42h44-evidence (from worktree root).
- reserve-full-all-3.log: 766762880516683b98b93d7ee49d802a0aea02b8a7a707e3568587a4dc3451f7
- reserve-static.log: 6ca66029c009db87a9b933b143c06218f24adfba59c11d5f02a4878214464a60
- reserve-rules-all.log: 47c122faaa8a2076c471627d020a9031eaeb955aa246faddf0c7fa755c5a5189
- reserve-native-2.log: 7a3a48fd746f891f6001dbfe507159f839fffac062baececbb69c027446ccd57

Rules negative tests intentionally emit PERMISSION_DENIED diagnostics. Passing
their assertions is not a claim that raw logs contain zero error strings.
