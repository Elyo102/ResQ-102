# Active tasks — deploy runbook (Rules first, then indexes; NOT executed)

Status: **NOT DEPLOYED.** This follows condition 3 of the security code review of a0d4f05 (30/09/2026). Every step
below that changes the live project needs a fresh, explicit approval from the owner (אלדד) for that step. No listener
identity is provisioned, and no listener runs. Nothing here starts a daemon.

| Item | Value |
|---|---|
| Project | `resq-agent-control-20260928` (always passed explicitly as `--project`) |
| Live ruleset now (rollback target) | `projects/resq-agent-control-20260928/rulesets/569cfc0c-a798-45b6-b8f6-d3bd501369ba` |
| Live source sha256 now | `f30d3d85142e21abae4e3a2c53938242d105be8f9dbffc71e5633301f3b94e16` (= `deploy/firestore.dispatch.rules`) |
| New artifact | `control-plane/deploy/firestore.control-plane.rules`, 16250 bytes |
| New artifact sha256 | `358b4c0cf9bef8a49508828f1d4060864583677544ff0a449dbb545246691c7f` (see `firestore-active-tasks-provenance.json`) |
| Diff vs live | `control-plane/deploy/firestore-active-tasks.diff` |

## Never
- Never deploy without `--project resq-agent-control-20260928`. `.firebaserc` defaults to **station-102**.
- Never use the root `firebase.json`. It is the station app config.
- Never use `--only firestore` (that would include indexes). Use `--only firestore:rules`.
- Never use `--force` and never delete indexes. Index changes are additive only (see step 5).
- Never deploy the listener, or start one, before the indexes in step 5 are `READY`.

## 0. Local checks (read-only)
From the repository root, on the exact commit that was reviewed:
```sh
git status --porcelain                      # must be empty
node control-plane/assemble-rules.mjs --active   # regenerates; git status must stay empty afterwards
sha256sum control-plane/deploy/firestore.control-plane.rules    # must be 358b4c0c…691c7f
```
PowerShell (LD): `(Get-FileHash control-plane\deploy\firestore.control-plane.rules -Algorithm SHA256).Hash.ToLower()`.
The artifact is `-text` in `.gitattributes`, so autocrlf cannot change its bytes. If the hash differs, stop.

## 1. Pre-check: live hash must still be f30d3d85 (read-only)
You need an owner-authenticated `gcloud`. The token is used in the pipe only; never print it.
```sh
P=resq-agent-control-20260928
T=$(gcloud auth print-access-token)
R=$(curl -sf -H "Authorization: Bearer $T" "https://firebaserules.googleapis.com/v1/projects/$P/releases/cloud.firestore" | node -pe 'JSON.parse(require("fs").readFileSync(0)).rulesetName')
echo "$R"                                   # must be …/rulesets/569cfc0c-a798-45b6-b8f6-d3bd501369ba
curl -sf -H "Authorization: Bearer $T" "https://firebaserules.googleapis.com/v1/$R" \
  | node -e 'const r=JSON.parse(require("fs").readFileSync(0));const f=r.source.files;if(f.length!==1)throw Error("files="+f.length);process.stdout.write(require("crypto").createHash("sha256").update(f[0].content,"utf8").digest("hex")+"\n")'
# must print f30d3d85142e21abae4e3a2c53938242d105be8f9dbffc71e5633301f3b94e16
```
If the live hash or ruleset is different, stop. Someone changed the live rules, and the diff must be rebuilt and reviewed again.

## 2. Deploy (only after explicit owner approval)
```sh
firebase deploy --only firestore:rules --config control-plane/deploy/firebase.control-plane.json --project resq-agent-control-20260928
```
`control-plane/deploy/firebase.control-plane.json` contains only `{"firestore":{"rules":"firestore.control-plane.rules"}}`.
It has no indexes, no hosting and no functions.

## 3. Post-check (read-only)
Repeat step 1. The ruleset name must be new (not 569cfc0c), and the printed hash must be exactly
`358b4c0cf9bef8a49508828f1d4060864583677544ff0a449dbb545246691c7f`. Write the new ruleset name down; it goes in the report.
If the hash differs, roll back at once (step 4).

## 4. Rollback: re-release the old ruleset 569cfc0c
Point the release back at the existing ruleset. Do **not** redeploy through `firebase.control-plane.json`, which would
upload the new artifact again.
```sh
P=resq-agent-control-20260928
T=$(gcloud auth print-access-token)
curl -sf -X PATCH -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  "https://firebaserules.googleapis.com/v1/projects/$P/releases/cloud.firestore" \
  -d "{\"release\":{\"name\":\"projects/$P/releases/cloud.firestore\",\"rulesetName\":\"projects/$P/rulesets/569cfc0c-a798-45b6-b8f6-d3bd501369ba\"}}"
```
Then repeat step 1. The hash must be `f30d3d85…` again. Fallback, only if that ruleset has been deleted: deploy the exact
live bytes `control-plane/deploy/firestore.dispatch.rules` with a separate temporary config file outside the repo, and still pass `--project`.
Rolling back removes every `active_tasks` and `task_listeners` permission at once. The data stays in place, and nobody can read or write it.

## 5. Indexes (separate, owner-approved, additive; before any listener)
The owner feed needs no composite index. The listener query `where(targets.<key>=='EXECUTE').orderBy(timestamp desc).limit(5)`
needs one composite index per key. Run these one by one, with no `--force`:
```sh
for k in codex grok gemini; do
  gcloud firestore indexes composite create --project=resq-agent-control-20260928 --database='(default)' \
    --collection-group=active_tasks --query-scope=COLLECTION \
    --field-config=field-path=targets.$k,order=ascending --field-config=field-path=timestamp,order=descending
done
gcloud firestore indexes composite list --project=resq-agent-control-20260928 --database='(default)'   # all three READY
```
The same definitions are in `firestore.indexes.active-tasks.json`, for review only. That file is not wired into any
`firebase deploy`, because `firebase deploy --only firestore:indexes` can offer to delete indexes that aren't in the file.

## 6. Hard kill (a listener identity misbehaves)
Do these in order. Each one is independent.
1. **Stop new tokens.** Disable that listener's Auth user, or revoke its refresh tokens (Firebase console → Authentication,
   or `gcloud`/Admin SDK `revokeRefreshTokens(uid)`).
2. **Kill the process** on LD (PowerShell):
   `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -match 'task-listener' | ForEach-Object { Stop-Process -Id $_.ProcessId }`
3. **Rules-level revoke:** set `private_listeners/{uid}.enabled=false`, or raise `revokedAfter` above the current time.
   New requests are denied at once. **An already-open snapshot stream may keep delivering until it reconnects**, which is why steps 1 and 2 come first.
4. If the whole feature has to go: roll back (step 4).

## 7. Before any real listener runs (condition 5)
- The credential lives **outside** `work\` and outside every git worktree. It is never in the repo, env files or logs.
- The inbox root is outside every git worktree. `createInbox` enforces this (`INBOX_ROOT_IN_GIT_WORKTREE`). On Windows the
  root must be a plain `C:\...` path; UNC, `\\?\`, 8.3 short names and junctions are rejected.
- `delivery:false` is the default. Turning it on is an explicit per-agent owner decision.
- Start manually only, in a foreground terminal. No autostart, service or scheduled task.
- The `task_listeners` heartbeat is limited by the Rules to one write per 30 s. The listener beats every 60 s, and a failed beat only increases an error counter.
