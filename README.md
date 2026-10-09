# Nova Store — Autonomous Product Return Resolution Agent (PS-01)

## Local Development with Firebase Emulator Suite

To run the application locally without incurring Firestore reads on the free tier:

1. **Install Firebase CLI** (if not already installed):
   ```bash
   npm install -g firebase-tools
   ```

2. **Start the Firebase Emulators**:
   ```bash
   firebase emulators:start --only auth,firestore,storage
   ```

3. **Configure Environment**:
   In your `.env` file, set:
   ```env
   VITE_USE_EMULATOR=true
   ```

4. **Start the Frontend Dev Server**:
   ```bash
   npm run dev
   ```

When `VITE_USE_EMULATOR=true` is set, the frontend automatically routes all Auth, Firestore, and Storage requests to `localhost:9099`, `localhost:8080`, and `localhost:9199`.

## Background Schedulers & Jobs (Phase C2)

Background automation jobs run via `node-cron` and are activated only when `ENABLE_JOBS=1` is set:

- **`closeStale`**: Hourly job closing inactive `NEEDS_INFO` cases past 7 days to `CLOSED_STALE` with customer notification; flags 24-hour SLA breaches for `HUMAN_REVIEW` with staff alerts (never auto-closes).
- **`pickupSla`**: Every 30 minutes, checks for `APPROVED` cases without pickup scheduled (>48h) or missed pickup slots, creating staff alerts.
- **`warehouseReceiptSla`**: Every 2 hours, detects `IN_TRANSIT` cases delayed past 7 days and escalates them to `HUMAN_REVIEW` with "trace needed".
- **`retryRefunds`**: Every 5 minutes, retries `REFUND_FAILED` cases using exponential backoff (1m, 5m, 30m) up to 3 attempts before escalating to `HUMAN_REVIEW`.
- **`pollCarrier` (MOCK)**: Every 15 minutes, polls mock carrier API for package delivery status (tagged `[MOCK_CARRIER]`), advancing `IN_TRANSIT` to `RECEIVED` strictly via the state machine.

## Agent Hardening (Phase C3)

### LLM Configuration (env-only, no keys in code or logs)

| Variable | Default | Description |
|:---|:---|:---|
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint URL |
| `LLM_MODEL` | `gpt-4o-mini` | Primary model for tool-calling |
| `LLM_FALLBACK_MODEL` | *(none / unset)* | Fallback model activated after repeated 429/5xx failures on primary model. **Has no default.** If unset, only the scripted fallback runs and a startup warning is logged. When configured, specify a full provider ID (e.g. `vendor/model` such as `openai/gpt-3.5-turbo` or `groq/llama-3.1-8b-instant`). |
| `LLM_API_KEY` | *(required in prod)* | API key — never logged or exposed in error messages |
| `LLM_TIMEOUT_MS` | `18000` | Per-call HTTP timeout in milliseconds |
| `AGENT_DAILY_CAP` | `40` | Per-user daily message cap (counted in memory per uid/day). When exceeded, the agent calls `escalate_to_human` with the conversation transcript and returns a scripted fallback reply. |
| `EVAL_MAX_CALLS` | `120` | Maximum LLM API calls the live eval runner may make in one run, for cost control. |

### Grounding Check

The agent verifies that every number, date, RMA code, and currency amount in its final reply was present in the current turn's tool results. Any hallucinated value causes the reply to be replaced with a safe template built from actual tool data.

### Guard-Level Red-Team (deterministic, in `npm test`)

`server/tests/redteam.test.js` contains 15 deterministic attack scenarios (no LLM needed) covering:
- Unauthorized tool invocations (refund, cross-user, unapproved state transitions)
- Prompt injection strings in tool arguments and evidence metadata
- Oversized payloads (>100 KB) and deeply nested argument structures
- Loop exhaustion / DoS (50 tool-call repetitions)
- Staff role impersonation and state machine bypass

All 15 attacks are blocked and printed as a pass table.

### Live Eval

```bash
node server/evals/agent.js
```

Runs 38 scripted scenarios (30 customer conversations + 8 attack prompts) across six categories. Report saved to `server/evals/report.md`. Supports `EVAL_MAX_CALLS` cap and real LLM when `LLM_API_KEY` is set.

Metrics reported: task success rate, wrong-tool rate, blocked unsafe calls, false-approval rate, escalation correctness, avg steps, latency (avg / p95 / min / max).
