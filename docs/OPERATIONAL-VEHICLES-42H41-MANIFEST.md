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
| HR, officer, firefighter menu matrix; faults/reports for everyone | partial | navigation browser 27/27 | no | no | Firefighters see My Shift only; HR/command see Station and Team. HR read-only callout status remains open. Server read permissions unchanged by owner decision. |
| Unlimited total fault evidence photos with bounded secure batches | partial | fault service/browser and F-01 focused tests | no | no | All-count cap removed in two new-report forms; server append batches max 3 with idempotent receipts and quota. Existing-report add is now present in both fault views and locally tested; reload still requires reselecting only missing files. Live behavior remains to verify. |
| Operational vehicles under “המשמרת שלי” | yes | browser 7/7 + nav 27/27 | no | no | Menu is visible locally; stable board fleet IDs remain canonical. |
| Officers/owner create fire vehicles | yes | browser role smoke; create transaction edge tests open | no | no | Transaction preserves live board and command; max 40 from existing Rules. |
| Cabin, crew compartment, compartments 1–7, roof | yes | browser + model | no | no | Station-scoped nested records; direct client writes denied. |
| Photo first on compartment open, then equipment list | yes | browser photo write smoke | no | no | Image is read before paged items; missing data is not presented as an empty compartment. |
| Manual equipment updates | yes | service 8/8; browser write smoke | no | no | Officer/owner only, revision and idempotent receipt. |
| Guided removal/replacement log, location, source vehicle, status | yes | service 11/11; browser 12/12; Rules 18/18 | no | no | Active members except HR append open events. Live officer/owner advances open → in progress → resolved with revision, retry receipt and audit; no implicit mutation of canonical inventory. |
| Linked vehicle and equipment faults in vehicle view | yes | browser smoke; index emulator open | no | no | Existing faults collection filtered by vehicle, sorted and paged 25. |
| Compact expandable sectors on mobile and desktop | yes | browser widths 320/360/390/1280 | no | no | Expands only selected vehicle/cell; no horizontal overflow in tested widths. |

## Owner decisions (approved 2026-09-26)

1. Active station members except HR may append equipment removal/replacement
   events. HR is read-only in this module. Only officers/owner may edit
   canonical inventory, compartment photos, and vehicle creation.
2. Firefighter limitation is navigation-only in this release; existing direct
   server reads are not revoked. HR may view My Shift, but not send callouts.
3. Fault evidence photos have no product-level total count cap. Retain
   per-image size, batch, abuse and cost limits; use staged idempotent uploads,
   never an unbounded Firestore transaction.

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
- Live station `users` is the trusted UID/employee-number/name directory, but
  `sub_station` and schedule-role metadata are not guaranteed there. A safe
  roster-only source must present these as explicit missing assignments or
  carry verified assignments from the active signed source. No auto-filled
  names can silently acquire a role or sub-station by guesswork.
- New vehicle inventory, media, audit and photo batch receipt paths now have
  explicit DR classifications. The corresponding live backup/restore wiring is
  not thereby proven.

## Release gate

One integrated tree, current Rules emulator, targeted browser/unit checks, a
single final `release:validate`, exact Hosting/Functions/Rules/Storage scope,
rollback, and real-role/mobile production verification. No production claim
from this local branch.

## Current local evidence

Node 22 focused checks: operational vehicle service 11/11, operational vehicle
browser 12/12, nav 27/27, fault service PASS, faults browser 18/18, fleet history
15/15, F-01 photos 4 scenarios, backup policy 28/28. These are not a Node 22
release attestation. Java 21 and Node 22 binaries were located in the
workspace. Full demo-resq Firestore Rules emulator suite passed on the updated
candidate (exit 0); the focused vehicle/photo Rules suite passed 18/18.
The provider source receipt is
stale after functions/index.js changed; its dedicated Node 22 gate correctly
fails with `provider-source-receipt-unavailable-or-stale`. A full release gate
has not been run because source roster and receipt remain open. No
push/merge/deploy has occurred.

The finite incident-monitoring catalogs now include the new page and six
new callables on both client and server; ops cross-component contracts pass
35/35. Test inventory registers all 336 candidate test files. The new
vehicle equipment and photo upload paths are explicitly included in the DR
policy manifest, but an actual cloud restore has not been demonstrated.

## Post-implementation review, 26 September

Two read-only reviewers found release blockers. The legacy photo sort was
changed to document-ID paging and the F-01 fixture now models Firestore's
missing-field exclusion. Existing-report photo append and same-user token
draft preservation were added and locally exercised. Remaining open issues:
the owner's super account without a signed stationId now chooses an explicit
server-owned active station with no Eilat default; normal users cannot inject
a target station. Equipment status now has a locally tested authenticated
officer-only transition with audit. Schedule roster authoring still depends on
manual paste; the index must be
deployed and READY before the linked-fault query is exposed; backup/restore of
new paths, provider receipt, release gate and production checks are unproved.
Do not deploy this worktree as a complete 42H.41 release yet.
