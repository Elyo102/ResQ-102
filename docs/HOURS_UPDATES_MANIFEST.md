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
