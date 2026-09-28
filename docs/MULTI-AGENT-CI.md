# Multi-agent PR review — isolated development package, not activated

2026-09-28. Additive to existing Rules/app CI, not a replacement release gate.

## Trust and setup

`pull_request` runs secretless mocked orchestration tests and existing Playwright
tests. Existing `tests.yml` retains Node22/Java21/demo-resq Rules and integration
tests. `pull_request_target` checks out only the base SHA and executes no PR code,
dependencies, artifacts or model suggestions. It has contents:read and
pull-requests:write only. No merge, production database or deploy operations.

After human review installs this workflow/script on the base branch, configure
repository Secrets ANTHROPIC_API_KEY, XAI_API_KEY, GEMINI_API_KEY, and repository
variables ANTHROPIC_REVIEW_MODEL, XAI_REVIEW_MODEL, GEMINI_REVIEW_MODEL with models
available to those accounts. Set MULTI_AGENT_REVIEW_ENABLED=true and configure
REVIEW_TRUSTED_ACTORS as a comma-separated list of trusted maintainer logins.
Tests run automatically on every PR; paid reviews run only when a listed
maintainer adds label `resq-ai:<full-head-SHA>`. A changed SHA requires a
new label. This deliberate spend gate prevents arbitrary fork PRs spending API
credits across unlimited new PRs. It differs from unguarded automatic paid review.
Never put API keys in code, PR comments or chat. GitHub may separately restrict
pull_request_target; do not bypass organization policy. No keys were accessed or
external provider requests executed during local implementation.

Activation authorizes disclosure of selected source diffs to three providers.
Source-extension/path filters and credential heuristics reduce exposure but are
not a guarantee of secret detection. No fixtures, data/log directories or raw
provider errors are sent. Review only repositories approved for this disclosure.

## Limits and truthful status

Maximum40 files and60KB eligible diff; patches must account for GitHub line counts.
Each provider called once, timeout45seconds, no retries, bounded response/output.
One reservation per base/head SHA and at most5 reservations per PR. A crash after
reservation consumes that attempt; a rerun fails INCOMPLETE_RESERVED rather than
silently spending again or asserting completion. Two COMMENT reviews are posted:
reservation and final findings, not inline line comments. This is
a per-PR usage cap, not an account-wide money budget; configure provider spending
limits before activation. Missing configuration, incomplete coverage, stale SHA
or provider failures never mean clean review. Both head and base are rechecked.
Comments are untrusted suggestions, not evidence tests passed. Gemini failure
does not discard Claude/Grok findings. No automatic APPROVE or REQUEST_CHANGES.

## Remaining work (not claimed complete)

- Actual GitHub/provider activation and validation, required branch checks.
- Review comments per exact diff line (current implementation posts PR reviews
  containing file-specific findings, not invented line positions).
- Separate secretless Codex remediation lane: reproduce each accepted finding,
  preserve existing behavior, at most5 total repair cycles, tests and final human
  review. No model-produced command/patch is executed by this privileged runner.
- Account-wide spend control and strong external-disclosure review.
- Existing local test containment work and remaining approved product packages
  stay open; this addition does not replace or complete them.

Local check: `node --test .github/scripts/multi-agent-review.test.mjs`.

Local evidence: 11/11 mocked checks passed after review repairs; raw log in
workspace outputs/multi-agent-review-tests.log. Both connected reviewers
independently reran the mocks. This proves mocked orchestration, not GitHub
workflow execution, provider compatibility or account permissions. The workflow
has not been activated, pushed or deployed. Follow-up validation found the
already-installed firebase-tools/node_modules/yaml parser: the YAML parsed with
zero errors/warnings and both expected triggers/jobs. GitHub upstream tag APIs
verified checkout v4.2.2 = 11bd71901bbe5b1630ceea73d27597364c9af683 and
setup-node v4.4.0 = 49933ea5288caeca8642d1e84afbd3f7d6820020. Full actionlint
and execution on GitHub remain unverified. No new parser was installed.

## Approval follow-up and package boundary

Owner approved continuation. GitHub repository metadata resolved the old
Elyo102/station-102-Fire name to Elyo102/ResQ-102. The available connector supports
repository/PR operations, not Secrets management; local gh is not installed.
Do not infer provider credentials from repository permissions or ask for keys in
chat. Configure Secrets securely in the repository settings when activating.

The owner expressly authorized a CI-only dev push and PR on 2026-09-28. This
package is isolated on branch dev from GitHub main
70d770ec4c70489e3406b1e2c01d4f830f68da40, not the newer dirty product checkout.
Its allowlist is17 files: workflow, script/tests, this document, Playwright
config and two E2E files, minimal tests/package.json scripts and .gitignore,
AGENTS.md, PROJECT_STATUS.md, the local Rules runner and five synthetic-project
ID normalizations in Rules tests. No product HTML, Functions, production Rules,
indexes or existing test commands are changed.
Dependencies are unchanged: npm ci --offline --ignore-scripts succeeded against
the existing lockfile (Playwright1.62.1). Existing product work remains open and
untouched. This is NOT a release-readiness or all-tests-green claim: broad all
was not run because its network containment remains unresolved. Provider calls,
GitHub workflow execution, real-device behavior and full Auth E2E are not proven
by the local mocked/component tests. Rollback: close the PR or revert this
CI-only commit; no data migration or runtime rollback is involved.

Do not enable paid review during bootstrap: the privileged job deliberately
requires the reviewed script on the trusted base branch first. Secrets alone
do not activate it; repository variables, model names and a trusted SHA label
are also required. No merge or production deployment is part of this delivery.

## Historical isolated-base failure and authorized correction

On dev based on 70d770e: review mocks11/11 PASS; YAML0 errors/warnings;
offline clean dependency install and manifest/lock parity PASS. Component
browser tests:6/8 PASS,2/8 FAIL (same assertion on Mobile and Desktop).
`tests/e2e/resq-core.spec.mjs:31` expects `calls[0].ack.terms_version === '1.3'`.
The historical base's actual invitation handler does not include ack. The newer
product branch contains the related consent changes; copying them would expand
the approved CI-only diff into product behavior and backend/Rules dependencies.
No assertion was removed and no synthetic ack was added to conceal this gap.
Evidence: workspace outputs/ci-dev-e2e.log plus ignored Playwright traces and
screenshots under tests/test-results. Owner subsequently explicitly authorized
refactoring the legacy specs. They now assert the exact historical three-field
payload and retry identity. The newer product consent regression is unchanged.
The corrected first gate and final clean gate both passed11/11 existing Rules
suite entries and8/8 browser tests. Final receipt: outputs/ci-dev-test-all-final.log
(EXIT0); review mocks11/11: outputs/ci-dev-review-final.log. Expected permission
denials in negative Rules tests are retained in raw logs. Inherited dependency
deprecation warnings are disclosed in PROJECT_STATUS.md, not hidden. This does
not prove terms1.3 integration on the historical branch.

The CI scope now also includes a loopback/Node22 Rules runner and normalization
of five legacy synthetic project IDs to demo-resq. No runtime code, production
Rules or lockfile is changed. `npm run test:all` from tests executes the owner's
requested Rules+E2E chain; the broad legacy `all` command is unchanged. Locally
the installed Java emulator is started directly; CI uses the explicit demo
emulators:exec command. Neither is claimed to be a general OS network sandbox.

References: GitHub secure pull_request_target documentation; Anthropic Messages
API; xAI Chat Completions API; Google Gemini generateContent API (checked
2026-09-28). Endpoints fixed in trusted script; models configured by repository
owner, never by PR input.
