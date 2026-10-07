/**
 * Job Scheduler — PS-01 Phase C2
 *
 * Started only when ENABLE_JOBS=1.
 * Uses node-cron for scheduling.
 *
 * Schedules:
 *   closeStale   — runs every hour  (0 * * * *)
 *   pollCarrier  — runs every 15 min (*/15 * * * *)
 *
 * Usage:
 *   import { startJobs } from './jobs/scheduler.js';
 *   if (process.env.ENABLE_JOBS === '1') startJobs(db);
 */

import { closeStaleReturns } from './closeStale.js';
import { pollCarrier } from './pollCarrier.js';

let _cron = null;

/**
 * Lazily import node-cron so the module doesn't crash when the package is
 * absent in test/dev environments where ENABLE_JOBS is 0.
 */
async function getCron() {
  if (_cron) return _cron;
  try {
    const mod = await import('node-cron');
    _cron = mod.default || mod;
    return _cron;
  } catch {
    throw new Error(
      'node-cron is not installed. Run: npm install node-cron\n' +
      'Jobs require ENABLE_JOBS=1 and node-cron to be present.'
    );
  }
}

const _scheduledTasks = [];

/**
 * Start all background jobs.
 * @param {object|null} db – Firestore Admin SDK instance (or null)
 */
export async function startJobs(db) {
  const cron = await getCron();

  // Close stale HUMAN_REVIEW returns every hour
  const staleJob = cron.schedule('0 * * * *', async () => {
    try {
      const result = await closeStaleReturns(db);
      if (result.closed.length > 0 || result.errors.length > 0) {
        console.log('[jobs/closeStale]', JSON.stringify(result));
      }
    } catch (err) {
      console.error('[jobs/closeStale] uncaught error:', err.message);
    }
  });

  // Poll carrier for IN_TRANSIT returns every 15 minutes
  const pollJob = cron.schedule('*/15 * * * *', async () => {
    try {
      const result = await pollCarrier(db);
      if (result.advanced.length > 0 || result.errors.length > 0) {
        console.log('[jobs/pollCarrier]', JSON.stringify(result));
      }
    } catch (err) {
      console.error('[jobs/pollCarrier] uncaught error:', err.message);
    }
  });

  _scheduledTasks.push(staleJob, pollJob);
  console.log('[scheduler] Jobs started: closeStale (hourly), pollCarrier (every 15 min)');
}

/**
 * Stop all scheduled tasks (useful for graceful shutdown).
 */
export function stopJobs() {
  for (const task of _scheduledTasks) {
    try { task.stop(); } catch { /* ignore */ }
  }
  _scheduledTasks.length = 0;
  console.log('[scheduler] All jobs stopped');
}
