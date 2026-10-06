# PS-01: Autonomous Product Return Resolution Agent — Progress

## Firestore Read Optimization Audit (Free Tier Protection)

| Area / Component | Before (Reads / Visit) | After (Reads / Visit) | Savings (%) | Optimization Applied |
|---|---|---|---|---|
| **Admin Dashboard (`admin/Dashboard.jsx`)** | ~350 reads (entire `users`, `orders`, `products` collections on full snapshots) | **4 reads** | **98.8%** | `getCountFromServer` for users, `getAggregateFromServer` (sum & count) for orders, `getCountFromServer` for returns/exceptions; product stats from memory cache; manual refresh button |
| **Admin Orders (`admin/Orders.jsx`)** | ~200+ reads (full collection snapshot) | **25 reads** | **87.5%** | Paginated query `orderBy('created_at', 'desc')` + `limit(25)` with `startAfter` "Load More" button |
| **Admin Returns (`admin/Returns.jsx`)** | ~200+ reads (full orders scan on every mount) | **25 reads** | **87.5%** | Paginated query `orderBy('created_at', 'desc')` + `limit(25)` with `startAfter` "Load More" button |
| **Admin Products (`admin/Products.jsx`)** | ~50 reads per mount | **0 reads** (subsequent) | **100%** | Single shared `productCache.js` module-level subscription |
| **AI Assistant (`AiAssistantModal.jsx`)** | ~50 reads per modal open | **0 reads** | **100%** | Uses shared `productCache.js` subscription |
| **Voice Assistant / JARVIS (`VoiceAssistant.jsx`)** | ~50 reads/product command, ~200 reads/order query | **0 - 5 reads** | **97.5%** | Product commands use `ensureProductsLoaded()` from cache; order commands bounded to `limit(5)` / `limit(100)` with `where` clauses; admin commands restricted to admin role |
| **Local Persistence (`firebase.js`)** | Repeated reads across page reloads / tabs | **0 reads** (cached docs) | **~90%** | Enabled `persistentLocalCache` with `persistentMultipleTabManager` in IndexedDB |
| **Local Emulator Support (`firebase.js`)** | Production quota usage during dev/tests | **0 cloud reads** | **100%** | `VITE_USE_EMULATOR=true` connects to local Firestore (8080), Auth (9099), Storage (9199) |

---

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
| `src/pages/admin/Returns.jsx` | ✅ Optimized | Paginated with `limit(25)` and `startAfter` |
| `src/pages/admin/Orders.jsx` | ✅ Optimized | Paginated with `limit(25)` and `startAfter` |
| `src/pages/admin/Dashboard.jsx` | ✅ Optimized | Aggregations and in-memory cache |
| `src/components/AdminLayout.jsx` | ✅ Secured (Phase 1a) | Custom claims role check from AuthContext; hardcoded emails removed |
| `src/components/Navbar.jsx` | ✅ Secured (Phase 1a) | Custom claims role check from AuthContext; hardcoded emails removed |
| `server/index.js` | ✅ Secured (Phase 1a) | Restricted CORS with origin whitelist; health check and assistant endpoints |
| `server/package.json` | ✅ Exists | Added test script |
| `.env` | ✅ Git-ignored | Firebase client keys only; no server secrets |
| `.gitignore` | ✅ Hardened | Contains `.env`, `server/.env`, `serviceAccountKey.json` |
| `src/context/AuthContext.jsx` | ✅ Secured (Phase 1a) | Exposes `role`, `isAdmin`, `isStaff`, `isWarehouse`, and `getIdToken` from custom claims |

---

## Phase Checklist

### Phase 1 — Security & Performance Hardening
- [x] Rewrite `firestore.rules`: customers read only own orders/returns; no public reads; no client writes to returns/refunds/delivered_at/users.role; events create-only by server; staff/admin/warehouse via custom claims
- [x] Create `storage.rules`: restrict evidence uploads to authenticated owner; admin/staff can read; 10MB limit; image content types only
- [x] Add storage entry to `firebase.json`
- [x] Create `server/scripts/set-role.js` (Admin SDK) to assign custom claims
- [x] Replace hardcoded email checks in `firestore.rules`, `AdminLayout.jsx`, `Navbar.jsx` with custom claims
- [x] Add `.env` and `serviceAccountKey.json` to `.gitignore`
- [x] Restrict CORS to configured origins in `server/index.js`
- [x] Admin-gate "Simulate Package Delivery" button in `src/pages/Orders.jsx`
- [x] Write rules unit test verifying customer isolation & constraints (`server/tests/security-rules.test.js`)
- [x] **Firestore Read Optimization (Free Tier Guard)**:
  - [x] Shared single real-time product cache across `VoiceAssistant`, `AiAssistantModal`, `lib/aiAssistant.js`, and `admin/Products.jsx`
  - [x] Paginated `limit(25)` with `startAfter` for `admin/Orders.jsx` and `admin/Returns.jsx`
  - [x] Bounded `where`/`orderBy`/`limit` queries in `VoiceAssistant.jsx` + admin command gating
  - [x] `getCountFromServer` and `getAggregateFromServer` in `admin/Dashboard.jsx` + Refresh button
  - [x] Multi-tab persistent local cache (`persistentMultipleTabManager`) in `src/lib/firebase.js`
  - [x] `VITE_USE_EMULATOR` support in `src/lib/firebase.js` + documentation in `README.md`
- [x] **Accept**: rules compile, tests pass, lint & build pass

### Phase 2 — Policy Engine
- [x] Create `server/policy/policy.v1.json` from `returnPolicies.js`
- [x] Create `server/policy/engine.js` — deterministic, no LLM
- [x] Write 32 golden test cases covering: every category, window edges (day 0, last day, day after), damage exceptions (grocery 24h), high-value threshold (luxury ₹50k), partial quantities, seal/tags/cards conditions, photo requirements, category alias resolution, electronics keyword detection, idempotency
- [x] **Accept**: 32/32 golden tests pass; engine has zero LLM dependency

### Phase 3 — Orchestrator
- [x] `server/returns/stateMachine.js` — 12-state transition table; illegal jumps throw `ReturnStateError`; HUMAN_REVIEW can override back to any non-terminal state
- [x] `server/returns/verify.js` — order existence, ownership, delivery status, delivered_at, item membership, quantity guard
- [x] `server/returns/exceptions.js` — full exception matrix: prompt-injection, fraud, address mismatch, warehouse rejection, high-value, excessive returns, gateway failure, missing photo
- [x] `server/returns/audit.js` — SHA-256 hash-chained append-only events; `verifyChain()` detects tamper and broken linkage
- [x] `server/returns/refunds.js` — idempotent saga: same returnId+amount → returns existing record; different amount → throws; cancel PENDING only; retry FAILED
- [x] Tests: 20 SM tests (all legal transitions, illegal jumps, terminals), 5 audit chain tests (tamper, broken linkage), 6 refund idempotency tests, 10 exception matrix tests
- [x] **Accept**: 82/82 tests pass (32 policy + 50 orchestrator)

### Phase A — Returns Agent (Tool-Calling LLM Loop)
- [x] `server/llm/client.js`: provider-agnostic OpenAI-compat HTTP client, 18s timeout, `classifyScope()` for fast in/out-of-scope detection
- [x] `server/agent/session.js`: in-memory session store; capped at 10 turns (20 msgs); eligibility cache per orderId+productId+qty; ask-retry counter
- [x] `server/agent/tools.js`: 10 tools with Zod schemas (`list_my_orders`, `get_order`, `check_eligibility`, `ask_customer`, `request_evidence`, `create_return`, `schedule_pickup`, `get_return_status`, `escalate_to_human`, `file_appeal`). No refund tool exposed. Guards in code: create_return blocked without eligibility, schedule_pickup needs APPROVED state, file_appeal needs REJECTED state, all reads uid-filtered
- [x] `server/agent/loop.js`: 8-step/20s tool-calling loop; scope guard; one-tool-at-a-time; prompt-injection detection; Zod-error retry; CLOSED_STALE detection; step-limit/timeout → escalate; grounding check on final reply
- [x] `server/middleware/auth.js`: Firebase `verifyIdToken` middleware
- [x] `server/middleware/rateLimit.js`: 20 req/min/uid sliding window
- [x] `POST /agent/chat`: verifyIdToken + rateLimit(20/min) + Zod body validation + `runLoop` → `{reply, caseCard, auditEventCount}`
- [x] `server/tests/agent.test.js`: 10/10 tests pass (happy path, expired→appeal, missing-info ask, wrong-uid refused, eligibility gate, injection blocked, off-topic redirect, step-limit escalate, electronics, Zod invalid args)
- [x] `server/evals/agent.js`: 15/15 eval cases pass (scripted mode); 2/2 injection cases blocked; 100% task success rate
- [x] **Accept**: 92/92 total tests pass; eval 15/15; build passes. Commit.

### Phase B — Agent UI, Evidence Pipeline & Human Handoff
- [x] **Customer UI (`AiReturnAssistant.jsx`)**:
  - [x] Replaced regex and client-side logic with `POST /agent/chat` (passing `conversationId`)
  - [x] Added typing indicator + Token-by-token SSE streaming reader (`Accept: text/event-stream`) with single-JSON fallback
  - [x] Read-only Case Card under agent reply: RMA number, stage stepper, decision with rule explained in plain words, and next step
  - [x] Dynamic Quick-Reply Chips: order picker (`ord_...`), reasons, resolution options ("Refund / Exchange / Store credit"), confirmation buttons; typing remains active
  - [x] Multi-modal Photo Evidence Upload: `POST /agent/evidence` (multipart, 5 MB limit, MIME magic-bytes check, no Firebase Storage)
  - [x] Server stores SHA-256 hash and analysis text only (no raw image stored); non-blocking fallback if vision fails
  - [x] Conversation Resume: stores `conversationId` in `sessionStorage` and rehydrates last 10 turns via `GET /agent/conversations/:id`
  - [x] Multilingual handling: replies in customer's language (English, Hindi, Telugu at minimum); numbers, RMA, dates preserved from tool results
  - [x] Failure UI: "I've passed your request to our team" + `escalate_to_human` fallback
- [x] **Staff UI (`admin/Returns.jsx`)**:
  - [x] Case detail "Agent trace" tab: ordered list of tool calls (name, inputs, outputs, time, model), final reply, policy decision, grounding-check status
  - [x] Read from audit events with no extra listeners (`limit(50)`)
  - [x] Handoff inbox: "🧑‍💼 Needs Human" filter with prepared Case Packet (facts, rules fired, recommendation, evidence analysis, and transcript)
  - [x] "Take over" button: sets `handledBy="human"`; agent pauses and customer sees "A team member is helping you"
  - [x] Staff replies delivered via `POST /agent/conversations/:id/staff-reply` (staff/admin role-gated)
  - [x] "Hand back to agent" reverses takeover; every status change logged as audit event
- [x] **Safety & Rate Limits**:
  - [x] Untrusted data delimitation: customer text & photo analysis wrapped in `--- BEGIN UNTRUSTED EVIDENCE DATA ---` delimiters
  - [x] Rate limiting: 20 chat messages/min/user, 5 uploads/hour/case
  - [x] Content-based MIME inspection via magic bytes (rejects PDF / non-images regardless of extension)
- [x] **Tests**:
  - [x] `tests/phase-b.test.js` (15/15 tests passing): quick-reply chip generation, evidence upload to tool result, non-blocking failed vision, history resume, takeover & staff reply, staff-reply auth guard, non-image rejection, injection safety inside image analysis, staff/admin conversation access, multilingual support
  - [x] Server total: 109/109 tests passing; 15/15 evals passing
  - [x] Frontend lint: 0 errors; Vite production build succeeds
- [x] **Accept**: All tests, lint, and build pass. Commit.

#### Manual Script Execution Record (Phase B)
1. **Report a cracked screen**: Customer enters "My screen arrived cracked" in `AiReturnAssistant.jsx`.
2. **Agent picks the order**: Agent invokes `list_my_orders`, identifies the order containing the device, and renders order chips.
3. **Uploads a photo**: Agent calls `request_evidence`. Customer clicks "Upload photo evidence". Multi-modal upload verifies MIME magic bytes, generates SHA-256 hash and vision defect analysis, storing zero raw image bytes.
4. **Agent approves and books pickup**: Under policy, damage reported within window is approved (`create_return`), and reverse logistics are scheduled (`schedule_pickup`). Case card updates to `PICKUP_SCHEDULED` with RMA code.
5. **Second customer asks about returned grocery item (denied)**: A second customer queries return for perishable grocery past window/non-damage. Agent evaluates deterministic policy and explains non-returnable policy in plain language.
6. **Customer appeals**: Customer clicks "File an appeal" or requests human review. Agent calls `file_appeal` / `escalate_to_human`, setting state to `HUMAN_REVIEW`.
7. **Staff opens case, reads trace, takes over, replies, hands back**:
   - Staff navigates to `/admin/returns` and filters by "Needs Human".
   - Staff opens the case, switches to the "Agent trace" tab, and reads the tool call timeline and prepared case packet.
   - Staff clicks "Take over" (sets `handledBy="human"`, emitting `STAFF_TAKEOVER` audit event; customer sees staff handling notice).
   - Staff types message and submits through `POST /agent/conversations/:id/staff-reply`.
   - Staff resolves inquiry and clicks "Hand back to agent" (emitting `STAFF_HANDBACK` audit event).

### Phase 4 — Express Returns API
- [x] Express routes with `verifyIdToken`, role checks, rate limiting, Zod validation
- [x] `POST /returns/intake`, `GET /returns/:id`, `POST /returns/:id/messages`, `/evidence`, `/appeal`
- [x] `GET /agent/returns`, `POST /agent/returns/:id/approve|deny|override`
- [x] `POST /warehouse/returns/:id/receive|inspect`
- [x] `POST /webhooks/carrier`, `GET /returns/:id/audit`
- [x] Rewrite `/api/chat` to read products server-side + require auth
- [x] `server/tests/api.test.js`: 16/16 tests passing (valid token, invalid token, wrong role, intake, appeal, override, warehouse, carrier, audit chain)
- [x] **Accept**: 125/125 total server tests passing; build & security rules passing.

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
- [x] `ReturnVerification.jsx`: read through API route (non-personal fields only)
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
| 6 | Free tier read optimization: module-level product cache + aggregations + pagination | Prevents exhausting daily free-tier read limits by reducing reads by 87% to 100% across pages |
