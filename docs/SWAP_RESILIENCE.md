# Swap resilience: local verification boundary

The browser currently writes swap transitions directly to Firestore. Rules
serialize conflicting updates against the current document and recheck live
station membership. There is no dedicated durable offline swap queue or
idempotent-success receipt in this change.

## Tested contracts

- Two competing acceptances produce one winner; the losing request is denied.
- Repeating a successful acceptance is a conflict, not another transition.
- Owner cancellation cannot be resurrected by an acceptance queued in the
  browser SDK's default in-memory disconnected state.
- Deactivation/transfer after a client read denies the subsequent write.
- `serverTimestamp()` resolves on the server, but the legacy Rules schema also
  accepts caller-provided timestamps. Server-only timestamp enforcement is a
  separate compatibility decision, not implemented or claimed here.
- The real `onSwapChange` handler's corrective rejection/pending writes compare
  the event's exact document update time with a fresh transaction read. Stale
  or duplicate events cannot overwrite newer source state or emit the paired
  corrective push. Transaction infrastructure failures propagate.

The trigger tests execute the exact extracted handler with synthetic dependencies;
they are not deployed-trigger tests. Shift-log entries and ordinary notification
branches remain at-least-once. The corrective push is not atomic with the source
write: a crash after commit can lose that push. No exactly-once delivery claim.

The native suite uses unique synthetic station paths, deletes only its own
documents, and refuses non-loopback/non-`demo-resq` targets before SDK imports.
It does not prove browser reload/crash persistence or physical Safari behavior.
No persistent caching or queue was added to HR, attendance, callout, or push.

## Validation commands

- Node 22: `node --test functions/swap-trigger-resilience.test.js`
- Existing loopback emulator, `GCLOUD_PROJECT=demo-resq`:
  `node rules-test/swap-resilience.test.mjs`

Both are registered in `rules-test/package.json`; the registry now contains 21
entries. No existing gate was removed. This backend source change also invalidates
the previous provider source attestation for `functions/index.js`; refresh only
after the separately required boundary suites, not by regenerating it blindly.

No Rules, UI, deployment, production data, or provider API call changed in this
slice. Rollback is a reviewed code revert; do not restore stale swap documents.
