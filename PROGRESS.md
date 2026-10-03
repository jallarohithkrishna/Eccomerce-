# PS-01: Autonomous Product Return Resolution Agent — Progress

## Codebase Audit (completed before any changes)

### What Already Exists

| File / Area | Status | Notes |
|---|---|---|
| `firestore.rules` | ✅ Secured (Phase 1a) | Role-based via custom claims (`request.auth.token.role`); no hardcoded emails; orders/returns scoped to owner; client return/refund writes disabled; users role self-escalation prevented |
| `storage.rules` | ✅ Created (Phase 1a) | Authenticated owner-scoped evidence uploads; 10MB max; image mime types only; staff read access |
| `server/policy/` | ❌ Missing (Phase 2) | To be created in Phase 2 with `policy.v1.json` + deterministic `engine.js` |
| Security rules tests | ✅ Passing (Phase 1a) | `server/tests/security-rules.test.js` passing |
| Custom-claims script | ✅ Created (Phase 1a) | `server/scripts/set-role.js` for customer/staff/admin/warehouse role claims management |
| `src/constants/returnPolicies.js` | ✅ Exists | 8 category policies (retained for UI display; server will run `policy.v1.json`) |
| `src/constants/returnStatuses.js` | ✅ Exists | 10-stage pipeline + HUMAN_REVIEW and REJECTED |
| `src/lib/returnAgent.js` | ⚠️ Exists | Client-side tools to be replaced with Returns API calls in Phase 4-6 |
| `src/components/AiReturnAssistant.jsx` | ⚠️ Exists | To be updated in Phase 5-6 with intake API |
| `src/components/ReturnModal.jsx` | ✅ Exists | Modal for return flow |
| `src/pages/Returns.jsx` | ✅ Exists | Customer returns tracker |
| `src/pages/ReturnVerification.jsx` | ✅ Exists | QR courier pass verification |
| `src/pages/admin/Returns.jsx` | ✅ Exists | Admin returns dashboard |
| `src/components/AdminLayout.jsx` | ✅ Secured (Phase 1a) | Custom claims role check from AuthContext; hardcoded emails removed |
| `src/components/Navbar.jsx` | ✅ Secured (Phase 1a) | Custom claims role check from AuthContext; hardcoded emails removed |
| `server/index.js` | ✅ Secured (Phase 1a) | Restricted CORS with origin whitelist; health check and assistant endpoints |
| `server/package.json` | ✅ Exists | Added test script |
| `.env` | ✅ Git-ignored | Firebase client keys only; no server secrets |
| `.gitignore` | ✅ Hardened | Contains `.env`, `server/.env`, `serviceAccountKey.json` |
| `src/context/AuthContext.jsx` | ✅ Secured (Phase 1a) | Exposes `role`, `isAdmin`, `isStaff`, `isWarehouse`, and `getIdToken` from custom claims |

---

## Phase Checklist

### Phase 1 — Security
- [x] Rewrite `firestore.rules`: customers read only own orders/returns; no public reads; no client writes to returns/refunds/delivered_at/users.role; events create-only by server; staff/admin/warehouse via custom claims
- [x] Create `storage.rules`: restrict evidence uploads to authenticated owner; admin/staff can read; 10MB limit; image content types only
- [x] Add storage entry to `firebase.json`
- [x] Create `server/scripts/set-role.js` (Admin SDK) to assign custom claims
- [x] Replace hardcoded email checks in `firestore.rules`, `AdminLayout.jsx`, `Navbar.jsx` with custom claims
- [x] Add `.env` and `serviceAccountKey.json` to `.gitignore`
- [x] Restrict CORS to configured origins in `server/index.js`
- [x] Admin-gate "Simulate Package Delivery" button in `src/pages/Orders.jsx`
- [x] Write rules unit test verifying customer isolation & constraints (`server/tests/security-rules.test.js`)
- [x] **Accept**: rules compile, tests pass, lint & build pass

### Phase 2 — Policy Engine
- [ ] Create `server/policy/policy.v1.json` from `returnPolicies.js`
- [ ] Create `server/policy/engine.js` — deterministic, no LLM
- [ ] Write 30+ golden test cases covering: every category, window edges (day 0, last day, day after), damage exceptions, high-value threshold, partial quantities, already-returned items, groceries 24h perishable
- [ ] **Accept**: all golden tests pass; engine has zero LLM dependency

### Phase 3 — Orchestrator
- [ ] `server/returns/stateMachine.js` — transition table, illegal jumps throw
- [ ] `server/returns/verify.js` — order + delivery verification
- [ ] `server/returns/exceptions.js` — full exception matrix
- [ ] `server/returns/audit.js` — hash-chained append-only events (SHA-256)
- [ ] `server/returns/refunds.js` — idempotent, saga-style compensation
- [ ] Mock services behind interfaces: carrier, warehouse, payments, notifier
- [ ] Tests: every legal transition, illegal transitions rejected, hash chain tamper detection, repeated refund = single payment
- [ ] **Accept**: all tests pass

### Phase 4 — Returns API
- [ ] Express routes with `verifyIdToken`, role checks, rate limiting, Zod validation
- [ ] `POST /returns/intake`, `GET /returns/:id`, `POST /returns/:id/messages`, `/evidence`, `/appeal`
- [ ] `GET /agent/returns`, `POST /agent/returns/:id/approve|deny|override`
- [ ] `POST /warehouse/returns/:id/receive|inspect`
- [ ] `POST /webhooks/carrier`, `GET /returns/:id/audit`
- [ ] Rewrite `/api/chat` to read products server-side + require auth
- [ ] **Accept**: API tests with valid token, invalid token, wrong role

### Phase 5 — LLM Agents
- [ ] `server/llm/client.js` — provider-agnostic (OpenAI-compatible HTTP)
- [ ] Intake agent: free text + photo → validated ReturnRequest JSON
- [ ] Comms agent: decision JSON → grounded customer message (post-check rejects hallucinated numbers/dates)
- [ ] Prompt-injection safety: no tools with side effects exposed to LLM
- [ ] Eval script: 20 labelled intake messages, groundedness check, 5 prompt-injection cases
- [ ] **Accept**: evals pass

### Phase 6 — Frontend
- [ ] `AiReturnAssistant.jsx`: call `POST /returns/intake` instead of regex flow; add photo upload, appeal, message thread
- [ ] Customer tracker (`/returns`): live status stepper from `returns/{id}`, messages, evidence
- [ ] `admin/Returns.jsx`: queue with filters, case detail with timeline, AI recommendation card, approve/deny/override, audit tab, policy view with simulate, analytics
- [ ] `/admin/warehouse` screen for receive and inspect
- [ ] `ReturnVerification.jsx`: read through API route (non-personal fields only)
- [ ] Remove all client-side decisions from `src/lib/returnAgent.js`
- [ ] **Accept**: all 9 deliverables work through UI

### Phase 7 — Automation & Notifications
- [ ] Scheduled jobs: SLA timers (customer reply 7d, pickup 48h, warehouse receipt 7d), close stale, poll mock carrier
- [ ] Notifications: in-app + email through notifier interface (mock for demo)
- [ ] **Accept**: stale cases auto-close, SLA timers fire

### Phase 8 — Demo & Evaluation
- [ ] Seed script: ~50 orders, 10 products covering all scenarios
- [ ] Demo scenario 1: defective item in window → auto-approved + refunded
- [ ] Demo scenario 2: outside window → denial → appeal → human review
- [ ] Demo scenario 3: missing photo → agent asks → resumes
- [ ] Demo scenario 4: high value / suspected fraud → human review with case packet
- [ ] Demo scenario 5: prompt injection → ignored, visible in audit trail
- [ ] Demo scenario 6: refund gateway failure → retry → alert queue
- [ ] Update `README.md`: architecture, setup, env vars, tests, demo instructions
- [ ] **Accept**: all 6 demo scenarios run end to end

---

## Acceptance Checklist (project done when all true)
- [ ] No client code decides eligibility, amounts, or status; only server writes returns, refunds, delivered_at
- [x] Customer cannot read another user's data, write returns, or change roles (security rules enforced)
- [ ] 30+ policy golden tests pass; state machine + refund idempotency tests pass; hash-chain tamper test passes
- [ ] Intake, comms-grounding, and prompt-injection evals pass
- [ ] All 9 deliverables work through the UI
- [ ] All 6 demo scenarios run end to end
- [x] `npm run build` and `npm run lint` pass; README documents setup and demo

---

## Decisions Log
| # | Decision | Rationale |
|---|---|---|
| 1 | Project root is `Eccomerce--main/Eccomerce--main/` | Nested clone structure; all work happens in the inner directory |
| 2 | Git repo initialized fresh (no prior `.git`) | Clean commit history for this project |
| 3 | Will keep `returnPolicies.js` client-side for display only; server gets its own `policy.v1.json` | Client needs badge/color info for UI; server needs the rules for decisions |
| 4 | Firebase custom claims for roles (customer, staff, admin, warehouse) | Replaces hardcoded email checks; enforced in both Firestore rules and server middleware |
| 5 | Lock client return writes completely in `firestore.rules` | Only the server Orchestrator (Admin SDK) can write to `returns/*` and `refunds/*` |
