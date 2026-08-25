# ResQ — safe development rules

These rules apply to every Codex task in this repository.

## Default workflow

- Treat `main` and the Firebase project `station-102` as production.
- Never work directly on `main`. Create or continue a dedicated branch under `codex/`.
- Keep changes small and reviewable. Explain the intended change before editing when it affects authentication, authorization, Firestore rules, Cloud Functions, notifications, personal data, or deployment configuration.
- Before proposing a merge, run the relevant tests and report the exact results and any untested areas.
- Present the changed-file summary and diff for user review. Do not merge a pull request without explicit user approval.

## Mandatory two-reviewer workflow

- Before each proposed implementation action, two actually connected agents must each perform one independent review of the relevant code, dependencies, data flows, and likely system-wide impact. The reviews must consider regressions, security, privacy, performance, cost, data integrity, and rollback.
- The agents must compare their conclusions. If they disagree, identify a material risk, or cannot assess the impact with reasonable confidence, stop and present the disagreement, risk, assumptions, and available options to the user before proceeding.
- If both agents agree that no material risk has been identified and the residual risk is low, notify the user of the agreed scope, expected impact, validation plan, and rollback approach before starting; the implementation action may then proceed without an additional approval.
- Validation must be proportionate to risk and include relevant automated tests plus targeted end-to-end or emulator checks when applicable. Never promise zero risk or absolute certainty; report failures, untested areas, assumptions, and residual risks.
- Notify the user when work starts. When work finishes, report the changes, exact test results, failures, untested areas, and remaining risks.
- A single explicit user approval may authorize one complete, predefined workflow, including only the implementation, validation, commit, push, and pull-request steps listed in the approval request. The request must state the scope, branch and other targets, planned actions, validation gates, known risks, and stopping conditions. Approval does not extend to omitted steps.
- Stop and request renewed approval if the scope, target, planned actions, material risk, validation result, or rollback assumptions change; if validation fails; or if either reviewer identifies a new material concern.
- Merge to `main`, deploy, and every production action are excluded unless each is explicitly included in advance and the approval request names the exact production target and action, released commits or diff, required validation, known risks, and rollback plan.
- Never state that Claude or any named external reviewer inspected or approved work unless that reviewer was actually connected and performed the review. If a second reviewer is unavailable, stop before implementation and tell the user.

## Production boundary

Approval for a workflow does not authorize merge to `main`, deployment, or any production change unless those steps were explicitly listed in advance and the production approval requirements below were fully satisfied.

Do not run any command or action that can change production without explicit production approval, whether granted separately or explicitly included in advance in an approved workflow. The approval must name the production action. This includes, but is not limited to:

- `firebase deploy` (including partial deploys of hosting, functions, rules, or indexes)
- writes or migrations against the `station-102` Firebase project
- changing production secrets, environment variables, IAM, authentication users, App Check, FCM, or billing
- merging to `main`, publishing a release, or triggering a production deployment workflow

Before requesting production approval, state:

1. the exact command or action;
2. the target project and services;
3. the commits or diff being released;
4. completed validation and known risks;
5. the rollback plan.

Approval is single-use and limited to the complete workflow and steps described. If the scope, target, planned action, material risk, validation result, or rollback assumptions change, stop and ask again.

## Validation

- Application checks: `cd tests && npm run all`
- Firestore rules: `firebase emulators:exec --only firestore --project demo-resq "cd rules-test && npm test"`
- Prefer a demo project ID for emulator-only checks so validation cannot target production accidentally.
