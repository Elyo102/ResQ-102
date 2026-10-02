# Semantic target review, not an executable release manifest

Two independent read-only reviews of e949880 versus local baseline023ed2 agreed:
add markStationReady; exclude the seven unchanged call graphs below from the
minimal semantic target set. This yields79 provisional targets. Production
baseline/source parity is still NOT VERIFIED; package-byte differences alone
and these semantic decisions do not prove independently deployed versions.

| Target | Decision and source path |
|---|---|
| markStationReady | Include: index.js553 -> station-provision-service.js190/212 -> onboarding-station-gates.js91/135 -> index.js496/497 readSilenceCapability -> providerWiringReceipt initialized470. The attestation source hashes changed. |
| getHrMonthReports | Exclude: index.js278 -> hr-hours-service.js125-158 listMonth; unchanged stored-report/review reader, not changed course calculation. |
| listAttendanceCorrectionAudit | Exclude: index.js338 -> attendance-correction-support.js423 -> unchanged read225/event projection. |
| getAttendanceCorrectionAudit | Exclude: index.js340 -> attendance-correction-support.js435 -> unchanged read/evidence projection. |
| getHrMonthlyOverHours | Exclude: index.js4471 -> hr-monthly-summary.js592 overHours; unchanged active-generation reader, not changed cursor parser. |
| getHrOverHoursAlert | Exclude: index.js282 -> compatibility wrapper4480 -> same unchanged overHours. |
| getMetricsDashboard | Exclude: index.js799 -> metrics-service.js221; unchanged aggregate reader retaining legacy rows, not keyed ingestion77/155. |
| rollbackSchedule | Exclude: index.js7208 -> controlled rollback -> schedule-runtime.js7194/7253 -> service.publish and finishCommittedPublication/releaseOutbox; not modified delivery/reconciliation workers. |

Source paths in the table are relative to functions/ at the reviewed commit.
The review does not allow reverting old binaries after new data is created.
Rollback must retain shift_change and station_shift handling, course assignment
source labels, generation-bound summary cursors/source digests, replication
activation cutoff, E07 attempt/operation/payload provenance and uncertainty,
E08 truthful acknowledgement, E06 scan cursor, create-only audits and keyed
metrics ingestion. Reverting source and readiness attestation must be coordinated.

Rules delta versus the local baseline: eight lines adding explicit deny matches
for schedule_runtime_workers and security_audit_events. Firestore indexes are
unchanged against that baseline; current cloud readiness remains unverified.
No Storage rules deployment belongs to this change.

Packaging check additionally reproduced two emulator sidecars eligible for Hosting:
firebase.ack-emulator.json and firebase.hr48-emulator.json. Exact exclusions were
added after review; the existing privacy test, expanded with both local HTTP404
probes, passed47 checks. This was not evidence of existing production exposure.

Still required before cloud mutations: live baseline reconciliation, final frozen
manifest, compatible rollback artifacts, encrypted readback-verified backup, all
required acceptance evidence, quota-conscious coordinated Functions batches and
Hosting promotion last. Services do not form an atomic cloud transaction.
