# Rules diff vs live 358b4c0c — reason for every removed line (push trigger)

Base: live artifact sha256 `358b4c0cf9bef8a49508828f1d4060864583677544ff0a449dbb545246691c7f` (ruleset f7f2d208, deployed
30/09/2026 16:51 IL). New artifact: `firestore.control-plane.rules` sha256 `5b743f8110ed0da48e592eb57f73aacfd41b7f55290332b204c80d0dd3b7888c`
(**LOCAL_ARTIFACT_NOT_DEPLOYED**). Full unified diff: `firestore-push-trigger.diff` (17 removed lines, 101 added lines; all
changes are inside the `active_tasks` / `task_listeners` block; events, dispatch-request and budget rules are byte-identical).
Rollback: PATCH the `cloud.firestore` release back to ruleset f7f2d208 (section 8 of `ACTIVE-TASKS-DEPLOY.md`).

| # | Removed line (358b4c0c) | Replaced by | Reason |
|---|---|---|---|
| 1-4 | Block comment "Owner creates … Agents write ONLY progress[own key] … never a command." | 7-line comment | Describes the new model accurately: TASK/MESSAGE, owner-only IN_PROGRESS/COMPLETED, listener progress READY/REJECTED (EXECUTE only) + acks gated by the kill switch, A1 amended. Comment only; no rule effect. |
| 5 | `d.keys().hasOnly([... 'progress'])` in `atCreate` | same list + `'kind', 'acks'` | The owner may now send `kind` and `acks:{}` (C8 preview is the exact doc). Both stay optional: `kind` defaults to TASK, `acks` must be an empty map (`d.get('acks', {}).size() == 0`), so a create can never pre-seed an ack. `hasAll` of the 7 required keys is unchanged. |
| 6 | `t.grok in ['EXECUTE','IGNORE'] && …` in `atCreate` | `atTaskTargets(t)` (same expression, moved) | Moved verbatim into a helper so TASK keeps exactly the old constraint; `kind == 'TASK'` requires it. |
| 7 | `(t.grok == 'EXECUTE' \|\| …)` in `atCreate` | `atTaskTargets(t)` (same expression, moved) | Same as 6. A MESSAGE uses `atMessageTargets` (NOTIFY/IGNORE only, >= 1 NOTIFY, never EXECUTE) and `payload.size() <= 2000`. |
| 8 | Comment "IN_PROGRESS only after a real inbox delivery (READY/delivered); READY/delivery_off may only be REJECTED." | "Listener identity: READY or REJECTED only …" | The comment moved to `atOwnerTransition`, which now owns that transition (t176u). |
| 9 | `\|\| (prev != null && prev.state == 'READY' && next == 'REJECTED')` | same line with `;` (end of expression) | Unchanged semantics; the line is re-emitted only because it became the last disjunct. |
| 10 | `\|\| (… prev.step == 'delivered' && next == 'IN_PROGRESS')` | `atOwnerTransition` (owner only) | **Narrowing (t176u):** the listener identity loses READY/delivered -> IN_PROGRESS. Only Eldad's manual dashboard click (`owner()` + `atOwnerProgress`) may set it, still only from READY/delivered and only for an EXECUTE target. |
| 11 | `\|\| (prev.state == 'IN_PROGRESS' && next in ['COMPLETED','FAILED'])` | `atOwnerTransition`: IN_PROGRESS -> COMPLETED (owner only) | **Narrowing (t176u):** the listener loses IN_PROGRESS -> COMPLETED/FAILED. The owner may set COMPLETED. FAILED is no longer reachable by anyone for new tasks (old FAILED docs still render). |
| 12 | `request.resource.data.keys().hasAll(['agent','seenAt'])` in `atHeartbeat` | `d.keys().hasAll(['agent','seenAt'])` | Same check through `let d` (readability); unchanged semantics. |
| 13 | `request.resource.data.keys().hasOnly(['agent','seenAt'])` | `d.keys().hasOnly(['agent','seenAt','ack','mode'])` + `d.get('ack','off') in ['on','off'] && d.get('mode','poll') in ['push','poll']` | UI C5: the heartbeat reports the ack mode (and push/poll). Both fields are closed enums, optional (old runners still valid). No free text. |
| 14 | `… agent == agentKey && … seenAt == request.time;` | `d.agent == agentKey && d.seenAt == request.time` | Same check via `let d`; the 30 s rate limit on update is untouched (outside the diff). |
| 15 | `allow get: if owner() \|\| (atListener() && targets.get(atKey(),'IGNORE') == 'EXECUTE');` | `… in ['EXECUTE','NOTIFY']` | A NOTIFY target must read the MESSAGE it acks. Non-targets (IGNORE) still cannot get it (emulator test). |
| 16 | `&& resource.data.targets[atKey()] == 'EXECUTE');` (listener list) | `… in ['EXECUTE','NOTIFY']` | The push query is `targets.<key> in [EXECUTE, NOTIFY]`, limit <= 5 (unchanged). Denials still proven: no filter, limit 6, another agent's key (emulator + gRPC spike). |
| 17 | `allow update: if (owner() && atCancel()) \|\| (atListener() && atProgress());` | `(owner() && (atCancel() \|\| atOwnerProgress())) \|\| (atListener() && (atProgress() \|\| atAck()))` | Adds the owner's manual progress click and the listener ack (the only autonomous write, gated by `control/ack_switch.enabled == true`; a missing switch doc denies). `atProgress` still requires `targets[k] == 'EXECUTE'`, so NOTIFY writes no progress. |

Added (no removed counterpart): `atTaskTargets`, `atMessageTargets`, `atOwnerTransition`, `atOwnerProgressFor`,
`atOwnerProgress`, `atAckEntry` (exact 3 keys, state enum, summary `size() <= 280` BEFORE the RE2 allowlist without newline,
UNDERSTOOD <=> non-empty summary, `updatedAt == request.time`), `atAckTransition` (none -> any; LIT -> UNDERSTOOD|UNREADABLE;
terminal otherwise), `atAckOn`, `atAck` (PENDING, EXECUTE/NOTIFY target, within 24 h, only `acks.<own key>`), and
`match /control/ack_switch` (owner get; no list; create only `{enabled:false, updatedAt}` with fresh auth; update owner,
ON needs fresh auth, OFF always allowed; no delete; listeners have no access).

Evidence: `rules-test/control-plane-active-tasks.test.mjs` (23 checks incl. Hebrew+niqqud at 280/281, RE2 allowlist, `in`
list limit <= 5 vs 6, NOTIFY writes no progress, switch missing/off denies, owner-only transitions), and
`rules-test/control-plane-listener-e2e.test.mjs` (real gRPC Listen).
