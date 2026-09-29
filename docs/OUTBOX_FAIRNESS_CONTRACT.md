# Outbox traversal and delivery contract

`schedule_runtime_workers/outbox_resume` is server-only ephemeral traversal
state. Its per-collection/status document-path cursors can be rebuilt by starting
at the beginning. They are not evidence that messages were delivered and must
not be restored as authoritative business data. Backup policy excludes them;
client Rules deny all access. No TTL, scheduled deletion or live reset is added.

The cursor advances atomically with the query, before per-row processing. A
crash may defer that page until a later wrap; delivery leases and live-source
checks remain authoritative. Queries are bounded per status, not a global
end-to-end latency guarantee. Document-path ordering avoids equal timestamp ties.

Retry reconciliation queues a due retry; a subsequent resume sends it. Provider
entry is durably marked before the external call. A lost acknowledgement can
produce another delivery after lease expiry: this is **at least once**, not
exactly once. Stable operation/payload identity and duplicate-risk history make
that risk visible; they do not give FCM provider-side idempotency.

A retry with changed delivery content is terminally refused as
`DELIVERY_OPERATION_CONFLICT`, retaining the original identity and uncertainty.
This includes content derived from a changed live guard location. It does not
silently replace an already-attempted operation; any replacement requires a new
authorized business event. Tests must preserve this explicit compatibility rule.

This document records local code intent. It does not enable a scheduler, deploy
Rules/Functions, restore data or prove production index availability.

## Local test isolation limitation

The native runtime suite currently uses the fixed synthetic `schedule_it`
station. A failed run can leave state that its partial seed does not reset.
Before an authorized rerun, clean only that owned station and the test-owned
cursor document in the explicitly guarded demo-resq loopback emulator. Never
wipe an entire database. Future hardening should use a unique run namespace and
finally cleanup, and restore shared cursor state when tests share an emulator.
The two workbook lifecycle fixtures now use random run-specific station IDs and
delete only their exact generated roots in `finally`. The suite refuses non-demo
projects and non-loopback emulator endpoints before loading the Admin SDK.
