# HANDOFF — hardening package (pilot 42H.36 base)

## Codex integration note · candidate 42H.37
This file records Grok's source package, not a deployment. In the unified
candidate the App Check gate is monitor-only with partial-coverage reporting
and no limited-use token consumption. `station-jobs.js` is **not wired**:
Eilat scheduled reminders still use the legacy `PUSH_STATION` path. The
multi-station performance branch `00d6d03` is excluded after two independent
reviews found stale attendance data and identity/timing races. The visible
version has been advanced to 42H.37, pending release validation and rollout.

## Identity
- Branch: `grok/pilot-42h35-hardening-package`
- Worktree: `...\work\resq-grok-hardening-package`
- Base: `5c4276fadda64383af34aa9d961df23287bf014c` (42H.36)
- Tip source (read-only): `f997859e76092b0ff326d40c153000125a922d49`
- Package tip SHA: see `docs/FROZEN-TIP` (after freeze commit)

## Ported (surgical)
- `functions/app-check-gate.js` (+test) — MONITOR default; **zero Firestore writes per login/reset**; hourly-bounded flush
- `functions/auth-hardening.js` (+test) — progressive backoff helpers (base login lockout body untouched)
- `functions/fresh-admin.js`, `swap-safety.js`, `structured-log.js`, `on-call.js` (+tests)
- `functions/station-jobs.js` (+test) — inactive candidate; Eilat reminders retain the existing `PUSH_STATION` path
- `functions/index.js` — monitor gate on `loginWithEmployeeNumber` / `requestPasswordReset` / `unlockAccount` with `enforceAppCheck:false`; no `consumeAppCheckToken` until the client implements limited-use tokens
- `firebase.json` — CSP **Report-Only** + XFO DENY (no enforced CSP)
- `storage.rules` deny-all + `docs/STORAGE-CAPTURE-GATE.md` (**not deployable** until capture)
- `ops-backup.mjs` dry-run default (`--execute` to write)
- Docs: STATION-JOBS-MIGRATION, ISRAEL-TIME-OUT, PORT-INVENTORY

## Explicitly OUT / not done
- **israel-time** — no file; OUT of candidate
- No wholesale login.html / faults / SW / firestore.rules replace
- Original Grok package remained **42H.36**; unified Codex candidate is **42H.37**
- **No push / merge / Firebase deploy**

## OPEN (must stay explicit)
1. **H2** OPEN — monitor only; in-memory coverage is partial and cannot authorize enforcement; OWNER console still required
2. **H1 address-change notice** OPEN — do not call H1 closed
3. **israel-time** OUT of candidate
4. **Storage capture** — deny-all not deployable until Console capture + rollback drill
5. **firestore.rules tip hardening** — not wholesale-merged; `rules-test/readiness-hardening.test.mjs.pending`
6. **~31 legacy callables without App Check** — frozen debt
7. **Codex faults / dedupe / push / TITLE200** — untouched OPEN
8. Base `login_attempts` lockout path — left as-on-base

## Tests (this tree)
- `npm --prefix functions run test:hardening` → PASS (gate/auth/fresh/station-jobs/swap)
- `node tests/test-inventory.mjs` → PASS (328/328 after registration)
- Rules emulator (`firebase emulators:exec --only firestore --project demo-resq`):
  - registration terms isolation: **6 PASS**
  - callout privacy: **40/40 PASS**
  - callout delivery integration: **30/30 PASS**
  - schedule-access isolation: **226 PASS**
  - station-transfer: **76 PASS**
  - fleet: **36 PASS**
  - hr-private isolation: all role matrices **PASS**
  - Full `npm test` chain may still be running remaining suites at freeze time; firestore.rules unchanged from base so regressions unexpected. Record final exit in FROZEN-TIP if available.

## Owner console (H2) — not performed by agent
Staging IP-hop; PDF path; `config/on_call`; Auth/App Check console switches.
Do not seed `config/station_jobs` for the pilot: routing is inactive by design.


## SHA appendix
- Tip source: 157b1d7c37d0f0492bd6052a47122344cf461912
- Content tip: d149e18e7b3214f4786e70977ea7f399fbf298df
- Freeze commit / package HEAD before this note: 6a394e4512b39dde1be19eea39a418f0541686df

