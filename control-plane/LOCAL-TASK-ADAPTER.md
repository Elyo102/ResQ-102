# Local-only bounded task adapter

Status: DISABLED_UNTIL_ATOMIC_GRANT_BOUNDING_COMMITTED

The production/CLI runCycle entry point rejects before credential exchange,
telemetry or provider calls. No environment override enables it. runLocalCycle
is an injected contract harness: its capability flags and mocks are NOT evidence
of a deployed grant, Rules authorization, quota, or a live agent.

Tasks: planner_draft_recovery (Claude), swap_race_review (Grok),
clean_checkout_gates (Gemini). Inputs are caller-supplied, SHA-labelled partial
source excerpts restricted to reviewed paths/ranges. Both the excerpts and the
complete serialized provider request (instructions/envelope included) have a
12KB bound; oversized input fails before credential exchange or reservation.
They must be verified against immutable Git blobs before future live wiring;
this package does not claim supplied text is cryptographically bound to Git.
Secrets/PII detection is conservative screening, not a complete DLP guarantee.
Only strict, bounded JSON recommendations survive parsing. They are never
executed, applied, or treated as test/deployment evidence. Returned local results
include input and sanitized-response digests; nothing is broadcast to Firestore.

The local harness simulates at most three reservations of 250000 micro-USD.
It does not replace a durable per-authorization cap: the base atomic-budget only
has a monthly ledger. There is no retry/refund after uncertain delivery.
Heartbeat and task_started mean dispatch attempted, not a provider response or
continuous worker. These new labels are local only; existing UI/Rules allowlists
are unchanged. Unknown budget outcomes cannot emit provider running/completion.

Activation prerequisites (all remain OPEN): tracked atomic authorization grant
and cycle bounds, matching Rules and consumer task allowlists, immutable sanitized
source assembly, current model pricing/availability, emitter compatibility,
fresh full gate and two independent reviews. No existing untracked cloud/rules
files were imported. No UI, production, secrets, IAM or cloud state changed.
