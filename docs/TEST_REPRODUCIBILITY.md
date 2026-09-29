# Reproducible test inputs

`npm --prefix tests run test:all` means the registered Rules/service suites plus
the Playwright runner. `npm --prefix tests run all` remains the separate full
application gate. Neither replaces the other. Test files, scenario counts and
project-expanded browser cases are different denominators; report the command,
candidate SHA, registry and runner result rather than a universal test count.

Both gates run `test:reproducibility` first. Its explicit manifest covers the four
current Playwright spec files (the fifth e2e file is a fixture, not a spec), their
declared public dependencies and package locks. It refuses unknown/omitted specs,
missing/untracked inputs and private operator paths. It does not auto-discover and
silently skip local tests. Existing application inventory remains mandatory.
This is not a complete static analysis of dynamic dependencies or proof that
arbitrary code contains no secrets; additions require human review.

## Clean checkout procedure

1. Freeze the candidate. Include only reviewed safe inputs. In this change the
   seven existing public `control-plane/web/` assets and two private-dashboard
   synthetic browser specs are required unchanged; do not stage their parent
   directory wholesale. No operator/provisioning/vault code is needed.
2. Install the three lockfiles with Node22 `npm ci`; use the pinned Java/Firebase
   emulator versions from CI. Install the Playwright Chromium build from the lock.
3. Run `npm --prefix tests run test:reproducibility`. Missing Git entries are a
   release blocker, not grounds to remove tests or accept a local-only result.
4. Run `test:all` with the explicit demo-resq loopback emulator at 8191; run the
   application `all` gate separately using its established test environment.
5. Record actual runner counts and output status. Git-index membership is checked
   locally; final proof requires the committed candidate in a clean checkout.

Do not commit credentials, refresh tokens, provisioning helpers, vault material,
raw outputs, traces, screenshots or private exports. The browser configuration
contains public application identifiers, not publisher/owner credentials. The
synthetic tests intercept network and do not establish real Safari/OAuth/cloud
behavior. This work does not modify UI/runtime logic or deploy anything.
