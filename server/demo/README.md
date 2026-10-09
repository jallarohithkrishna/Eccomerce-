# Nova Store (PS-01) — Demo Scenarios Guide

This directory contains standalone, runnable end-to-end demo scripts demonstrating all six core scenarios required for Phase C4.

Each script can be run independently or all together via the demo runner:

```bash
# Run all 6 scenarios sequentially
node server/demo/run-all.js
```

---

## Scenario A: Defective Fashion Item Within Return Window

**Goal:** Demonstrates automated policy validation, instant auto-approval, carrier booking, warehouse inspection, and automated refund dispatch.

- **Script:** `node server/demo/scenario-a-defective-fashion.js`
- **Target Order:** `ORD-FASHION-DEFECTIVE-IN-WIN` (delivered 2 days ago, 14-day window)
- **Item:** Slim Fit Cotton Shirt (₹1,499)
- **Step-by-step Flow:**
  1. **Policy Evaluation:** Delivered 2 days ago ≤ 14 days, tags intact, defect claimed $\rightarrow$ Evaluated as `ELIGIBLE` (`full_refund_or_exchange`).
  2. **Auto-Approval:** Return case created in `APPROVED` state with cryptographically unique RMA issued.
  3. **Carrier reverse label:** Carrier service generates return label & books pickup slot (`SCHEDULE_PICKUP` $\rightarrow$ `PICKUP_SCHEDULED`).
  4. **Transit Scan:** Mock courier scans barcode upon pickup (`PICKUP_COMPLETE` $\rightarrow$ `IN_TRANSIT`).
  5. **Warehouse Intake:** Warehouse receives item (`RECEIVE` $\rightarrow$ `RECEIVED`) and conducts inspection (`INSPECT` $\rightarrow$ `INSPECTING`).
  6. **Automated Refund:** Payment service issues refund for ₹1,499 (`REFUND_SUCCESS` $\rightarrow$ `REFUNDED`).
  7. **Customer Notified:** In-app update & email dispatched.

---

## Scenario B: Outside Return Window then Customer Appeal

**Goal:** Demonstrates strict window enforcement, denial with appeal pathway, customer appeal submission, and routing to staff review.

- **Script:** `node server/demo/scenario-b-outside-window-appeal.js`
- **Target Order:** `ORD-FASHION-EXPIRED` (delivered 35 days ago, 14-day window)
- **Item:** Vintage Wash Denim Jacket (₹3,499)
- **Step-by-step Flow:**
  1. **Policy Check:** Delivered 35 days ago > 14-day limit $\rightarrow$ `WINDOW_EXPIRED` (`eligible: false`).
  2. **Denial:** Return created in `REJECTED` state. Customer notified of policy limits and allowed appeal window.
  3. **Customer Appeal:** Customer submits an appeal citing extenuating medical hospitalization delay (`APPEAL` $\rightarrow$ `APPEALED`).
  4. **Human Review Escalation:** System escalates appealed case to staff review queue (`ESCALATE` $\rightarrow$ `HUMAN_REVIEW`).
  5. **Audit Chain:** Complete appeal reason and timestamp chained in tamper-evident audit log.

---

## Scenario C: Missing Photo Evidence Request & Resumption

**Goal:** Demonstrates hygiene/beauty category policy requiring photo proof, transition to `NEEDS_INFO`, evidence ingestion, and approval resumption.

- **Script:** `node server/demo/scenario-c-missing-photo.js`
- **Target Order:** `ORD-BEAUTY-IN-WIN` (delivered 3 days ago, 7-day window)
- **Item:** Vitamin C Radiance Face Serum (₹999)
- **Step-by-step Flow:**
  1. **Initial Claim:** Customer claims leaked cap, but provides no photo.
  2. **Evidence Gate:** Policy engine evaluates `requires_photo_evidence: true` $\rightarrow$ denies immediate auto-approval.
  3. **Evidence Request:** Case placed in `NEEDS_INFO`. Agent asks customer for clear photo of broken seal.
  4. **Customer Upload:** Customer uploads photo evidence. Vision analysis verifies image authenticity.
  5. **Resumption & Approval:** Case resumes from `NEEDS_INFO` $\rightarrow$ transitions to `APPROVED` for replacement dispatch.

---

## Scenario D: Luxury Item at ₹60,000 High-Value Human Review

**Goal:** Demonstrates high-value threshold enforcement ($>\text{₹}50,000$), prevention of instant auto-approval, and compilation of a case packet.

- **Script:** `node server/demo/scenario-d-luxury-human-review.js`
- **Target Order:** `ORD-LUX-60K-HUMAN-REVIEW` (delivered 2 days ago)
- **Item:** Heritage Chronograph Luxury Watch (₹60,000)
- **Step-by-step Flow:**
  1. **High-Value Detection:** Price (₹60,000) exceeds category threshold (₹50,000) $\rightarrow$ `requiresHumanReview: true`. Auto-approval strictly forbidden.
  2. **Case Packet Compilation:** System prepares case packet with authenticity card verification requirement, packaging check, serial tracking, and fraud score.
  3. **State Transition:** Direct transition to `HUMAN_REVIEW`.
  4. **Staff Alert:** Priority notification flagged on staff dashboard (`/admin/returns`). Customer informed of specialist white-glove review.

---

## Scenario E: Adversarial Prompt Injection Blocked & Audited

**Goal:** Demonstrates agent scope guardrails, refusal to invoke unexposed or unauthorized tools, zero state corruption, and tamper-evident audit logging.

- **Script:** `node server/demo/scenario-e-prompt-injection.js`
- **Payload:** Multi-vector prompt injection claiming administrator override and demanding immediate refund without return.
- **Step-by-step Flow:**
  1. **Prompt Ingestion:** Adversarial payload sent to Returns Agent.
  2. **Scope Guard & Sandbox:** Returns Agent system prompt rejects administrative bypass; unexposed `refund_customer` tool call is blocked.
  3. **Zero State Corruption:** Session maintains `returnId: null` and zero illegal transitions.
  4. **Tamper Event Chaining:** Security incident hashed with SHA-256 and appended to the immutable audit chain.

---

## Scenario F: Refund Gateway Failure, Exponential Backoff & Alert Queue

**Goal:** Demonstrates payment gateway failure handling, `REFUND_FAILED` state, idempotent backoff retries (1m, 5m, 30m), and escalation to staff alert queue.

- **Script:** `node server/demo/scenario-f-refund-failure-retry.js`
- **Target Order:** `ORD-2026-0008` (passed inspection, state: `INSPECTING`)
- **Step-by-step Flow:**
  1. **Gateway Failure:** Payment service simulates bank gateway network timeout / 502 error (`simulateFailure: true`).
  2. **Failure Transition:** State machine moves case `INSPECTING` $\rightarrow$ `REFUND_FAILED` with unique idempotency key.
  3. **Backoff Retries:** Scheduled `retryRefunds` job checks backoff schedule:
     - Attempt 1: 1-minute backoff
     - Attempt 2: 5-minute backoff
     - Attempt 3: 30-minute backoff (max retries exhausted)
  4. **Alert Escalation:** After 3 attempts fail, job triggers `ESCALATE` $\rightarrow$ `HUMAN_REVIEW` and writes critical alert to `alerts` collection for manual finance bank transfer.
