# E19 focused offline/data classification

Read-only source review at working base3a4575b with HR48/replication/E07 edits. This is not offline device testing and does not approve durable sensitive-data storage. Other product modules remain to be classified.

| Area | Observed behavior | Evidence |
|---|---|---|
| Application shell | Same-origin GET assets may use SW cache; Firebase/Auth/Functions bypass it. Not an action queue. | firebase-messaging-sw.js174-189 |
| HR requests | Callable mutation; payload/request identity retained in memory, success follows validated receipt. Unknown result retries same intent. Closing page loses retry details, not necessarily the server operation. | hr-requests-client.js28-37; hr-requests-ui.js621-665; hr-requests.html25-32 |
| Attendance | Save/delete/submit/approve/correction use callables. Memory-only, identity-scoped pending states; no durable offline guarantee. | attendance.html473-479,548-620,1600-1636 |
| HR report reads | Bounded identity-scoped memory cache marks memory/server freshness; review requires server freshness. | hr-client.js47-110; hr-hours-ui.js351 |
| Callout send/close/transfer | Callable workflow; uncertain intent and transfer state remain in memory with scope fences. | callout-console.js519-521,615-694 |
| Callout seen/response | Firestore setDoc; SDK-pending write, confirmation waits for promise. Not an approved durable/reload-safe queue. | callout.js215-236,562-587 |
| Callout roster privacy exception | localStorage may contain up to200 UID/name/crew entries, viewer/station/crew scoped,8-hour read TTL. Login clears cache; TTL on read is not timed physical deletion. | callout-roster-cache.js8-17,43-72; login.html1392 |
| Schedule edits/publish | Callable preview/digest/base and pending apply stay in memory. Publication receipt precedes success. Prepared notices do not prove delivery. | schedule-management.js21-67,4621-4640 |

No new IndexedDB persistence configuration was found in the inspected attendance/callout entry points. Do not generalize this limited inspection to every module or call sensitive data entirely memory-only: the roster cache is a concrete exception.

## Open requirements

- E20: owner/privacy-approved eligible action plus reload, termination, conflict and replay evidence before introducing any durable workflow.
- E21: existing pending/uncertain states are partial; factual publication-delivery wording is being corrected without layout changes. Unified offline UX is still a proposal.
- E29: browser closure loses memory-held intent; a non-PII identity-scoped reconciliation journal is not implemented or tested here.
- Complete remaining module classification and review the persistent roster exception before marking E19 closed.
- No false offline-success bug was established in the inspected HR/hours/callout confirmation paths. Absence of a finding is not a guarantee.
