# Unified execution checkpoint

Parent candidate:5dd2544. Estimated development53%; final integrated acceptance0/57. This is not a frozen release or production readiness declaration.

The owner-specified AGENTS.md system-tool exemption was independently read back; shared Git and required runtime access restored. No unrelated personal data or .resq-listeners accessed.

## E08 partial: truthful durable acknowledgement

Both schedule and guard delivery now report sent:true only when their own lease/status transaction actually persists sent. A positive provider result followed by replaced lease, cancellation or deleted row returns provider-accepted-unacknowledged without overwriting newer state or another send. Existing recipient, publication, monthly authority, retry and trial boundaries unchanged. Audit writes unchanged and create-only.

8 new native Firestore emulator scenarios PASS: schedule/guard × normal ACK, changed lease, cancellation, deleted row. Normal ACK replay sends once; raced records remain exactly unchanged. Provider is a synthetic callback, not FCM or device delivery. No exactly-once claim.

Initial fixture run failed before provider because publication/guard IDs violated the existing minimum length. Repair1 changed only synthetic IDs; all8 then passed. No previously green component suite rerun.

Evidence: outbox-ack-emulator-20261001.log (failed fixture) and outbox-ack-emulator-repair1-20261001.log (PASS), SHA25661d78590ac3ef964e2d20d58d1b1fa981a718bbf43ad4e93cf30bfd2e562162a. Expected emulator SIGINT shutdown notice retained. Tests registered additively in rules-test pretest.

## Configuration and remaining work

HMAC secret RESQ_METRICS_HASH_KEY version1 was created and metadata-verified in the previous authorized run. Do not regenerate it. Current source already binds it only to recordMetrics; application deployment and runtime access readiness remain separate. No secret values appear here.

Token revocation code and prior local evidence retained. Real Auth refresh-token invalidation and client reauthentication are not validated with employee accounts or simulated claims. Dedicated safe test-identity evidence remains open.

E07 operation/payload/attempt identity and unknown provider outcome tracking are not integrated by this E08 partial fix. Same-lease attempt/digest fences, changed-payload conflicts and crash/retry evidence remain required. Control-plane, physical-device, DR, retention decisions and other mandatory57-scope items remain open. Do not silently exclude them or promote before the frozen integrated gate.

Next: scoped E07 integration preserving the verified E06 traversal and create-only audit fixes; then remaining requirements, exact candidate freeze and full required release evidence. No production deployment occurred.
