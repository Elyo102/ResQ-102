# Agent matrix (descriptive data only)

`control-plane/agent-matrix.json` describes which of the four agents (codex, claude, grok, gemini)
is best suited to which kind of work. It is parsed only by `control-plane/agent-matrix.mjs`
(strict schema, 8 KB limit) and its tests. `routeTask(tag)` is a dry run that returns a suggested
agent and executes nothing.

## Optional `dispatchers` layer

```json
"dispatchers": {
  "gemini_dispatcher": {"role": "Planning, Architecture, Safety & Task Structure", "accepts_user_input": true},
  "grok_dispatcher":   {"role": "Real-Time Telemetry, PWA, Live Status & Field Sync", "accepts_user_input": true}
}
```

- **`accepts_user_input` is descriptive metadata only.** It grants no authority, no routing and no
  input acceptance. Nothing in the control plane reads it to accept, forward or act on user input.
- **A real user-input dispatcher requires a separate security review** before any code may act on it.
- Dispatchers live under their own key and are never merged into `agents`; they do not affect
  `routeTask`. The mapping is hard-coded: `gemini_dispatcher -> gemini`, `grok_dispatcher -> grok`.
- Each entry has exactly `{role, accepts_user_input}`. `role` is at most 120 ASCII characters from
  letters, digits, space and `& , - /`; `accepts_user_input` must be a boolean. The layer is optional:
  a matrix without it parses and exposes `dispatchers` as `{}`.
- The private dashboard does not load the matrix, and no workflow, rule, CI script, agent cycle,
  task contract or budget module references it (enforced by the guard tests).

## Agent Dispatch Center (separate security review, 2026-09-30)

The security review required above was carried out for the Agent Dispatch Center and is recorded in
`control-plane/DISPATCH-CENTER.md` (verdict SAFE_WITH_CONDITIONS; the UI review was done separately).
It does **not** give the `dispatchers` layer any authority, and `accepts_user_input` stays descriptive only:

- The deployed Rules carry a fixed task-type map (`dispatchTaskMap()`), and the browser model carries
  the same fixed map. Neither loads this matrix at runtime. `control-plane/dispatch-drift.test.mjs`
  reads the matrix **as data only** to check that the map equals the `agents` roles under an explicit
  id-to-name mapping (`gemini -> Gemini`, `codex -> Codex`, `grok -> Grok`), minus the excluded
  `executor` and `commit-branch-dispatch` roles. Claude gets no dispatchable task types.
- A dispatch document is a display-only request from the owner, not an authorization and not a
  routing decision. `routeTask` is unchanged and is never called from the dashboard.
- The guard tests allow exactly two new references: the drift test and `DISPATCH-CENTER.md`.
