# Backup activation plan — FUTURE ONLY (DO NOT RUN)

This document lists **commands and decisions** for turning on paid/platform backup controls.  
**Do not execute** any of these against `station-102` or billing accounts from an agent session. OWNER + Billing approval required.

Qualitative cost: PITR + daily/weekly scheduled exports are usually modest vs. engineering time; encrypted monthly offsite and a second destination with retention lock dominate cost and ops load. Exact quotes belong in Billing console at decision time.

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
# PITR (Firestore) — OWNER/Billing
# gcloud firestore databases update --project=station-102 --enable-pitr

# Daily / weekly scheduled backups + retention — OWNER/Billing (console or gcloud firestore backups schedules …)
# … set retention (e.g. 7d daily / 12w weekly) …

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
5. Run **demo/emulator** drill before any prod schedule enablement.  
6. Update `BACKUP-MAP.md` statuses from DOCUMENTED_ONLY → IMPLEMENTED only after evidence.
