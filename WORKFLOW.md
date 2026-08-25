# ResQ development workflow

1. Start each task from an up-to-date `main` and create a branch named `codex/<short-task-name>`.
2. Use the Codex task to agree on the requested outcome. Inspection, implementation, and validation must follow the mandatory two-reviewer workflow in `AGENTS.md`.
3. Review Codex's summary, changed files, diff, and test results from the desktop app or Remote on the phone.
4. Push only the work branch and open a Pull Request. GitHub runs the existing `בדיקות` workflow for every Pull Request.
5. Merge to `main` only with explicit merge approval satisfying `AGENTS.md`, whether granted after review or explicitly included in advance in a fully defined workflow.
6. Deployment requires explicit production approval satisfying `AGENTS.md`, whether granted separately or explicitly included in advance in a fully defined workflow. Before any production action, Codex must provide the exact target, command, validation evidence, risks, and rollback plan.

## Phone review checkpoints

Ask Codex to stop at any of these checkpoints when desired:

- **Plan:** proposed outcome, affected areas, and risks before editing.
- **Diff:** changed files and important code differences before committing.
- **PR:** final test results and Pull Request summary before merging.
- **Production:** exact deployment plan and rollback procedure. This checkpoint is always mandatory.

In ChatGPT Remote, the connected computer must remain awake and online. The phone can guide the task, approve requested actions, and review changed files, diffs, and test results.
