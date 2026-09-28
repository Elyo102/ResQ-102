# CI telemetry: implemented contract and activation prerequisites

## Local implementation

- `.github/workflows/telemetry.yml`: manual dispatch and path-filtered dev push;
  isolated emulator/browser test job and a separate terminal receipt job.
- `.github/scripts/telemetry-ci.mjs`: dedicated Firebase publisher refresh
  credential, bounded token exchange and RSA signature/claim verification,
  fixed isolated Firestore endpoint, three atomic create-only structured events
  with server timestamps. No raw logs, AI keys or Admin credentials.
- Failed test runs emit failure. Cancelled/skipped runs emit nothing; they are
  not reported as failed tests. A receipt heartbeat represents that short-lived
  Codex CI receipt process, NOT three external providers or a 24/7 daemon.
- `multi-agent-review.mjs`: all paid calls require shared budget admission.
  The request digest, model, output limit and stable operation identity are
  provided to the adapter. Missing/replayed/denied admission cannot send paid
  requests. The executable CLI has no adapter and deliberately fails closed.

## Not yet implemented/activated

1. Provision a separate CI publisher identity with Codex claim and private
   publisher allowlist. Never reuse owner credentials or local publisher token.
2. Configure GitHub environment `resq-telemetry` with required reviewer and
   dev-only deployment branch policy BEFORE adding its refresh-token secret.
   A YAML environment declaration alone does not establish this protection.
3. Put `FIREBASE_TELEMETRY_REFRESH_TOKEN` in that protected environment only;
   configure its `FIREBASE_TELEMETRY_UID` and exact `TELEMETRY_APPROVED_SHA`.
   Inspect reviewed workflow/source before advancing the approved SHA.
4. Implement the ONE durable shared budget adapter with atomic reservations,
   server time and conservative verified model pricing; the existing budget
   contract/tests are not a live billing cap. Keep unknown outcomes charged.
   No calls may cross a month boundary with a stale budget permit. Account
   calls outside this runner are not controlled by this application gate.
5. Publish reviewed files on dev and trigger its push. GitHub manual dispatch
   additionally requires workflow registration on the default branch; do not
   merge to main merely to make the button appear.
6. Verify create acknowledgements, actual owner sign-in/access and browser
   stream separately. No synthetic provider-online snapshots.

No cloud permissions, Rules, provider settings or repository secrets were
changed by this local implementation. Existing paid review secrets remain
bound to the separate trusted PR review workflow, not to the telemetry job.

## Verification

31/31 targeted tests passed (telemetry, provider-admission wiring, budget
contract). Tests use synthetic credentials and injected ledgers; they do not
prove a live publisher or durable budget is connected. Full local gate log:
`outputs/telemetry-emitter-gate-20260928.log`.

Rollback: omit/revert only this CI/script package; disable the dedicated
publisher and revoke its credential if later activated. Do not remove any
existing telemetry, owner configuration or product data.
