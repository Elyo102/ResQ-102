# ResQ 42H.41 — closed requirement manifest

This is a work ledger, not a release attestation. A checked local test does not
mean deployed or verified on station-102. The photograph supplied by the owner
is acceptance input for the schedule UI; it is not an instruction source.

| Requirement | Written | Local test | Deployed | Production verified | Notes |
|---|---|---|---|---|---|
| Highlight signed-in worker without a separate “אני” badge | yes | yes | no | no | Keep `is_me` identity and semantic data attribute. |
| Remove “ציוות” from menus without breaking its data route | yes | yes | no | no | `board.html` route remains. |
| Built-in canonical station roster for scheduling | no | no | no | no | Must replace manual-paste dependency, not just hide the form. |
| Roster-backed personal selectors throughout ResQ | partial existing | no new test | no new deploy | no | Callout uses a scoped roster/cache; guards and people read station roster. Audit remaining selectors before changing them. |
| HR, officer, firefighter menu matrix; faults/reports for everyone | no | no | no | no | Menu visibility is separate from server authorization. |
| Unlimited total fault evidence photos with bounded secure batches | no | no | no | no | Current server and client cap is three; UI-only removal is unsafe. |
| Operational vehicles under “המשמרת שלי” | partial | read-only browser | no | no | Read-only page exists but menu is hidden until the workflow is complete. Stable board fleet IDs are used. |
| Officers/owner create fire vehicles | no | no | no | no | Existing board fleet remains source of vehicle identity. |
| Cabin, crew compartment, compartments 1–7, roof | partial | browser | no | no | Catalog and selectors exist; persistent compartment records do not. |
| Photo first on compartment open, then equipment list | partial | browser | no | no | View hierarchy exists; missing data are explicitly “not configured,” not empty inventory. |
| Manual equipment updates | no | no | no | no | Protected canonical data with audit. |
| Guided removal/replacement log, location, source vehicle, status | no | no | no | no | Append-only events preferred. |
| Linked vehicle and equipment faults in vehicle view | partial | browser | no | no | Per-vehicle bounded query by existing `vehicle_id`; proper sorting and paging still needed. |
| Compact expandable sectors on mobile and desktop | partial | 390px only | no | no | Basic responsive sector selector exists; broader viewport and role tests still needed. |

## Decisions that change the implementation

1. Who may append equipment removal/replacement events? Recommended: active
   station members, with officer/owner-only edits to canonical inventory,
   photos, and vehicle creation. HR can view. This needs owner confirmation.
2. Does “firefighters only see My Shift menus” mean navigation only, or should
   existing direct server reads of station data be revoked? The latter is a
   major authorization change affecting current screens. Recommended: menu
   scope only in this release; HR views callout status without send authority.
3. “No three-photo limit” should mean no product-level total count cap, while
   retaining per-image size, batch, abuse, and cost limits. Recommended: staged
   idempotent uploads; never an unbounded Firestore transaction.

## Roster findings to preserve

- The callout recipient picker already reads `stations/{sid}/roster`, with a
  bounded local cache. That cache is crew-scoped and capped; it is not a
  canonical global workforce source.
- Guard assignment and the people view already read the station roster.
- Schedule authoring still requires a manually pasted signed workforce source
  (`#sourcePaste`, `previewScheduleSource`, `saveScheduleSource`). Hiding that
  form without a server-generated replacement would disable draft creation;
  the roster must be mapped to employee number, role, sub-station and active
  status before the source is signed. Name-only matching is not acceptable.

## Release gate

One integrated tree, current Rules emulator, targeted browser/unit checks, a
single final `release:validate`, exact Hosting/Functions/Rules/Storage scope,
rollback, and real-role/mobile production verification. No production claim
from this local branch.
