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
