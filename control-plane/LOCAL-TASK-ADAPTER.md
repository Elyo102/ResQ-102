# Local-only bounded task adapter

Status: DISABLED_UNTIL_ATOMIC_GRANT_BOUNDING_COMMITTED

The production/CLI runCycle entry point rejects before credential exchange,
telemetry or provider calls. No environment override enables it. runLocalCycle
is an injected contract harness: its capability flags and mocks are NOT evidence
of a deployed grant, Rules authorization, quota, or a live agent.

Tasks: planner_draft_recovery (Claude), swap_race_review (Grok),
clean_checkout_gates (Gemini). The synthetic runLocalCycle harness still accepts
branded test excerpts; runVerifiedLocalCycle additionally requires the Git
assembler's unforgeable provenance brand. The assembler checks clean HEAD before
and after reading regular immutable blobs, rejects replacements, dirty inputs,
caller text and unapproved paths/ranges. Both the excerpts and the
complete serialized provider request (instructions/envelope included) have a
12KB bound; oversized input fails before credential exchange or reservation.
There is also a 60KB aggregate bound. Live wiring remains disabled regardless of
local capability flags or assembled inputs.
Secrets/PII detection is conservative screening, not a complete DLP guarantee.
Only strict, bounded JSON recommendations survive parsing. They are never
executed, applied, or treated as test/deployment evidence. Returned local results
include input and sanitized-response digests; nothing is broadcast to Firestore.

The budget adapter generates exactly two CAS writes: monthly ledger and a
principal/SHA/task-bound authorization grant. It appends one immutable provider
slot (at most three), reserves 250000 micro-USD per provider, caps each grant at
750000 and the month at 20000000. IDs are authorizationId_provider, not run IDs.
The permit is process-local, single-use and valid for at most 20 seconds. Fresh
instances seeing an existing reservation cannot dispatch. No retry or refund is
made after uncertain delivery. Fresh, operator-approved model pricing must bound
the request below its reservation; synthetic prices do not establish live prices
or prove provider billing/availability.
Heartbeat and task_started mean dispatch attempted, not a provider response or
continuous worker. Task consumers share closed local allowlists; no visual UI
changes were made. Unknown budget outcomes cannot emit provider running/completion.

The budget fragment is not deployable by itself. The full local candidate is
control-plane/firestore.rules, deterministically assembled from the read-only
capture identified in firestore-rules-provenance.json. assemble-rules.mjs requires
the exact capture SHA256 and performs no network requests. Owner/events and final
deny-all bytes are preserved except the explicitly approved four additional task
labels. The legacy budget block is replaced completely, never overlapped. The
dynamic publisher revocation check and server-side 120-second month-end blackout
are preserved. Full Rules emulator coverage exercises these together, not just
the isolated fragment. The boundary test substitutes only budgetWindow's clock;
it does not claim the emulator's global request.time is controllable.

Activation remains a separate OPEN gate: fresh deployed-Rules drift check, fresh
operator-approved grants/pricing, scoped identities and emitter compatibility,
full candidate validation and two reviews. This local package neither provisions
nor migrates existing live ledgers. Legacy missing-grant/pricing schemas fail
closed. No product, production, secrets, IAM or cloud state was changed.

Rollback is not a blind re-deployment of old Rules: first disable paid execution
and the budget publisher, preserve every monthly charge/grant/history document,
then verify schema compatibility. Never reset counters, delete history or refund
uncertain reservations. No rollback/cloud command is included in this package.
