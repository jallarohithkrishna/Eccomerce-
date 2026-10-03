# PS-01: Autonomous Product Return Resolution Agent — Progress

## Codebase Audit (completed before any changes)

### What Already Exists

| File / Area | Status | Notes |
|---|---|---|
| `firestore.rules` | ✅ Exists | **Insecure**: `allow read: if true` on orders & returns; admin check is hardcoded to two emails (`k71540270@gmail.com`, `jallarohithkrishna@gmail.com`); no custom claims; customers can write returns directly; no events sub-collection rules |
| `storage.rules` | ❌ Missing | No file found |
| `server/policy/` | ❌ Missing | No directory; policies live only in `src/constants/returnPolicies.js` (client-side) |
| Policy tests | ❌ Missing | No test files anywhere in the project |
| Custom-claims script (`server/scripts/set-role.js`) | ❌ Missing | No `server/scripts/` directory |
| `src/constants/returnPolicies.js` | ✅ Exists | 8 category policies: groceries (non-returnable, 24h damage exception), beauty (7-day replacement-only), electronics (service-center-only), fashion (14-day), luxury (10-day), home (15-day), vehicle (non-returnable), standard (14-day). Has `isElectronicsItem()`, `resolvePolicyForItem()`, `resolvePolicyForCategory()`. |
| `src/constants/returnStatuses.js` | ✅ Exists | 10-stage pipeline: REQUESTED → VERIFYING → ELIGIBILITY_CHECK → APPROVED → PICKUP_SCHEDULED → IN_TRANSIT → RECEIVED → INSPECTION → REFUND_PROCESSING → COMPLETED. Plus HUMAN_REVIEW and REJECTED. Has `normalizeReturnStatus()`, `buildInitialTimeline()`. |
| `src/lib/returnAgent.js` | ✅ Exists | **7 tools running in the browser** (violates core design rule). Tools: (1) lookupCustomerOrders, (2) verifyOrderAndDelivery, (3) checkProductPolicy, (4) evaluateEligibility, (5) createReturnRMA — writes to Firestore directly from client, (6) escalateToHumanReview — writes from client, (7) advanceReturnStatus — writes from client. Also writes to `orders.returns[]` array (duplicate data). |
| `src/components/AiReturnAssistant.jsx` | ✅ Exists | 54KB — large component with chat UI for returns |
| `src/components/ReturnModal.jsx` | ✅ Exists | 58KB — modal for return flow |
| `src/pages/Returns.jsx` | ✅ Exists | 27KB — customer returns page |
| `src/pages/ReturnVerification.jsx` | ✅ Exists | 22KB — QR verification pass |
| `src/pages/admin/Returns.jsx` | ✅ Exists | 31KB — admin returns dashboard |
| `src/components/AdminLayout.jsx` | ✅ Exists | Hardcoded admin email check on line 56 + reads role from `users/{uid}.role` Firestore doc |
| `src/components/Navbar.jsx` | ✅ Exists | Hardcoded admin email check on line 72 |
| `server/index.js` | ✅ Exists | Express server with `/api/chat` (Gemini RAG shopping assistant), `/api/sync-products`, `/api/health`. CORS is `origin: '*'`. No auth middleware. No returns routes. |
| `server/package.json` | ✅ Exists | Dependencies: express, cors, dotenv, firebase-admin, @google/generative-ai |
| `.env` | ✅ Exists | Contains Firebase config + **not in .gitignore** |
| `.env.example` | ✅ Exists | Template for Firebase config vars |
| `.gitignore` | ✅ Exists | **Missing `.env`**, missing `serviceAccountKey.json` |
| `src/context/AuthContext.jsx` | ✅ Exists | Firebase Auth with email/password + Google. Sets `role: 'customer'` on new user Firestore doc. No custom claims reading. |
| `src/lib/firebase.js` | ✅ Exists | Standard Firebase client init from env vars |
| `functions/package.json` | ✅ Exists | Nearly empty — no Cloud Functions deployed |

### Key Security Issues Found
1. `.env` with real Firebase keys is **not in .gitignore**
2. `firestore.rules`: orders and returns have `allow read: if true` (public)
3. `firestore.rules`: returns have `allow create: if request.auth != null` (any user can create)
4. Admin check is hardcoded emails in 3 places: `firestore.rules:9`, `AdminLayout.jsx:56`, `Navbar.jsx:72`
5. `server/index.js` has `cors({ origin: '*' })` — wide open
6. No `storage.rules` at all
7. Client-side `returnAgent.js` makes eligibility decisions and writes returns/refunds directly to Firestore

### Key Architecture Violations (vs. target)
1. **Client decides eligibility** — `toolEvaluateEligibility` runs in browser
2. **Client writes returns** — `toolCreateReturnRMA` and `toolEscalateToHumanReview` write directly to Firestore from the client
3. **Duplicate data** — returns stored in both `orders/{id}.returns[]` array AND `returns/{id}` collection
4. **No state machine** — status transitions are ad-hoc, no validation of legal transitions
5. **No audit hash chain** — audit entries exist but are simple objects, no hash linking
6. **No idempotent refunds** — no refund collection, no idempotency keys
7. **No server-side returns API** — all return logic is client-side
8. **No role-based access via custom claims** — roles stored in Firestore doc, checked client-side

---

## Phase Checklist

### Phase 1 — Security
- [ ] Rewrite `firestore.rules`: customers read only own orders/returns; no public reads; no client writes to returns/refunds/delivered_at/users.role; events create-only by server; staff/admin/warehouse via custom claims
- [ ] Create `storage.rules`: restrict evidence uploads to authenticated owner; admin/staff can read
- [ ] Create `server/scripts/set-role.js` (Admin SDK) to assign custom claims
- [ ] Replace hardcoded email checks in `firestore.rules`, `AdminLayout.jsx`, `Navbar.jsx` with custom claims
- [ ] Add `.env` and `serviceAccountKey.json` to `.gitignore`
- [ ] Remove any hardcoded keys from client code
- [ ] Restrict CORS to configured origins
- [ ] Remove or admin-gate "Simulate Package Delivery" button (if present)
- [ ] Write rules unit test proving customer isolation
- [ ] **Accept**: emulator test proves customer can't read others' data, write returns, or set role

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
- [ ] Customer cannot read another user's data, write returns, or change roles (emulator tests pass)
- [ ] 30+ policy golden tests pass; state machine + refund idempotency tests pass; hash-chain tamper test passes
- [ ] Intake, comms-grounding, and prompt-injection evals pass
- [ ] All 9 deliverables work through the UI
- [ ] All 6 demo scenarios run end to end
- [ ] `npm run build` and `npm run lint` pass; README documents setup and demo

---

## Decisions Log
| # | Decision | Rationale |
|---|---|---|
| 1 | Project root is `Eccomerce--main/Eccomerce--main/` | Nested clone structure; all work happens in the inner directory |
| 2 | Git repo initialized fresh (no prior `.git`) | Clean commit history for this project |
| 3 | Will keep `returnPolicies.js` client-side for display only; server gets its own `policy.v1.json` | Client needs badge/color info for UI; server needs the rules for decisions |
| 4 | Firebase custom claims for roles (customer, staff, admin, warehouse) | Replaces hardcoded email checks; enforced in both Firestore rules and server middleware |
