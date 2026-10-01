# Codex Autonomous Execution Guidelines - ResQ-102

## 🛡️ STRICT SECURITY & SCOPE BOUNDARIES
1. **PROJECT & SYSTEM TOOL ISOLATION:**
   - File creation, modification, and deletion are strictly limited to the local ResQ project repository.
   - **SYSTEM EXEMPTION:** You are explicitly PERMITTED to access and execute global system binaries, paths, and environment tools (Git, Node.js, npm, Firebase CLI, Google Cloud SDK) required to test, compile, and deploy the project.
   - NEVER access, scan, or read personal user documents, desktop files, or directories unrelated to project build tools.
2. **DATA & APP PROTECTION:** Zero destructive actions. Protect live services (`station-102`), Firestore schemas, and database documents.
3. **SECRET SAFETY:** Never print, log, or expose raw API keys, tokens, or Secret Manager payload values in outputs.

## 🚀 AUTONOMOUS EXECUTION & PERFORMANCE RULES
1. **FULL AUTONOMY:** Execute all remaining tasks sequentially to completion. Do NOT pause or stop execution to ask for manual confirmations (such as secret generation, bug fixes, or test reruns).
2. **SMART CACHING (NO DUPLICATE WORK):** Do NOT re-write or re-test code/modules that have already passed green evidence in previous candidates (e.g., commit 5dd2544). Resume strictly from the latest candidate state.
3. **NO INFINITE LOOPS & SELF-HEALING:** If local CLI or helper errors (`helper_unknown_error`) occur, automatically retry using local fallbacks/mocks. Never enter infinite retry loops—simplify logic directly if a gate check fails twice.
4. **ONE-SHOT UNIFIED PROMOTION:** Keep all verified code intact. Execute a SINGLE, UNIFIED live deployment (Firestore Rules & Indexes -> Cloud Functions v2 -> Live Promotion) ONLY when all 57 verification items pass.

## 📊 MANDATORY STATUS REPORTING
In every response, always provide:
- Estimated Real Development Progress (%)
- Formal Gate Readiness Status (X/57)
- Current Working Commit Hash
- Next Immediate Action
