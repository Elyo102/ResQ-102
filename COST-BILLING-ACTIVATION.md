# Cost and usage: proposed activation, not executed

Status: **LOCAL CANDIDATE ONLY**. No Cloud Billing export, BigQuery dataset,
authorized view, IAM binding, production secret, or deploy is created by this file.
The 90-day expiry timestamps on cost counters and the replay ledger are a
retention target, not an active deletion policy. This release does not enable
TTL for those collections. The internal prune stub is neither scheduled nor
exposed as an operator action. Keep the cost event feeder off until a reviewed
manual cleanup process, owner, and privacy retention decision exist.
The Billing account linked to `station-102` also pays for another project;
Standard export is account-wide. Never give the ResQ runtime identity direct
read access to the raw export table.

## Proposed isolated target

- New FinOps project: `resq-finops-station102` (ID availability and billing link
  must be verified before creation).
- Location: `EU` for both datasets and query jobs.
- Raw export dataset: `resq_billing_export`; Standard usage cost only.
- View dataset: `resq_billing_views`; view name:
  `resq_station102_usage_cost`.
- The view must be authorized on the raw dataset and must use the exact
  `project.id = 'station-102'` predicate. Its only exported fields should be
  `usage_start_time`, `service`, `currency`, `cost`, `credits`, `export_time`,
  `project`, and `cost_type`. Verify the live view definition and query result
  before enabling the reader. The raw table name is assigned by Google after
  export is enabled.

Illustrative view SQL, with the actual account table name substituted only
after export setup:

```sql
CREATE VIEW `resq-finops-station102.resq_billing_views.resq_station102_usage_cost` AS
SELECT usage_start_time, service, currency, cost, credits, export_time,
       project, cost_type
FROM `resq-finops-station102.resq_billing_export.gcp_billing_export_v1_<BILLING_ACCOUNT_ID>`
WHERE project.id = 'station-102';
```

The runtime identity is
`resq-cost-billing-reader@station-102.iam.gserviceaccount.com`, bound only to
`getCostUsageDashboard`. It needs a BigQuery job-creation role on the FinOps
job project and read access to the **view only**, not the raw dataset. Because
this callable also serves the existing dashboard, it separately needs verified
read access to Auth users, Firestore documents and the HMAC secret in
`station-102`. Do not grant project-wide BigQuery Data Viewer.

## Activation gates

1. Confirm target project ID, billing link, account scope, EU location, and
   owner-approved BigQuery storage/query cost. Create two isolated datasets.
2. Enable Standard usage cost export, leave detailed/pricing/FOCUS disabled.
   The first export can be delayed or backfilled; never display missing rows
   as zero cost.
3. Create and authorize the project-filtered view. Verify its definition,
   schema, only-ResQ rows, and that the reader identity cannot query raw data.
4. Create the dedicated runtime identity and its minimum cross-project IAM.
   Verify Auth/Firestore/Secret access without granting write privileges.
5. Set only the exact view, job project, location, byte cap and enable flag on
   the callable. Deploy only after the final clean-tree release gate and exact
   production approval. Verify one dry run, one real bounded query, source
   currency/as-of, the UI badge, and comparison against the Billing report.
6. Keep per-user call counts labelled `not_wired` until a separately reviewed
   live feeder, HMAC secret, retention and monitoring are actually active.

The code has a 100 MiB per-query default cap, a 15-minute per-instance
single-flight cache, and one maximum dashboard instance. These are *not* a
daily spend ceiling. Set a Billing budget alert and monitor BigQuery jobs;
measure partition pruning against the real table before changing the query.

Rollback is staged: disable the reader flag/redeploy the prior callable,
revoke the reader's view and job IAM, then disable export if the owner wants
new billing writes to stop. Disabling export does not erase prior BigQuery
data or its storage cost. Never delete the datasets as an automatic rollback.
