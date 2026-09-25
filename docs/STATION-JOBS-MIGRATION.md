# Station jobs migration + rollback (GAP3)

## Current pilot behavior
The scheduled Functions in `functions/index.js` still use the existing
`PUSH_STATION` Eilat path. `functions/station-jobs.js` is an inactive candidate:
it is not imported or called by those Functions. Editing `config/station_jobs`
therefore has **no effect** on live reminders. Eilat remains the first-station
template for shared rules; a station's own schedule and substations are data,
not a separate copy of the scheduling code.

## Future migration (not included in this pilot release)
1. Add a persistent per-station/day job claim and explicit failure state before
   fan-out, so a partial push cannot be silently marked successful or blindly
   replayed to every recipient.
2. Test retries, overlap, time-zone boundaries and two stations in an isolated
   environment. Keep Eilat enrolled during the first multi-station cycle.
3. Review the final source and deploy the routing change separately. Then add
   station ids one at a time and observe each complete reminder cycle.

## Rollback
Before routing is wired, there is no enrollment rollback to perform. After a
future routing release, rollback must restore the last known good Functions
revision; clearing enrollment alone is not a substitute for that rollback.

## Candidate behavior
The unused module keeps Eilat when enrollment is empty. It is retained for
development tests only and must not be described as deployed multi-station
coverage.
