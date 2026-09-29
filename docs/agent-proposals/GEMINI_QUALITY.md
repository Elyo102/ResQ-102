# Gemini-role quality and integration review

Date: 2026-09-29. Inspected checkout: `work/resq-ci-review-dev`, branch `dev`,
HEAD `e6b7367ae81dae1e76b9c9540dd421a7044a5dc7`. This is a local Codex agent
performing the requested Gemini specialist role, **not an external Gemini API
review**. Evidence is a read-only source/configuration audit of a dirty checkout.
No tests, provider calls, cloud reads, deployments or production-data operations
were performed for this report. Passing historical runs are not fresh evidence.

## Coverage and limits

| Area | Current source evidence | What it does not establish |
| --- | --- | --- |
| Focused gate | `tests/package.json`: `test:all` runs `test:rules && test:e2e`; `all` is a separate, much broader application chain | A successful `test:all` is not a successful full application gate |
| Rules and backend | `rules-test/package.json` registers isolation, attendance, HR read/write access, wrapper wiring and native concurrency tests | Admin SDK service tests do not by themselves prove client Rules enforcement; mocks do not prove native transaction behavior |
| Emulator safety | `tests/run-local-rules.mjs` requires Node22, explicit `127.0.0.1:8191` and `demo-resq`, removes credential overrides and validates child command forms | This is scoped target protection, not an OS network sandbox or production acceptance |
| New browser runner | `tests/playwright.config.mjs`: one worker, no retries, forbidOnly, failure traces; Mobile Chrome and Desktop Chrome, service workers blocked | No WebKit, real iPhone/Safari, actual push delivery or service-worker integration coverage in this runner |
| Private dashboard | `tests/e2e/private-live-bootstrap.spec.mjs` substitutes GIS and Firebase SDKs; tests user gesture, denied access and no auth-handler redirect | Real Google OAuth, Safari storage policies, deployed Rules and provider connectivity are not tested by that fixture |
| PWA lifecycle | `tests/service-worker-browser.mjs` allows Chromium service workers, exercises cache activation/update and actually closes/reopens its local HTTP server for offline recovery | Offline shell behavior is not a verified Firestore write queue, conflict strategy or mobile OS lifecycle |
| iOS-oriented check | `tests/pwacheck.mjs` creates an iPhone-user-agent context in Chromium | User-agent emulation is not Safari engine/device evidence |

**Release reproducibility concern:** at inspection, `control-plane/web/`,
`tests/e2e/private-status.spec.mjs` and `private-live-bootstrap.spec.mjs` were
untracked. Local wildcard discovery can therefore run a different suite from a
clean checkout. Before a release claim, inventory tracked test inputs and their
dependencies at the exact candidate SHA; do not sweep private provisioning,
vault files or raw outputs into Git to make the counts match.

## API integration blockers: actual PR review

The interfaces are compatible but not yet a safe drop-in activation:

1. `.github/scripts/multi-agent-review.mjs` requires `sharedBudget` and its CLI
   does not inject one. This intentional fail-closed state must remain until a
   reviewed connection is supplied. `createAtomicBudget` accepts the existing
   `connectCloud` transport with the separate budget UID and budget-only claim;
   a telemetry publisher identity is not interchangeable.
2. The PR reviewer still calls Grok Chat Completions with `max_tokens`, while
   `control-plane/agent-cycle.mjs` uses Responses and its reviewed combined
   output/reasoning limit. Reuse the reviewed endpoint/body/extraction contract
   before asserting the fixed reservation covers the request.
3. `selectDiff` caps filename-plus-patch bytes at 60,000. JSON escaping, prompts
   and request structure add bytes. `atomic-budget.mjs` correctly rejects full
   bodies over 60,000: preflight the exact serialized bodies, without silently
   truncating source or claiming complete coverage.
4. Environment-selected model IDs must equal the server policy. The PR Gemini
   request lacks the explicit minimal-thinking configuration used by the newer
   agent cycle. Model/body compatibility and cost assumptions require pinned
   tests, not a model-name regular expression alone.
5. `multi-agent-review.yml` checks out the trusted PR base, not PR code, but has
   no protected environment or budget credential wiring. Existing dev-only
   telemetry approval is not automatically permission for a PR-target/main
   review job. Preserve trusted-base execution, manual SHA-bound approval and
   secret separation when designing that bridge.

Required bridge regressions: actual atomic adapter with mocked REST; reservation
before each fetch; concurrent-cap/CAS conflict; expired or replayed permits;
unknown commit and provider response without retries/refunds; wrong identity or
model; escaped-body overflow; reasoning-token bound; stale base/head; partial
coverage never green. Provider smoke success is connectivity evidence, not a
substantive review of a PR. This report makes no fresh account-credit assertion.

## Mobile, offline, vehicle and media roadmap

- `firebase-messaging-sw.js:105` implements network-first same-origin GET caching,
  excludes cross-origin services and version metadata, and supplies offline shell
  fallback. Preserve this privacy boundary; do not blanket-enable persistent HR
  caches or replay approvals after reconnect without a separate threat model.
- `vehicle.html:298` loads whole faults, vehicles and vehicle-view collections;
  `faults.html:677` similarly loads broad station collections with an origin
  fence. A proposed limit of 20 is not safe operational completeness. Design
  active-data coverage and paged history separately, including legacy missing
  dates/statuses and full report/export semantics. Read failures caught as null
  merit targeted readiness/recovery tests; no user-visible defect was reproduced
  in this audit.
- `faults.js:481` already compresses images through canvas/JPEG with 1280-edge and
  600 KiB data-URL limits; `vehicle.html:604` uses 1600/820 KiB and checks captured
  target identity before and after processing. Proposals should measure decode
  memory, upload latency and image usefulness, not claim compression is absent.
  Storage/codec changes need authorization, legacy-media compatibility and rollback.
- Add an explicitly scoped Safari/WebKit test track and physical-device checklist
  for login, standalone launch, suspend/resume, keyboard, offline/reconnect and
  station/account switching. Browser emulation cannot close the device checklist.

All visual/loading/progress/offline-status changes remain proposals under the
strict UI freeze. The canonical approval document is
[`../DESIGN_PROPOSALS.md`](../DESIGN_PROPOSALS.md); historical proposals must not
be interpreted as approved implementations.

## CI efficiency without weakening evidence

Both PR local-tests and telemetry test jobs can execute `test:all` for overlapping
changes. Their code identity is not necessarily equal: PR merge SHA, head SHA and
trusted base SHA differ. Do not deduplicate solely by branch or PR head.

Current setup-node caches npm downloads using three lockfiles and
`.github/ci-toolchain.json`; retain this safe separation from privileged review.
Do not reuse untrusted PR artifacts, node_modules or success receipts in a
secret-bearing job. First measure job durations and identify truly identical
inputs. Any future success-evidence reuse must bind source tree, test/fixture
bytes, tools, configuration and environment, reject failures/cancellations and
retain mandatory release gates until explicitly reviewed. No cache bypass is
implemented or authorized by this report.

Recent test timing/line-ending repairs warrant portability coverage: source
assertions should normalize CRLF only where semantics require LF, and asynchronous
UI assertions should wait for the exact bounded postcondition. Never replace
them with sleeps, retries that mask failures, forced focus or reduced assertions.

## Documentation and acceptance

`PROJECT_STATUS.md` begins with historical statements that external providers
are unactivated and no API requests have occurred. These must be reconciled with
dated activation evidence rather than quoted as current facts. The referenced
engineering standards file from the broader product workspace is not present at
`docs/ENGINEERING-STANDARDS.md` in this checkout; do not assume cross-worktree
documents or uncommitted implementations belong to this candidate.

Before closing this workstream: record the exact clean candidate and tracked
suite inventory; report `all`, `test:all`, targeted integration and device results
separately; validate any API bridge locally before approved paid execution; and
keep written, locally tested, deployed and production-verified states distinct.
Broad code areas above were sampled, not exhaustively tested or certified.
