# Port inventory: grok hardening on pilot-42h35 base

Created: 2026-09-25 Asia/Jerusalem
Branch: `grok/pilot-42h35-hardening-package`
Worktree: `...\work\resq-grok-hardening-package`
Base (verified): `5c4276fadda64383af34aa9d961df23287bf014c` (`codex/pilot-42h35-claude-integration`)
Do **not** use old tip as base. Old tip objects available via local remote `grok-old` (no push).

## Old tip (hardening source only)

- Worktree: `...\work\resq-grok-readiness-hardening`
- Branch: `grok/production-readiness-hardening`
- HEAD: `f997859e76092b0ff326d40c153000125a922d49`
- Merge-base with this branch: `e5dc92902f6d18bc1582b5d2ee23d21fabbfd6e0`
- Candidate slice: `e5dc929..f997859` (37 commits; many docs/SHA churn)

## Gap map (8 items)

| # | Gap | Candidate commits / files | Notes |
|---|-----|---------------------------|-------|
| 1 | Freeze on new base; port hardening only | this branch | Freeze done; code port pending |
| 2 | No Firestore writes on every login/reset App Check path; aggregate metrics with cost limits | `a07909b`, `70661f2`, `f997859`; `functions/app-check-gate.js`, `auth-hardening.js`, `structured-log.js`, `monitoring-bootstrap.js`, `appcheck.js` | Old tip still writes STATS daily docs + GATE_DOC + mail quota — refine on this base; do not blindly overwrite `functions/index.js` |
| 3 | Eilat reminders if `config/station_jobs` empty; migration+rollback before multi-station | `47d2eb7`, `1c6038d`, `f997859`; `functions/station-jobs.js` (+tests), fence defaults | Empty enrollment alerts; no hard-coded Eilat fallback |
| 4 | H2 OPEN monitor-only | `a07909b` | Keep monitor; no enforce without tests+console |
| 5 | deny-all `storage.rules` needs capture gate in docs/scripts | `fd3a524`, `fdc77f9`, `106fbd4` | Port rules + explicit capture/rollback gate |
| 6 | HR old-address change notice | H1 rules in `fb5d8bd`; notice not proven closed | Mark OPEN; do not call H1 closed without it |
| 7 | israel-time wire+bump+DST tests OR remove | `2c8cd55` then `f2ab067` UNWIRED; `8ed7dab`; `functions/israel-time.js` | Prefer UNWIRED/remove from candidate; finish scheduled-job wrapping (partial) |
| 8 | Rules emulator + release gate on THIS tree | `fb5d8bd` + `rules-test/readiness-hardening.test.mjs` | `java` not on PATH; JDK at `work\jdk21\jdk-21.0.12.1+1\bin\java.exe`. Node: `...\resq-tooling\node-v22.23.2-win-x64\node.exe` |

## Top theme commits (skip SHA-churn docs)

1. `fb5d8bd` Rules hardening
2. `a07909b` Functions auth hardening (H2 monitor)
3. `47d2eb7` Multi-station jobs / reminders
4. `fd3a524` CSP + storage deny-all
5. `199ba0a` esc() + SW same-origin (faults excluded)
6. `2c8cd55` / `f2ab067` israel-time then UNWIRED
7. `106fbd4` / `a9c2d82` archive firestore_1; ops-backup dry-run
8. Follow-ups: `26792eb`, `16251cc`, `8e3c5e1`, `70661f2`, `0009c75`, `f997859`

## Files missing on base (must appear after port)

`functions/app-check-gate.js`, `auth-hardening.js`, `fresh-admin.js`, `station-jobs.js`, `structured-log.js`, `swap-safety.js` (+tests), `functions/israel-time.js`, `israel-time-format.js` (UNWIRED preferred), `storage.rules`, `rules-test/readiness-hardening.test.mjs`, `scripts/staging-auth-rest-bypass-probe.mjs`

## Constraints

No push/merge/Firebase/deploy. Do not destroy terms 1.3, cost monitoring, fault fixes, Claude work. No worktree prune. Surgical port around `functions/index.js`.

## This turn

Worktree+branch at exact base. Old tip fetched via `grok-old`. Code port deferred (divergent index.js vs Claude base).
