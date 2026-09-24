# Cost/usage feeder — activation boundary

This branch implements a **disabled-by-default** durable outbox and a five-minute
drain for three read-only callables: `getStationScheduleRange`,
`getMyAttendanceMonth`, and `listHrRequestsInbox`. It does not measure all
Firebase reads/writes, all Functions, or the emergency callout path. The board
must label this as partial usage; user attribution is not a billing invoice.

## Local flow

1. The business callable completes and has already performed its own live
   authorization.
2. With `RESQ_COST_USAGE_OUTBOX_ENABLED=true`, the wrapper reads the locked
   measurement start and current Auth claims, then persists only HMAC event ID,
   HMAC user ID, station ID, feature, outcome, and timestamp. A failed outbox
   write fails that measured read; this is a deliberate accuracy/availability
   tradeoff and must be pilot-tested before enabling.
3. A scheduled server-only drain processes up to 500 pending events every five
   minutes, but stops after 240 seconds within a 300-second function timeout.
   Ledger + user daily + user lifetime + one of 16 station/day shards + one of
   16 global/day shards are atomic per eligible event after their separate
   aggregation starts. Station is
   captured at event time, not looked up when the dashboard opens. Only after a
   successful ingest is an outbox document deleted. Retry after a crash is
   deduplicated. A permanently invalid event is retained as `blocked` for
   operator review while later events continue. No public ingest callable exists.
4. The dashboard reports `awaiting_sample`, `active_partial`, `backlog`,
   `blocked`, `delayed`, or `not_wired`. A fresh empty scheduler run is not proof
   that any callable emitted an event.
   The cursor document is diagnostics, **not** a resumable upstream cursor.

## Before any production enablement

- Complete review of the exact final diff and Node 22 release gate; run relevant
  Firestore rules emulator tests on the same tree.
- Set `RESQ_COST_USAGE_HASH_KEY` in Secret Manager before deploying any function
  that binds it. Record key version `v1`; do not rotate it without a migration
  for lifetime counters and outstanding outbox events.
- Confirm callable service identities can read Auth, read measurement config,
  and write only the private outbox; drain identity needs private counter access.
- Deploy the code with the flag **off**. In a controlled pilot, set the locked
  measurement start (or call the same super-only start action once to establish
  a separate station aggregation start on an existing measurement), then enable
  the flag for the three read callables and the
  drain together. Verify one real call of each, replay, failure recovery,
  delayed-state display, latency and Firestore cost. For an existing measurement,
  the global cutover is the next UTC midnight; before then the global total is
  not measured. Disable the old drain/emitter revision before setting this
  cutover; otherwise old code can create a ledger entry without a global shard.
- The disabled scheduler still creates a recurring Cloud Scheduler job if
  deployed. Its cost and removal are part of the exact production approval.
- Configure an operational alert for drain errors, pending backlog and stale
  `cost_usage_config/feeder.checked_at`. Name the responder. Without these,
  this is not a production-ready monitoring claim.
- Set and verify privacy retention/account-deletion policy for lifetime counts.
  Station/day and global/day shards are retained for 90 days and must be restored
  with the replay ledger. No events before `station_aggregate_start_at` or
  `global_aggregate_start_at` are backfilled;
  a late source event is counted only if its occurrence is after that start.
  The board reads one selected UTC day: 16 global shards and up to 25 stations
  times 16 shards, plus the station page. The global total can include archived
  stations and is not the sum of a station page. This creates one extra Firestore
  write per measured event; with outbox create/delete it is about seven document
  writes per event before retries and TTL deletes. Do not enable without a pilot
  cost and queue-latency budget. At 500 events in 240 seconds, average ingest and
  delete must stay below 480 ms/event or the backlog grows.
  Pending outbox documents have **no TTL**: they require alerting and manual
  resolution if one remains invalid. Daily and ledger TTL policies must be
  activated and checked separately.
- Expand the measured-callable allowlist only after per-endpoint authorization,
  sensitivity, latency, cost, and rollback review. Do not call three endpoints
  “all server calls.”

## Rollback

Disable `RESQ_COST_USAGE_OUTBOX_ENABLED`; this stops emission and drain without
deleting counters or pending events. Keep the HMAC key and outbox until a
reviewed replay/retention decision. Revert the Functions and Rules changes only
after confirming no pending event needs replay. Billing Export is a separate
path described in `COST-BILLING-ACTIVATION.md`.

No production configuration, secret, IAM, billing, or deployment was changed by
this local implementation.
