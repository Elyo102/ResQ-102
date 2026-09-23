# ResQ · BACKUP-MAP (authoritative)

Updated: 2026-09-23 · Branch: `grok/backup-recovery-hardening`
Policy source: `functions/backup-policy.js` · Ops: `ops-disaster-restore.mjs`, `ops-auth-backup.mjs`, `ops-backup.mjs`

> **Status legend (never present DOCUMENTED_ONLY as active):**
> `IMPLEMENTED` = code path exists and is fail-closed where claimed.
> `DOCUMENTED_ONLY` = described here / in runbooks; **not** an active backup.
> `BLOCKED` = refused by code (e.g. restore to `station-102`).
> `OWNER_DECISION` = retention / enablement not decided by owner.

This map does **not** authorize production PITR, Storage backup jobs, or restore to `station-102`.

| Component | Source | Sensitivity | Source-of-truth | Backup method | Proposed frequency | Destination | Encryption | Retention | RPO | RTO | Restore path | Verification path | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Firestore collections / subcollections (managed_export + identity_consistency_export) | Live Firebase project (ops: `--source`) | confidential / restricted_identity / secret (per policy row) | `functions/backup-policy.js` `DATA_POLICIES` | `ops-disaster-restore.mjs backup --execute` → sealed `resq-fs-*` snapshot | Daily (proposed) | `_גיבוי/resq-fs-*` (gitignored) | AES-256-GCM seal (`ops-backup-seal.mjs`, passphrase via `RESQ_BACKUP_SEAL_PASSPHRASE` only) | Align to policy `retention` + owner window | Measured per run (`plan.rpo`); target **OWNER_DECISION** | Measured on execute (`rto_seconds`); target **OWNER_DECISION** | `restore` dry-run → isolated `--execute` to allowlisted non-prod only | `verify` (enc checksum without decrypt; full content with passphrase) + integrity-report | **IMPLEMENTED** |
| Firestore paths with `backupPolicy: exclude` / `restorePolicy: do_not_restore\|rebuild` | Same | secret / temporary / derived | backup-policy.js | Not copied into snapshot (counted in `paths_excluded`) | n/a | n/a | n/a | n/a | n/a | n/a | Rebuild or omit (never auto-restore) | Policy classify + plan counts | **IMPLEMENTED** (exclude) |
| Firestore `specialized_media_export` / `specialized_restore` | Same | sensitive_media | backup-policy.js | Snapshotted but **never** auto-written | With FS snapshot | Inside sealed set | Same seal | media / legal **OWNER_DECISION** | — | — | Manual specialized restore only | Listed as `manual_required` in plan/report | **IMPLEMENTED** (capture + gate); restore procedure **DOCUMENTED_ONLY** |
| Unclassified Firestore path | Discoverable at backup | unknown | Must be added to backup-policy.js | Backup **fails closed** | n/a | n/a | n/a | n/a | n/a | n/a | Blocked until classified | Error: unclassified collections | **IMPLEMENTED** |
| Firebase Auth users (hashes/salts) | `firebase auth:export` via `ops-auth-backup.mjs` | secret / restricted_identity | Auth service | Encrypted export (`resq-auth-backup-v2`) with **hash_config embedded** | Daily (proposed) | **Outside repo** only | AES-256-GCM + scrypt passphrase | **OWNER_DECISION** | **OWNER_DECISION** | **OWNER_DECISION** | Import to allowlisted demo only; `station-102` + `.firebaserc` default HARD_DENY; params from blob | `verify` + fingerprint mismatch detection | **IMPLEMENTED** |
| Firebase Auth custom claims | Admin/fixture provider (not in `auth:export`) | restricted_identity | Fixture/`claimsProvider` selects stored claims | Embedded in Auth payload (+ optional split claims `.enc`) | With Auth export | Outside repo | Same AES-256-GCM | **OWNER_DECISION** | — | — | `setCustomUserClaims` on demo import only | Manifest `includes_custom_claims` + count | **IMPLEMENTED** (fixture/provider path); production Admin wiring **OWNER_DECISION** |
| Cloud Storage HR private objects | Bucket `station-102-hr-private-europe-west1`; prefix `hr-private/{station}/{parent_kind}/{parent_id}/{attachment_id}` | sensitive_media | Object generation + FS `object_path`/`object_generation` | `ops-storage-backup.mjs` incremental by generation | **OWNER_DECISION** | `_גיבוי-storage/` / external `--out` (gitignored) | Local object files + manifest checksums | media / medical **OWNER_DECISION** | **OWNER_DECISION** | **OWNER_DECISION** | Restore to allowlisted demo adapter only; no silent overwrite | `verify` local (+ optional compareRemote) | **IMPLEMENTED** (adapter/offline); live GCS drill **NOT RUN** |
| Hosting static assets | Repo root / hosting public `.` | operational | Git | Git + `ops-backup.mjs` repository.bundle | With code backup | `_גיבוי/resq-*` | Bundle hash in manifest | keep N sets (`ops-backup` keep) | Commit-based | Redeploy | Redeploy from commit / hosting release | SHA-256 of bundle | **IMPLEMENTED** (code path via `ops-backup.mjs`) |
| Cloud Functions source + config | `functions/` + `firebase.json` | confidential (may embed ops config; no secrets in repo) | Git | Git / repository.bundle | With code backup | `_גיבוי/` | Bundle hash | keep N | Commit-based | Redeploy functions | `firebase deploy --only functions` from known commit | lockfile + tests | **IMPLEMENTED** (via git/`ops-backup.mjs`) |
| Firestore Rules | `firestore.rules` (+ `firestore_1.rules` legacy) | operational | Git | Git | With code | Git remote / `_גיבוי` | n/a | git history | Commit-based | Redeploy rules | `firebase deploy --only firestore:rules` | rules-test suite | **IMPLEMENTED** |
| Storage Rules | *(no `storage.rules` in repo)* | operational | Missing — Admin SDK is sole access path today | **Not invented this branch** | — | — | n/a | — | — | — | — | — | **BLOCKED / OWNER_DECISION** (cannot verify safe rules from code alone; no deploy) |
| Firestore indexes | `firestore.indexes.json` | operational | Git | Git | With code | Git / `_גיבוי` | n/a | git history | Commit-based | Deploy indexes | `firebase deploy --only firestore:indexes` | index file digest | **IMPLEMENTED** |
| Release manifests / attestations | `release-manifest.json`, `PILOT-INTEGRATION-MANIFEST.md`, `release-*.mjs` | operational | Git | Git | Per release | Git | n/a | permanent in git | Commit-based | Re-read manifest | Compare SHA / stamp | **IMPLEMENTED** |
| Ops / release / DR docs | `DISASTER-RECOVERY-RUNBOOK.md`, `DR-WIRING.md`, `PILOT-DR-PLAN.md`, `README-ניטור-וגיבוי.md`, this map | operational | Git | Git | Continuous | Git | n/a | git history | — | — | Follow runbook (dry-run first) | Doc ↔ code review | **IMPLEMENTED** |
| Managed Firestore PITR / scheduled export | GCP Billing + console | N/A (platform) | GCP | Platform PITR / export | **OWNER_DECISION** (enablement blocked until billing/approval) | GCP-managed | GCP default | Platform default / **OWNER_DECISION** | Platform (often ≤1h if enabled) | Platform restore | GCP console / support — **never** wired to auto-hit `station-102` from this repo | GCP audit | **DOCUMENTED_ONLY** / **OWNER_DECISION** |
| Medical / HR attachment retention | FS + Storage | restricted_identity / sensitive_media | legal + owner | specialized paths only | **OWNER_DECISION** | **OWNER_DECISION** | Required if exported | **OWNER_DECISION** (medical) | **OWNER_DECISION** | **OWNER_DECISION** | specialized_restore unresolved | Manual | **OWNER_DECISION** |
| Local code/docs backup (`ops-backup.mjs`) | Working tree + `_דיונים` docs | may include sensitive local notes | Git + private folders | `repository.bundle` + `documents.zip` | Operator-driven | `_גיבוי/resq-*` | Content hashes in manifest (not AES seal) | `--keep` 1..365 | File mtime / commit | Unpack bundle | Manifest SHA-256 | **IMPLEMENTED** |
| Restore target `station-102` | n/a | production | `.firebaserc` default + `HARD_DENY_TARGETS` | n/a | n/a | n/a | n/a | n/a | n/a | n/a | **Hard refuse** | Unit + CLI tests | **BLOCKED** |

## Fail-closed defaults (Packages 2–3)

- `backup` and `restore` default to **dry-run** (no SDK, no network, no sensitive writes).
- Real backup requires `--execute` + `RESQ_BACKUP_SEAL_PASSPHRASE` (≥20); plaintext `documents.jsonl` is removed after seal.
- Production project ids (`station-102` / `.firebaserc` default) are refused as **backup source** unless `RESQ_BACKUP_ALLOW_PROD_SOURCE=1` (manual ops only; automated tests must not set this).
- Unclassified collections **abort** backup completion.
- Unknown pagination token **aborts** (does not restart from page 0).
- Storage object backup remains **DOCUMENTED_ONLY** until Package 5.
- PITR enablement remains **DOCUMENTED_ONLY / OWNER_DECISION** — not activated by this branch.

## Related commands (non-prod / dry-run first)

```text
node ops-disaster-restore.mjs backup --source <project>                 # dry-run
node ops-disaster-restore.mjs backup --source <project> --execute     # seals snapshot
node ops-auth-backup.mjs export --project <project> --out <outside-repo>
node ops-backup.mjs --dry-run
```

## Monitoring & full drill (packages 6–7)

| Asset | Method | Status |
|-------|--------|--------|
| Observation evaluator `functions/backup-monitoring.js` | Pure function → PASS\|ALERT\|BLOCK\|ERROR | **IMPLEMENTED** (evaluator only — does **not** send alerts) |
| Full DR drill `ops-dr-full-drill.mjs` + `FULL-DR-DRILL-RUNBOOK.md` | Offline/emulator procedure | **IMPLEMENTED** procedure; live Rules/emulator steps may be **NOT RUN** |
| Sheet export `nightlySheetBackup` | Scheduled callable helper | **RETIRED / FAIL-CLOSED** while `BACKUP_SHEET_ID` empty — not an active control |
| Policy count | `DATA_POLICIES.length` in `functions/backup-policy.js` | **158** rows (metrics rows included; `metrics-backup-policies.js` kept as wiring helper — do not delete) |
