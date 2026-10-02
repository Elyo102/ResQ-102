# Clean-checkout reproduction of the declared product slice

Date: 2026-10-02. Commit: e94988085d7413ba50ffdb89c564936489991194.
Checkout: work/resq-repro-e949880, detached local clone with no hardlinks.
No production data, product deployment, external AI call or secret payload was used.

## Environment and installation

Node22.21.1, npm11.17.0, Temurin Java21.0.12.1, Playwright1.62.1,
functions firebase-admin13.10.0; Firebase CLI from the existing pinned runtime.
All three committed lockfiles were installed independently in the fresh checkout.
The initial npm.cmd launcher selected its adjacent Node24.19.0 despite PATH
selecting Node22. It emitted EBADENGINE. The corrected installation explicitly
invoked npm-cli.js with the pinned Node22 executable for tests/functions/rules-test.
The corrected commands used ci --no-audit --no-fund --ignore-scripts; this is NOT
proof that default lifecycle-script installation succeeds. Existing upstream
deprecation warnings were retained, not described as zero warnings.
The lockfile-matching Chromium install command exited0.

## Results

All10 declared entrypoints ran successfully against newly installed dependencies:

- Pure replication20 and controlled authority routing3:23 PASS.
- Fresh demo-resq Firestore emulator: HR shift-change23, replication7,
  replication cutoff boundaries5, outbox operation14, outbox boundaries4,
  ACK races8:61 PASS. Auth/FCM were synthetic.
- Contained browser with local Firebase stubs: HR requests52, replication2:
  54 PASS. Chromium only, not physical iPhone/Safari.

Total:138 local assertions/scenarios in this declared slice. This number is NOT
the57-item release gate or evidence that all application tests passed.
The50-file working/index input check also passed in this checkout.
Tracked files remained unchanged; only local containment output was untracked.
Normal emulator SIGINT shutdown was recorded with successful script exit0.

Logs: e01-pure-20261002.log, e01-native-20261002.log,
e01-browser-20261002.log in this docs directory. Installation output was returned
by the execution tool, not independently captured as a repository log.

## Remaining limitations

E01 is PARTIAL: this demonstrates reproducibility of the declared product slice,
not a fresh full application/Rules gate, all transitive inputs, CI Linux parity,
or the eventual frozen unified release candidate. The existing donor control-plane
contract is separate. Do not reuse these results for changed inputs or a different
runtime. Do not rerun this unchanged slice merely to increase pass counts.
