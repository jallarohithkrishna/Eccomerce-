/**
 * Job Scheduler — PS-01 Phase C2
 *
 * Started only when ENABLE_JOBS=1.
 * Uses node-cron for scheduling.
 *
 * Schedules:
 *   closeStale          — runs every hour     (0 * * * *)
 *   pollCarrier         — runs every 15 min   (星/15 * * * *)
 *   pickupSla           — runs every 30 min   (星/30 * * * *)
 *   warehouseReceiptSla — runs every 2 hours  (0 */2 * * * *)
 *   retryRefunds        — runs every 5 min    (星/5 * * * *)
 *
 * Safety:
 *   Logs a prominent warning if ENABLE_JOBS=1 is set without FIRESTORE_EMULATOR_HOST.
 */

import { closeStaleReturns } from './closeStale.js';
import { pollCarrier } from './pollCarrier.js';
import { checkPickupSla } from './pickupSla.js';
import { checkWarehouseReceiptSla } from './warehouseReceiptSla.js';
import { retryRefunds } from './retryRefunds.js';

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
  if (process.env.ENABLE_JOBS !== '1') {
    return;
  }

  // Live quota guard warning
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    console.warn(
      '[WARNING] ENABLE_JOBS=1 is set without FIRESTORE_EMULATOR_HOST. ' +
      'Scheduled background jobs will consume live Firestore project quota.'
    );
  }

  const cron = await getCron();

  // 1. Close stale NEEDS_INFO returns (>7d) & flag HUMAN_REVIEW SLA (>24h)
  const staleJob = cron.schedule('0 * * * *', async () => {
    try {
      const result = await closeStaleReturns(db);
      if (result.closed.length > 0 || result.alerted.length > 0 || result.errors.length > 0) {
        console.log('[jobs/closeStale]', JSON.stringify(result));
      }
    } catch (err) {
      console.error('[jobs/closeStale] uncaught error:', err.message);
    }
  });

  // 2. Poll mock carrier for IN_TRANSIT returns every 15 minutes
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

  // 3. Monitor pickup SLA breaches (APPROVED >48h or missed slots) every 30 minutes
  const pickupJob = cron.schedule('*/30 * * * *', async () => {
    try {
      const result = await checkPickupSla(db);
      if (result.alerted.length > 0 || result.errors.length > 0) {
        console.log('[jobs/pickupSla]', JSON.stringify(result));
      }
    } catch (err) {
      console.error('[jobs/pickupSla] uncaught error:', err.message);
    }
  });

  // 4. Monitor warehouse transit receipt SLA (IN_TRANSIT >7d) every 2 hours
  const transitJob = cron.schedule('0 */2 * * *', async () => {
    try {
      const result = await checkWarehouseReceiptSla(db);
      if (result.escalated.length > 0 || result.errors.length > 0) {
        console.log('[jobs/warehouseReceiptSla]', JSON.stringify(result));
      }
    } catch (err) {
      console.error('[jobs/warehouseReceiptSla] uncaught error:', err.message);
    }
  });

  // 5. Retry failed refunds with backoff every 5 minutes
  const refundRetryJob = cron.schedule('*/5 * * * *', async () => {
    try {
      const result = await retryRefunds(db);
      if (result.retried.length > 0 || result.succeeded.length > 0 || result.escalated.length > 0 || result.errors.length > 0) {
        console.log('[jobs/retryRefunds]', JSON.stringify(result));
      }
    } catch (err) {
      console.error('[jobs/retryRefunds] uncaught error:', err.message);
    }
  });

  _scheduledTasks.push(staleJob, pollJob, pickupJob, transitJob, refundRetryJob);
  console.log('[scheduler] Background jobs started: closeStale, pollCarrier, pickupSla, warehouseReceiptSla, retryRefunds');
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
