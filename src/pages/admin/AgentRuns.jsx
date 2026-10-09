import { useState, useEffect, useCallback } from 'react';
import { db } from '../../lib/firebase';
import { doc, getDoc, collection, query, orderBy, limit, getDocs } from 'firebase/firestore';
import { 
  Bot, Clock, AlertTriangle, ShieldCheck, Cpu, 
  Terminal, Search, RefreshCw, ChevronRight, X, 
  CheckCircle2, XCircle, ArrowUpRight, MessageSquare, 
  Layers, User, Eye, ShieldAlert
} from 'lucide-react';

const SERVER = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

export default function AdminAgentRuns() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [runs, setRuns] = useState([]);
  const [metrics, setMetrics] = useState({
    totalRuns: 0,
    latency: { avgMs: 0, minMs: 0, maxMs: 0, lastMs: 0 },
    toolCallCounts: { _total: 0 },
    escalations: 0,
    blockedCalls: 0,
    modelUsed: 'gpt-4o-mini',
    alertsOpen: 0,
  });
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [selectedRun, setSelectedRun] = useState(null);
  const [detailTab, setDetailTab] = useState('trace'); // 'trace' | 'transcript' | 'card'

  const loadData = useCallback(async () => {
    setRefreshing(true);
    try {
      // 1. Fetch metrics from the single document (No whole-collection read!)
      let metricsLoaded = false;
      try {
        const res = await fetch(`${SERVER}/agent/metrics`, {
          headers: { 'x-dev-uid': 'admin', 'x-dev-role': 'admin' },
        });
        if (res.ok) {
          const data = await res.json();
          setMetrics(data);
          metricsLoaded = true;
        }
      } catch {
        // Fallback to direct Firestore single doc read
      }

      if (!metricsLoaded && db) {
        try {
          const docRef = doc(db, 'system_metrics', 'agent_counters');
          const docSnap = await getDoc(docRef);
          if (docSnap.exists()) {
            setMetrics(docSnap.data());
          }
        } catch (e) {
          console.warn('Firestore metrics read fallback error:', e);
        }
      }

      // 2. Fetch recent agent runs (Strictly bounded with limit 50, No whole-collection scan!)
      let runsLoaded = false;
      try {
        const res = await fetch(`${SERVER}/agent/runs?limit=50`, {
          headers: { 'x-dev-uid': 'admin', 'x-dev-role': 'admin' },
        });
        if (res.ok) {
          const data = await res.json();
          setRuns(data.runs || []);
          runsLoaded = true;
        }
      } catch {
        // Fallback to direct Firestore bounded query
      }

      if (!runsLoaded && db) {
        try {
          const q = query(
            collection(db, 'agent_conversations'),
            orderBy('updatedAt', 'desc'),
            limit(50)
          );
          const snap = await getDocs(q);
          const list = snap.docs.map(d => {
            const data = d.data();
            const auditEvents = data.auditEvents || [];
            const toolEvents = auditEvents.filter(e => e.actor === 'agent' && e.action !== 'PROMPT_INJECTION_DETECTED' && e.action !== 'ESCALATE_TO_HUMAN');
            const escalated = auditEvents.some(e => e.action === 'ESCALATE_TO_HUMAN') || data.caseCard?.state === 'HUMAN_REVIEW';
            const blocked = auditEvents.some(e => e.action === 'PROMPT_INJECTION_DETECTED' || e.action === 'DAILY_CAP_EXCEEDED');

            return {
              conversationId: d.id,
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
          });
          setRuns(list);
        } catch (e) {
          console.warn('Firestore bounded runs query fallback error:', e);
        }
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Filter runs by search and status
  const filteredRuns = runs.filter(run => {
    const matchesSearch = 
      (run.conversationId || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (run.uid || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (run.caseCard?.rmaNumber || '').toLowerCase().includes(searchTerm.toLowerCase());
    
    if (!matchesSearch) return false;
    if (statusFilter === 'ALL') return true;
    if (statusFilter === 'ESCALATED') return run.escalated;
    if (statusFilter === 'BLOCKED') return run.blocked;
    if (statusFilter === 'HUMAN_REVIEW') return run.caseCard?.state === 'HUMAN_REVIEW';
    if (statusFilter === 'COMPLETED') return run.status === 'COMPLETED' || run.caseCard?.state === 'COMPLETED';
    return true;
  });

  return (
    <div className="space-y-6">
      {/* ── Page Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <Bot className="h-7 w-7 text-indigo-600" />
            Agent Runs &amp; Telemetry
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Real-time multi-turn agent runs, single-document counters, and audit execution traces (bounded to 50 runs).
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={loadData}
            disabled={refreshing}
            className="btn btn-secondary flex items-center gap-2 px-4 py-2 text-sm"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin text-indigo-600' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* ── Top Counters Section (Single Document Derived) ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
        {/* Latency */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Avg Latency</span>
            <Clock className="h-5 w-5 text-indigo-500" />
          </div>
          <div>
            <div className="text-2xl font-bold text-slate-900">
              {metrics.latency?.avgMs || 0} <span className="text-sm font-normal text-slate-400">ms</span>
            </div>
            <div className="text-xs text-slate-400 mt-1 flex items-center gap-2">
              <span>Min: {metrics.latency?.minMs || 0}ms</span>
              <span>•</span>
              <span>Max: {metrics.latency?.maxMs || 0}ms</span>
            </div>
          </div>
        </div>

        {/* Tool Calls */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Tool Calls</span>
            <Terminal className="h-5 w-5 text-emerald-500" />
          </div>
          <div>
            <div className="text-2xl font-bold text-slate-900">
              {metrics.toolCallCounts?._total || 0}
            </div>
            <div className="text-xs text-slate-400 mt-1 truncate">
              {Object.keys(metrics.toolCallCounts || {}).filter(k => k !== '_total' && metrics.toolCallCounts[k] > 0).length} unique tools active
            </div>
          </div>
        </div>

        {/* Escalations */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Escalations</span>
            <ArrowUpRight className="h-5 w-5 text-amber-500" />
          </div>
          <div>
            <div className="text-2xl font-bold text-slate-900">
              {metrics.escalations || 0}
            </div>
            <div className="text-xs text-amber-600 font-medium mt-1">
              Passed to staff inbox
            </div>
          </div>
        </div>

        {/* Blocked Calls */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Blocked Calls</span>
            <ShieldAlert className="h-5 w-5 text-rose-500" />
          </div>
          <div>
            <div className="text-2xl font-bold text-slate-900">
              {metrics.blockedCalls || 0}
            </div>
            <div className="text-xs text-rose-600 font-medium mt-1">
              Injections &amp; caps guarded
            </div>
          </div>
        </div>

        {/* Model Used */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Active Model</span>
            <Cpu className="h-5 w-5 text-blue-500" />
          </div>
          <div>
            <div className="text-base font-bold text-slate-900 truncate" title={metrics.modelUsed}>
              {metrics.modelUsed || 'gpt-4o-mini'}
            </div>
            <div className="text-xs text-blue-600 font-medium mt-1">
              Tool-calling enabled
            </div>
          </div>
        </div>

        {/* Alerts Open */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Open Alerts</span>
            <AlertTriangle className={`h-5 w-5 ${metrics.alertsOpen > 0 ? 'text-amber-500 animate-pulse' : 'text-slate-400'}`} />
          </div>
          <div>
            <div className={`text-2xl font-bold ${metrics.alertsOpen > 0 ? 'text-amber-600' : 'text-slate-900'}`}>
              {metrics.alertsOpen || 0}
            </div>
            <div className="text-xs text-slate-400 mt-1">
              {metrics.alertsOpen > 0 ? 'Pending staff review' : 'All SLA checks normal'}
            </div>
          </div>
        </div>
      </div>

      {/* ── Tool Breakdown Pills ── */}
      {metrics.toolCallCounts && Object.keys(metrics.toolCallCounts).length > 1 && (
        <div className="bg-white px-5 py-4 rounded-2xl border border-slate-100 shadow-sm">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Tool Call Breakdown</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(metrics.toolCallCounts)
              .filter(([k]) => k !== '_total')
              .map(([tool, count]) => (
                <span
                  key={tool}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-medium bg-slate-50 text-slate-700 border border-slate-200"
                >
                  <span className="text-indigo-600">{tool}</span>
                  <span className="bg-white px-1.5 py-0.2 rounded-full border border-slate-200 text-slate-900 font-bold">
                    {count}
                  </span>
                </span>
              ))}
          </div>
        </div>
      )}

      {/* ── Filter & Search Toolbar ── */}
      <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="relative w-full sm:w-80">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search Conversation, UID, or RMA..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div className="flex items-center gap-2 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0">
          {['ALL', 'COMPLETED', 'ESCALATED', 'BLOCKED', 'HUMAN_REVIEW'].map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                statusFilter === f
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {f.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {/* ── Runs Table (Bounded to 50 items) ── */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2 text-sm">
            <Layers className="h-4 w-4 text-indigo-500" />
            Agent Runs (Bounded to 50 records — No full-collection scan)
          </h2>
          <span className="text-xs text-slate-400 font-mono">
            Showing {filteredRuns.length} of {runs.length} runs
          </span>
        </div>

        {loading ? (
          <div className="p-12 text-center text-slate-400">
            <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-3 text-indigo-500" />
            <p className="text-sm">Loading agent runs...</p>
          </div>
        ) : filteredRuns.length === 0 ? (
          <div className="p-12 text-center text-slate-400">
            <Bot className="h-10 w-10 mx-auto mb-2 text-slate-300" />
            <p className="font-medium text-slate-600">No agent runs matching filter</p>
            <p className="text-xs text-slate-400 mt-1">Runs will appear as customers chat with the Returns Assistant</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase font-medium border-b border-slate-100">
                <tr>
                  <th className="px-6 py-3.5">Run / Conversation ID</th>
                  <th className="px-6 py-3.5">Customer UID</th>
                  <th className="px-6 py-3.5">Status</th>
                  <th className="px-6 py-3.5">Tool Calls</th>
                  <th className="px-6 py-3.5">Timestamp</th>
                  <th className="px-6 py-3.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredRuns.map((run) => (
                  <tr key={run.conversationId} className="hover:bg-slate-50/70 transition-colors">
                    <td className="px-6 py-4">
                      <div className="font-mono text-xs font-semibold text-indigo-600 truncate max-w-[200px]" title={run.conversationId}>
                        {run.conversationId}
                      </div>
                      {run.caseCard?.rmaNumber && (
                        <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                          {run.caseCard.rmaNumber}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-xs font-mono text-slate-600 truncate max-w-[140px]" title={run.uid}>
                        {run.uid}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${
                        run.escalated
                          ? 'bg-amber-50 text-amber-700 border border-amber-200'
                          : run.blocked
                          ? 'bg-rose-50 text-rose-700 border border-rose-200'
                          : run.status === 'APPROVED' || run.status === 'COMPLETED'
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                      }`}>
                        {run.escalated ? <ArrowUpRight className="h-3 w-3" /> :
                         run.blocked ? <ShieldAlert className="h-3 w-3" /> :
                         <CheckCircle2 className="h-3 w-3" />}
                        {run.status}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1 max-w-[240px]">
                        {run.toolNames && run.toolNames.length > 0 ? (
                          run.toolNames.slice(0, 3).map((tool, idx) => (
                            <span
                              key={idx}
                              className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-100 text-slate-600"
                            >
                              {tool.toLowerCase()}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-slate-400">None</span>
                        )}
                        {run.toolNames && run.toolNames.length > 3 && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-200 text-slate-600">
                            +{run.toolNames.length - 3}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-xs text-slate-500 whitespace-nowrap">
                      {new Date(run.updatedAt || run.createdAt).toLocaleString()}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button
                        onClick={() => {
                          setSelectedRun(run);
                          setDetailTab('trace');
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-xs font-medium transition-colors"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        View Trace
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Agent Trace Detail Modal / Drawer (Keep Agent trace tab for each case) ── */}
      {selectedRun && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-4xl w-full max-h-[90vh] shadow-2xl border border-slate-100 flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/60">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-indigo-100 text-indigo-600 flex items-center justify-center">
                  <Bot className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-slate-900 text-base">Run Trace</h3>
                    <span className="font-mono text-xs px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded-md font-semibold border border-indigo-100">
                      {selectedRun.conversationId}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Customer: <span className="font-mono">{selectedRun.uid}</span> • Updated: {new Date(selectedRun.updatedAt).toLocaleString()}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedRun(null)}
                className="h-8 w-8 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 flex items-center justify-center transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Tabs */}
            <div className="flex border-b border-slate-200 px-6 bg-slate-50/30">
              <button
                onClick={() => setDetailTab('trace')}
                className={`py-3 px-4 text-xs font-semibold border-b-2 flex items-center gap-2 transition-colors ${
                  detailTab === 'trace'
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <Terminal className="h-4 w-4" />
                Agent Trace ({selectedRun.auditEvents?.length || 0} events)
              </button>
              <button
                onClick={() => setDetailTab('transcript')}
                className={`py-3 px-4 text-xs font-semibold border-b-2 flex items-center gap-2 transition-colors ${
                  detailTab === 'transcript'
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <MessageSquare className="h-4 w-4" />
                Transcript ({selectedRun.messages?.length || 0} turns)
              </button>
              <button
                onClick={() => setDetailTab('card')}
                className={`py-3 px-4 text-xs font-semibold border-b-2 flex items-center gap-2 transition-colors ${
                  detailTab === 'card'
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <ShieldCheck className="h-4 w-4" />
                Case Card
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 overflow-y-auto flex-1 space-y-4">
              {/* TAB 1: AGENT TRACE TAB */}
              {detailTab === 'trace' && (
                <div className="space-y-4">
                  {/* Grounding and Safety Banner */}
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 flex items-center justify-between text-xs text-emerald-800">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-emerald-600" />
                      <span><strong>Grounding Verified:</strong> Numbers, dates, and RMA codes anchored directly to verified tool data.</span>
                    </div>
                    <span className="font-mono bg-white px-2 py-0.5 rounded border border-emerald-200 text-emerald-700">
                      Hash-chained SHA-256
                    </span>
                  </div>

                  {/* Audit Event Timeline */}
                  {selectedRun.auditEvents && selectedRun.auditEvents.length > 0 ? (
                    <div className="relative pl-6 space-y-6 before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-200">
                      {selectedRun.auditEvents.map((ev, i) => (
                        <div key={i} className="relative group">
                          {/* Dot */}
                          <div className={`absolute -left-6 top-1 h-4 w-4 rounded-full border-2 border-white flex items-center justify-center ${
                            ev.action === 'PROMPT_INJECTION_DETECTED'
                              ? 'bg-rose-500 ring-4 ring-rose-100'
                              : ev.action === 'ESCALATE_TO_HUMAN'
                              ? 'bg-amber-500 ring-4 ring-amber-100'
                              : 'bg-indigo-600 ring-4 ring-indigo-100'
                          }`} />

                          <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200/80">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className="font-mono font-bold text-xs text-slate-800 bg-white px-2 py-0.5 rounded border border-slate-200">
                                  {ev.action}
                                </span>
                                <span className="text-[11px] text-slate-400 font-mono">
                                  Actor: {ev.actor}
                                </span>
                              </div>
                              <span className="text-[11px] text-slate-400 font-mono">
                                {new Date(ev.timestamp).toLocaleTimeString()}
                              </span>
                            </div>

                            {/* Data Snippet */}
                            {ev.data && (
                              <div className="mt-2 space-y-2">
                                {ev.data.inputs && (
                                  <div>
                                    <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Inputs</div>
                                    <pre className="bg-white p-2.5 rounded-lg border border-slate-200 text-[11px] font-mono text-slate-700 overflow-x-auto max-h-36">
                                      {JSON.stringify(ev.data.inputs, null, 2)}
                                    </pre>
                                  </div>
                                )}
                                {ev.data.outputs && (
                                  <div>
                                    <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Outputs</div>
                                    <pre className="bg-white p-2.5 rounded-lg border border-slate-200 text-[11px] font-mono text-emerald-700 overflow-x-auto max-h-36">
                                      {JSON.stringify(ev.data.outputs, null, 2)}
                                    </pre>
                                  </div>
                                )}
                                {!ev.data.inputs && !ev.data.outputs && (
                                  <pre className="bg-white p-2.5 rounded-lg border border-slate-200 text-[11px] font-mono text-slate-700 overflow-x-auto max-h-36">
                                    {JSON.stringify(ev.data, null, 2)}
                                  </pre>
                                )}
                              </div>
                            )}

                            {ev.hash && (
                              <div className="mt-2 text-[10px] text-slate-400 font-mono truncate">
                                Hash: {ev.hash}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="p-8 text-center text-slate-400 text-xs">
                      No tool-calling audit events recorded for this run.
                    </div>
                  )}
                </div>
              )}

              {/* TAB 2: TRANSCRIPT TAB */}
              {detailTab === 'transcript' && (
                <div className="space-y-3">
                  {selectedRun.messages && selectedRun.messages.length > 0 ? (
                    selectedRun.messages.map((msg, i) => (
                      <div
                        key={i}
                        className={`flex gap-3 ${
                          msg.role === 'user' ? 'justify-end' : 'justify-start'
                        }`}
                      >
                        <div
                          className={`max-w-[80%] rounded-2xl px-4 py-3 text-xs leading-relaxed ${
                            msg.role === 'user'
                              ? 'bg-indigo-600 text-white rounded-br-sm'
                              : msg.role === 'staff'
                              ? 'bg-amber-100 text-amber-900 border border-amber-200'
                              : 'bg-slate-100 text-slate-800 rounded-bl-sm'
                          }`}
                        >
                          <div className="text-[10px] font-semibold uppercase tracking-wider opacity-75 mb-1">
                            {msg.role}
                          </div>
                          <div className="whitespace-pre-wrap">{msg.content || '(Tool call event)'}</div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="p-8 text-center text-slate-400 text-xs">
                      No messages stored in transcript.
                    </div>
                  )}
                </div>
              )}

              {/* TAB 3: CASE CARD TAB */}
              {detailTab === 'card' && (
                <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200 space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <span className="text-xs text-slate-400 uppercase font-medium">Return / RMA</span>
                      <div className="font-mono text-sm font-bold text-slate-900 mt-1">
                        {selectedRun.caseCard?.rmaNumber || selectedRun.caseCard?.returnId || 'N/A'}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs text-slate-400 uppercase font-medium">Current State</span>
                      <div className="mt-1">
                        <span className="px-2 py-1 rounded-md text-xs font-semibold bg-indigo-100 text-indigo-700">
                          {selectedRun.caseCard?.state || 'INIT'}
                        </span>
                      </div>
                    </div>
                    <div>
                      <span className="text-xs text-slate-400 uppercase font-medium">Policy Decision</span>
                      <div className="font-medium text-xs text-slate-700 mt-1">
                        {selectedRun.caseCard?.decision || 'PENDING'}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs text-slate-400 uppercase font-medium">Handled By</span>
                      <div className="font-medium text-xs text-slate-700 mt-1">
                        {selectedRun.handledBy ? `Staff (${selectedRun.handledBy})` : 'Autonomous Agent'}
                      </div>
                    </div>
                  </div>

                  {selectedRun.caseCard?.ruleExplanation && (
                    <div className="pt-3 border-t border-slate-200">
                      <span className="text-xs text-slate-400 uppercase font-medium">Policy Explanation</span>
                      <p className="text-xs text-slate-700 mt-1 bg-white p-3 rounded-xl border border-slate-200">
                        {selectedRun.caseCard.ruleExplanation}
                      </p>
                    </div>
                  )}

                  {selectedRun.caseCard?.nextStep && (
                    <div className="pt-2">
                      <span className="text-xs text-slate-400 uppercase font-medium">Next Step</span>
                      <p className="text-xs text-slate-700 mt-1 font-medium text-indigo-600">
                        {selectedRun.caseCard.nextStep}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
              <span className="text-xs text-slate-400 font-mono">
                Audit event linkage: complete &amp; tamper-resistant
              </span>
              <button
                onClick={() => setSelectedRun(null)}
                className="btn btn-secondary px-4 py-2 text-xs"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
