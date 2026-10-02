# Actual integrated execution, 2026-10-02

Base: a5cd149345362b36245f9d73a59be9622208b77d. Reviewed runner/identity
fixture repair commit: fed4775. Subsequent scoped repairs are recorded below.
This document is NOT a frozen-candidate attestation or a 57/57 release result.

## Commands and results

- Actual `npm --prefix tests run release:validate` under Node22 exited1 with
  GATE_KEYS. The historical registry omitted the approved additional tests.
- Fixed additive registry retains every historical command, order and multiplicity.
  Exact registry equality, native branches, network ledger and unchanged-tree
  attestation requirements remain. Targeted contract:14/14 PASS.
- Actual contained application branch reached onboarding and exposed stale doubles:
  numeric audit timestamp, then missing tx.create. Test-only atomic staging,
  collision rejection and replay checks passed23 and31 respectively. Earlier
  Auth operations are not represented as rolled back by Firestore failure.
- The independent sanitized native branch passed3/3 suites, including local
  Git/archive/restore fixtures. This is NOT a production backup or project-loss DR.
- Full rules-test pretest and test scripts ran in a fresh demo-resq Firestore
  emulator on loopback8199, exit0. Expected permission-denial diagnostics and
  expression-limit denials remain in the log; this is not zero-warning evidence.
- The remaining registered application plan was executed once with failure
  collection:143 steps PASS,12 FAIL initially. Failed steps were not skipped or
  converted to passing. This aggregate was executed across a working repair tree,
  not a frozen source tree; no attestation was issued.
- Unexecuted inventory tail:23 command leaves PASS,0 FAIL. Earlier successful
  inventory leaves were not needlessly replayed for each fixture repair.
- Previously unreached browser tail completed:47 command leaves PASS,0 FAIL,
  exit0, including phonesweep at320/360/390. No final attestation was issued.

## Differential repairs and evidence

- UX source assertion follows current-cache fallback rather than requiring unsafe
  global cache lookup. UX pass includes30/30 PWA lifecycle checks.
- Calendar isolated mutation fixture copies its exact new dependencies; all53
  mutants retained/caught. Policy/mode fake transactions support atomic create:
  73 and128 assertions PASS. Hidden-authority inventory explicitly verifies
  replication delegation and both manager gates:203 PASS.
- Source EOL regression:46/46 PASS,14 probes on LF and actual CRLF copies.
- Telemetry allowlists explicitly add previewScheduleReplication on client/server;
  no arbitrary callable admission. Ops contract PASS; security289/289 PASS.
- Fleet worker double supports staged addAll, cache match, timers and waitUntil:
  18 PASS. It remains a simplified single-cache fixture.
- HR incomplete-generation test now supplies a matching digest, so the separate
  digest guard cannot hide a missing completion guard. Complementary digest
  negatives and positive control retained:45 PASS. Updated exact N+1 mutation
  needle preserves transaction authority:19 mutants caught,0 survived.
- Report keyboard repair1 (bounded wait alone) FAILED and is preserved. Controlled
  A/B evidence isolated first-paint/input readiness: immediate key remained at0;
  fonts+two animation frames allowed one trusted ArrowLeft to reach negative scroll.
  Repair2 retains one key, focus/overflow/movement and column-reachability checks:
  38/38 PASS, zero captured browser warnings/errors; not physical Safari evidence.
- Historical preflight test accepts only exact reviewed option deltas for two
  App Check additions and recordMetrics HMAC binding; all other options remain
  exact.83/83 PASS. Production preflight readiness logic is unchanged.

## Evidence locations and outstanding boundary

Logs retained in the parent work directory: unified-gate-a5cd149-20261002.log,
unified-gate-contract-repair1-20261002.log, unified-application-a5cd149-repair1-20261002.log,
unified-application-a5cd149-repair2-20261002.log,
unified-application-onboarding-repair1-20261002.log, unified-native-a5cd149-20261002.log,
unified-rules-a5cd149-20261002.log, unified-remainder-20261002.log,
unified-inventory-tail-20261002.log, unified-eol-repair1-20261002.log,
unified-fleet-repair1-20261002.log, unified-report-scroll-repair1-20261002.log,
unified-report-scroll-repair2-20261002.log and unified-browser-tail-20261002.log.
Some child-agent targeted runs are preserved in tool output rather than standalone
repository logs. The browser tail terminal result was captured from the original
running process and its retained log; it was not rerun to obtain this result.

BackupSealMaterialAvailable=false was checked without revealing any value. No
encrypted readback-verified production rollback archive has been created. The
bounded ops/release source inspection found only direct environment/options
injection for RESQ_BACKUP_SEAL_PASSPHRASE, not an established Secret Manager/KMS/
DPAPI resolver or recoverable key escrow. Synthetic fixture keys were not used
as production recovery material. A protected recoverable value or an explicitly
configured recovery-secret reference is still required; never send it in chat.
The
79-target manifest is still non-executable pending real baseline/rollback and all
57 acceptance requirements. Existing open feature/device/Auth/DR requirements
remain in the authoritative ledger; passing these tests cannot erase them.

No production deployment, employee mutation, secret payload read or paid API call.
No blanket source freeze, no final57 acceptance and no new release receipt.

## Subsequent local environment verification

At pushed1142286 the executing PowerShell, Node22 parent and inherited Node child
all reported the named seal variable unavailable. The later direct owner request
authorized creating project-root .env.local. Before writing, its absence and
untracked status were checked; .gitignore excludes it and Firebase Hosting has
explicit .env.* and **/.env.* exclusions. No exclusions were changed.

Node22 --env-file=.env.local then reported availability=true and minimumValid=true.
An in-memory synthetic sealBuffer/unsealBuffer roundtrip passed. The requested
value was disclosed in chat, so productionKeyApproved=false: it was not used for
employee data, cloud export, a production backup or a release readiness receipt.
The ignored file carries a synthetic-only warning and was not staged. No key value
or secret-derived diagnostic was emitted. Production requires a distinct random,
recoverable protected key; no new escrow/IAM/storage location was silently created.

E11 local follow-up confirmed callout.js still writes client ISO seen_at and at.
Existing Rules deliberately preserve the first seen string and accept cached
legacy answer merges. A naive additional server answer timestamp can become stale
when an old client changes the answer while preserving the new field; requiring
it on every write would break that cached client. E11 therefore remains OPEN
pending a reviewed payload-bound compatibility contract and emulator proof, not
merely an added timestamp field. No product timestamp change was made here.

The requested AGENTS reporting-section removal was denied by the permission
reviewer even after independent verification of the human message; it was not
bypassed and AGENTS.md remains unchanged.

## Random recovery key and real backup attempt

Direct human turn01a0fb78-62b8-73a1-af95-ede7329e03e7 superseded the disclosed
synthetic key with authorization for a cryptographically random32-byte key.
ops-provision-backup-key.ps1 generated it with the platform CSPRNG, persisted it
atomically in project-root .env.local, and verified a protected current-user-only
ACL plus exact readback. Recovery location: this worktree's .env.local. No value
or fingerprint is recorded here. It is local recovery material, not offsite DR.
Subsequent runs reuse the random-marker key, never rotate it automatically.

Two scoped reviews and45 synthetic assertions passed. Earlier failed synthetic
attempts exposed PowerShell null-string replacement and redundant owner ACL
assignment issues; both were repaired before real provisioning. Node22 loaded the
persisted key and passed a synthetic seal/decrypt check. The original provisioning
command completed successfully; its caller exited before Node verification due
to unset LASTEXITCODE, so verification ran separately without regenerating the key.

ADC was unavailable (including a metadata lookup warning), but the existing
Firebase CLI session was independently usable. No login, new credentials, IAM
grant or token persistence was performed. Firebase Admin rejected its generic
custom credential before capture, so the reviewed adapter uses the installed
Google Cloud Firestore client with GoogleAuth/OAuth2Client and an in-memory CLI
refresh handler.19 synthetic adapter/refresh assertions passed with no Admin app
creation. The optional inMemoryUnseal path passed8 new synthetic assertions,
including wrong key/ciphertext/manifest rejection and zero plaintext-temp attempts.
No earlier green application/browser suite was rerun.

The actual authorized capture then failed. One bounded metadata-only diagnostic
confirmed Firestore PERMISSION_DENIED(code7), not absent ADC or a missing key.
No permission grant or retry loop followed. A private staging directory may
remain; it is not a completed backup and was not removed. No backup readback
success, source/config/IAM rollback completeness, point-in-time consistency,
57/57 gate or production promotion is claimed. Successful CLI authentication
does not establish authorization to read Firestore documents.

### Subsequent bounded diagnosis: SDK failure remains unresolved

The read-only IAM check returned all four requested permissions allowed:
datastore.databases.get, datastore.entities.get, datastore.entities.list and
serviceusage.services.use. A direct REST listCollectionIds metadata request with
the existing CLI credential returned HTTP 200. No document contents or collection
names were output. These results do not support claiming a missing IAM role.

The final permitted SDK metadata-only check, using preferRest:true, still failed
with code7 (capture stage; backupCreated:false). The SDK/credential-path mismatch
remains unresolved. The adapter repair limit is reached: do not repeat capture,
grant permissions, or describe this adapter as production-verified. Preserve the
private staging directory and successful provisioning/synthetic-test evidence.
No complete production backup or unified deployment was produced.

### Owner-renewed REST-only recovery path

Verified human turn01a0fbc1-f9f7-7c21-8b99-dd7221278608 renewed autonomous
credential/backup resolution. The SDK repair cycle remains closed. A new bounded
read-only REST adapter uses the existing CLI identity, fixed Firestore origin,
no redirects/retries, and the existing protected key. No IAM change or key
regeneration occurred. Two PRE and two POST source reviews covered this path.

ops-backup-rest.mjs validates resource boundaries, collection/document pagination,
missing-parent recursion, timestamp submilliseconds and snapshot value markers.
It rejects unsupported/lossy values rather than silently converting them.
The existing snapshot format does not preserve integer-versus-double identity;
this is not a raw Firestore managed export. Limits:10000 requests,50000 documents
including placeholders,128MiB aggregate responses,16MiB/page,100 path segments,
30000ms per request including credentials/headers/body. Limits fail closed.

Final changed adapter:50 synthetic assertions PASS;9 additional boundary checks
PASS including nested missing-parent encrypted capture/readback, null-field and
unknown-envelope rejection, aggregate/document limits and stalled credentials/
headers. Existing application suites were not repeated. Syntax checks PASS.
Git diff hygiene PASS. This is local adapter evidence, not final57 acceptance.

Actual metadata-only proof through the exact wrapper returned exit0,
operationSucceeded:true,metadataReadVerified:true,backupCreated:false. Private
key/destination ACL and ignored-key checks passed before this call. One subsequent
authorized capture was started; its completion must be recorded separately.

The single REST capture completed with exit1 at capture stage:
operationSucceeded:false,backupCreated:false,category:POLICY_UNCLASSIFIED.
Authentication/transport was no longer the blocker. The policy deliberately
refuses a snapshot when paths have no backup classification; no catch-all,
omission, restore classification or retention decision was invented. The error
output was sanitized and contains no document paths, identities or payloads.
No second full scan was launched. Protected staging artifacts remain preserved.
No completed production backup, source/config/IAM rollback or promotion exists.

Reviewed code and tests were committed/pushed non-force as4a3dd87 to
codex/unified-enterprise-20261001 only. The backup/key/REST test files are scoped
supplemental operational evidence, not silently added product-gate passes.
Pure buildHours46Plan metadata validation passed with156 application entries;
executedTests:0,formalAcceptancePassed:0. This does not execute or replace the
required final gate. Prior readiness artifacts remain historical.

Remaining boundaries reconfirmed by two read-only reviews: S02 runtime service
account effective Secret Manager access is not established by the operator's
Firestore permission; S04 real refresh-token/client reauthentication proof needs
a separately authorized dedicated test identity (never an employee account).
Physical-device acceptance, project-loss DR, production baseline/rollback and
the open requirements in UNIFIED_REQUIREMENTS_20261001.md remain unresolved.

### Source-backed policy repair after renewed authorization

Human turn01a0fbf1-c2fa-7b91-a92a-2cc1249b9322 authorized resolution, not a
fabricated local_verified receipt. Failed staging directories contained zero
files, so no raw-document diagnostic was available. Bounded root metadata
comparison initially missed doc() syntax; the pure matcher was corrected and
tested (10 assertions). It identified three source-backed roots: invitations,
onboarding_assignment_links and system. Only these repository-defined schema
labels were output; no live document identifiers/fields were printed.

Seven exact policy/Rules additions were reviewed twice before and after edits:
six invitation/onboarding/provisioning authority/receipt patterns use encrypted
managed_export with specialized_restore (manual_required), restricted_identity,
humanReadable:forbidden and unresolved retention. No automatic identity restore,
TTL or deletion was enabled. The exact derived system/heartbeat singleton alone
is excluded; system/other and unknown descendants remain unclassified. Three
additional related receipt patterns were source-backed, not claimed live-present.

Affected evidence:53 policy assertions PASS after one CRLF test-only repair;
exact Rules/policy coverage191 PASS;5 restore-plan assertions PASS (six manual,
zero automatic/identity writes);120 emulator-only denial assertions PASS with
expected permission-denial diagnostics, not zero warnings. Heartbeat create
case uses its adjacent -new name; exact singleton create is not independently
exercised, although its new exact rule explicitly denies writes. Owned demo-resq
emulator was stopped. Initial Java argument quoting failed before startup and
was repaired once; it did not touch production. The59 unchanged REST assertions
were preserved, not rerun. No backup or release success is inferred from these.

### Resumed capture outcome after policy commit 0c66a15

The existing capture process (session 51623) completed with exit1:
operationSucceeded:false,backupCreated:false,stage:capture,
category:POLICY_UNCLASSIFIED. Authentication, request metadata and transport
failure flags were all false. The seven classified patterns did not establish
complete live-path coverage. No new capture, deployment, IAM change or secret
rotation was started during this continuation. Existing artifacts were preserved.

The root-only diagnostic explicitly does not validate nested coverage; its prior
result cannot locate or classify the remaining gap. The sanitized capture output
does not identify it. Do not invent a classification, exclude unknown records, or
replace the failure with local_verified. A scoped, privacy-preserving diagnostic
is still needed before another authorized capture.

Current tracked product source remains 0c66a15. AGENTS.md already matches the
requested autonomous-execution instructions. Local source inspection confirms
recordMetrics declares RESQ_METRICS_HASH_KEY in its Functions secret binding;
this is not proof of deployed runtime secret access. Final frozen gate remains
0/57; a development percentage is not established by this operational check.

### Authorized metadata diagnosis and HMAC metadata verification

The resumed owner-authorized diagnosis uses a separate REST metadata interface
(`listDocumentMetadata`, no `listDocuments` and no data payload), a field mask
and partial-response selector, and rejection of any returned fields. A bounded
probe must succeed before recursive enumeration, including missing parents.
The original request/response/document limits and no-retry policy remain.
Two independent PRE and POST reviews approved the diagnostic under the verified
private destination/key ACL controls. It is not a backup or restore artifact.

New synthetic evidence:16 metadata/parser assertions passed;3 additional private
callback/redaction assertions passed via inline execution, then preserved as
tests/backup-metadata-private-callback.mjs with repository-relative imports.
The59 historical REST assertions were not rerun. Changed CLI syntax and diff
checks passed (Git line-ending notices retained). Static scanning covered716
tracked source files, with4106 path-call findings and6113 unresolved constructs:
2411 possible wrappers,3639 dynamic paths/parents,59 computed calls,4 HTML
external-script references. No parse failures occurred in this inventory.
Lexical binding analysis is not scope-aware or full dynamic execution coverage;
the unresolved inventory cannot authorize automatic policies.

Read-only cloud metadata confirms deployed recordMetrics is ACTIVE, uses the
shared Compute runtime identity, and has no RESQ_METRICS_HASH_KEY binding yet.
Secret version1 is ENABLED; direct secret IAM bindings for that runtime are empty.
The exact principal/secret/secretmanager.versions.access Policy Troubleshooter
request returned HTTP403, with effective access NOT_ESTABLISHED. No payload,
IAM mutation, impersonation, secret rotation or Functions deployment occurred.
Do not infer access from the operator's credentials or synthetic Auth tests.
Granting access to the shared runtime would affect other workloads using it;
no such grant was made. Existing revokeRefreshTokens code remains preserved;
real client reauthentication has not been tested on employee identities.

One metadata-only recursive run was launched as session37964, with encrypted
private evidence/readback required. Completion must be recorded separately;
no policy gap, backup, final57 pass or deployment is inferred from launch.

The metadata diagnostic completed exit0 with encrypted readback:217 collections,
6414 existing documents,5 missing parents and90 unclassified documents. Private
evidence is under _גיבוי/unified-20261002/metadata-diagnostic-a6b5dc8a-762a-42d2-88ce-21861c3785c3.
Public output suppressed IDs and unknown labels. In-memory correlation to tracked
source identified bulletin_rate_limits(3),bulletin_requests(11),
schedule_identity_state(1),schedule_people(75). The latter two were resolved from
the explicit COLLECTIONS contract and childRef wrapper, not guessed by the AST.

Two PRE reviews approved nine exact policies: the four observed schemas plus
schedule_source_bindings, schedule_person_link_index, schedule_identity_operations,
schedule_identity_audit and global schedule_person_link_reservations. State is
the exact current singleton. All nine are encrypted export/manual-only restore,
restricted_identity, humanReadable forbidden, retention unresolved. Rate state is
temporary and identity audit is audit_log. No identity replay, exclusion, TTL or
deletion was introduced. Exact deny Rules preserve existing catch-all behavior.

New evidence:78 policy/manual-plan assertions PASS; changed coverage200 paths
PASS;150 emulator-only denial assertions PASS across three roles and ten paths,
including exact singleton creation and unknown-state sibling. Expected denial
diagnostics remain; emulator stopped intentionally with Ctrl-C. Reconciliation of
the encrypted90 gap paths against the repaired policy gives zero unclassified
paths in that observed interval, without another metadata scan. This is not a
point-in-time guarantee, full backup or live deployment evidence.
