# Full DR drill runbook (offline / emulator)

**Status:** procedure + script land in-repo. RPO ≤ 24h and RTO ≤ 4h are **targets**, not proven, until an OWNER-accepted execute drill report records measured times (`rtoProven` / `rpoProven` stay false by default).

## What this covers

| Area | How |
|------|-----|
| Firestore | Real `ops-disaster-restore.mjs` adapters; emulator only when `FIRESTORE_EMULATOR_HOST` is set + injectable API |
| Auth fixtures + custom claims | Real `ops-auth-backup.mjs` refuse/import guards; fixture import only via injectable `authApi` |
| Storage fixtures | Real `ops-storage-backup.mjs` refuse/restore; create-only |
| Rules | Static `tests/rulecheck.mjs` always; **live Rules = NOT RUN** without emulator + `rulesRunner` — never faked PASS |
| Indexes / Hosting / config | Inventory of `firestore.indexes.json`, `firebase.json`, `.firebaserc` |
| Integrity | Count + checksum compare helpers |
| RTO | `rtoMeasuredMs` on the report (wall clock of the drill harness, not a production SLA proof) |
| Cleanup / rollback | Temp demo workdir removed; create-only / skip-existing defaults |

## Hard rules

- Demo project IDs only (default `resq-dr-demo`).
- `station-102` hard-denied even if present on an allowlist.
- `--execute` requires `--confirm-target` identical to `--target` and `RESQ_RESTORE_SIGNING_KEY` (≥32).
- `--verify-only` never writes.
- No cloud connection on the offline path; script refuses auto-connecting Admin SDK without injectables.
- `storage.rules` remains **BLOCKED** — not invented, not deployed.

## Commands

```bash
# Offline / CI — expected NOT RUN for emulator + live Rules
node ops-dr-full-drill.mjs --verify-only --target resq-dr-demo

# Emulator execute (local only; inject adapters from a wrapper — do not point at prod)
# export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
# export RESQ_RESTORE_TARGET_ALLOWLIST=resq-dr-demo
# export RESQ_RESTORE_SIGNING_KEY='…≥32 chars…'
# node ops-dr-full-drill.mjs --target resq-dr-demo --execute --confirm-target resq-dr-demo
```

 complementary local bundle drill (git/documents):

```bash
node ops-restore-drill.mjs
```

## Interpreting NOT RUN

If `FIRESTORE_EMULATOR_HOST` is unset, steps `firestore_emulator_restore`, `rules_live_emulator`, `auth_fixture_import`, and `storage_fixture_restore` are **NOT RUN** with that exact reason. That is success of the gate, not a silent PASS.

## Evidence after each drill

Keep the JSON report under `_גיבוי/dr-drill-runs/` (gitignored patterns apply). Record: who ran it, target id, emulator host or NOT RUN reason, `rtoMeasuredMs`, FAIL steps, and that prod was not touched.
