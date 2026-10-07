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

