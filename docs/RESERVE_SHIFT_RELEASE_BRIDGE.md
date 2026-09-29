# Reserve shift creation gate: local A/B release preparation

No cloud, deployment, worker data writes or release attestation in this work.
Base: ea874f5f97a2ac528f2306f3dbe8c19b81b5e3ef on full 42H.44 sources.

## Artifacts and single source of policy

A: functions/reserve-shift-policy.json has creationEnabled=false. Its generated
public reserve-shift-policy.js must match exactly; tests fail on drift or an
invalid canonical configuration. Missing/corrupt server policy disables creation.
No request field, runtime environment variable or database setting overrides it.

The server checks transactional before-images for self-save, monthly fill and HR
create/update. Existing reserve_shift rows remain readable, editable, calculable
and submit/recalculate compatible. Exact recorded receipts replay after rollback.
Old reserve absence remains 8.5 hours. No records are migrated or deleted.

B: changes the one canonical flag to true, regenerates its browser projection,
and stamps final activation identity. All executable policy logic is already A.
Both client/server version mismatch directions are safe: the server denies new
creation while disabled even if an old client exposes it; a disabled client only
hides new creation while an enabled server can still read/update existing data.

## Deployment/cache recipe (preparation, not authorization)

1. Capture fresh generation-pinned sources/config and a verified encrypted
   recovery artifact, then run the exact clean release gate for the candidate.
2. Install and verify A's narrow Rules restriction first: historical direct
   import must never create reserve_shift (in A or B). Other import types retain
   their permissions. This avoids bypassing callable creation/overlap guards.
   Deploy A's four attendance mutators; verify creation is denied and
   existing records remain supported. Keep the current Hosting release unchanged.
   A deliberately retains 42H.44 identity and is NOT a standalone Hosting update.
3. Deploy B's same four mutators, verify enabled behavior, then publish B Hosting
   with a strictly newer visible version/query/cache identity (42H.45).
4. If rollback is needed after new records exist, deploy A's compatible mutators
   to disable creation. Keep B Hosting to retain all new-type readers/calculators;
   retain A's Rules exclusion; never restore old pre-feature calculators or remove records. A stale enabled
   form will receive a clear server rejection without a committed creation.
5. For a matching disabled UI, prepare a roll-forward disabled-policy Hosting
   build with a NEWER visible/query/cache identity than every already-published
   release, regenerate/check policy, run its own full release gate and verify
   online/offline asset parity before publication. Do not republish A's 42H.44
   cache or reuse a prior attestation. This future rollback Hosting build is not
   implemented or authorized by this local task.

Affected exports: mutateMyAttendanceDay, mutateMyAttendanceMonth,
correctAttendanceDay, correctAttendanceMonth. Rules change: only
validHistoricalImportCreate excludes day_type reserve_shift, with no new reads.
Rules version: Git blob 1198fd994b9d55650c9a77564e35c73120dcb5f8;
local file SHA-256 c1a39882b0f6e54da0817e54e5d19221a3915aaf7ef5c51ccbe9780e9a06b8a6.
Retain both in the final A/B manifest. No index/Storage/IAM change.
No automatic notifications, extra polling or additional database policy reads.

## Stage A evidence

- Policy/parity/config: 15 checks passed with the real canonical flag false.
- Actual server factories under isolated release policies: 7 tests passed,
  covering both states, self/HR creation/conversion, existing edits/recalculation,
  mixed-fill atomicity and receipt replay after disabling.
- Actual dialog code: 34/34 at 360/1280; generated false/true artifacts, synthetic
  transport. Not an authenticated real-device/offline-PWA claim.
- Native emulator, real false policy: 4/4 passed on demo-resq with synthetic Auth.
  First run failed due to missing synthetic draft monthly report for HR; repaired
  after two independent reviews, with exact policy-message denial assertions.
- Version contract: 369 references, 19/19 mutation checks caught.
- Public inventory: 131 assets; test inventory: 352/352 registered.
- Initial Pages command accidentally inspected the parent directory; corrected
  repository-root check passed, without modifying any files in the parent.
- Two independent final post-reviews approved the local A commit after comparing
  their conclusions and verifying the final Rules/native evidence.
- Final review found the super-user historical-import bypass. The coordinator
  explicitly authorized the narrow Rules exclusion and regression; both reviewers
  approved it before editing. Node 22 Rules suite: 784/784 passed; native false
  policy rerun against patched Rules: 4/4 passed. An earlier 784/784 run used
  Node 24 due to a wrong relative runtime path and is not the accepted gate.

Final activation stamp scope is explicitly approved as hosting-only: visible
42H.45, server_version and telemetry_version 42H.44. The four changed mutators
must be identified by source SHA in the companion immutable release manifest;
no claim is made that their global server identity became 42H.45.

## Stage B evidence

Pending flag activation, final stamp, fresh literal full all EXIT0, native enabled
checks, post-reviews and local commit. No earlier gate is reused for changed code.
