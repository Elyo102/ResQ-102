# Codex orchestration proposal

## Objective

Turn isolated reviews into small, measurable, reversible implementation batches on one integration branch.

## Worktree and Git rules

1. One frozen integration SHA per batch.
2. One worktree per independent risk domain; no copying uncommitted product files between worktrees.
3. Rebase/reconcile before tests, then freeze the candidate; do not test one tree and deploy another.
4. A change is reported separately as written, locally tested, deployed, and production verified.
5. Visual work remains preview-only until owner approval.

## Efficient test routing

- Documentation-only: link validation and diff hygiene.
- Service worker: focused lifecycle/browser suite, then full gate once on the final SHA.
- Firestore authorization/data: rules emulator plus affected integration suite.
- Scheduling engine: deterministic unit/load fixtures before browser UI tests.
- Release: run the full gate when the candidate SHA, relevant external configuration, toolchain, workflow, or evidence-validity window changes.

## Budget controls

- Reserve budget atomically before paid requests.
- Do not emit a provider heartbeat unless that provider actually ran.
- Cache review results only when base/head/tree, provider, model, policy, prompt, test inventory, toolchain, environment, and workflow identity all match.
- Stop duplicate workflows only when those identities and privilege/secret contexts match; never reuse a secretless or lower-privilege result as evidence for a privileged run.
- Use the exact quota handoff string and checkpoint defined in the enterprise roadmap.

## Cycle completion record

This cycle created three specialist reports, a consolidated roadmap, and four visual proposal files. It did not change runtime/UI product code, invoke external provider APIs, push, merge, deploy, or access production data.
