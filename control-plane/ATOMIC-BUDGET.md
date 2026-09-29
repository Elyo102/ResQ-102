# Isolated paid-agent activation

The public dashboard is unchanged. Authentication already uses a popup and the
owner reported successful iPhone verification. Private operator provisioning
and deployed Rules remain outside the public web assets.

## Accounting contract

Every paid request in `agent-cycle.mjs` first reserves USD 0.25 against a shared
UTC-month USD 20 ceiling. Integer micro-USD only; no refund, deletion or reset.
The reservation and month increment commit atomically with CAS and create-only
preconditions. Uncertain commit responses never authorize an API request.
Reservations have a single-use, 20-second dispatch permit, server-time checks,
and a 120-second month-end blackout. Existing monthly balances are preserved.
An absent future month fails closed until its zero ledger is provisioned.

This is a conservative reservation ceiling for these runners, not a claim about
taxes, provider invoice timing, unrelated key usage or platform subscriptions.
The existing PR-review entry point still fails closed without its own injected
adapter; this activation stage does not silently enable arbitrary PR execution.

## Pinned activation requests

Only a fixed public design-review prompt is sent, under 4,000 serialized UTF-8
bytes and 2,200 output tokens. No tools, images, search, cache creation, arbitrary
input or paid retry. Responses are validated but never executed or printed.

Checked 2026-09-29 against official documentation:

- Claude `claude-haiku-4-5-20251001`: USD 1 input / 5 output per million tokens.
  https://platform.claude.com/docs/en/models/overview
- Grok `grok-4.7`: USD 2 input / 6 output per million tokens.
  https://docs.x.ai/developers/models/grok-4.7
  Uses **Responses** `max_output_tokens`, which includes reasoning tokens.
  Chat Completions' visible-output-only cap is deliberately not used.
  https://docs.x.ai/developers/rest-api-reference/inference/responses.md
- Gemini `gemini-3.5-flash-lite`: USD 0.30 text input / 2.50 output per million tokens;
  minimal thinking (not disabled), total output cap 2200.
  https://ai.google.dev/gemini-api/docs/pricing
  https://ai.google.dev/gemini-api/docs/generate-content/thinking
  Google restricts2.5 access for new users; the migration preserves all previous
  reservations and updates only the model policy/version.
  https://ai.google.dev/gemini-api/docs/deprecations

Any model, pricing or request-shape change requires revalidation. USD 0.25 is a
reservation, not a measured per-call invoice. No attempt is made to infer exact
spend from a missing response.

## Genuine status, not simulated workers

Codex is the CI coordinator. Claude, Grok and Gemini statuses describe real
provider workers and their bounded connectivity/design-review requests. A
completed call does not mean repository code was reviewed or tests were run by
that provider. This is not a continuously running daemon. Missing heartbeats
become stale in the existing dashboard rather than remaining falsely active.

## Release and rollback

Only the reviewed dev SHA may receive protected-environment credentials after
successful tests. Distinct Firebase principals handle budget and each agent's
events; no Admin credentials or production access in CI. Emergency stop is
disabling the budget policy/principal. It cannot cancel already issued requests.
Preserve all operation records and totals when reverting code or Rules.
