# Hours update candidate — not deployed

Base: dab2a5ddafc800215793776d87c86f28473740b0.

## Isolated dev integration checkpoint

Product milestone committed as f8311aa. This worktree instead starts from GitHub dev0e88ba7932341737ed63c0e2a34e5aa500d977ac and selectively ports that milestone. Product-baseline test evidence below is not evidence for this different tree.

- Current branch: codex/hours-credit-dev-integration; no commit/push of the integration yet.
- Three conflicts resolved narrowly: retain dev synchronous editor/equalOffset semantics, contained browser adapter and all dev test scripts. Do not copy product-only authorization, refresh/cache, full-day-consent UI or release stamps.
- Two independent connected reviewers approved the resolved source scope, NOT push readiness.
- Integrated `npm run attendance:corrections`: exit0,147 core tests plus policy/source/wiring/report checks. Exact locked dependencies installed offline; existing dependency deprecation warnings were reported, not suppressed.
- Mandatory contained `test:all` NOT RUN: port127.0.0.1:8191 is held by Java PID30268 with --project_id demo-resq-control. Do not kill, reuse or reconfigure that unrelated emulator. The gate requires an owned demo-resq emulator at that endpoint.
- Native `rules-test/reserve-shift.integration.test.mjs`: updated new-record32.5/version2 expectations; historical24 and ordinary24 cases retained. Owned demo-resq emulator on8199:11/11PASS, actual transactions/Rules with synthetic Auth/config. Expected negative Rules tests emitted PERMISSION_DENIED diagnostics; not an error-free console claim.
- No force push, no dirty existing dev-worktree edits, no production access.

All requirements remain in scope. The earlier release exception does not apply.

| Requirement | Status |
|---|---|
| Green reserve and reserve-shift, yellow sick, blue vacation in hours and report | Written; targeted report/browser checks pass; final visual acceptance pending |
| Red course in hours/report | Styling prepared only; actual course flow pending |
| Reserve work plus full 8.5 once; 12/24/26 ->20.5/32.5/34.5 | Written; 23 focused calculator/overlap tests pass |
| Explicit next-day exit beyond24, without changing shift type | Written; calculator checks pass; real-device validation pending |
| Preserve historical calculations unless actual times/type change | Server-owned version2; omitted-secondary normalization fixed; browser regression passes |
| Exact columns שעת כניסה / שעת יציאה / תחנה in attendance and generated report | Written; report test passes; explicit next-day labels, no invented missing station |
| Course start/end and horizontal timeline from authoritative per-date user shifts | OPEN: not implemented; no fixed10/24 values permitted |
| Private military-order file/image attachment | Written and targeted-tested: private saved-row parent, PDF/JPEG/PNG, existing2MiB/file and10-file/20MiB quota; no implicit reserve absence; real cloud upload NOT tested |
| New full candidate gate, commit, deploy handoff | OPEN |

No schedule-management changes, production writes, migration, or retrospective report rewrite.

## Local checkpoint 2026-09-30

Each command executed separately with Node 22.21.1:
- `node --test functions/reserve-credit-v2.test.js functions/reserve-shift-calculation.test.js functions/attendance-reserve-overlap.test.js`: exit0,23/23PASS.
- `node tests/reserve-shift-browser.mjs`: exit0,34/34PASS, Chromium360/1280, synthetic transport, no external network. Earlier failure at legacy note-only upgrade was fixed; subsequent old new-credit expectations and server mock were updated, not suppressed.
- `node --test functions/attendance-corrections.test.js functions/attendance-hours-calculator.test.js`: exit0,57/57PASS.
- `node tests/hours-report-updates.mjs`: exit0, exact labels, five category mappings, escaped/missing station, explicit offsets and print colors PASS.
- `node tests/attendance-self-source.mjs`: exit0, trusted employee read/write boundary PASS (static source check, not emulator integration).

Two connected local reviewers independently approved the scoped calculation/report changes. No claim of external Claude/Grok review.

Milestone verification: `npm run attendance:corrections` exit0 with149 Node core tests plus policy/source/wiring/report checks. Its initial3 failures were old new-record24 expectations, now32.5 with persisted/read version2 assertions; legacy24 assertions remain unchanged. New regression files are registered additively. `node tests/test-inventory.mjs` exit0,354/354 registered. Both reviewers approved this local milestone commit only.

GitHub dev was fetched read-only at0e88ba7932341737ed63c0e2a34e5aa500d977ac. It diverges from the product baseline; do not merge this entire product branch into dev. A separate semantic integration and validation is required, preserving the dirty existing dev checkout.

Release blockers/open engineering work:
- Course needs authoritative per-date hours/revision data; current aggregate rotation defaults are not sufficient. Resolve server-side and recheck on commit; unknown dates must not become invented shifts.
- Orders now have a separate authorized attendance parent with creationTime incarnation, live identity, report-state and CAS fencing. Existing request/document parent behavior is retained. Deployment must include context callable plus five attachment callables, sidecar Rules and frontend assets; private bucket real-environment verification remains pending.
- Prior A rollback calculator is NOT compatible with v2 >24/+8.5 rows. Prepare and test a new compatibility rollback before any deployment of this candidate.
- Full release gate and production deployment have NOT run for this candidate. Targeted native integration is recorded separately below, not a substitute for the full gate.

## Integration evidence — 2026-09-30

- Integrated reserve browser:26/26PASS at360/1280, actual source and mock transport. Initial launch-only failures were missing inherited NODE_OPTIONS then Windows backslash quoting; forward-slash inherited guard fixed execution, containment was never disabled.
- Attachment backend/service/core:126/126PASS. Initial array parent-kind acceptance failure fixed with an explicit string guard; existing parent tests retained.
- Attendance attachment host:4/4PASS (component substituted; tests cover epoch and modal pending-work lifecycle).
- Existing real attachment component browser:49/49PASS, mock transport/storage, no real upload claim.
- New attachment native suite:6/6PASS, actual Firestore createTime, concurrent CAS, delete/recreate isolation and Rules; synthetic Auth and no Storage calls. Denied-write SDK diagnostics are expected negative checks.
- Owned Java emulator PID8168 on8199 was stopped after both native suites; unrelated8191 process was untouched.
- Provider boundary probes and receipt-generator tests:53 TAP entries PASS (some entries contain additional internal cases), plus actual-source SMTP wiring10PASS. Only index.js receipt hash changed after verification; all other covered source hashes retained. Receipt verifierPASS.
- Version contract:342references,19/19mutations caught. Test inventory343/343registered. Existing dependency deprecation warnings are not claimed absent.
- Attachment callable wiring:21/21PASS, retaining five private attachment callables and testing the new context callable with explicit doubles. Public source inventory121assetsPASS; no publishing performed by that check.
- GitHub dev advanced from0e88ba7 to faaed15 with three control-plane provenance files only; preserve them when integrating. No force push.
- Course range/timeline remains OPEN: authoritative workday API yields dates/counts but not authoritative per-day credited hours. A metadata-only overlay would not fulfill full course reporting, so it was not substituted silently. No invented fixed10shifts or24hours.
- This is a DEV milestone, NOT100% of the closed feature manifest and NOT a production-ready release. Native coverage does not prove Storage IAM, real App Check, real-device Safari, or production delivery.
- Before production, include the new restricted attendance_order_parents sidecar in the approved backup/restore classification. This DEV milestone does not perform or claim that infrastructure change.

## Approved course completion — 2026-09-30 (validation in progress)

This section supersedes the earlier OPEN course calculation decision, not the recorded historical test results. The owner approved full official standard hours for each original crew-cycle work date inside an HR-approved course period. Course is a red report overlay; it must not remove the underlying assignment or attendance.

- HR approval freezes explicit rotation standard hours, original crew/role, source versions and digest. Missing/ambiguous standards fail closed; no fixed 10-shift or 24-hour default is invented.
- The private monthly course index and HR decision are written transactionally. Monthly submission/HR approval use union dates and course revision, credit each date once, and retain base attendance. Course-only months are supported. Submitted reports must reopen before changing approval.
- Self, HR detail and export consume the same approved projection. The red timeline shows start/end and actual 9/10/11-cycle work dates. Pending/rejected requests do not grant credit.
- Both legacy attendance-create alternatives now include a bounded course-month exclusion. This intentional create-only Rules dependency prevents later conflicting absence/import writes; it does not broaden read/update permissions.
- Backup classification now includes private order parents as authoritative with specialized coherent restore. Course indexes are derived and excluded from independent restore. Before any future restored hours service is enabled, rebuild indexes from currently approved historical snapshots, never by reapproving against today's rotation. No backup, restore, deletion or cloud mutation was executed here.
- Compatibility rollback must retain course-aware readers and the create exclusion while approved course indexes exist. An older reader that ignores them is not an approved rollback.

Targeted evidence: course UI pure 9/9; actual-source browser 32/32 at 360/1280 (mock transport); native Firestore course 6/6 including serialization, legacy conflict denial and unaffected positives, submission CAS, reopen/rejection/history and HR payroll approval. Native backup/restore suites 13/13 and 8/8 passed on synthetic temporary Git/ZIP fixtures. Version contract 345 references and 19 mutations passed; inventory 345/345 registered. Both connected local reviewers approved the bounded implementation; no external provider review is claimed.

Final gate initially stopped before execution on unstaged reproducibility inputs; the reviewed candidate was then staged. Its first full Rules run reached a separate control-plane budget fixture rejection, under diagnosis without weakening Rules. Remote dev advanced to 6e0fe31; its three control-plane commits were preserved by fast-forward plus recoverable local reapplication, not force push. The accidentally commented-out DEL negative test was restored with paired review. Final combined gate, commit and push remain pending until recorded below. No production deployment performed.

Final merged `npm run test:all`: EXIT0, 30/30 Rules entries, 72/72 Playwright cases and 32/32 reserve/course actual-source browser scenarios, clean containment (`resq-contained-d5S0EW`). The earlier budget rejection did not recur: diagnostic run 20/20 and final combined run passed without changing its Rules or fixture semantics; root cause remains unproven, not reported as fixed.

Full containment suite: 140/140 PASS, inventory 100 files/63 browser entries. Full application gate is being completed in evidence-linked segments: first 10/138 passed, then 26/138 cumulative after repairing missing course dependency injection in legacy VM test fixtures. A subsequent static Rules read-budget contract must be updated for the approved bounded course exclusion; historical import batch size is being reduced conservatively without relying on caching. These are scoped compatibility corrections, not disabled assertions. Retained logs: `%TEMP%/resq-course-final-test-all-merged.log`, `resq-course-final-application.log`, `resq-course-app-continuation.log`, `resq-course-containment.log`.

## Final candidate reconciliation

The historical OPEN entries above are checkpoints, not the current feature status. The course calculation, red overlay, approved-period timeline, private index, report projection and backup classification are implemented in this candidate on dev baseline `6e0fe31dc2e2003f66c698434f4e2a7f020b061e`. No original attendance or operational schedule is overwritten.

- The approved Rules read-cost contract now pins the exact create-only helper and both call sites. Historical import batches are bounded at three rows. A new native emulator import-budget suite passed 2/2 with a clean containment ledger; the Rules registry now has 31 entries. Evidence is the earlier complete 30-entry run plus this separately executed additional entry, not a claimed 31-entry full run.
- Actual HR monthly-summary handling was corrected so a valid course request is not classified as malformed or counted as sickness/reserve/vacation. The stored monthly report remains the hours source. Its suite passed 39/39.
- Legacy VM fixtures now inject the course service explicitly; finite callable telemetry lists include the exact course/order read callables only. HR enum tests retain all prior categories and add course. The reviewed HR source and provider attestation pins were refreshed only after their corresponding verification.
- The application chain reached 125/138 completed steps. In step126, the first three browser scripts passed; the UX correction fixture then failed because it omitted mandatory `course_month`. Its canonical empty month was added without changing assertions or product validation. The failed run also recorded `implicit-child-shell` during failure handling; it is retained as failed evidence, not relabeled clean. The successful continuation must have its own clean ledger.
- Segmented logs retained in `%TEMP%`: `resq-course-app-final.log`, `resq-course-app-last.log`, `resq-course-app-hr.log`, `resq-course-app-browser.log`, and the final continuation `resq-course-app-remainder.log`. An in-memory continuation runner initially rejected its own over-escaped grammar before running tests; it was corrected without changing repository gate scripts.
- Two independent connected reviewers compared their final conclusions and approved the implementation conditionally on the remaining gate, clean ledger and accurate final documentation. No external provider review, production deployment, real-device result, live Storage upload or cloud rollback rehearsal is claimed.
- Existing gate inefficiency observed, not introduced here: `browser` ends with `phonesweep.mjs`, and subsequent `browser:mobile` invokes that same file again. This candidate preserves the registered acceptance chain; deduplicating the gate is a separate test-infrastructure improvement, not a hidden skip during this run.

## Completed DEV validation

- The evidence-linked application chain is complete: **138/138 registered contained steps PASS**, with the two separate mandatory native backup/restore suites already PASS. This is segmented coverage of the unchanged registered plan after scoped repairs, not a claim that one literal `npm run all` invocation exited0. The final continuation exited0 and its guard asserted a clean ledger: `%TEMP%/resq-course-app-remainder-f55f7b89-0e38-4944-b50d-0db90d4716e3`.
- The actual HR browser cases passed for a pending employee course (no client credit/approval fields) and the approved server-snapshot timeline (original assignments retained). The UX correction fixture passed after the additive schema fix. All remaining registered browser, HR, security, DR, capacity, metrics and mobile-shell checks passed; mobile-shell finished104/104.
- Focused combined gate evidence remains: `test:all` EXIT0 with30/30 Rules entries,72/72 Playwright and32/32 course/reserve browser scenarios; the later added native import-cost entry separately passed2/2. No failed assertion remains in the completed DEV validation. Expected permission-denial diagnostics, dependency/Git line-ending warnings and the pre-existing server-only collection warning are not claimed absent.
- Explicit NOT RUN: iOS native build (requires macOS/Xcode), Android native build (SDK unavailable), real iPhone/Safari acceptance, live order-document upload/Storage IAM, production App Check and deployment/rollback rehearsal. Mock/browser/emulator results are not production verification.
- Approved action after final staged-input verification: one reviewed feature commit and non-force push to GitHub `dev`. No `main` merge, product deployment, production reads/writes or paid agent dispatch is included.
