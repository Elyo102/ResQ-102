# HANDOFF — hardening package (pilot 42H.36 base)

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
- `functions/station-jobs.js` (+test) — **empty enrollment → still runs `eilat_102`** (tip empty=0 NOT ported)
- `functions/index.js` — monitor gate on `loginWithEmployeeNumber` / `requestPasswordReset` / `unlockAccount` with `enforceAppCheck:false`; reminders use `forEachEnabled`
- `firebase.json` — CSP **Report-Only** + XFO DENY (no enforced CSP)
- `storage.rules` deny-all + `docs/STORAGE-CAPTURE-GATE.md` (**not deployable** until capture)
- `ops-backup.mjs` dry-run default (`--execute` to write)
- Docs: STATION-JOBS-MIGRATION, ISRAEL-TIME-OUT, PORT-INVENTORY

## Explicitly OUT / not done
- **israel-time** — no file; OUT of candidate
- No wholesale login.html / faults / SW / firestore.rules replace
- Version remains **42H.36** (no asset bump)
- **No push / merge / Firebase deploy**

## OPEN (must stay explicit)
1. **H2** OPEN — monitor only; OWNER console still required (cannot close via callable App Check alone)
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
Staging IP-hop; PDF path; seed `config/station_jobs`; `config/on_call`; Auth/App Check console switches.
