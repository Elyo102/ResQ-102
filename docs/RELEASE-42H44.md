# ResQ 42H.44 — closed product scope

Baseline: 6811504bf474a461988525beb4dc934fda2ad84f (42H.43).
Current status: LOCAL implementation; NOT DEPLOYED. Final candidate and gate pending.

## Required package (owner confirmed)

- V1: real existing vehicle photographs navigable by side with arrows/swipe, small damage pins, optional roof; reusable for all vehicles. No synthetic continuous 3D or invented angles. Coordinates/auth unchanged.
- PWA: visible-window periodic SW check and explicit update prompt, no automatic reload on discovery, no signout or Auth storage deletion. Existing draft/file guards retained. Old loaded clients may require initial reopen. Browser scheduling is not a guaranteed five-minute SLA.
- U1: existing attendance actions organized as prepare missing draft days / inspect and correct / explicit preview and submit. Preparing saves only missing draft days. No automatic attendance attestation; no replacement of existing records. Advanced controls remain visible according to existing authorization.
- H1: selected employee report refresh in visible HR hours section with 30-second cadence, one in-flight operation, paused while interacting/offline/hidden/pending. Identity/month/detail guards checked after response. Old data retained with stale warning on network errors; malformed responses rejected. No all-station realtime claim; list refresh remains manual. HR reads saved unsubmitted drafts already supported. No scheduled email path added.
- Release engine: local orchestration core plus failure/resume tests outside public product tree. Real cloud adapters, frozen target manifest, archive and production verification still required; local simulation is not authorization or deployment.

## Evidence so far

Vehicle helper9, fleet Rules43 and F-01/browser regressions passed before release stamp.
PWA coordinator9, lifecycle, real Service Worker browser and installation checks passed.
HR hours65 scenarios and HR client50 passed before final additional race test/stamp.
Attendance create-only/self/approval boundaries and role browser suite passed.
Local engine13 simulated cases passed (retry budget now part of plan digest).
These are local checks, not physical-device delivery or production-flow proof.

## Release boundaries and order

Recompute exact Functions after stamping, including version-bound dependencies. Deploy the roof-compatible createFaultReport and Firestore Rules before matching UI. No Storage rules, index/TTL policies, IAM, Auth users, invitations, email sends or live-mode switch.
Capture current sources/config/rules/IAM and encrypted readback-verified rollback before mutation. Keep old 42H.43 evidence immutable. Rollback must retain readers/server support for roof data created after release; no data deletion.
Freeze one clean candidate; run final release:validate and Rules emulator on it. Reconcile each remote outcome before retry. Verify Functions, Rules, Hosting and Pages parity before claiming deployed.

## Still outside this delivered change

Broad U2 visual simplification proposals require individual review and approval; real continuous vehicle360 awaits capture. Lisa account issuance and device QA are separate operations. Historical Grok/Claude tasks must be reconciled against current evidence, not silently declared complete by this release.
