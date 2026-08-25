# ResQ — safe development rules

These rules apply to every Codex task in this repository.

## Default workflow

- Treat `main` and the Firebase project `station-102` as production.
- Never work directly on `main`. Create or continue a dedicated branch under `codex/`.
- Keep changes small and reviewable. Explain the intended change before editing when it affects authentication, authorization, Firestore rules, Cloud Functions, notifications, personal data, or deployment configuration.
- Read-only inspection, local edits, local emulators, and tests are allowed without additional approval.
- Before proposing a merge, run the relevant tests and report the exact results and any untested areas.
- Present the changed-file summary and diff for user review. Do not merge a pull request without explicit user approval.

## Production boundary

Explicit approval to edit code, commit, push a work branch, or open a pull request is not approval to deploy.

Do not run any command or action that can change production without a separate, explicit approval that names the production action. This includes, but is not limited to:

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

Approval is single-use and limited to the action described. If the target, command, or scope changes, ask again.

## Validation

- Application checks: `cd tests && npm run all`
- Firestore rules: `firebase emulators:exec --only firestore --project demo-resq "cd rules-test && npm test"`
- Prefer a demo project ID for emulator-only checks so validation cannot target production accidentally.

