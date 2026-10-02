# Unified execution checkpoint

## Clean-environment continuation — 2026-10-02

Further differential closure: bulletin rendering now type-checks display metadata
without altering raw records/message bodies.81 boundary checks,46 compatibility
checks and a contained malformed-message/reply browser scenario passed; two
independent POST reviews found no blocker in this narrow change. E10 remains
partial for callout decoding and broader callback isolation.

Hosting packaging: reproduced two unexcluded emulator sidecars; exact exclusions
and local HTTP404 regression probes now pass47 privacy checks. No production
exposure was inferred. Two independent target reviews resolved all8 transitive
questions against local baseline023ed2: include markStationReady, exclude7 unchanged
call graphs.79 semantic targets remain provisional until current cloud baseline
and compatible encrypted rollback are verified. See DEPLOYMENT_TARGET_REVIEW_20261002.md.

External release prerequisites remain unchanged: recoverable encryption material
for the mandated readback-verified rollback archive; verified HMAC runtime secret
access/binding (existing enabled version1, no regeneration); real App Check and
safe Auth/client reauthentication evidence; physical-device checks; measured DR;
owner/legal retention policy. These cannot be represented by mock passes. No
secret payload, IAM mutation, employee write or product deployment was performed.

Base e94988085d7413ba50ffdb89c564936489991194 was cloned into a separate detached
checkout. All three lockfiles installed with explicit Node22; all10 declared
entrypoints passed there (138 local assertions/scenarios), with no tracked drift.
See E01_CLEAN_CHECKOUT_20261002.md for environment, initial npm launcher mismatch,
remaining lifecycle-script/deprecation caveats and the deliberately partial scope.
This is fresh-environment evidence, not an unnecessary repeat on unchanged inputs.
E01 remains PARTIAL until the full frozen-candidate reproduction is complete.

Conservative development indicator:22/57 (38.6%, rounded39%) have retained product
implementation or locally tested implementation in the named scope: H01-H09;
E04,E06,E07,E08,E15,E17,E26,E27,E28,E30; S01,S02,S04. This is a source-development
indicator only, not22 accepted release items. Open integration, environment,
coverage and operational caveats on those rows remain binding. All partial and
unclassified rows are excluded from this numerator. Formal frozen gate:0/57.

## Follow-up local validation — 2026-10-02

Integrated milestone634bd04 is committed and pushed on codex/unified-enterprise-20261001. The earlier integration paragraphs below are historical. Formal frozen release gate remains0/57; no product deployment occurred.

E10 timestamp overflow in bulletin messages/replies was reproduced (13 failures among27 boundary cases), then fixed at the timestamp decoder. Targeted results:27/27 boundary tests,46/46 compatibility assertions, and one contained Chromium scenario covering malformed message/reply timestamps, valid siblings, fallback dates, loading completion, preserved unsent draft and subsequent valid snapshots. Logs:bulletin-time-before-20261002.log,bulletin-time-after-20261002.log,bulletin-compatibility-20261002.log,bulletin-time-browser-20261002.log. This does not close remaining malformed display-field/callout decoder cases or prove physical Safari behavior.

Product-only E00 input validation is a partial independent contract, not the donor control-plane gate or a fresh installation. Its final unit checks passed13/13 after explicit emulator/rules/index inputs were added. Actual working/index validation passed for50 declared files including10 entrypoints (product-inputs-final-20261002.log and product-inputs-checkout-20261002.log). Two reviews found no blocker within this declared partial scope; raw-byte and base-HEAD identity limitations are documented. E01 remains OPEN. The prior integration-evidence-20261002.json describes milestone634bd04 only, not these follow-up changes.

## Current integrated evidence — 2026-10-02 (supersedes older status paragraphs)

HEAD at verification: 3a4575b1920c84c9121341525e163d5ebe562138. HR48, replication and E07 integration remain local until the next explicitly enumerated commit. Formal frozen release acceptance is 0/57; no production mutation, secret payload read, paid dispatch or employee operation was performed. Development percentage is not recomputed from test counts.

E07 is now implemented with durable operation, payload and attempt identities; final provider entry checks both attempt ownership and current canonical content. ACK/error/suppression cannot overwrite a replacement attempt sharing the same lease. Unknown legacy acceptance and expired provider-entered attempts retain explicit duplicate-risk history. This is at-least-once, not exactly-once delivery.

Native demo Firestore evidence: outbox operation14 and supplemental boundary4 pass in sequence with exclusive-empty guard queues and owned shared-cursor cleanup (`e07-isolation-20261002.log`). The new boundary cases reject changed retry content after uncertain send and do not double-count expired-attempt risk. Existing E08 ACK8 passed against these runtime bytes in `e07-operation-repair2-20261002.log`; it was not rerun for test-only cleanup. Earlier fixture failures are retained. Provider calls are synthetic; no physical push is proven. Trial Auth outcomes and early authority-cancellation/replaced-attempt combinations remain additional coverage gaps.

Replication adds selected-month editing independent of the default active month, busy/pending edit guards and midnight-before-activation rejection. Native singleton/monthly boundary5 pass (`rep48-boundary-20261002.log`); selected-month mobile mock-browser2 pass (`rep48-browser-review-20261002.log`). Successful publication receipt replay survives a date change. These complement previous generator20, controlled-routing3, native replication7/edit13 and HR23/19/22/47 + browser52 evidence; they do not replace the integrated release gate.

All new native suites are registered additively in rules-test pretest; pure/control/browser replication suites are also registered. Updated reviewed HR source pins, version reference count and trial fence assertion reflect the changed interfaces, without removing rejection checks. The old trial three-argument literal failed once; it now asserts the final four-argument true provider-entry fence and attempt ownership, and passes.

Provider source receipt resealed only for index.js, schedule-runtime.js and hr-domain-dispatch.js after affected boundary checks. The other five receipt hashes are unchanged. Current extracted push10, callout blocked replay, trial wiring, HR nudge wiring16, SMTP wiring10, source compatibility131 and receipt checks pass. HR dispatcher47 native evidence covers the current HR source hash. The registry contract153 passes (`unified-registry-20261002.log`), explicitly LOCAL_VALIDATION_PASS / PRODUCTION_BLOCKED, not 153 real release steps or the57 acceptance items.

HMAC metadata: one failed versions request was followed by a successful authorized CLI metadata-only check: RESQ_METRICS_HASH_KEY version1 ENABLED. No duplicate creation. Secret-level IAM metadata was readable and returned no direct bindings; inherited permissions were not established. Two bounded direct recordMetrics metadata requests returned local status500 with no upstream status. The alternative standard CLI functions:list succeeded and confirmed gcfv2/europe-west1, runtime service account52676411962-compute@developer.gserviceaccount.com and no current HMAC binding. Source binding remains present and undeployed. IAM readiness is not closed; no IAM mutation or secret payload access occurred.

Still required: exact unified target/rollback inventory, unchanged-evidence fingerprints and clean candidate; remaining ledger implementation/conditional decisions; real App Check readiness, dedicated safe Auth revocation verification, physical devices, DR and retention decision. Do not treat these as passing mocks or issue a partial production deployment.

Additional local closure: E19 focused offline classification is recorded, including the personal-data roster localStorage exception; E20/E29 durable action/recovery choices remain unresolved. E21 false post-publication delivery claim is replaced by prepared-notification count with explicitly unverified delivery. Two PRE reviewers approved the factual correction; contained375/430px apply/receipt tests pass2/2 (`rep48-browser-receipt-20261002.log`) with no success before receipt and exact preview/base/digest checks. No layout redesign or provider/device receipt claim.

`unified-deployment-impact-20261002.json` is explicitly non-executable:78 provisional export targets (including all previous12) and8 unresolved transitive candidates. All86 names exist in current index.js. The named production baseline has not been reconciled to current deployed bytes. Rollback must retain shift_change, course assignment readers, generation cursors, replication cutoff, attempt provenance and create-only audits. This inventory is preparation, not permission to release78 Functions blindly.

`integration-evidence-20261002.json` pins30 changed source inputs and9 local evidence logs. It is not a release attestation. Normal emulator SIGINT and Git EOL notices are retained rather than reported as zero warnings. Earlier failed fixture logs and containment directories remain local and are not wholesale published.

## Claude42H48 integration checkpoint (2026-10-02)

Working base remains 3a4575b; all integration edits are uncommitted. No production deployment, secret value access or new secret creation occurred. Final frozen-candidate gate remains 0/57; the previous 53% estimate is stale after scope expansion.

Imported shift-change request/decision and notification fixes, and connected server-side monthly replication to preview/apply and controlled monthly-authority routing. Durable HR create replay now precedes moving date validation; ineligible existing replication targets are removed rather than silently retained.

Recorded local evidence: HR native emulator 23 shift-change, 19 requests, 22 attachment-parent and 47 dispatcher scenarios passed; HR mock browser 52 passed. Replication generator 20 passed, native replication 7 and edit integration 13 passed. These are scoped local results, not the final unified gate or device/production verification.

New controlled-routing synthetic tests passed 3/3: compatibility selection, monthly selection, and changed-authority rejection before response. New Chromium mock-callable scenarios passed at 375px and 430px, verifying selected-date publication identity, no client-generated edits, explicit manual override and no captured console/page errors. Evidence: rep48-browser-drawer-20261002.log. Initial runs exposed two UI integration defects: controls missing when setup finishes after the board, and drawer hidden under the station tab. Fixed using cached-row repaint without another server read and switching to management before opening the drawer. The initial synthetic station key was also corrected; failed logs retained.

Latest cleanup clears cached rows on month reload and removes diagnostic-only test mode; final targeted browser pass is 2/2 (rep48-browser-final-20261002.log). git diff --check exits0 with existing LF/CRLF conversion warnings, not a zero-warning claim. Browser scripts are individually registered; full gate/CI registry integration remains pending. Outstanding: full monthly runtime coverage, identity/retry browser cases, updated source pins and release inventory, E07 provider-attempt identity, HMAC runtime access, real safe-test Auth revocation, remaining operational/device/DR requirements and complete frozen57 gate. No commit/push or release-ready claim.

## Latest instruction-file update

Subsequent direct user authorization was independently verified in primary thread 01a03a36-f0bb-7841-9a23-8ecd10bb301b (messages 01a0f931-6f80-7cc0-8cf5-c8247f8ed8f0 and 01a0f936-2bae-7030-af5e-ba828016d34a). It permits system CLI tools, scoped secret management, pushes to the existing isolated branch, and requires ingesting the Claude42H48 bundle. AGENTS isolation clause now reflects this newer authorization; the temporary restriction described below is resolved, not a current blocker. All prior57 requirements remain mandatory. The previous53% development estimate predates the added scope and must not be presented as a current recalculated percentage.

AGENTS.md was replaced with the exact owner-requested strict project-isolation text and read back successfully. Verified starting HEAD is 3a4575b1920c84c9121341525e163d5ebe562138 (clean before this documentation edit); preserve it rather than resetting to its parent 5dd2544. These documentation edits are not committed.

The new instruction removes the previous system-tool exemption. The in-repository .git pointer locates shared metadata outside this worktree, and the pinned Node/Firebase runtimes are sibling directories. Do not access those external paths under the new boundary without a scope clarification. No further Git mutation, cloud operation or test execution was performed after this instruction replacement.

Source inspection confirms recordMetrics still binds RESQ_METRICS_HASH_KEY through defineSecret and that identity-coordinator contains revokeRefreshTokens. This is source evidence only, not runtime IAM or real-token validation. Existing provisioning evidence above is historical; do not duplicate secret creation.

The existing release-targets-42h47.json is not a unified deployment manifest: it lists twelve hours functions and explicitly excludes firestore-rules and indexes. It cannot authorize or attest the broader 57-item release. Estimated 53% is the previous development estimate, not a newly recomputed closure count; final integrated gate remains 0/57. No deployment occurred.

Parent candidate:5dd2544. Estimated development53%; final integrated acceptance0/57. This is not a frozen release or production readiness declaration.

The owner-specified AGENTS.md system-tool exemption was independently read back; shared Git and required runtime access restored. No unrelated personal data or .resq-listeners accessed.

## E08 partial: truthful durable acknowledgement

Both schedule and guard delivery now report sent:true only when their own lease/status transaction actually persists sent. A positive provider result followed by replaced lease, cancellation or deleted row returns provider-accepted-unacknowledged without overwriting newer state or another send. Existing recipient, publication, monthly authority, retry and trial boundaries unchanged. Audit writes unchanged and create-only.

8 new native Firestore emulator scenarios PASS: schedule/guard × normal ACK, changed lease, cancellation, deleted row. Normal ACK replay sends once; raced records remain exactly unchanged. Provider is a synthetic callback, not FCM or device delivery. No exactly-once claim.

Initial fixture run failed before provider because publication/guard IDs violated the existing minimum length. Repair1 changed only synthetic IDs; all8 then passed. No previously green component suite rerun.

Evidence: outbox-ack-emulator-20261001.log (failed fixture) and outbox-ack-emulator-repair1-20261001.log (PASS), SHA25661d78590ac3ef964e2d20d58d1b1fa981a718bbf43ad4e93cf30bfd2e562162a. Expected emulator SIGINT shutdown notice retained. Tests registered additively in rules-test pretest.

## Configuration and remaining work

HMAC secret RESQ_METRICS_HASH_KEY version1 was created and metadata-verified in the previous authorized run. Do not regenerate it. Current source already binds it only to recordMetrics; application deployment and runtime access readiness remain separate. No secret values appear here.

Token revocation code and prior local evidence retained. Real Auth refresh-token invalidation and client reauthentication are not validated with employee accounts or simulated claims. Dedicated safe test-identity evidence remains open.

E07 operation/payload/attempt identity and unknown provider outcome tracking are not integrated by this E08 partial fix. Same-lease attempt/digest fences, changed-payload conflicts and crash/retry evidence remain required. Control-plane, physical-device, DR, retention decisions and other mandatory57-scope items remain open. Do not silently exclude them or promote before the frozen integrated gate.

Next: scoped E07 integration preserving the verified E06 traversal and create-only audit fixes; then remaining requirements, exact candidate freeze and full required release evidence. No production deployment occurred.
