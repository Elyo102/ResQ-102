# israel-time — OUT OF DEPLOY CANDIDATE (GAP7)

Decision (aligned with UI review): **do not ship** `israel-time.js` /
`israel-time-format.js` in this hardening package.

- No half-wire into UI / SHELL / version bump.
- Scheduled job wrappers (`station-jobs` forEachEnabled) do **not** depend on it.
- Revisit only as a full wire + midnight/DST tests + version bump **above** 42H.36
  in a separate change set.
