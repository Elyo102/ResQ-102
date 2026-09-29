# Grok-role proposal: data, realtime, offline resilience

> Planning artifact only. No external Grok API was invoked, and this is not evidence that Grok reviewed the repository. The analysis was performed by a connected Codex sub-agent acting in the requested Grok specialist role. Local checkout verification remains pending because the workspace runner was unavailable.

## Evidence boundary

- Intended local target: `work/resq-ci-review-dev`.
- The local command runner failed before process creation (`helper_unknown_error: setup refresh had errors`), so the local checkout, local `AGENTS.md`, branch status, and test execution could not be verified in this agent session.
- To avoid guessing, source evidence below is from the repository's GitHub default branch snapshot exposed by the connected repository reader at blob commit `11472fef62370cb177b184f1834ae3447db9de93`. Before implementation, reconcile every cited file and line against the local target branch.
- Repository policy was read from GitHub: `AGENTS.md` requires two connected reviewers before implementation, demo-only emulator validation, and explicit production authority. `PROJECT_STATUS.md` also prohibits production reads/writes and requires owner approval plus a visual for visual/UI changes.
- No production data was accessed. No runtime/UI code was changed. No deploy, push, merge, or production operation was attempted.

## Executive conclusion

ResQ has stronger idempotency and privacy boundaries than a typical Firebase PWA, but it is not an offline-first data application today. The service worker makes the application shell available offline; sensitive domain data is intentionally memory-only, and a test explicitly prevents IndexedDB persistence in HR, attendance, callout, and push clients. That is a defensible privacy choice, but it means a reload or browser eviction while offline loses domain state.

The highest-value safe cycle is therefore:

1. make the existing shell cache atomic and fast-failing;
2. reduce callout listener fan-out and read amplification;
3. add runtime validation at every realtime boundary;
4. move operational timestamps to server authority without weakening existing idempotency;
5. define a data-classification policy before adding any durable offline cache.

These are non-visual proposals. Any new offline/status wording, controls, or layout must go through the owner's mockup approval protocol and is not part of this document's implementation candidates.

## Findings and priorities

### P0 — The installed offline shell can be partial

Evidence:

- `firebase-messaging-sw.js:40-69` lists 89 shell URLs.
- `firebase-messaging-sw.js:74-76` defines only four core URLs.
- `firebase-messaging-sw.js:81-89` fails installation if a core URL fails, but catches and discards every failure for the other 85 URLs.
- `tests/service-worker-browser.mjs:138-143` asserts only that more than ten entries were cached, not that the release manifest's required offline dependency closure was cached.

Impact: a service worker can install and activate while a screen-specific HTML/module dependency is absent. A later offline navigation may load the page shell but fail its module graph, producing a broken operational screen instead of the explicit offline fallback.

Safe candidate:

- Generate the required offline dependency closure from the release manifest/build graph.
- Split assets into `required` and explicitly `optional`; make all required assets atomic with `cache.addAll` or equivalent all-or-nothing logic.
- Record optional failures in a bounded diagnostic result rather than silently swallowing them.
- Keep remote Firebase SDK imports out of the cache contract unless they are deliberately vendored and version-pinned.

Acceptance tests:

- Delete/fail each required asset one at a time and assert the new worker does not activate.
- Fail an optional asset and assert activation succeeds with a diagnosable degraded state.
- After successful installation, compare exact cached required URLs with the generated manifest; do not use a `> 10` proxy.
- Cold-load every declared offline-capable route with the HTTP server stopped and assert all module requests complete from the current release cache.

### P0 — Offline is shell-only for sensitive workflows, by explicit policy

Evidence:

- `tests/sensitive-persistence-boundary.mjs:11-20` rejects IndexedDB/Firestore persistent cache APIs in attendance, HR, callout, and push clients.
- `tests/sensitive-persistence-boundary.mjs:29-40` requires HR payloads to stay in bounded memory or explicit files.
- `tests/pilot-trust-ux.mjs` contains an assertion that there is no client-side queue (repository search matched `registration.sync`, `persistentLocalCache`, and `enableIndexedDbPersistence`).
- `firebase-messaging-sw.js:38-39` says data is not stored in the service-worker cache, while `firebase-messaging-sw.js:110-117` excludes remote Firebase providers and version truth from runtime caching.
- `bulletin.js:1493` explicitly says an offline post is not queued; the draft remains for manual retry.

Impact: after reload/browser eviction, the app cannot recover sensitive domain reads or pending writes offline. This is not a bug by itself; it is the current privacy contract. Calling the whole product "offline-first" would overstate the implementation.

Safe candidate:

- Adopt an explicit three-tier data classification:
  - Tier A, public/non-sensitive reference data: bounded durable cache with version, station scope where applicable, TTL, and schema validation.
  - Tier B, operational but sensitive: memory-only cache with reconnect refresh and visible freshness metadata supplied to existing presentation code.
  - Tier C, write intents/attachments/HR: no generic offline queue; preserve current server-idempotent workflows and require an authenticated online commit.
- Do not enable Firestore persistent cache globally. Any collection-specific durable cache requires a privacy review, logout purge proof, multi-account isolation proof, TTL, capacity bound, and device-loss threat assessment.
- Correct internal documentation that implies Firestore's cache is necessarily durable; the imported SDK uses default memory behavior unless persistence is configured.

Acceptance tests:

- Reload while offline for one route in each tier and assert the documented behavior.
- Sign out, sign in as a different user, and prove no Tier B/C payload crosses identities.
- Advance TTL/schema version and prove stale Tier A entries fail closed and are evicted.
- Reconnect after missed writes and prove a server snapshot replaces stale memory state without duplicating a write.

### P1 — Callout console has statically bounded but expensive listener fan-out

Evidence:

- `callout-console.js:381-384` opens one realtime listener for up to ten callout documents.
- `callout-console.js:388-393` calls `watchResponses` for every returned callout.
- `callout-console.js:427-443` opens a separate collection listener for each callout's response subcollection.
- Static upper bound on that screen: 11 concurrent listeners (one parent query plus ten response listeners), with initial reads of up to ten callout documents plus every response document under those ten callouts.
- `callout.js:391-397` listens to up to five active callouts; `callout.js:378-388` adds one response-document listener per result. Static upper bound: six concurrent listeners per recipient screen.
- Cleanup exists (`callout-console.js:411-417, 628-633`; `callout.js:339-347, 414-419`), so the problem is read amplification, not an obvious listener leak.

Impact: commander fan-out grows with both recent callouts and recipients. Reconnects replay the listener set and may cause burst reads and UI churn. Ten closed/history callouts receive the same response-stream treatment as an active operational callout.

Safe candidate:

- Separate active operations from history. Keep realtime response listeners only for active/in-flight callouts; use paginated one-shot reads or server-maintained immutable summaries for closed history.
- Prefer a server-maintained callout summary (`coming_count`, `declined_count`, `seen_count`, `pending_count`, revision) for list rendering. Subscribe to the response subcollection only when the operator opens one active callout's details.
- If exact names must remain visible simultaneously, benchmark the current fan-out first and set an explicit listener/read budget rather than assuming aggregation is cheaper.
- Reuse the existing `active` field and existing `uids + active + created_key` composite index (`firestore.indexes.json:223-253`) where the query shape permits. Add indexes only after emulator query tests prove the exact need.

Acceptance tests:

- Instrument listener construction and assert the list view uses a constant number of listeners independent of history length.
- Seed 10 callouts x 50 responses in the emulator, reconnect three times, and report document reads, first-meaningful-data latency, and render count before/after.
- Close an active callout during reconnect and prove the active detail listener is removed exactly once.
- Prove summary counts match the response subcollection under concurrent acknowledgement writes.

### P1 — Realtime payload validation is inconsistent

Evidence:

- `mode-controller.js:111-128` validates mode and revision and fails closed on listener error.
- `callout.js:401-412` accepts callout `data()` objects and uses selected fields without a shared schema decoder.
- `callout-console.js:388-403` accepts raw callout data, and `callout-console.js:430-438` copies every response document into a map before rendering.
- `home-faults.js:100-101` validates SDK dependencies, while its snapshot path is primarily a mapping/render boundary rather than a versioned domain decoder.
- Firestore Rules protect writes but do not replace client validation for legacy/corrupt/admin-written documents.

Impact: a malformed or partially migrated document can poison a whole snapshot render, create misleading counts, or cause repeated error/re-render loops. Rules cannot guarantee the shape of historic documents already stored.

Safe candidate:

- Create small pure decoders per realtime document type with explicit schema version, bounded arrays/maps/strings, allowed enums, and monotonic revision checks.
- Quarantine invalid rows individually, emit a redacted diagnostic, and continue rendering valid rows. Fail the whole stream only when identity/station/query authority is invalid.
- Centralize snapshot metadata (`fromCache`, `hasPendingWrites`, observed revision, last server time) in a non-visual state envelope.

Acceptance tests:

- Fuzz each decoder with unknown keys, oversized arrays/maps, invalid enums, missing IDs, mixed legacy/current versions, and prototype-like keys.
- Deliver one corrupt row among valid rows and assert valid rows continue, the corrupt row is excluded, and one bounded diagnostic is emitted.
- Deliver out-of-order generations after a session/identity change and assert no stale render occurs.

### P1 — Client-generated operational timestamps are syntactically valid but not authoritative

Evidence:

- `callout.js:204-217` writes acknowledgement `at` using `new Date().toISOString()`.
- `callout.js:223-235` writes first-seen `seen_at` using the device clock.
- `firestore.rules:1580-1598` validates timestamp string shape and field bounds, but not proximity to server time.
- `firestore.rules:1600-1622` correctly preserves first-seen and prevents erasing a final answer, but a recipient-controlled clock can still supply a valid-looking past/future value on creation.

Impact: ordering, response-time analytics, and incident reconstruction can be skewed by an incorrect or manipulated device clock even though authorization and immutability rules pass.

Safe candidate:

- Preserve user/device time only as explicitly untrusted context if needed.
- Add a server-authoritative receipt timestamp through a callable/transaction or trusted server completion path, using the existing authenticated identity and parent-callout checks.
- Do not make a trigger that can race and overwrite final response fields. Use a dedicated immutable server field or a server-owned receipt document.

Acceptance tests:

- Submit device timestamps years in the past/future and prove authoritative ordering uses server time.
- Race seen + answer writes and prove first-seen and final-answer semantics remain intact.
- Retry the same response and prove the server receipt is idempotent and does not create a second operational event.

### P1 — Network-first service-worker fetch has no latency bound

Evidence:

- `firebase-messaging-sw.js:119-152` waits on `fetch(req)` and uses cache only after rejection; there is no timeout/abort path.
- `tests/service-worker-browser.mjs:256-314` verifies hard disconnect and recovery by stopping the server. It does not simulate a connection that remains open but never produces headers/body.
- `pwa.js:112-113, 160-172` does have explicit 5-minute success throttling and 30-second failure retry for update checks, demonstrating a bounded retry pattern elsewhere.

Impact: captive portals, half-open mobile connections, and stalled radio transitions can hold navigation on the network path instead of promptly serving the cached shell.

Safe candidate:

- Add a tested timeout race for cache-eligible same-origin shell requests. On timeout, serve the release cache; allow the network request to update cache only if it later completes safely or abort it where supported.
- Keep `version.json`, Auth, Firestore, Functions, and other data APIs network-only/fail-closed.
- Use different budgets for navigation and subresources, derived from measured mobile traces rather than arbitrary constants.

Acceptance tests:

- Server accepts the request and never sends headers; cached navigation must complete within the declared budget.
- Slow successful response before the deadline wins and refreshes cache.
- Slow response after the deadline cannot overwrite a newer release cache.
- Network-only provider requests never fall back to cached data.

### P2 — Attachment transport is safe and idempotent, but CPU/memory/network inefficient

Evidence:

- `hr-attachments-ui.js:21-26` caps files at 2 MiB and allows a base64 string around 2.8 million characters.
- `hr-attachments-ui.js:93-99` builds base64 in chunks; `hr-attachments-ui.js:843-866` reads the entire file, hashes it, and retains bytes plus base64 during selection.
- `hr-attachments-ui.js:727` sends the full base64 body through a callable; retries reuse the same request and bytes (`hr-attachments-ui.js:765-779`).
- `functions/hr-attachments.js:219-254` derives deterministic request/attachment identity from the full intent; `functions/hr-attachments.js:522-528` verifies canonical base64, length, hash, and signature.
- `functions/hr-attachments-storage.js` explicitly rejects bearer-style signed/resumable URLs, a strong security boundary that should not be casually weakened.

Impact: base64 adds roughly 33% payload overhead before protocol framing, while the browser may simultaneously hold ArrayBuffer/Uint8Array, binary-string chunks, and base64. On memory-constrained iPhones this increases peak memory and retry cost. The current 2 MiB cap bounds the risk, so this is optimization, not a correctness emergency.

Safe candidate:

- First measure peak JS heap (where supported), task duration, and end-to-end upload time on iPhone-class hardware for 2 MiB PDF/JPEG/PNG.
- If material, evaluate an authenticated, short-lived, single-object upload session bound to uid, station, attachment id, content hash, size, MIME signature, generation precondition, and one-time server reconciliation. Do not expose a durable bearer download token.
- Retain the deterministic reserve/upload/resume state machine, content verification, quota ledger, and parent revision fence.
- If a secure streaming design cannot preserve those invariants, keep the current bounded base64 transport.

Acceptance tests:

- Disconnect at reserve, mid-upload, after object storage, and before final Firestore commit; every retry must converge to one attachment and one parent revision event.
- Revoke role/station membership between every phase and prove failure without publication.
- Upload conflicting bytes under the same request id and prove deterministic rejection/cleanup.
- Benchmark transport bytes and peak memory against the current 2 MiB worst case.

## Existing strengths to preserve

- Callout delivery uses a stable `request_id`, restores pending server state after refresh (`callout-console.js:394-408`), automatically retries a retryable result at most three times (`callout-console.js:573-584`), and distinguishes terminal dead-letter state (`callout-console.js:590-601`).
- Roster loading races an authoritative callable against a Firestore fallback with a timeout, then prevents a slower fallback from replacing authoritative data (`callout-console.js:297-357`).
- Listener owners/generations are checked and listeners are explicitly disposed in callout, bulletin, and fault flows.
- Attachment identity, intent fingerprint, content hash, size, MIME signature, generation, quota, and parent revision are checked in the server state machine.
- Firestore indexes declare the compound callout and bulletin queries, while multiple large/TTL fields disable unnecessary indexing (`firestore.indexes.json:223-327, 427-666`).
- The service-worker browser test uses a real worker and real Cache Storage, and covers install, activation, update, hard-offline fallback, and recovery (`tests/service-worker-browser.mjs:1-24, 118-327`).

## Proposed implementation order

1. **Baseline/reconcile:** verify the local branch matches the cited snapshot; inventory queries/listeners and record emulator read counts. Documentation/tests only.
2. **Atomic offline shell:** manifest-driven required asset closure plus stalled-network tests. No visual change.
3. **Realtime decoders:** pure validators and corrupt-row isolation for callout/fault/bulletin streams. No visual change; preserve existing messages.
4. **Listener budget:** active-only realtime callout responses plus history one-shot/summary path. Requires emulator cost/consistency proof and rollback flag.
5. **Server timestamps:** add authoritative receipt fields with compatibility and rollback plan.
6. **Data-classified offline experiment:** only for approved Tier A data, behind a development-only flag. Do not introduce durable sensitive caching without owner/privacy approval.
7. **Attachment benchmark:** optimize only if device measurements justify the added protocol complexity.

## Validation gate for any implementation cycle

- Two independent connected reviewers compare security, privacy, cost, data integrity, performance, regressions, and rollback before each implementation action, as required by `AGENTS.md`.
- Run `cd tests && npm run all` on the final integrated tree.
- Run Firestore Rules only against the fail-closed demo project: `firebase emulators:exec --only firestore --project demo-resq "cd rules-test && npm test"`.
- Add the targeted tests described under each finding and retain exact pass counts/logs.
- Capture read-count and reconnect benchmarks using synthetic emulator data; never use production data.
- Keep written, locally tested, deployed, and production-verified states separate. This proposal authorizes none of the latter two.
- For any user-visible status/wording proposal, stop and create the required visual mockup/description in `docs/DESIGN_PROPOSALS.md` for owner approval before changing UI code.

## Cycle readiness assessment (Grok-role scope only)

- Offline shell resilience: **64/100** — meaningful real-worker coverage, but optional dependency failures can produce a partial install and stalled-network fallback is untested.
- Realtime efficiency: **62/100** — queries are bounded and cleanup exists, but commander listener/read fan-out scales with recent callouts and recipients.
- Data integrity/idempotency: **82/100** — strong request identities, replay handling, bounded retries, and attachment state machine; client-authoritative operational timestamps remain.
- Sensitive-data persistence/privacy: **86/100** — deliberate memory-only boundary and explicit tests; this also limits offline capability.
- Failure recovery: **77/100** — good callout/attachment recovery semantics, but no generic offline data recovery and no hung-network service-worker test.

Weighted specialist maturity: **74/100**. This is a planning score from static evidence, not an enterprise launch approval and not a substitute for the full multi-agent release gate.
