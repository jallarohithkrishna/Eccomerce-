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

> ⚠️ **Default Execution:** By default, running `node server/evals/agent.js` executes against a **deterministic fake / scripted mock model** (`deterministic-eval-mock`) with in-memory state. This allows fast, zero-cost, fully offline evaluation during development and CI.

The evaluation runner tests 38 scenarios (30 customer conversations + 8 direct attack prompts) across six scenario categories. Comprehensive evaluation report is saved to `server/evals/report.md` and individual conversation transcripts are stored under `server/evals/transcripts/`.

Metrics reported: task success rate, wrong-tool rate, blocked unsafe calls (13/13: 5 prompt injections + 8 red-team prompts), false-approval rate, escalation correctness, avg steps, and latency (avg / p95 / min / max).

### How to run the live eval with a real model

To run the evaluation suite against a **live real LLM API** (such as OpenAI, Groq, Together, or any OpenAI-compatible provider):

#### 1. Configure Environment Variables

Set the following environment variables in your `.env` file or export them in your shell:

| Variable | Required? | Description | Example |
|:---|:---|:---|:---|
| `LLM_API_KEY` | **Yes** | API key for your LLM provider | `sk-proj-...` |
| `LLM_MODEL` | Optional | Primary model to evaluate (default: `gpt-4o-mini`) | `gpt-4o-mini` or `groq/llama-3.1-70b-versatile` |
| `LLM_BASE_URL` | Optional | Provider endpoint (default: `https://api.openai.com/v1`) | `https://api.groq.com/openai/v1` |
| `EVAL_MAX_CALLS` | Optional | Hard safety cap on live LLM calls (default: `120`) | `120` |
| `LLM_FALLBACK_MODEL` | Optional | Full provider ID for secondary model (*no default*) | `openai/gpt-3.5-turbo` |

**Linux / macOS:**
```bash
export LLM_API_KEY="your_api_key_here"
export LLM_MODEL="gpt-4o-mini"
export EVAL_MAX_CALLS="120"
node server/evals/agent.js
```

**Windows (PowerShell):**
```powershell
$env:LLM_API_KEY="your_api_key_here"
$env:LLM_MODEL="gpt-4o-mini"
$env:EVAL_MAX_CALLS="120"
node server/evals/agent.js
```

#### 2. Cost and Token Estimation

For a full evaluation run of all 38 scenarios:

- **Total Test Cases**: 38 scenarios (30 multi-turn customer dialogues + 8 attack prompts)
- **Model Probe**: 1 startup call testing function/tool calling support
- **Average Turns per Case**: ~1.8 turns (ranging from 1 to 4 steps)
- **Total LLM Calls**: ~55 to 80 calls per full run (safeguarded by `EVAL_MAX_CALLS=120`)
- **Prompt Tokens per Call**: ~550 – 750 tokens (system instructions, conversation history, and tool definitions)
- **Completion Tokens per Call**: ~40 – 120 tokens (structured tool calls or final customer replies)
- **Total Token Volume**:
  - Prompt tokens: ~30,000 – 50,000 tokens
  - Completion tokens: ~3,000 – 8,000 tokens
  - Combined tokens: ~35,000 – 60,000 tokens
- **Estimated Cost per Run**:
  - **OpenAI `gpt-4o-mini`** ($0.15/1M prompt, $0.60/1M completion): **~$0.008 to $0.015 USD (< 2 cents)**
  - **Groq `llama-3.1-8b-instant`** ($0.05/1M prompt, $0.08/1M completion): **~$0.002 to $0.004 USD (< 1 cent)**
  - **OpenAI `gpt-4o`** ($2.50/1M prompt, $10.00/1M completion): **~$0.12 to $0.20 USD (~15-20 cents)**

