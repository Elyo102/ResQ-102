# 42H.43 release scope

Baseline: 679a7bb41995aa7b493e5b65cf3848947616c318 (42H.42).
Target: station-102, europe-west1 Functions and Firebase Hosting; matching public-only GitHub Pages artifact. No main merge.

## Closed requirements

- D1: desktop workspace, full-height physical left rail, account/update panel open by default and manually collapsible; existing mobile layout preserved.
- D2: remove misleading three-photo label; do not remove upload safety limits.
- U1: owner user list exposes existing employee number or honest missing-number state.
- U2: owner-selected setup-mail preview/send/status, existing employee number and password-reset link, max 20 recipients, stable idempotency and rate limits. No plaintext passwords, automatic bulk send, allocation or activation.
- H1: owner-issued email/station-bound single-use HR invitation; 72-hour expiry, recovery/revocation, HR-only empty-shift approval exception. Lisa invitation issuance is a separate requested post-deployment action, not completed by source deployment.
- N1: eligible approved users receive dismissible notification activation guidance. No automatic permission grant, push delivery claim or urgent-callout obstruction.
- N2: existing local Auth persistence retained; actual device reopen behavior remains to verify.
- P1: no extra home listeners; bounded reminder status call coalescing. No production latency improvement claimed from mocks.
- R1: clean candidate, exact-tree release validation, scoped deployment, rollback evidence and live artifact verification remain release operations.

## Exact changed Functions

issueHrInvitation, revokeHrInvitation, ownerSetupMail, approveRegistration, deliverMail,
reportIncident, recordMetrics, getMaintenanceDashboard, setMaintenanceMode,
runMaintenanceAnalysis, prepareMaintenanceHandoff, activateScheduleMonthAuthority,
previewScheduleCutover, promoteScheduleToNew, systemHeartbeat.

The three schedule Functions share release-bound activation/preflight signatures and must move together. Existing deliverMail GMAIL_APP_PASSWORD binding is retained; new callables need no new secret. No Rules, indexes, Storage rules, IAM expansion, live-mode switch, TTL policy or data migration is part of this release.

## Evidence and gate

Two connected reviewers independently reviewed final scope and compared conclusions: SAFE_WITH_CONDITIONS, no new code blocker. Final release:validate on the clean committed tree is mandatory. Local targeted tests include HR 13, owner mail 10, actual mocked SMTP wiring 10, new private Rules isolation 120 denials, desktop workspace 18 scenario groups, layout 95, navigation 27, home 32 and readiness entry 74. Notification controller/bootstrap/activation identity-race fixtures pass. Provider boundaries pass; source receipt refreshed after checks. Public asset inventory 130; version contract 368 references and 19/19 mutation checks; Hosting privacy 43. These are local tests, not real device delivery proof.

## Rollback and operational limits

Pre-release Hosting baseline: sites/station-102/versions/3b50fab1a048d7df.
Pages baseline: 03686c2bd5901f28659447473c414b01a0db61ba.
Capture current changed Function configurations/source generations before deployment. Restore UI first when disabling new paths. Keep the new delivery guard while any setup-authority mail jobs remain pending; do not blindly restore old deliverMail. Retain HR approval compatibility while blank-shift invitations/requests exist. Never delete onboarding records or reallocate numbers as rollback. No provider sends or user mutations are part of verification without their explicit operational scope.

Unverified: actual authenticated owner screenshot path, Lisa completion, mailbox delivery, iPhone/Safari/push delivery and browser restart persistence. Training videos and historic infrastructure roadmap are not delivered by this release.
