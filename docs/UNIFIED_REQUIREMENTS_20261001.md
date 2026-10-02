# Current scope supplement — Claude 42H48

Authoritative direct owner authorization: primary-thread message 01a0f936-2bae-7030-af5e-ba828016d34a. Candidate baseline 3a4575b; donor a2cc43ef85e646fce53d439d3fb56cbf3ac1d259 on 619e333. All original 57 rows below remain. The former53% estimate predates this expansion; current percentage unavailable until subcriteria are reconciled. Final frozen gate0/57.

The following mandatory subcriteria extend E18/E24/E25/S03/U02/U03; they are NOT extra independent passing gate items. All start OPEN.
- HR48-01: shift_change request UI/server, server-fixed subject,250-character reason, Israel today through+92days, active sub-station within authenticated regional station, reject foreign station/date/attachments.
- HR48-02: live schedule_access manager appointment inside transactions; manager restricted to shift_change filtered inbox/read/decision/reply, not HR counters/status or other private requests; revoked/disabled identities denied.
- HR48-03: no self-decision; CAS/idempotency/no duplicate notification; optional250-character decision reason; reversal only before requested day passes.
- HR48-04: approval closes request but does not edit schedule; explicit UI notice; never absence months/hours.
- HR48-05: station_shift recipients are live HR/schedule managers; actor/recipient revalidation; setDecision notification regression for sick/reserve/vacation/course/extended absence preserved.
- HR48-06: schedule day-card deep link opens prefilled request; returned can_handle_shift controls filtered inbox; no extra public permissions.
- REP48-01: integrate pure replication module; same rotation, sub-station/month, server Israel today; authenticated callable using current publication, policy and people.
- REP48-02: skip manual days by default; override explicit; skip absent/departed/other-station people and invalid roles; preserve already matching engine slots.
- REP48-03: previewScheduleEdit/applyScheduleEdit pipeline; exact digest/CAS/live appointment, no stale-source apply; no silent partial result above400 actual changes.
- REP48-04: approved row button, override choice, summary of changes/days/skips/gaps; reviewed preview before apply.
- REP48-05: create-only audit origin=replicate/source_date; publication/outbox activation failure preserves active pointer and blocked unsent jobs.
- QA48-01: full differential donor/integration verification; preserve old failures separately; investigate actual current failures without deleting features or lowering acceptance.
- OPS48-01: scoped function/Hosting target manifest; O(N) schedule-access delivery read cost recorded; rollback after usage retains shift_change readers; no old-version invalidation of existing requests.

Current integrated local evidence (2026-10-02): HR48-01..06 implemented with native shift-change23, requests19, attachment-parent22, dispatcher47 and mock-browser52 passes. REP48-01..05 implemented with generator20, native replication7/edit13, controlled routing3, midnight singleton/monthly5 and mobile mock-browser2 passes. QA48-01 is partial: targeted checks passed, final integrated gate/CI/device and additional identity/retry cases remain open. OPS48-01 remains OPEN for final target/rollback/cost inventory. These subcriteria do not establish completion of their parent57 rows.

Donor historical pass counts are not current integrated evidence. iPhone/Safari/device push/CI/full release remain separate. Bundle imported as isolated handoff ref only; no merge/deploy at inventory time.

---

# ResQ — Unified release inventory, 2026-10-01

## Scope and verified execution checkpoint

The owner's latest unified-release instruction was verified in the main thread
`01a03a36-f0bb-7841-9a23-8ecd10bb301b`, user turn
`01a0f7ae-6982-7443-b404-b26a35a567e0`: complete the existing Enterprise/hardening
requirements and approved product features before one integrated release. No
intermediate hours-only deployment. This inventory is not release approval or
evidence that every requirement is implemented.

Additional owner turn `01a0f7b8-286e-7c33-83e6-9e0d2e633c0b` explicitly adds the
five security items S01–S05 below, differential validation, and one coordinated
Rules/indexes, Functions, then Hosting release. No blanket key rotation or data
deletion is implied. Local integration now uses `codex/unified-enterprise-20261001`
in the product worktree; the original09ac reference remains preserved.

### Latest local implementation checkpoint

Latest isolated branch HEAD: `458663d`, pushed without main/dev merge or deployment.
S03 four source/policy/mode/cutover audit writes now use tx.create;5 NEW native
collision/replay scenarios PASS initially with two POST approvals. Historical
audit collisions preserve business state and outbox; old receipt replay remains.
ALREADY_EXISTS after receipt removal is intentional fail-closed behavior, not
permission to auto-generate another request. Source child/foreign-stage cleanup
was source-reviewed; fixture proves active children/parent inventory, not every
aborted orphan. Rollback must retain create-only behavior.
S01 differential installed-SDK HTTP test:14 PASS, two actual POST approvals.
Actual onCall HTTP rejection runs before business/Terms/identity reads, controlled
valid verifier results forward App Check context, and Terms/disabled/Auth denials
remain. Synthetic verifiers are not real provider/domain/token readiness proof.
Expected SDK denial warnings retained. Additive gate registration151 steps PASS.
No prior green component test was rerun; no permanent-green waiver accepted.
Donor sweep still finds51 porcelain entries with8 staged/13 unstaged files and
untracked control-plane/operator material. None was discarded or blanket-staged.
E10 home-fault normalization now isolates a conversion-failing row instead of
aborting the snapshot.7/7 contained browser scenarios PASS and two POST reviews
agree. No new query, visual, permission or logging behavior. Counts remain valid
rendered rows, not authoritative totals. Other decoder streams remain OPEN.
E09 adds independent small-graph matching oracle, depth-six adversarial chain,
mutation check and full baseline parity at3000 people/500 slots/30 days. Initial
Node22 PASS; two POST approvals; additive150-step gate contract PASS. Local
instrumented runtime934ms and3757500 candidate visits are measurements, not
production limits. Negative heap delta is not peak memory. Planner unchanged.
E28 pins build-context fingerprints, atomically commits page rows/checkpoints,
and returns generation-bound cursors.44 summary +7 synthetic scale +3 native
checks PASS with two independent POST approvals. Native107-user fixture reads
missing monthly-report documents; it does not prove107 populated payroll reports.
Final source recapture adds bounded read cost and detects observed drift only,
not a global historical snapshot or the final-read/activation race.
E17 invocation-local controlled-outbox runtime reuse:17 synthetic checks and3
native Firestore selector/fence checks PASS.100 identical selections construct
one runtime instead of100; fresh per-job selections and transaction fences remain.
No cross-invocation cache, provider-delivery proof or Firestore-read savings claim.
E27 service-side impossible-date rollover rejected before projection:69 service
checks and85 native runtime checks PASS initially, no repairs; no timezone/schema
migration. This does not claim every legacy date reader has been hardened.
E26 precise event-version corrective CAS:10 extracted-handler unit checks and10
native direct-client Rules scenarios PASS initially, no repairs. Additive test
registration and149-step release-script contract PASS. Existing notification
delivery limitations remain; not exactly-once delivery or native trigger race proof.
E30 `e93d575`: live UID fences before auth observers update, including pagination
success/error/cache paths. Focused regressions and5 contained browser scenarios PASS.
E15 `ec4fb3c`:54 parity/service checks and85 native runtime checks PASS.
Synthetic monthly element visits decreased7688->124 rows and3844->62 events;
these are CPU fixtures, not production timings or Firestore read reductions.
E04/E05 committed as `70a1522`. All following older HEAD checkpoints are historical.

2026-10-01 continuation: `dd6f27b` adds deterministic transaction-created
identity completion events (five operation kinds), server-only Rules and backup
classification. Local helper5, backup32, native identity31 and20 expected client
denials PASS;183 paths classified. No immutable Admin-SDK/WORM claim and no
production audit backfill. Source audit is not proof of every shift edit path.

`4921847` plus normalization-only correction `e0e326c` enforce the remaining29
App Check declarations: exact194 inventory,288 source checks and18 mutations
PASS. Terms15, auth8, diagnostic5 and client-source checks PASS. One stale role
assertion failed initially and passed repair1 with actual negative scope cases
and a valid HR control. Real provider/domain/token acceptance remains OPEN.
An accidental CRLF-only packaging diff was corrected on the isolated branch;
history was preserved, no product release occurred. Future compound commands
must abort on failed diff checks.

E04/E05 working integration preserves all47 assets and adds atomic required
cache installation, a5000ms response-header deadline, current-cache-only fallback
and reserved Auth-route exclusion. Initial contained browser run33/33 PASS, no
network-containment violations, no repairs. Body loading and optional install
fetches are not bounded by this change; final release still needs a new cache
stamp. This is local evidence, not final release acceptance.

Update: `fe2ff69` pushed to the same isolated integration branch. S05 now has a
pure advisory retention-decision API,31 unit tests PASS, two PRE/POST reviews.
All182 existing catalogue rows and their restore digest are unchanged. Unknown
paths block; unresolved policies retain records. No TTL, scheduler, deletion or
retention engine was activated. Actual retention durations/policies remain an
owner dependency, not an invented legal or operational guarantee.

The user's new limit is recorded in `MASTER_EXECUTION_STATE_20261001.json`:
initial failure plus at most two repair attempts; third failure reverses only
the attributable owned change, logs the blocker and proceeds to unrelated work.
Historical exhausted issues do not reset. All mandatory gates must still pass
before production. Existing ten-minute reporting automation verified ACTIVE;
no duplicate automation created.

Integration HEAD `1c69033` was pushed only to
`codex/unified-enterprise-20261001` on `Elyo102/ResQ-102`. Product worktree is
clean. No main/dev merge, CI dispatch, production or Pages release occurred.

* `51c298b`: HMAC-only new metrics ingestion;31 unit +51 source/mutation checks
  passed, two PRE/POST reviews, index syntax and diff hygiene checked.
* `ff7070b`: three self-target revocation skips removed;28 native Firestore
  integration checks passed with fake Auth. Tests prove phase/retry behavior,
  not actual production-token invalidation. Expected emulator SIGINT on shutdown.
* `1c69033`: role assignment awaits live actor authority before target lookup;
  stale signed privileges are not retained;7 helper/actual-index-prefix checks
  passed, two PRE/POST reviews. Shared Super helper behavior is unchanged.

The latter closes the signed-claims-only entry-gate finding noted below. It does
not make subsequent Auth/Firestore work atomic against a concurrent authority
change. No unchanged broad release gate was rerun for these local patches.
Deployment remains OPEN: S01/S03/S05 and Enterprise integration are incomplete;
S02 requires exact secret/version readiness; expanded target/backup/rollback and
final integrated evidence are not yet ready. Do not deploy the three commits as
an intermediate product release.

**No production deployment, backup capture, employee-data write, or paid provider
request occurred in this execution.** No `hours47-*` capture/deploy journal exists
in the local release state directory. This does not make a claim about earlier
42H.46 deployments in other sessions. No access to `.resq-listeners` occurred.

* Product worktree: `work/resq-hours-production-42h47`, clean branch
  `codex/hours-production-42h47`, HEAD `09ac0fcbcf24b9a4382a38df0b0f6e807fee43e1`,
  tree `ed88d6fa143f910db3652d1c57936c29819400be`.
* Enterprise worktree: `work/resq-ci-review-dev`, branch `dev`, HEAD
  `871a3f7074c6e8a9959dc54493fd57bbc7a99f44`, **dirty**. Common ancestor with
  product: `70d770ec4c70489e3406b1e2c01d4f830f68da40`. Neither Enterprise commit
  `6d826bb` nor `871a3f7` is an ancestor of the product candidate.
* Full local release gate on predecessor `07701a3` / tree
  `c1dc2dd158680c2d92307874e7936e534426bd39`: **EXIT 0**.
  Log: `C:/Users/User/Documents/Codex/t-hours/hours47-release-07701a3.log`.
* CI run `36865522475`: Rules/integration job **SUCCESS**, app job **FAILURE**
  at an immediate focus assertion preceding the product's animation-frame focus.
  This is not an overall green CI run.
* `09ac0fc` adds only a bounded focus wait before the unchanged assertion.
  Targeted contained bulletin browser: **156/156 PASS**, exit0. Earlier launch
  refusals due to missing/relative/inherited containment preload are preserved;
  no guard was removed. Log: `t-hours/hours47-bulletin-focus-verified.log`.
* The local full gate on `09ac0fc` and CI `36870070748` were **CANCELLED** after
  the scope update. They are not failures or passes and cannot issue release proof.
  Historical successful proofs are not relabeled for the expanded candidate.
* New package exists for09ac: `t-hours/resq-hours47-package-7JZAdk`, proof digest
  `19e73bc73ce726f8f91fb50e9b70a43b2ac64fac454d346f06511c75c86e8428`.
  Function ON bytes remain `5c22f5ab0c61ac9eaca5469237927cecf6f322061b8e4e9dbd845e7398c453eb`;
  134 Hosting assets. Declaration comparison changed nothing. This is packaging,
  not deployment. Enterprise integration will invalidate these candidate pins.

## Sources and state vocabulary

Paths below are relative to the relevant worktree. Sources read: `AGENTS.md`,
`PROJECT_STATUS.md`, `docs/ENTERPRISE_RESQ_ROADMAP.md`,
`docs/ENTERPRISE_ROADMAP_20260929.md`, the four `docs/agent-proposals/*.md`,
`docs/TEST_REPRODUCIBILITY.md`, `docs/OUTBOX_FAIRNESS_CONTRACT.md`,
`docs/SWAP_RESILIENCE.md`, `docs/DESIGN_PROPOSALS.md`, `docs/PROPOSALS_2026.md`,
product `docs/HOURS_PRODUCTION_42H47.md` and `docs/release-targets-42h47.json`.

PRESENT means inspected code exists, not that it is integrated or tested here.
HISTORICAL_PASS is bound to its original inputs/environment. OPEN means unresolved
implementation, integration, or proof—not automatically a reproduced production bug.
No item below is silently excluded. Conditional proposals retain their original
measurement/privacy/approval conditions rather than being converted into invented
mandatory architecture changes. All integrated items need a final target manifest.

## A. Approved hours/report/forms functionality to preserve

| ID | Requirement | Evidence/state | Next acceptance |
|---|---|---|---|
| H01 | Ready own report; no visible prepare-draft step; no write on load | PRESENT/product; `attendance.html`, ready-report browser;077 full local PASS | Preserve saved versus proposed/unconfirmed distinction in integration |
| H02 | Edit days and explicitly approve fresh report | PRESENT/product; fresh timestamps, exact intent recovery, stale reconfirmation tests | Preserve partial-save/unapproved failure semantics; never imply fill+submit is atomic |
| H03 | Responsive local export/share/download | PRESENT/product; `attendance-ready-report-browser.mjs`, `report-responsive-browser.mjs` | Preserve HTML statuses and no-write export; physical WhatsApp/mail delivery NOT_RUN |
| H04 | Course dates, red timeline, actual assigned shifts and full scheduled credit | PRESENT/product; `attendance-course-entry-browser.mjs`, course transaction suites | Preserve9/10/11-shift cases, approval snapshot and fresh assignment authority |
| H05 | Reserve/shift-in-reserve green, illness yellow, vacation blue, course red in hours report | PRESENT/product hours fixtures | Preserve hours/report-only meaning, not an unapproved schedule redesign |
| H06 | Actual entry/exit including next-day07:00/08:00/09:00, work duration+8.5 reserve credit | PRESENT/product; reserve/calculator regression evidence | Preserve explicit date duration and no same-minute accidental24-hour regression |
| H07 | Reserve order file/image, existing attachment protections | PRESENT/product; order/HR attachment suites | Preserve size/content/identity/parent/version checks and existing-data readers |
| H08 | HR station-scoped report visibility; existing dropdown/form behavior | PRESENT/product;077 full gate and CI HR integration success | No new role or impersonated employee approval; retain form state/retry safety |
| H09 | Terms1.3, current authorization, rollout switches and compatible readers | PRESENT/product; consent-negative fixtures and toggle tests | Keep admission OFF behavior distinct from reading/processing existing records |

## B. Enterprise product requirements — complete inventory

| ID | Requirement/source | Verified state | Next action/evidence needed |
|---|---|---|---|
| E00 | Safe tracked inputs / sanitized generators (roadmap phase0.1) | PARTIAL product-only contract:13/13 unit checks and50-file working/index verification PASS; donor contract retained separately | Not complete transitive coverage or E01 clean install; no vault/provisioning/log inputs |
| E01 | Actual clean-checkout reproduction | PARTIAL: clean detached e949880 checkout, three lockfiles installed, all10 declared entrypoints/138 local scenarios PASS; E01_CLEAN_CHECKOUT_20261002.md | Full frozen-candidate application/Rules reproduction and lifecycle-script parity remain OPEN; not just an index check anymore |
| E02 | One explicit test denominator and exclusions | PARTIAL; focused `test:all` and full `all` are distinct | Reconcile final registries without dropping existing product tests |
| E03 | Current status and frozen integrated SHA | OPEN; status is historical, dev dirty | Preserve history; produce fresh integrated manifest/status, then freeze once |
| E04 | Atomic required SW shell (phase1.1) | LOCAL_TESTED70a1522;33 browser +30 lifecycle PASS | Preserves47 assets; final release cache stamp and integrated gate OPEN |
| E05 | Bounded network-first/cache fallback (phase1.2) | LOCAL_TESTED70a1522 header deadline5000ms | Current-cache and reserved-route guards covered; response bodies/optional install fetches remain unbounded |
| E06 | Outbox fairness beyond first100 (phase1.3) | LOCAL_TESTED5dd2544 pushed isolated; helper7/controlled3/direct3 native, Rules24denials, synthetic10 andbackup2+184paths PASS | Fresh owner-authorized source runner1PASS and4negative CLI cases; historical VM failures retained. Finite-set fairness, crash-to-wrap delay, no bounded continuous-insertion guarantee. Final index/deployment readiness OPEN. |
| E07 | Durable operation/payload/attempt identities and duplicate visibility | WRITTEN / LOCAL_TESTED current working tree: native14+4 PASS, two reviews; source131 PASS | Same-lease attempt fencing, canonical payload retry conflicts and unknown/expired outcomes covered. Trial Auth/early cancellation combinations remain coverage gaps; no exactly-once/device claim |
| E08 | Provider acceptance versus durable acknowledgement | LOCAL_TESTED3a4575b preserved; affected native8 PASS on integrated E07 runtime | Provider acceptance without own durable ACK remains explicitly unacknowledged; final frozen release and real provider behavior separate |
| E09 | Planner deterministic parity/resource budget (phase1.5) | PARTIAL bea3992; local oracle/parity/adversarial measurement PASS | Production budgets/peak heap remain OPEN; no planner change or capacity reduction |
| E10 | Realtime decoders/invalid-row isolation (phase2.1) | PARTIAL619e333 + bulletin timestamp27/metadata81,compatibility46 and contained recovery PASS; callout decoder50/lifecycle65 and contained recovery PASS; two POST reviews per fix | Raw records preserved; malformed callout bodies stay pending without receipts/alarm and valid siblings continue. Broader callback/DOM-failure isolation and already-shown valid same-ID refresh remain outside verified scope; no full decoder or production proof claimed |
| E11 | Server-authoritative operational timestamps (phase2.2) | OPEN compatibility item; legacy client times remain | Preserve legacy schema while proving server ordering, retry and seen/answer races |
| E12 | Listener/read budgets (phase2.3) | OPEN; existing cleanup, commander response fan-out remains | Measure synthetic active/history/reconnect reads; retain operational live updates, then reduce with parity |
| E13 | Growing fault/vehicle history pagination (phase2.4) | OPEN for main collections; photo subcollections already lazy/paged | Separate complete active data from historical cursors; legacy and export continuity; no blind limit20 |
| E14 | Media transport/Storage migration (phase2.5) | PARTIAL: compression/lazy retrieval already exist; base64 remains | Measure bytes/heap first; preserve legacy readers/auth/rollback; Storage migration requires explicit reviewed Rules/backup scope |
| E15 | Indexed monthly projection (phase2.6) | LOCAL_TESTEDec4fb3c;54 service +85 native PASS | Frozen independent parity oracle; synthetic element visits reduced, no production latency claim |
| E16 | Closed client-state schema (phase2.7) | OPEN | Inventory keys/reset paths; stale user/station/role and ambiguous mutation tests; no framework rewrite |
| E17 | Invocation-local runtime reuse (phase2.7) | LOCAL_TESTED7fbf4d2;17 synthetic +3 native PASS | Per-sweep full selection key,100->1 constructions; no cached authority, no E06 scan changes |
| E18 | Bulk-edit indexes/module boundaries (phase2.7) | OPEN proposal | Differential move/absence/remove/rebase tests and same digest/order before any extraction |
| E19 | Offline action/data classification (phase3.1) | PARTIAL: HR/hours/callout/schedule classified in OFFLINE_CLASSIFICATION_20261002.md; callout roster localStorage is a documented personal-data exception | Complete remaining modules/privacy review; callable receipts are not durable offline queues and TTL-on-read is not physical deletion |
| E20 | Approved durable queue/reload/conflicts (phase3.2,3.4) | OPEN; default SDK cache not a durable workflow | Privacy-reviewed eligible action only; reload/termination/conflict/idempotency proof before persistent payloads |
| E21 | Clear queued/sync/conflict/completed status (phase3.3) | OPEN UX proposal beyond existing messages | Visual approval where not already covered; never show success before authoritative acceptance |
| E22 | Physical iPhone/Android field checks (phase4.1) | NOT_RUN in this execution | Owner/device session: login, PWA update, push/background, weak network, keyboard, identity switch |
| E23 | DR exercise with RPO/RTO (phase4.2) | OPEN; deployment backup is not project-loss DR | Separate scoped drill and measured recovery evidence; never use telemetry as employee backup |
| E24 | Multi-station/role/shift isolation (phase4.3) | Existing SaaS modules/tests present in product; not missing by default | Preserve authorization and broaden only actual missing scenarios; unified emulator proof |
| E25 | Frozen release/rollback/postflight (phase4.4) |12-target hours tooling locally implemented/reviewed; release blocked pending expanded manifest/evidence/backup | Recompute exact affected Functions/Rules/index/Hosting/backup targets; reviewed compatible rollback; postdeploy hashes separate |
| E26 | Swap accept/cancel/revocation/stale-trigger races | LOCAL_TESTED0373281;10 unit +10 native PASS | Precise-version corrective CAS; retain pre-CAS audit and notification limitations, no stale data restore |
| E27 | Strict calendar/date contract (architecture P3) | LOCAL_TESTED6eedab6 service projection;69 service +85 native PASS | Impossible-date/leap/month/year/DST-calendar cases covered; broader legacy date schema/Israel-current-time remains separate |
| E28 | HR report consistency between pages/resume | LOCAL_TESTED17bebe7;44 summary +7 scale +3 native PASS | Pinned context, atomic page checkpoint, generation-bound cursor; old naked cursors restart. Global source snapshot/ABA/final-read gap not claimed solved; extra bounded scan cost documented |
| E29 | Safe intent recovery after browser close | Memory retry exists; reload recovery OPEN | Non-PII identity-scoped journal only after privacy review; receipt reconciliation; preserve uncertain state |
| E30 | In-flight fault photo dedupe/identity fences | LOCAL_TESTEDe93d575; focused races +5 browser scenarios PASS | Retains current lazy/paged coalescing; live UID checked before cache/paint/error, no production latency claim |
| E31 | Efficient evidence reuse (roadmaps/test-efficiency) | Advisory checks exist, no blanket gate waiver | Match source/tests/fixtures/tools/config/environment/workflow; retain failure/cancel status and mandatory final gate |

## Security additions explicitly approved in the unified scope

| ID | Requirement | Actual state and acceptance |
|---|---|---|
| S01 / O1 | Enforce App Check on legacy callable paths | LOCAL_TESTED4921847/e0e326c: all194 declarations enforced;288 source checks+18 mutations PASS. Real provider/domain/token and pre-auth client readiness OPEN. No production enforcement claimed; compatible rollback required. |
| S02 / O3 | HMAC-SHA256 metrics with validated key | Commit51c298b, locally tested and two independent POST approvals: lazy Secret Manager binding only recordMetrics;32–4096 UTF-8 bytes, whitespace-only rejected; no new unkeyed writes, legacy reads retained.31 unit and51 source/mutation checks PASS, Node22 index syntax and diff hygiene PASS. Git emitted normal LF-to-CRLF notices; no runtime warning was observed in these checks. Existing key/version/readiness must be verified before release; no automatic rotation or quota/replay namespace reset. NOT_DEPLOYED. |
| S03 | Immutable identity/role/shift audit events | PARTIALdd6f27b: five identity operation kinds with deterministic transaction-created server-only events, native identity31 and expected client-denial20 PASS;183 backup paths classified. All shift-event coverage and production proof OPEN; no Admin-SDK/WORM immutability claim. |
| S04 | Revoke refresh tokens on critical role/status changes | Local self-target repair ff7070b removes three skip arguments, preserving coordinator/bootstrap/clear/transfer flows; two POST approvals and28 native Firestore integration checks PASS (simulated Auth). Log `t-hours/unified-self-revocation-20261001.log`; EXIT0, expected emulator SIGINT shutdown notice. Revocation failure/finalization failure/replay covered. Entry-gate stale authority repaired in1c69033,7 tests PASS; concurrent mid-operation authorization race not claimed closed. NOT_DEPLOYED; real Auth/client reauthentication NOT_RUN. Revocation alone is not immediate rejection of all previously issued ID tokens. |
| S05 | Explicit backup retention policy | fe2ff69 adds tested frozen advisory decisions (31PASS): declared/unresolved/blocked, default retain, automaticDeletionAuthorized:false, durationDays:null.182 legacy catalogue rows/digest unchanged. No new TTL/scheduler/deletion. Actual legal/audit durations and deployed enforcement remain unresolved; not claimed closed. |

## C. Isolated agent/control-plane requirements retained, not silently shipped with ResQ

These are in the supplied29.09 roadmap and remain inventoried. They are a separate
cloud target from station-102; inclusion in a unified plan does not authorize
publishing private provisioning code or performing paid provider calls.

| ID | Requirement | State / next acceptance |
|---|---|---|
| C01 | Real PR review adapter and one-use atomic dispatch permit | Partial implementation, CLI/wiring OPEN; test expired/copied/replayed permit and exact serialized body before HTTP |
| C02 | Durable task ownership/lease/checkpoint/result-hash/ack | OPEN beyond connectivity smoke; no blind replay of uncertain paid request |
| C03 |80% quota alarm and truthful handoff | Planner-only/historical evidence; current source/unit/window required; UNKNOWN is not available quota |
| C04 | Shared monthly+cycle budget transactions | Dirty implementation retained; exact integration/evidence OPEN; no provider switching to bypass shared cap |
| C05 | Scheduled actual review/no-overlap/max5 fixes | OPEN activation proof; no fake ACTIVE/heartbeat and no new paid run here |
| C06 | API body/model/endpoint/secret separation | Preserve trusted-base execution and scoped identity; review Anthropic/xAI/Gemini contracts, body limits and unknown outcomes |
| C07 | Private dashboard status/budget/handoff visuals | Existing proposals remain scoped; public code and private owner enforcement separate; no Pages deployment in hours manifest |

## D. Four already-approved product mockups / preservation

| ID | Approved area | Current comparison / next acceptance |
|---|---|---|
| U01 | Desktop command center | Product47 already has full-height left rail and wider layout; do not replace with olderDEV. Verify right account panel/default and role/viewport behavior rather than call whole feature missing |
| U02 | Schedule manager workspace | Preserve current monthly board, roster-authoritative edits and own-name highlighting; integration must not revert to olderDEV layouts |
| U03 | HR station dashboard/counters | Existing counters and pending/history distinction; drift warning is not proof of live push updates. Preserve station scoping and month/range behavior |
| U04 | Operational vehicles | Compartment/photo/equipment-log/fault-link modules exist; integrated user journey still needs explicit mapping/verification. Future360capture not fabricated. No new layout invented |

## E. Existing uncommitted material — preserve, classify before integration

### Inspected S03 coverage map (not final release evidence)

Already transaction-created: schedule edit-draft/runtime4692, publication7075,
singleton rollback7480, monthly operation receipts/store172–195 and rollback7163,
authority activation/control68–100, guard management/runtime897–905, display
selection5705, qualifications4983/5057/5139/5381, responses9415/9480. Line numbers
refer to inspected619e333; four-write458663d does not add runtime lines.
Concrete remaining gaps: guard signup/withdrawal/runtime1024 has no immutable
change event; legacy browser swaps plus asynchronous index shift_log are not
atomic audit of originating mutations. Planner/import staging is mutable and
requires an explicit coverage interpretation before adding duplicate logs.
No claim that these findings exhaust unrelated legacy writers.

E06 additional integration dependency: controlled-runtime resumeOutbox has its
own four status/limit100 scans (schedule-month-control-runtime.js55–72). Porting
only the donor's three runtime call sites would miss this active fourth seam.
Cursor pre-advance/crash-wrap and contention remain reviewed material risks;
the historical repair counter has not been reset and no sixth attempt ran.

51 porcelain records were observed in DEV, not51 features. Eight staged files:
`faults.html`, `functions/provider-wiring-attestation.json`,
`functions/schedule-runtime.integration.test.js`, `functions/schedule-runtime.js`,
`tests/fault-photo-read-dedupe-browser.mjs`, `tests/package.json`,
`tests/personal-live-lab.mjs`, `tests/schedule-runtime-source.mjs`.
The last file ALSO contains an unstaged source-test correction: staged-only copy
would lose it.13 unstaged file entries include control-plane budget/cycle/cloud,
workflow tests, status/night reports and agent state. Untracked operator helpers,
vault/provisioning files, Rules fixtures, checkpoints and outputs are not a bundle
to stage wholesale. No unrelated changes were removed or restaged here.

`dev/ERROR_LOG.md` records the fifth/final source-gate attempt exhausted on
`tests/schedule-runtime-source.mjs:949–950`: old literal collectionGroup checks
versus delegated fair-scan calls. It requires fresh scope/read-only review before
another repair loop. This inventory does not reset that counter or mark it fixed.

Historical logs record95 runtime,30 browser,8 swap-trigger and9 native-swap passes.
They are not proof of the dirty candidate or final integration. A separate
`provider-ack-receipt-all.log` ends `DIRTY_INPUT: tests/package.json`.

## Integration constraints and release sequence

1. Keep product09ac as the preservation reference; do not wholesale replace files
   fromDEV. DEV's service worker is42h30 and omits newer Terms/report/course/reserve/
   vehicle assets. Preserve product's broader App Check wrapper detection,
   cost-usage tests and newer sealed/dry-run disaster-restore safeguards.
2. Reconcile safe Enterprise hunks and pending changes in isolated reviewable
   work, with two actual reviewers per implementation. No runtime edit in this
   inventory step; the recorded exhausted repair loop remains visible.
3. Resolve every inventory row to integrated proof, a real external dependency,
   or an explicit owner decision. Conditional migration/privacy proposals are not
   silently mandatory or silently discarded. Avoid repeating unchanged green tests.
4. Create the new exact target/backup/rollback manifest. Outbox integration adds
   `schedule_runtime_workers` deny Rules/backup classification and scheduled/runtime
   consumers; the former12-Functions+Hosting-only manifest cannot authorize that
   expanded cloud mutation. Confirm exact scope and compatible rollback before release.
5. Freeze one integrated SHA; prove clean-checkout reproducibility and applicable
   final release gates once on that tree. Existing proofs may support unchanged
   components but cannot masquerade as final-tree release attestations.
6. Only then encrypted/readback-verified backup and one coordinated release.
   Functions, Hosting and Rules are not one atomic transaction. Journal staged
   service operations, reconcile uncertain results, preserve stored data and verify
   actual published hashes. Device/DR/production verification retain honest separate states.

No100/100 rating, zero-bug guarantee or completed Enterprise claim is made.
