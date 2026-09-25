# HANDOFF — hardening package (pilot 42H.36 base)

## Identity
- Branch: `grok/pilot-42h35-hardening-package`
- Worktree: `...\work\resq-grok-hardening-package`
- Base: `5c4276fadda64383af34aa9d961df23287bf014c` (42H.36)
- Tip source (read-only): `f997859e76092b0ff326d40c153000125a922d49` on `grok/production-readiness-hardening`
- Tip SHA of this package: see `docs/FROZEN-TIP` (written after final commit)

## What was ported (surgical)
- `functions/app-check-gate.js` (+test) — MONITOR default; **zero Firestore writes per login/reset**; hourly-bounded in-memory flush to daily stats
- `functions/auth-hardening.js` (+test) — progressive backoff helpers (not replacing base lockout body)
- `functions/fresh-admin.js`, `swap-safety.js`, `structured-log.js`, `on-call.js` (+tests where present)
- `functions/station-jobs.js` (+test) — **empty enrollment → still runs `eilat_102`** (tip empty=0 NOT ported)
- `functions/index.js` — gated monitor wrap on `loginWithEmployeeNumber` / `requestPasswordReset` / `unlockAccount` with `enforceAppCheck:false`; reminders iterate `stationJobs.forEachEnabled`
- `firebase.json` — **CSP Report-Only** + `X-Frame-Options: DENY` only (no enforced CSP)
- `storage.rules` — deny-all present; **NOT deployable** without capture gate (`docs/STORAGE-CAPTURE-GATE.md`)
- `ops-backup.mjs` — dry-run default (`--execute` to write)
- Docs: station-jobs migration/rollback, israel-time OUT, storage capture gate

## Explicitly NOT done / OUT
- **israel-time** — OUT of deploy candidate (no file added)
- **No wholesale** login.html / faults / SW / firestore.rules replace
- **No version regress**; still 42H.36; no new public assets requiring bump
- **No push / merge / Firebase deploy**

## OPEN (must stay open)
1. **H2** — App Check monitor only; OWNER console (reCAPTCHA enforce, enumeration protection, App Check on Auth, API key referrer, etc.) still required. Closing H2 via callable App Check alone is forbidden.
2. **H1 address-change notice** — not implemented; do **not** call H1 closed.
3. **israel-time** — out of candidate until full wire+tests+bump > 42H.36.
4. **Storage capture** — deny-all not deployable until Console capture + rollback drill (`docs/STORAGE-CAPTURE-GATE.md`).
5. **firestore.rules H1/H5/M2… hardening suite** — tip rules not wholesale-merged (protects terms 1.3 / Claude). `readiness-hardening.test.mjs.pending` awaits a surgical rules PR.
6. **~31 legacy callables without App Check** — frozen debt; not closed by this package.
7. **Codex faults / dedupe / push / TITLE200** — untouched; remain OPEN per prior trackers.
8. **Base login lockout** (`login_attempts`) — left as-on-base; auth-hardening helpers available but not substituted into the lock-before-password path in this pass.

## Tests run (this tree)
See commit message / CI notes in follow-up freeze commit. Commands:
- `node functions/app-check-gate.test.js`
- `node functions/station-jobs.test.js`
- `node functions/auth-hardening.test.js`
- `node functions/fresh-admin.test.js`
- `node functions/swap-safety.test.js`
- `npm run release:validate` (from `tests/`)
- `npm test` (from `rules-test/`) with Java on PATH

## Owner console actions (H2)
Staging IP-hop probe; PDF path; seed `config/station_jobs`; configure `config/on_call`; App Check + Auth console switches — **not** performed by this agent.
