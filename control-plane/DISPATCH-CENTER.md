# Agent Dispatch Center — security review and deploy runbook

Status: the first dispatch artifact (note ≤ 280) was DEPLOYED on 30/09/2026 15:53:04 IL (ruleset
`ba01608d-2c4b-41c0-9a3c-b019fb518007`, sha256 `17301818…`). The note-10k artifact supersedes it. Its status and
deployment details are in `control-plane/deploy/firestore-dispatch-provenance.json` (`status`, `deployment`,
`history`). The assembler CLI regenerates the local (undeployed) record, so keep the `deployment`/`history`
blocks when you re-run it.

## Separate security review (required by AGENT-MATRIX.md)

This file records the "separate security review" that `AGENT-MATRIX.md` requires before any
user-input dispatch path can exist. The review ran on 2026-09-30 with the verdict SAFE_WITH_CONDITIONS,
and the UI review ran separately. Both approved the design, and the owner authorized local implementation.
Mapping of the conditions to the code:

| # | Condition | Where |
|---|-----------|-------|
| 1 | Dedicated control-plane deploy config, never the repo root (root `firebase.json` → station-102 rules, `.firebaserc` default station-102) | `control-plane/deploy/firebase.control-plane.json`, command below, provenance `control-plane/deploy/firestore-dispatch-provenance.json` |
| 2 | No collisions with the budget fragment (`tasks()`, `aid()`, `policy()`) | `dispatchTaskMap/dispatchUuid/dispatchFresh/dispatchValid/dispatchCancel` in `firestore-dispatch.rules.fragment`; asserted in `rules-test/control-plane-dispatch.test.mjs` |
| 3 | v4 UUID doc id and batchId; exactly 7 keys on create (hasAll+hasOnly); string types; queued; server createdAt; createdBy = auth uid | `dispatchValid(id)` |
| 4 | `auth_time` is int and ≤ 900 s old, plus `owner()` (revokedAfter, pinned uid, verified email) | `dispatchFresh()` + `owner()` from the live capture |
| 5 | Note allowlist, the same on client and server (now LF + ≤ 10,000; see "Note 10k change") | Rules `size() <= 10000` then regex; `web/dispatch-model.mjs` `NOTE_PATTERN`/`normalizeNote`/`noteLength` |
| 6 | Cancel only owner-authored queued → cancelled with server `cancelledAt`, no other key; no delete; list only with limit 1..50 | `dispatchCancel()`, `match /dispatchRequests/{id}` |
| 7 | Task-type map fixed in the Rules; drift test reads Rules + matrix as data only; `executor` and `commit-branch-dispatch` excluded | `dispatchTaskMap()`, `control-plane/dispatch-drift.test.mjs` |
| 8 | Note is display-only; a doc is a request, not an authorization | this file, the fragment comment, the drift test's static check |
| 9 | Client retries reuse the same UUIDs; PERMISSION_DENIED → `getDocFromServer` reconcile; 'לא אושר' says it may still land | `web/dispatch-view.mjs` |
| 10 | Client checks `getIdTokenResult().authTime` (> 840 s → re-sign-in in a separate direct click); state survives `controller.reset` | `web/dispatch-view.mjs`, `web/firebase-adapter.mjs` |
| 11 | Tests on the EXACT artifact bytes, including disabled owner, old/future auth_time, publisher/budget principals, field-changing updates | `rules-test/control-plane-dispatch.test.mjs` |
| 12 | Client-side cooldown (there is no server rate limit) | `COOLDOWN_MS` in `web/dispatch-model.mjs` |

## What a dispatch document is, and is not

- `note` is **display-only** multi-line text of up to 10,000 characters. It never becomes input to a prompt, a
  shell command, a branch or commit name, CI, telemetry, logs or a routing decision. Any future executor needs a
  separate security review, and it must wrap the note as untrusted data, never as instructions. No code in this repository reads `dispatchRequests` for any purpose other than showing
  it to the owner.
- A dispatch document is a **request, not an authorization**. A future executor would need all of:
  its own grant, a re-check of the task type against `control-plane/agent-matrix.json` at execution time,
  and a Firestore transaction that moves the document out of `status == 'queued'`. None of this exists today.
- The Admin SDK bypasses Firestore Rules. Any future server-side consumer must enforce the same
  constraints in code.
- The dashboard never sets RUNNING or CONNECTED from dispatch data. Agent status still comes only from
  telemetry events, and the dispatch feed shows the server's `status` string as a text badge.
- The browser holds no GitHub token and no CI trigger.

## Note character allowlist (emulator findings)

Current rule: `d.note.size() <= 10000 && d.note.matches('^[\\x{000A}\\x{0020}-\\x{007E}\\x{05D0}-\\x{05EA}\\x{05B0}-\\x{05C7}]*$')`.
It allows LF (U+000A), printable ASCII, Hebrew letters (U+05D0–05EA) and Hebrew points (U+05B0–05C7). The first
artifact used `{0,280}`; the 10k artifact uses `size()` first plus an unbounded `*`, because RE2 caps repeat
counts at 1000.

- A single backslash (`'\x{0020}'`) fails to compile in a Rules string with "Unexpected 'x'". The escape must
  be doubled in the Rules source (`'\\x{0020}'`), which RE2 then receives as `\x{0020}`. The emulator
  accepted this form.
- Rules `string.size()` counts UTF-16 code units: an emoji counts 2, `א` counts 1, and `שָׁ` counts 3 (letter plus two points).
  RE2 `{0,280}` counts code points. Every allowed character is in the BMP, so for any note that passes
  the allowlist, code points = UTF-16 units = `size()`. Astral characters (emoji) fail the allowlist
  whatever their length. The client counts `[...note].length` (code points) and tests the same ranges with a `/u` regex.
- Note 10k: 10000 ASCII, 10000 Hebrew, 10000 LF and multi-line notes pass. 10001 characters fail, and so does
  3333 × `שָׁ` + `ab` (10001 units), while 3333 × `שָׁ` + `a` (exactly 10000) passes. This confirms empirically that
  `size()` equals the client's code-point count for everything the allowlist accepts.
  `\r`, `\r\n`, `\t`, NUL, U+200F, U+061C, U+202E, U+2066, U+FEFF, U+2028 and astral/emoji all fail.
- Rejected, and tested one code point each in the emulator: U+200E, U+200F, U+061C, U+202A–202E,
  U+2066–2069, U+2028, U+2029, U+FEFF, U+200B–200D, C1 U+0080–009F, C0 U+0000–001F, U+007F, and others.

## Note 10k change (2026-09-30, both reviews SAFE_WITH_CONDITIONS)

- Rules: the only changes are `size() <= 10000` (before `matches`), the added `\\x{000A}`, the `*` quantifier
  and the note comment. Everything else is byte-identical, and the live-capture prefix/suffix is unchanged.
  The diff against the previous live artifact is `control-plane/deploy/firestore-dispatch-note10k.diff`; the
  emulator test reverse-applies it and checks that the result hashes to `17301818…`.
- Client: CRLF/CR → LF and tab → two spaces before counting, validating and sending (shown in the preview),
  with no NFC/NFKC. The same allowlist and limit, with offending characters reported as e.g. `U+201C בשורה 12`.
  The client BLOCKS secret-looking content (ghp_, github_pat_, gho_, AIza, sk-, xox[bpa]-, -----BEGIN, PRIVATE KEY,
  FIREBASE_TOKEN=, GOOGLE_APPLICATION_CREDENTIALS) with a Hebrew message and never echoes it. `sk-` is matched
  only at the start of a token, so words like "task-" pass.
- Display: textContent only, `white-space:pre-wrap`, `unicode-bidi:plaintext` plus `dir=auto`,
  `overflow-wrap:anywhere`, and `<details>` collapse with a ~500-character snippet. The full text is rendered only
  when expanded. There is no markdown, no linkify and no Run/copy-as-command button. A permanent banner reads
  "הערה לתצוגה בלבד, לא מבוצעת ולא מועברת לסוכן" next to the form, the preview and every feed note.
  The client feed shows 20 rows; the Rules still allow list limits up to 50.

## Deploy artifact and provenance

- Built by `node control-plane/assemble-rules.mjs --dispatch <capture>/source-0.rules`. This mode writes ONLY
  `control-plane/deploy/firestore.dispatch.rules` and `control-plane/deploy/firestore-dispatch-provenance.json`.
  It never touches `control-plane/firestore.rules` and never includes the budget fragment.
- Base: live capture `capture-2026-09-29T16-24-26-038Z/source-0.rules`, sha256
  `8c0eb6571dd04f2100c4e9988a32457a039b31bb23e77275298a435b3ce51454` (= `CAPTURE_SHA256`).
- The only change is inserting the dispatch fragment immediately before `    match /{document=**}`. The prefix
  and suffix are byte-identical to the capture (tested: `sha256(prefix + suffix) == CAPTURE_SHA256`).
- The artifact sha256 is recorded in `firestore-dispatch-provenance.json` (`artifactSha256`).
  `.gitattributes` marks the artifact `-text`, so its bytes stay LF on every checkout.

## Deploy runbook (every deploy needs explicit owner approval)

1. **Pre-deploy drift check.** Recapture the live ruleset read-only (as for the 2026-09-29 capture) and confirm
   its source sha256 equals the expected live state. That was `8c0eb657…` for the first deploy; for the note-10k
   deploy it is `history.expectedLiveBeforeDeploySha256` (`17301818…`). If it differs, STOP and review the diff.
2. Confirm the artifact on disk still matches its provenance:
   `node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('control-plane/deploy/firestore.dispatch.rules')).digest('hex'))"`
   must print `artifactSha256` from `control-plane/deploy/firestore-dispatch-provenance.json`.
3. Deploy from the repository root with the dedicated config and an explicit project (never the root config):

   ```
   firebase deploy --config control-plane/deploy/firebase.control-plane.json --project resq-agent-control-20260928 --only firestore:rules --non-interactive
   ```

4. **Post-deploy verification.** Recapture the live ruleset read-only. Its source sha256 must equal
   `artifactSha256`. Record the new ruleset name and release update time in a new provenance record.

## Rollback

- Note-10k artifact: redeploy the previous live bytes (`git show faaed15:control-plane/deploy/firestore.dispatch.rules`,
  sha256 `17301818…`) with the dedicated config, then recapture and verify the hash.

- Before deploy: nothing to do. Nothing is live, and the web code keeps the panel hidden until the backend
  authorizes. With the current live rules, every dispatch write and read is denied by `match /{document=**}`.
- After deploy: redeploy the exact capture bytes (`source-0.rules`, sha `8c0eb657…`) with the same dedicated
  config pointed at a copy of the capture. Then recapture and verify the hash equals `CAPTURE_SHA256`.
  Existing `dispatchRequests` documents become unreadable and inert. They grant nothing.
- Code: revert the local commit on `grok/dispatch-center`.
