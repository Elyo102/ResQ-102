# ResQ enterprise roadmap

Evidence base: the role-specialized reports in `docs/agent-proposals/`. This is a work plan, not a deployment record. Runtime and visual product code were not changed in this cycle.

## Current maturity rating

**72/100 — subjective planning estimate, not a release attestation.**

Method: 25 points reliability, 20 security/isolation, 20 test reproducibility, 20 performance/scalability, and 15 field UX. The estimate uses only the inspected source and recorded tests; unrun physical-device, recovery, and production-scale checks receive no credit. A formal release score requires a fixed denominator and fresh evidence on the frozen candidate.

Why it is not higher yet:

- The PWA currently proves shell availability more strongly than durable offline workflow completion after reload.
- Real iPhone Safari, real notification delivery, recovery RPO/RTO, and production-scale latency remain separate verification gates.
- Some test and control-plane inputs are untracked, so a clean checkout cannot yet reproduce every local result.
- The scheduling engine and outbox paths have boundedness/fairness risks that should be removed before broad multi-station scale.

## Role-specialized contributions

| Role | Completed in this cycle | Main impact |
|---|---|---|
| Claude architecture role | Deep scheduling, state, outbox, and runtime analysis | Found algorithmic scale and crash-window risks before they reach more stations |
| Grok realtime role | PWA, listeners, timestamps, transport, and retry analysis | Distinguished shell-offline behavior from true offline workflow resilience |
| Gemini quality role | Tests, CI, Safari, integration, and documentation audit | Identified clean-checkout reproducibility and evidence gaps |
| Codex orchestrator | Unified scope, roadmap, approval-only visual mockups, and release sequencing | Prevented isolated branches and visual proposals from being treated as shipped product |

These are role-based subagent reviews. This cycle did not invoke or bill external Claude, Grok, or Gemini APIs.

## Execution order

### Phase 0 — reproducible baseline

1. Track every safe input needed by the test gates, or provide a documented sanitized generator. Secrets, provisioning credentials, vault material, and raw sensitive evidence must never be committed. A clean checkout with approved test credentials must reproduce the same result.
2. Define one authoritative `test:all` denominator and list exclusions explicitly.
3. Reconcile `PROJECT_STATUS.md` so historical provider/CI claims are not presented as current evidence.
4. Freeze one integration SHA before implementation batches begin.

Acceptance: clean clone, documented setup, one command, identical test inventory, zero hidden local assets.

### Phase 1 — reliability P0

1. **Service worker atomic shell:** fail installation when required core assets are absent; verify the exact required cache set rather than a minimum count.
2. **Network timeout:** add a bounded timeout and safe cached fallback to the service-worker network-first path.
3. **Outbox fairness:** prevent the first 100 records from starving later work; add cursor/fair scheduling and retry metadata.
4. **Push delivery contract:** add a durable operation identity and reconciliation, then document the provider's idempotency/ack guarantees. Without provider-supported idempotency, retain an explicit at-least-once contract and test how duplicates are surfaced rather than claiming exactly-once delivery.
5. **Schedule engine bounds:** first characterize output parity and Node 22 time/memory budgets. Any supported-capacity limit needs owner approval and must fail clearly before producing a partial schedule. Replace the planner only after differential tests prove stable assignment and tie-breaking behavior.

Acceptance: emulator and browser tests for interrupted network, reload, duplicate delivery, 101+ queued items, and worst-case scheduling input.

### Phase 2 — data and realtime efficiency

1. Normalize realtime document decoders and reject malformed cross-station data before paint/cache.
2. Use server-authoritative timestamps for operational events.
3. Budget listeners per screen; keep only visible/operational subscriptions alive and unsubscribe deterministically.
4. Add pagination/cursors to every collection that grows over time, beginning with faults and vehicle history.
5. Move media bytes from callable/base64 transport toward Storage metadata plus lazy retrieval, with migration and rollback.
6. Index station-range projections so monthly views do not repeatedly rescan the full plan; measure with `tests/schedule-performance.mjs`.
7. Close the client-state schema, reuse runtime construction, and index bulk-edit lookups before extracting the large runtime into modules.

Acceptance: per-route read/listener budgets, late-response identity tests, pagination continuity, and measured before/after results.

### Phase 3 — genuine offline workflows

1. Classify every action as online-required, safely queueable, or read-only cached.
2. Add durable local queueing only where server idempotency and conflict resolution are explicit.
3. Show transparent Hebrew state: queued, syncing, conflict, completed, or needs manual review.
4. Test reload and browser termination—not only temporary network interception.

Acceptance: offline action survives reload, syncs once, cannot duplicate, and exposes conflict resolution.

### Phase 4 — release and field proof

1. Physical iPhone Safari and Android checks for auth, PWA update, push, weak network, and background resume.
2. Recovery exercise with measured RPO/RTO.
3. Multi-station tenant isolation and role/shift authorization tests.
4. Release from one frozen SHA with rollback artifact and production verification separated from deployment.

Acceptance: signed evidence matrix with `WRITTEN`, `LOCAL_TESTED`, `DEPLOYED`, and `PRODUCTION_VERIFIED` kept separate.

## UI/UX approval gate

No design proposal is authorized for implementation by this document. Visual proposals and explanations are in [`DESIGN_PROPOSALS.md`](DESIGN_PROPOSALS.md). Each requires an explicit owner decision before UI code changes.

## Token and budget handoff protocol

At 80% of a provider-specific quota, the active runner must stop paid work, write its exact checkpoint, and emit:

> עצרתי פה, תמשיכו אותי

The checkpoint must include completed steps, remaining steps, changed files, last verified SHA, test evidence, and recommended successor. Reassignment may not bypass a shared budget cap or fabricate an agent heartbeat.

## Next implementation batch

The first code batch should contain only Phase 0 plus the service-worker atomic-cache tests. It should not include visual changes, media migration, or scheduling-algorithm replacement. This keeps rollback small and gives the later P0 fixes a reproducible gate.
