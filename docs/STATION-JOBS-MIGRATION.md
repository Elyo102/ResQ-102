# Station jobs migration + rollback (GAP3)

## Current behavior (this package)
`functions/station-jobs.js` reads `config/station_jobs.enabled_station_ids`.

If the doc is **missing or empty**, scheduled reminders still run for the
legacy Eilat station id `eilat_102` (`DEFAULT_FALLBACK_STATION_ID` /
`fallbackStationId`). This preserves today's single-station behavior.

## Migration (multi-station)
1. Dry-run: write `config/station_jobs` with `enabled_station_ids: ["eilat_102"]`.
2. Observe one hoursReminder / guardReminder / signReminder cycle.
3. Add additional station ids one at a time.
4. After ≥7 days stable multi-station, OWNER may set `fallbackStationId: ''`
   in a follow-up PR to remove the Eilat auto-fallback.

## Rollback
1. Clear `enabled_station_ids` to `[]` or delete `config/station_jobs`.
2. Fallback immediately returns to `eilat_102` — reminders continue.
3. No Cloud Functions redeploy required for enrollment rollback.

## Tip behavior NOT ported
The readiness tip treated empty enrollment as **0 runs**. That is rejected here
(would silence Eilat). Do not re-introduce tip empty=0 semantics.
