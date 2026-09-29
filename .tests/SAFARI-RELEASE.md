# Safari authentication candidate — 2026-09-29

Base: dd32efe25071dfabb4697bca044e70c1f10c9de2.
Target after configuration verification: codex/pages-public-42h7.

The dashboard uses Google Identity Services token popup and Firebase
signInWithCredential. The application does not call Firebase popup or redirect
APIs. Each attempt owns its callback; cancellation, duplicate callbacks and
overlapping signout are fenced. Module imports carry a new cache marker.

Validation:
- Adapter regression tests: 15/15 passed against this Pages artifact.
- Source/Pages assets: 7/7 byte-identical before Git EOL normalization.
- Source test:all: exit 0; 19 Rules suite entries and 30 browser tests passed.
- Additional auth/controller/public-assets tests passed (26 tests before the
  final two logout regressions; adapter total subsequently increased to 15).
- Two independent local reviewers approved the final adapter.
- Mock browser tests preserve user activation and observe no auth-handler request.
- Rules rejection tests intentionally log PERMISSION_DENIED; these are expected
  negative-test outcomes, not a claim of an empty raw console log.

Deployment is NOT completed. The Google OAuth web client must authorize exactly
https://elyo102.github.io as a JavaScript origin. The attempted scoped APPEND
request returned HTTP 400 INVALID_ARGUMENT; no successful config write/readback.
Do not publish this candidate until the origin is verified. The prior origin
mismatch reproduction means deploying without this step would break login.

Unverified: real iPhone Safari login, real credential exchange, live authorized
Firestore stream, deployed asset hashes and production handler-request absence.
No station-102 access or mutation was performed for this fix.

Rollback after an eventual deployment: restore the five prior status assets from
the base commit in a new commit, assign a NEW module cache marker, test, and push
fast-forward to the same Pages source branch. Do not force-push or change Rules.
