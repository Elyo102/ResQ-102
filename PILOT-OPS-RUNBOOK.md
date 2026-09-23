# Pilot operational runbook — backup & recovery

## Owner

- Product / station owner for pilot: **OWNER** (name filled by human; agents do not invent).
- Technical backup operators: maintainers with access to demo restore allowlists only.

## Alert recipients

- Primary: OWNER email / phone.
- Secondary: on-call maintainer.
- Monitoring evaluator (`functions/backup-monitoring.js`) returns PASS|ALERT|BLOCK|ERROR only — **wire transport separately**; do not assume mail/SMS was sent.

## How to detect failure

- Evaluator BLOCK/ALERT on missing backup, too-old backup, failed backup, missing manifest, auth without hash config, storage without generation/checksum, retention violation, restore drill overdue.
- `nightlySheetBackup` is **retired/fail-closed** while `BACKUP_SHEET_ID` is empty — empty id must **not** be treated as success.
- Scheduled Cloud Function failures / missing drill reports.

## When to stop the pilot

- Any restore path that can touch `station-102`.
- Suspected ransomware, mass delete, or privacy incident.
- Backup ALERT/BLOCK unresolved past RPO target window.
- Loss of OWNER contact / approval.

## Training mode

- Use demo project + emulator only.
- Prefer `--verify-only` / dry-run.
- No real PII in fixtures.

## Rollback

- Prefer create-only restore to demo; never overwrite prod.
- App rollback via previous Hosting release / Functions revision (separate from data restore).
- Code rollback cannot undelete Firestore documents removed via ops-export delete.

## Privacy incident

1. Stop exports that could widen exposure.
2. Preserve audit logs; do not commit secrets/exports.
3. Notify OWNER; follow legal/privacy playbook outside this repo.
4. Rotate seal/signing keys if exposure suspected.

## Escalation

Operator → OWNER → Billing (if platform backup cost/PITR) → legal/privacy if PII.

## Go / No-Go

| Gate | Go only if |
|------|------------|
| Hard deny | `station-102` refused by restore adapters |
| Signing | `RESQ_RESTORE_SIGNING_KEY` required for execute |
| Drill | Latest drill report OK or NOT RUN reasons understood |
| Sheet backup | Not counted as active protection while retired/fail-closed |
| PITR / schedules | Read-only GCP check on 2026-09-23 confirmed PITR, daily and weekly schedules, and a latest backup in READY; recheck freshness before a drill |

If a resumed Storage backup reports `PARTIAL` because a completed encrypted file is missing or damaged, preserve the failed set for diagnosis and start a new destination. Do not delete or overwrite the old set, and do not count it as a successful backup.

## RPO / RTO

- **Targets:** RPO ≤ 24h, RTO ≤ 4h.
- **Not marked proven** until an OWNER-accepted execute drill records evidence (`rtoProven`/`rpoProven`).

## Evidence list after each drill

- Drill JSON report path and SHA-256.
- Operator name + timestamp (Asia/Jerusalem).
- Target project id (demo).
- Emulator host or exact NOT RUN reason.
- Measured `rtoMeasuredMs` (harness).
- FAIL/NOT_RUN step list.
- Confirmation that prod / real PII were not used.
