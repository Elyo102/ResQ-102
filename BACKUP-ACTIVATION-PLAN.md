# Backup completion plan — remaining work (DO NOT RUN without approval)

Read-only GCP checks on 2026-09-23 confirmed Firestore PITR enabled for seven days, daily and Sunday weekly backup schedules retaining each backup for 98 days, and a latest backup in `READY` state. These controls need no activation by this branch. Isolated restore, Auth/Storage backup execution, monitoring transport, and measured RPO/RTO remain open.
**Do not execute** production or billing changes without the required OWNER approval.

Qualitative cost: existing PITR and daily/weekly scheduled backups incur platform charges; encrypted monthly offsite and a second destination with retention lock add cost and operational load. Check actual charges in Billing.

## Minimum IAM / role separation

- Separate **backup writer**, **restore operator**, and **billing/owner** principals.
- Never document the Compute Engine default service account as the standing access recipient for Sheets or export buckets.
- Prefer a dedicated backup SA with least privilege to the backup destination only.
- Restore operator must not be the same principal as daily app runtime where avoidable.

## Ransomware / insider risk

- Keep a **second backup destination** (different project or org-controlled bucket) with **retention lock / object lock** where available.
- Signing keys and seal passphrases live only in operator env / secret manager — never in git.
- Deletes of backup objects require dual control (IAM + retention lock).

## Command sketch (DO NOT RUN)

```text
# PITR and daily/weekly schedules are already active in station-102.
# Verify their state before a drill; do not create duplicate schedules.

# Encrypted monthly export to isolated bucket + retention lock — OWNER
# … create bucket, uniform access, retention policy / bucket lock, CMEK optional …

# Auth export schedule — ops-auth-backup.mjs with passphrase + hash config env (demo first)
# Storage incremental — ops-storage-backup.mjs (demo first); storage.rules still OWNER_DECISION

# Status / alert wiring — feed observations into functions/backup-monitoring.js evaluator;
#   alerting transport is OUT OF SCOPE of the pure evaluator (do not claim alerts are sent).

# Isolation drill — restore only to resq-dr-demo / emulator; refuse station-102.
```

## OWNER / Billing approval checklist

1. Written approval that cost and retention are accepted.
2. Named alert recipients and on-call.
3. Confirm second destination + retention lock.
4. Confirm IAM role separation.
5. Run a **demo/emulator** restore drill and measure RPO/RTO before claiming recovery readiness.
6. Update `BACKUP-MAP.md` for Auth/Storage execution and monitoring only after evidence.
