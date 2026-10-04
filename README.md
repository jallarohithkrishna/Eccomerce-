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
