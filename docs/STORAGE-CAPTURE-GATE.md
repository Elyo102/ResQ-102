# Storage rules capture gate (GAP5) — NOT optional

Status: **BLOCKED for deploy**. `storage.rules` in this tree is deny-all and must
not be applied to production until the steps below are done.

## Why
The first `firebase deploy --only storage` (or a full deploy that includes
storage) **overwrites** whatever is currently live in Firebase Console.
If Console has more permissive/path-specific rules today, deny-all would
break HR attachments / uploads immediately.

## OWNER pre-deploy checklist
1. Open Firebase Console → Storage → Rules.
2. Copy the **entire** live rules text into
   `docs/storage-rules-console-capture-YYYYMMDD.txt` (commit on a private ops
   branch or store in the secure ops vault — do not paste secrets).
3. Confirm this tree's `storage.rules` is still deny-all and intentionally so.
4. Confirm rollback plan: re-apply the captured Console text within 5 minutes
   if anything breaks.
5. Only then may an OWNER authorize `firebase deploy --only storage`.

## This package
- `storage.rules` is present for review.
- `firebase.json` does **not** claim a green-lit storage deploy in this handoff.
- Do **not** treat deny-all as production-ready.
