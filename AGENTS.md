# Codex Autonomous Execution Guidelines - ResQ-102

## 🛡️ STRICT SECURITY & SCOPE BOUNDARIES (MANDATORY)
1. **PROJECT & SYSTEM TOOL ISOLATION:** File changes are restricted to the ResQ project. The owner's subsequent overnight authorization permits required system CLI tools, shared project Git metadata, scoped deployment authentication and the explicitly named ResQ handoff bundles. Never access unrelated personal documents or system settings.
2. **DATA & APP PROTECTION:** Perform zero destructive actions. Protect all production data, schemas, and live services (`station-102`). No breaking schema changes, no data wiping, and no unauthorized file deletion.
3. **SECRET SAFETY:** Never print, expose, or log actual API keys, private credentials, or Secret Manager payload strings in local logs or chat output.

## 🚀 AUTONOMOUS EXECUTION RULES
1. **FULL AUTONOMY:** Execute all remaining tasks sequentially to completion. Do NOT pause execution to ask for manual confirmations (e.g., secret generation, bug fixes, or test re-runs).
2. **SMART CACHING (NO DUPLICATE WORK):** Do NOT re-write or re-test code/modules that have already passed green evidence in previous candidates (e.g., commit 5dd2544). Resume strictly from the latest candidate state.
3. **SELF-HEALING ENVIRONMENT:** If local CLI/Helper errors (`helper_unknown_error`) or runner stalls occur, retry using local fallbacks/mocks automatically without halting execution.
4. **ONE-SHOT UNIFIED PROMOTION:** Keep all verified code intact. Execute a SINGLE, UNIFIED live deployment (Firestore Rules & Indexes -> Cloud Functions v2 -> Live Promotion) ONLY when all 57 verification items pass.

## 📊 MANDATORY STATUS REPORTING
In every turn, provide a concise update containing:
- Estimated Development Progress (%)
- Formal Gate Readiness Status (X/57)
- Current Working Commit Hash
- Next Immediate Step
