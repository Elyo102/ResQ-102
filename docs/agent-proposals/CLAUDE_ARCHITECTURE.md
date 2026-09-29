# ResQ architecture and logic proposal

Role-specialized review: architecture and logic (Claude role). This is not a
claim that Anthropic Claude or any external provider reviewed the repository.

## Scope and evidence

- Evidence base: branch `dev`, inspected HEAD
  `e6b7367ae81dae1e76b9c9540dd421a7044a5dc7` on 2026-09-29.
- The worktree was already dirty. This review did not alter, discard, stage, or
  reinterpret those changes.
- Reviewed paths: schedule client state, schedule projection/edit/planning,
  monthly authority transactions, notification workers, attendance-hour
  calculation, and their focused tests.
- No UI/visual production code, runtime code, rules, indexes, production data,
  deployment, commit, or push was changed. This document is the only change.
- No test suite was run because the deliverable is a read-only proposal. Test
  names below are required gates for any later implementation.

## Executive assessment

The scheduling domain already has unusually strong fail-closed checks: strict
calendar dates in the runtime and planner, deterministic ordering, signed
snapshot verification, auth-generation guards in the browser, Firestore
transactions for authoritative state, leases for concurrent workers, and broad
adversarial tests. The main architectural risk is now concentration rather than
absence of safeguards: `functions/schedule-runtime.js` is 10,252 lines and
`schedule-management.js` is 4,871 lines. Several high-volume paths repeatedly
scan or recreate these large structures, and correctness depends on informal
relationships between many mutable fields.

Recommended order: first add characterization and measurement; then implement
the low-risk indexing/state-contract changes; only after that change matching or
delivery semantics. No recommendation below requires a visual change.

## Prioritized findings and proposals

### P1 — Station-range projection repeatedly scans the whole plan

**Evidence.** `functions/schedule-service.js:294-329` builds one day by scanning
all `plan.rows` and filtering all events. `buildStationSchedule` invokes that
work for previous/current/next days at `functions/schedule-service.js:336-352`.
The monthly range then calls `buildStationSchedule` once per requested date in
both imported and active V2 paths (`functions/schedule-runtime.js:9095-9099` and
`functions/schedule-runtime.js:9164-9166`). The public range is bounded to one
month at `functions/schedule-runtime.js:8633-8662`, so this is bounded, but it is
still approximately O(days * (rows + events)); because rows grow with days, the
range projection is quadratic in the number of days. The existing
`tests/schedule-performance.mjs:89-140` measures browser navigation and callable
count against stubbed responses, not server projection cost.

**Impact.** Extra CPU and latency on every monthly board read, especially for
many sub-stations, events, or large rosters. It also repeats roster name and
qualification lookups inside projection helpers. On mobile, this translates to
longer loading states even though network call count is already optimized.

**Proposal.** Add a pure `createScheduleProjectionIndex(plan, events, roster)`
that validates once and builds immutable `rowsByDate`, `eventsByDate`, and
`personById` maps. Add `buildStationRange({from,to,...})` to `schedule-service`
and have both runtime range branches call it once. Keep `buildStationSchedule`
as a compatibility wrapper over the same index.

**Risk.** Medium. Ordering, frozen-object behavior, missing-day semantics,
`is_me`, unlinked markers, and event projection must remain byte-for-byte or
deep-equal compatible.

**Required tests.** Golden parity for existing station views; empty and missing
days; first/last day outside the plan; event ordering; dynamic sub-stations;
unlinked roster entries; 28/29/30/31-day ranges. Add a server benchmark with a
31-day, 64-sub-station synthetic plan and assert both output parity and linear
row-visit count. Avoid a fragile wall-clock-only assertion in shared CI.

### P1 — Planner accepts work budgets large enough to time out or exhaust memory

**Evidence.** The engine accepts up to 20,000 people, 1,000 days, 1,000,000
planned slots, and 50,000,000 candidate edges
(`functions/schedule-calendar-engine.js:54-63`). For every demand it builds or
reuses candidate arrays (`:565-600`) and then runs a recursive augmenting-path
matcher (`:602-631`). The preflight upper bound at `:786-792` only rejects work
above 50 million edges. The 3,000-person readiness case deliberately approaches
that ceiling (`tests/saas-capacity-3000.mjs:240-268`), but its large-station run
has no independent latency, heap, or recursion-depth acceptance threshold; the
reported timer at `:228-238` covers the earlier multi-station fixture set.

**Impact.** An authorized but pathological plan can consume a Cloud Function's
CPU/memory budget, increase cost, or fail with recursion/timeout rather than a
clear domain error. Retries amplify the cost. This is efficiency and failure
isolation risk, not evidence of an untrusted public DoS path.

**Proposal.** Introduce an explicit planner work budget derived from measured
production function memory/timeout, with separate ceilings for normalized
records, candidate visits, and augment operations. Return a stable
`planner-capacity` domain error before allocating the full graph. In a later,
separately reviewed step, replace recursive augmentation with an iterative
implementation while preserving exact deterministic tie-breaking. Do not
silently lower supported tenant size without an owner-approved capacity
contract.

**Risk.** High for matcher replacement because tie-breaking changes can change
who is assigned. Low-to-medium for measurement and fail-fast budgeting.

**Required tests.** Boundary cases at budget-1/budget/budget+1; adversarial
overlapping qualifications that force long augmenting paths; deterministic
output against the current solver; heap and operation counters; 3,000-person
fixture under the deployed Node 22 memory/timeout profile. Preserve the existing
scarcity, rest, rotation, manual placement, and fairness tests.

### P1 — Push delivery is concurrency-safe but not crash-exactly-once

**Evidence.** Schedule delivery atomically claims a queued row and lease
(`functions/schedule-runtime.js:9505-9552`), revalidates immediately before the
provider (`:9554-9579`), calls the external provider at `:9581-9584`, and only
after success records `sent` at `:9595-9605`. A process crash after the provider
accepts the push but before the final transaction leaves `sending`; the resume
path later recovers expired leases (`:9632-9647`). Guard delivery has the same
shape at `:9987-10071` and recovery at `:10095-10166`. Tests prove concurrent
claiming sends once and expired leases recover
(`functions/schedule-runtime.integration.test.js:2497-2507` and `:2596-2625`),
but do not inject a crash after provider success and before the status write.

**Impact.** The present design correctly prefers possible duplicate notification
over silent loss. During a narrow crash window a recipient can receive the same
schedule or guard notification twice, reducing trust and generating support
noise.

**Proposal.** Make the delivery guarantee explicit in code/docs as at-least-once.
Pass a deterministic notification idempotency key to the provider when the
provider contract supports it. If it does not, store a deterministic delivery
identity and suppress duplicate presentation client-side where possible; retain
server retries because marking sent before the provider would create silent
loss. Do not promise exactly-once without provider acknowledgement semantics.

**Risk.** Medium-high. Incorrect deduplication can suppress a legitimate changed
notification. The key must include station, notification kind, logical entity,
revision, recipient, and membership epoch where applicable.

**Required tests.** Fault injection immediately after provider acceptance;
retry with the same deterministic key; changed revision must deliver; same
revision must not create a second visible notification when dedupe is supported;
provider timeout with unknown outcome; policy suppression remains terminal only
under the current strict contract.

### P1 — Worker batches can starve rows beyond the first 100

**Evidence.** `resumeOutbox` queries each status with `limit(100)` but no
ordering or cursor (`functions/schedule-runtime.js:9632-9648`). The monthly
controlled wrapper repeats the same pattern
(`functions/schedule-month-control-runtime.js:54-67`). Guard workers at least
order by `created_at`, but still restart from the oldest 100 on every run
(`functions/schedule-runtime.js:9815-9829` and `:10151-10166`). Long-lived
`blocked`, future `retry`, or unexpired `sending` rows can repeatedly occupy a
page while later eligible work remains unseen.

**Impact.** Delayed notifications and slow failure recovery under backlog, with
unpredictable fairness across stations. Sequential per-document reconcile and
delivery also stretches scheduled invocation time.

**Proposal.** Define a fair sweep protocol: query only eligible lifecycle rows
where possible, order by the relevant due time plus document identity, use a
persisted/rotating cursor or bounded pagination, and impose a total per-run work
budget. Partition fairness by station or use a deterministic round-robin so one
large tenant cannot monopolize every run. Any new query requires index review
before implementation.

**Risk.** Medium. Cursor mistakes can skip rows; parallel delivery can raise
provider rate and Firestore contention. Start with pagination and fairness,
retain sequential provider calls, then measure before bounded concurrency.

**Required tests.** More than 300 rows per status; first 100 all not-yet-due;
permanently blocked staging rows; mixed stations; rows inserted during a sweep;
cursor restart after crash; no skip/no double claim; explicit read/write counts.

### P2 — Client state is an open, cross-domain mutable object

**Evidence.** `schedule-management.js:73-103` declares one object containing
auth, authorization, mode transition, planner, import, display, edit, and board
state. Additional keys such as `boardSlotKeys`, `mine`, `importReport`,
`importPending`, `editList`, `editPending`, `editReport`, `intentRequestIds`, and
`scheduleEditDrawer` are introduced later instead of in the initial schema. The
scope reset at `schedule-management.js:4699-4721` must manually know almost all
of them. Existing stale-result controls are good: auth task identity is checked
at `:1573-1594`, range requests are sequenced at `:1606-1638`, display status is
sequenced at `:3064-3083`, and scope changes clear sensitive UI at `:4764-4866`.
The risk is that every new feature must remember to join all these contracts.

**Impact.** A missed reset or request guard can surface stale station/user data,
reenable an ambiguous operation, or make a retry use the wrong intent. It also
makes isolated testing and maintenance expensive.

**Proposal.** First define and freeze a complete `initialState()` schema and add
a test that rejects undeclared `state.*` keys. Then split state into explicit
`auth`, `view`, `range`, `planner`, `import`, `edit`, and `mode` slices with
slice reset functions. Centralize async work in a small operation controller
that issues `{scopeVersion, sequence, abortSignal}` tokens. Preserve all current
auth-generation and idempotency behavior; this is not a framework migration.

**Risk.** Medium. Broad rewrites can regress carefully developed auth and retry
semantics. Migrate one slice at a time behind characterization tests.

**Required tests.** Closed state-key inventory; logout and user/station/role
switch during every async loader and mutation; ordinary same-scope token refresh
preserves unsaved form state; refresh during a mutation remains fail-closed;
out-of-order range/import/preview responses; no previous-user DOM content during
boot. Keep the existing browser race tests and add mutation tests for each token
guard.

### P2 — Runtime construction and domain ownership are too concentrated

**Evidence.** `functions/schedule-runtime.js` is 10,252 lines and defines context,
policy/source authoring, import/edit/publish, monthly authority, projections,
effective workdays, responses, and two notification pipelines inside one
factory. The monthly control wrapper creates a new full runtime for each dispatch
(`functions/schedule-month-control-runtime.js:18-40`) and again for each outbox
document at `:61-65`. This repeatedly allocates the full closure graph during a
100-row recovery pass.

**Impact.** Higher cold/warm invocation CPU, difficult ownership boundaries, and
large regression blast radius. Reviewers must reason about unrelated domains to
change one worker.

**Proposal.** Extract modules by stable capability, not by arbitrary line count:
`schedule-read-model`, `schedule-authoring-runtime`, `schedule-publication-runtime`,
`schedule-delivery-worker`, and `guard-delivery-worker`. Each receives the
minimum dependency object. As an immediately safe optimization, cache one
controlled runtime per stable station/authority-selection key within a single
resume invocation; never cache authorization selections across invocations.

**Risk.** Medium-high for extraction, low-to-medium for invocation-local caching.
Import cycles and accidentally widened dependency access are the main risks.

**Required tests.** Existing exported API inventory; dependency-denial tests
showing a read module cannot write; one controlled runtime construction per
selection in a synthetic 100-row sweep; mixed station/mode selections remain
isolated; all current integration suites unchanged.

### P2 — Bulk edits repeatedly scan rows, absences, and events

**Evidence.** `findSlot` is a linear rows/slots scan
(`functions/schedule-edit.js:228-235`), and `stateOf` adds a linear absence scan
(`:237-244`). `applyEdits` permits up to 200 edits and 62 dates per edit, then
calls these helpers throughout `:331-419`; `rowFor` also scans rows (`:337-348`),
and `inPlan` rescans the original plan for each edit (`:363-367`).

**Impact.** Bulk manual correction cost grows as edits × dates × plan size.
That is avoidable latency on an operator action and magnifies transaction staging
or function timeout risk for large plans.

**Proposal.** Reuse a mutable edit index keyed by date then UID, plus absence and
event id maps. Update the index atomically whenever a slot/absence/note changes,
then serialize rows in their original order. Keep warnings and before/after
states identical.

**Risk.** Medium. An index not updated on move/remove can create duplicate daily
assignments. The index must be an internal acceleration structure, never a second
source of truth persisted separately.

**Required tests.** Differential property tests comparing indexed versus current
implementation across random edit sequences; assign-move-unassign; absence plus
assignment warnings; departed-member removal; notes; policy rebase; maximum
200×62 input; deterministic row/event ordering and unchanged digest.

### P3 — Date arithmetic has multiple contracts

**Evidence.** Strict calendar validation exists in
`functions/schedule-calendar-engine.js:121-142` and
`functions/schedule-runtime.js:173-182`, while
`functions/schedule-service.js:286-292` rejects only `NaN` and therefore accepts
JavaScript-normalized impossible dates when invoked directly. Date/month helpers
also exist in `schedule-management.js:165-195`, `rotation.js:23`,
`functions/schedule-edit.js:61,97`, and `functions/hr-monthly-summary.js:111`.
The callable runtime currently protects station-view requests with the strict
helper, so this is a contract-drift hazard rather than a confirmed live defect.

**Impact.** A new internal caller can accidentally accept `2026-02-30`, or apply
different range/month semantics from another module.

**Proposal.** Create one small pure UTC calendar contract for strict ISO date,
day-number conversion, offset, and month bounds, with browser/server-compatible
exports. Adopt it incrementally, starting with `schedule-service`; do not mix
Jerusalem “today” selection with UTC calendar arithmetic.

**Risk.** Low if introduced behind parity tests; medium if all callers are
changed at once.

**Required tests.** Leap years; impossible dates; year/month rollover; negative
offsets; DST boundaries in Asia/Jerusalem; canonical round trip; parity with all
current valid fixtures.

## Safe non-visual implementation candidates

These are the smallest candidates suitable for the next cycle. Each still needs
the repository's mandatory two connected reviewers before implementation.

1. **Closed client state schema and inventory test.** Add every existing key to
   `initialState()`, add reset coverage, and make no behavioral or DOM changes.
2. **Projection index plus differential tests.** Introduce a pure index and keep
   current public methods as wrappers. Switch only the monthly range path after
   deep-equality and visit-count gates pass.
3. **Edit indexes plus differential property tests.** Internal-only acceleration;
   no persistence or API contract changes.
4. **Planner instrumentation and fail-fast budget proposal.** First measure
   candidate visits, augment operations, peak heap, and runtime on Node 22. Do
   not change assignments or supported capacity until the owner approves a
   measured capacity contract.
5. **Outbox fairness reproducer.** Add >100-row emulator tests that demonstrate
   current starvation before changing queries/indexes. Treat delivery
   idempotency as a separate provider-contract work package.

## Complex edge-case matrix for later gates

| Area | Cases that must stay explicit |
| --- | --- |
| Identity/state | user switch, station switch, role downgrade, manager revocation, same-scope token refresh, refresh during ambiguous commit |
| Calendar | leap day, month/year boundary, impossible date, negative offset, Jerusalem DST while UTC work date stays stable |
| Planner | manual assignment reserved across sub-stations, versatile-person augment path, rest at month boundary, strict/non-strict rotation, advisory monthly cap, inactive/unlinked people |
| Edit | same UID on many dates, move then role change, absence collision, departed-person removal, policy rebase with deleted sub-station |
| Authority | concurrent publish/rollback, migration race, stale generation, replay after superseding publication, transaction retry |
| Delivery | revocation before provider, provider unknown outcome, crash after provider success, expired lease, >100 backlog, future retry, station fairness |

## Definition of done for an architecture cycle

- Characterization tests pass before and after the refactor.
- Server-side work is measured with operation/read/write counts and Node 22
  resource observations; browser callable count alone is insufficient.
- No assignment, warning, digest, ordering, authorization, retry identity, or
  notification audience changes unless separately approved and documented.
- Firestore index additions, provider semantics, and capacity reductions are
  explicit rollout items with rollback plans.
- Written, locally tested, deployed, and production-verified remain separate
  states. This proposal is **written only**.
