# Product input reproducibility — E00 partial

This checker covers an explicit product-owned slice: HR48, schedule replication and E07/E08 outbox tests, selected application files, local browser harnesses, package registries and all three lockfiles. It does not execute any listed entrypoint. It is not a complete transitive dependency graph, secret certification, clean-install proof or complete release gate.

E00 remains PARTIAL. E01 remains OPEN until the exact committed candidate is installed and tested in a fresh checkout. The separate donor four-spec/control-plane contract remains in resq-ci-review-dev; it is not removed, imported, or satisfied here. All control-plane/ and public/status/ paths are denied. No donor dashboard or Hosting assets are added.

The index/path validation derives from donor commit 6d826bb tests/reproducibility.mjs plus its reviewed, uncommitted ancestor-lstat hardening. Paths are explicit, reviewed and independently enumerated in the checker; omissions, additions and duplicates require deliberate contract review. Parent components and leaves must be ordinary directories/files before hash or blob access. Existing symlinks fail closed. This is not protection against concurrent TOCTOU changes, hardlinks, or all platform-specific junction behavior.

The manifest itself and every enumerated file must have one regular stage-zero Git index entry. Staged blob bytes are authoritative; working bytes must match Git's path-filtered hash. This accepts equivalence under trusted Git filters, not necessarily raw-byte identity. The checker reads existing Git filter configuration; execute only in a trusted repository. Newly created files must be reviewed and staged before checkout verification can pass. This checker neither stages files nor changes the index. Its baseHead is the pre-existing commit, not an attestation identifying pending staged changes.

Manual commands from repository root (not run by this change):

- node --test tests/product-reproducibility.test.mjs
- node tests/product-reproducibility.mjs

Existing gate commands and Rules pretest are preserved; named product:inputs, product:inputs:test and bulletin:time:browser scripts were added. This is not the donor test:all gate, and does not replace npm --prefix tests run all or any registered emulator suites. Keep isolated fresh-emulator prerequisites and each suite's allowed ports; do not bypass them to make reproduction pass.

For E01, freeze and commit the reviewed tree, create an exact clean checkout, install tests/functions/rules-test with their existing lockfiles, use Node 22 and CI-pinned Java/Firebase tooling, install the lockfile-compatible Chromium build, then run the declared product gates with their containment and emulator prerequisites. Record the SHA, tool versions, commands, actual results and unresolved scope. Do not import logs, traces, screenshots, credentials, private exports, vaults or provisioning helpers as inputs.
