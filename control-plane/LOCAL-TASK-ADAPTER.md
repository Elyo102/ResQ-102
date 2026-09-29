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

The budget Rules file is a test-only fragment, wrapped only by the isolated
emulator harness. It is NOT a complete/deployable control-plane ruleset. Capture
the actual isolated project's full Rules read-only, or obtain an approved committed
source; merge the fragment with owner/events authorization and review/test that
whole ruleset before any deployment. No owner/events permissions were invented.

Activation remains a separate OPEN gate: full Rules reconciliation, fresh
operator-approved grants/pricing, scoped identities and emitter compatibility,
full candidate validation and two reviews. This local package neither provisions
nor migrates existing live ledgers. Legacy missing-grant/pricing schemas fail
closed. No product, production, secrets, IAM or cloud state was changed.
