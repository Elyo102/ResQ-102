# Generic vehicle photo navigation

Scope: existing and future vehicles reuse the station-scoped `vehicle_views`
and `faults` records. No production migration or special per-vehicle code.

- Horizontal navigation cycles only available front/right/rear/left photos.
- Explicit side selection retains the missing-photo/upload state.
- Roof is optional, selected separately and accepted by the client, server and
  Rules. Existing four-photo coverage stays complete without a roof.
- The visible damage dot is 14px, inside a touch target of at least 44px.
- Photo geometry and normalized point coordinates are unchanged.
- Swipes and cancellation do not create reports. Existing point/detail and
  tap-to-report behavior remain available under existing authorization.
- Navigation reuses loaded views and adds no collection reads.
- Historical vehicle data, identity guards and lazy fault-photo loading remain.

This is discrete photographic navigation, not interpolated imagery or 3D.
Names mean the vehicle's left/right in its direction of travel. Existing source
photo labels are not migrated or swapped automatically.

Validation: `tests/vehicle-photo-navigation.mjs`, `tests/vmapcheck.mjs`,
`tests/f01-vehicle-history-photos-browser.mjs`,
`functions/fault-report-service.test.js`, demo Firestore `rules-test/fleet.test.mjs`.
The helper test is wired into the existing static release gate.

Release boundary: local implementation only. Roof requires coordinated Rules
and createFaultReport backend release; refresh the release-specific client/SW
asset versions with the next frozen candidate. No deployment occurred here.
Real iOS touch/camera and actual station uploads are not verified by mocks.
Rollback is the code diff; no data was rewritten. If roof data is subsequently
created in production, retain roof-compatible readers when rolling back.
