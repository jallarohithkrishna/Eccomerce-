/**
 * Agent Metrics Store — PS-01 Phase C4
 * 
 * Aggregates runtime telemetry into a SINGLE Firestore document:
 * Collection: `system_metrics`
 * Document:   `agent_counters`
 * 
 * Tracks:
 * - Latency (avg, min, max, total, last)
 * - Tool-call counts (per tool and total)
 * - Escalations count
 * - Blocked calls (prompt injections, unauthorized attempts, daily cap hits)
 * - Model used (active model + distribution)
 * - Open alerts count
 * 
 * No whole-collection scans: single-doc reads/writes only.
 */

import { listAlerts } from '../returns/store.js';

const DEFAULT_COUNTERS = {
  id: 'agent_counters',
  totalRuns: 0,
  latency: {
    avgMs: 0,
    totalMs: 0,
    minMs: 0,
    maxMs: 0,
    count: 0,
    lastMs: 0,
  },
  toolCallCounts: {
    list_my_orders: 0,
    get_order: 0,
    check_eligibility: 0,
    ask_customer: 0,
    request_evidence: 0,
    create_return: 0,
    schedule_pickup: 0,
    get_return_status: 0,
    escalate_to_human: 0,
    file_appeal: 0,
    _total: 0,
  },
  escalations: 0,
  blockedCalls: 0,
  modelUsed: process.env.LLM_MODEL || 'gpt-4o-mini',
  models: {},
  alertsOpen: 0,
  updatedAt: new Date().toISOString(),
};

// In-memory singleton mirror for fast reads & zero-DB tests
let memoryCounters = { ...DEFAULT_COUNTERS, latency: { ...DEFAULT_COUNTERS.latency }, toolCallCounts: { ...DEFAULT_COUNTERS.toolCallCounts }, models: {} };

/**
 * Record a completed agent run into the single metrics document.
 */
export async function recordAgentRun({
  db = null,
  conversationId,
  latencyMs = 0,
  toolCalls = [],
  escalated = false,
  blocked = false,
  model = null,
} = {}) {
  const modelName = model || process.env.LLM_MODEL || 'gpt-4o-mini';
  const now = new Date().toISOString();

  // Update in-memory counters
  memoryCounters.totalRuns += 1;
  memoryCounters.updatedAt = now;
  memoryCounters.modelUsed = modelName;
  memoryCounters.models[modelName] = (memoryCounters.models[modelName] || 0) + 1;

  // Latency tracking
  const lat = memoryCounters.latency;
  lat.count += 1;
  lat.totalMs += latencyMs;
  lat.lastMs = latencyMs;
  lat.minMs = lat.minMs === 0 ? latencyMs : Math.min(lat.minMs, latencyMs);
  lat.maxMs = Math.max(lat.maxMs, latencyMs);
  lat.avgMs = Math.round(lat.totalMs / lat.count);

  // Tool calls tracking
  for (const name of toolCalls) {
    const key = name.toLowerCase();
    memoryCounters.toolCallCounts[key] = (memoryCounters.toolCallCounts[key] || 0) + 1;
    memoryCounters.toolCallCounts._total += 1;
  }

  if (escalated) {
    memoryCounters.escalations += 1;
  }

  if (blocked) {
    memoryCounters.blockedCalls += 1;
  }

  // Sync to Firestore if db provided
  if (db) {
    try {
      await db.collection('system_metrics').doc('agent_counters').set(memoryCounters, { merge: true });
    } catch (err) {
      console.warn('Failed to sync agent metrics to Firestore:', err.message);
    }
  }

  return memoryCounters;
}

/**
 * Get the latest counters from the single document (or in-memory fallback).
 */
export async function getMetrics({ db = null } = {}) {
  // If DB provided, attempt single document fetch
  if (db) {
    try {
      const doc = await db.collection('system_metrics').doc('agent_counters').get();
      if (doc.exists) {
        memoryCounters = { ...memoryCounters, ...doc.data() };
      }
    } catch (err) {
      console.warn('Failed to read agent_counters doc from Firestore:', err.message);
    }
  }

  // Count open alerts (bounded to 100 alerts max, no full scans)
  let openAlertsCount = 0;
  try {
    const alerts = await listAlerts({ db, limitN: 100 });
    openAlertsCount = alerts.filter(a => a.status === 'OPEN').length;
  } catch {
    openAlertsCount = 0;
  }

  memoryCounters.alertsOpen = openAlertsCount;
  return { ...memoryCounters };
}

/**
 * Query recent agent runs bounded by limit 50 (No whole-collection reads).
 */
export async function listAgentRuns({ db = null, limitN = 50 } = {}) {
  const boundedLimit = Math.max(1, Math.min(Number(limitN) || 50, 50));

  if (db) {
    try {
      const snap = await db.collection('agent_conversations')
        .orderBy('updatedAt', 'desc')
        .limit(boundedLimit)
        .get();
      return snap.docs.map(d => formatRunSummary(d.id, d.data()));
    } catch {
      // Fall through to in-memory store
    }
  }

  // Fallback to in-memory conversation store
  const { _get, _getAll } = await import('./conversations.js').then(m => ({
    _get: m._get,
    _getAll: m._getAll || (() => []),
  }));

  const all = _getAll ? _getAll() : [];
  return all
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, boundedLimit)
    .map(c => formatRunSummary(c.conversationId, c));
}

function formatRunSummary(id, data = {}) {
  const auditEvents = data.auditEvents || [];
  const toolEvents = auditEvents.filter(e => e.actor === 'agent' && e.action !== 'PROMPT_INJECTION_DETECTED' && e.action !== 'ESCALATE_TO_HUMAN');
  const escalated = auditEvents.some(e => e.action === 'ESCALATE_TO_HUMAN') || data.caseCard?.state === 'HUMAN_REVIEW';
  const blocked = auditEvents.some(e => e.action === 'PROMPT_INJECTION_DETECTED' || e.action === 'DAILY_CAP_EXCEEDED');

  return {
    conversationId: id,
    uid: data.uid || 'anonymous',
    createdAt: data.createdAt || data.updatedAt || new Date().toISOString(),
    updatedAt: data.updatedAt || new Date().toISOString(),
    caseCard: data.caseCard || {},
    handledBy: data.handledBy || null,
    messagesCount: (data.messages || []).length,
    toolCallsCount: toolEvents.length,
    toolNames: toolEvents.map(e => e.action),
    escalated,
    blocked,
    status: escalated ? 'ESCALATED' : blocked ? 'BLOCKED' : data.caseCard?.state || 'COMPLETED',
    auditEvents,
    messages: data.messages || [],
  };
}

/** Test helper */
export function _resetMetrics() {
  memoryCounters = {
    ...DEFAULT_COUNTERS,
    latency: { ...DEFAULT_COUNTERS.latency },
    toolCallCounts: { ...DEFAULT_COUNTERS.toolCallCounts },
    models: {},
  };
}
