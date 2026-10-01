# 42H.47 attendance candidate

Baseline: production `023ed2df7a8bf411cd7ef8280931137a8100818b`.
Surgical input: `032d34a42e9f34aba911adb604996687c05fd1e9`; not the full dev tree.

## Closed requirements

| Requirement | Acceptance | State |
| --- | --- | --- |
| Own report opens ready | Existing saved records and clearly unconfirmed scheduled days; no write on load | Under validation |
| Edit | Visible edit action for saved and proposed days, fresh write context retained | Under validation |
| No preparation step | No user-facing draft preparation; internal draft state and withdrawal/delete retained | Under validation |
| Explicit report approval | Confirm displayed dates/hours, save missing days, refresh and compare versions, then submit; stale state requires reconfirmation | Under validation |
| Local export/share | Read-only HTML report download and native file sharing to available mail/WhatsApp apps; no automatic email, no public report link | Under validation |
| HR visibility | Existing station-scoped access retained; no new role or employee attestation by HR | Under validation |
| Course/manual entry integration | Full approved scheduled course credit, actual assignment proof, manual date/editor behavior from surgical input | Under validation |
| Production safety | Existing three admission toggles, fresh write guards, Terms 1.3, reserve calculation and approved snapshot readers preserved | Under validation |

## Failure semantics

Loading/exporting does not confirm attendance. Fill and submission are not one transaction: an interrupted confirmation may leave saved but unapproved records. An uncertain request may only be explicitly recovered with the original request ID and payload, followed by fresh confirmation. No automatic replay or fabricated successful approval.

Sharing depends on browser/OS file-share support and installed apps. Download is the fallback; the user attaches the file manually. Actual WhatsApp/email delivery and physical iPhone behavior are not asserted by local browser tests.

## Release scope and evidence

Main ResQ Hosting and only the twelve changed existing callable paths in `release-targets-42h47.json`. No status dashboard, GitHub Pages, data migration, employee writes, new IAM, Rules, Storage or indexes.

Targeted tests precede commit. The full clean-tree release gate, native emulator validation, encrypted read-back verified deployment backup and post-release source/Hosting hash checks remain required. No prior candidate's results authorize this candidate. Deployment and production verification remain pending.

Rollback retains new course-label compatible readers and existing records. Admission switches can block new reserve/course/order operations but do not undo report confirmation or saved records. Do not restore incompatible old readers after new snapshots exist.

## Local evidence before release gate

- Ready-report browser: 32/32 in one final run at 375/430 px, including exact-request recovery for lost fill/submit responses, stale views, no-write export and real course rendering.
- Course-entry browser: 18/18 on this production-based tree.
- Native course transaction/Rules integration: 6/6 with synthetic identities on `demo-resq` emulator. Expected denied-write logs occurred; this is not a claim of zero emulator log messages.
- Backend course/calculator/rollout/correction/support suites: 152/152 (reviewer run); exact callable wiring 12/12.
- Version contract: 377 references and 19/19 mutations; provider boundary checks and fresh source receipt passed.
- Test inventory: 364/364 registered. Existing application test chain retained, with two new browser suites added.
- Two independent local reviewers approved the ready-report flow and uncertainty recovery. They are not external Claude/Grok provider attestations.
- Fixed test-fixture mismatches: actual `{data,fence}` envelope, obsolete preparation-step labels, and an asynchronous share-result race. No failing assertion was removed to obtain a pass.

Full clean-tree release gate, physical-device sharing and deployment verification are still pending.
