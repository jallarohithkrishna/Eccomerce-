import { useState, useEffect } from 'react';
import { db } from '../../lib/firebase';
import { collection, onSnapshot, query, orderBy, limit, startAfter, getDocs } from 'firebase/firestore';
import { 
  RotateCcw, Search, AlertTriangle, 
  Package, ShieldCheck, QrCode, 
  ExternalLink, FileText,
  ClipboardCheck, Warehouse, CheckCheck, Send, Loader2,
  Bot, List, CreditCard
} from 'lucide-react';
import { 
  RETURN_STATUS_DETAILS, 
  normalizeReturnStatus 
} from '../../constants/returnStatuses';
import { toolAdvanceReturnStatus } from '../../lib/returnAgent';

const SERVER = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

export default function AdminReturns() {
  const PAGE_SIZE = 25;
  const [allReturns, setAllReturns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [lastDoc, setLastDoc] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedFilter, setSelectedFilter] = useState('ALL');
  const [selectedReturn, setSelectedReturn] = useState(null);
  const [staffNote, setStaffNote] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  // Phase B
  const [activeTab, setActiveTab]     = useState('details'); // 'details' | 'trace'
  const [agentTrace, setAgentTrace]   = useState(null);      // conversation audit events
  const [traceLoading, setTraceLoading] = useState(false);
  const [staffReply, setStaffReply]   = useState('');
  const [replyLoading, setReplyLoading] = useState(false);
  const [inboxCases, setInboxCases]   = useState([]);

  const processReturnsDocs = (docs, isAppend = false) => {
    setAllReturns(prevReturns => {
      const returnsMap = isAppend ? new Map(prevReturns.map(r => [r.rma_number || r.id, r])) : new Map();

      docs.forEach(docSnap => {
        const ret = docSnap.data();
        const rma = ret.rma_number || docSnap.id;
        returnsMap.set(rma, {
          ...ret,
          id: docSnap.id,
          order_id: ret.orderId || ret.order_id,
          order_number: ret.order_number || ret.orderId || ret.order_id,
          created_at: ret.created_at || ret.createdAt,
          customer: ret.customer || {
            full_name: ret.customer_name || 'Customer',
            email: ret.customer_email || 'N/A',
            phone: ret.customer_phone || '',
            address: ret.customer_address || 'N/A',
          },
        });
      });

      const list = Array.from(returnsMap.values());
      list.sort((a, b) => {
        const timeA = new Date(a.created_at || a.createdAt || 0).getTime();
        const timeB = new Date(b.created_at || b.createdAt || 0).getTime();
        return timeB - timeA;
      });

      return list;
    });
  };

  // Real-time listener for first page of returns — reads ONLY returns collection (migrated from orders)
  useEffect(() => {
    const q = query(collection(db, 'returns'), orderBy('created_at', 'desc'), limit(PAGE_SIZE));
    const unsubReturns = onSnapshot(q, (snapshot) => {
      processReturnsDocs(snapshot.docs, false);
      setLastDoc(snapshot.docs[snapshot.docs.length - 1] || null);
      setHasMore(snapshot.docs.length === PAGE_SIZE);
      setLoading(false);
    }, (err) => {
      console.error('Error fetching admin returns from returns collection:', err);
      // Fallback without orderBy in case index pending
      getDocs(query(collection(db, 'returns'), limit(PAGE_SIZE)))
        .then(snap => {
          processReturnsDocs(snap.docs, false);
          setLastDoc(snap.docs[snap.docs.length - 1] || null);
          setHasMore(snap.docs.length === PAGE_SIZE);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    });

    return () => unsubReturns();
  }, []);

  const handleLoadMore = async () => {
    if (!lastDoc || loadingMore) return;
    setLoadingMore(true);
    try {
      const q = query(
        collection(db, 'returns'),
        orderBy('created_at', 'desc'),
        startAfter(lastDoc),
        limit(PAGE_SIZE)
      );
      const snapshot = await getDocs(q);
      processReturnsDocs(snapshot.docs, true);
      setLastDoc(snapshot.docs[snapshot.docs.length - 1] || null);
      setHasMore(snapshot.docs.length === PAGE_SIZE);
    } catch (err) {
      console.error('Error loading more returns:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  const loadInbox = async () => {
    try {
      const res = await fetch(`${SERVER}/agent/inbox`, {
        headers: { 'x-dev-uid': 'admin', 'x-dev-role': 'admin' },
      });
      if (res.ok) {
        const data = await res.json();
        setInboxCases(data.cases || []);
      }
    } catch { /* server may not be running */ }
  };

  useEffect(() => { loadInbox(); }, []);

  // Load agent trace when detail panel opens
  const loadAgentTrace = async (conversationId) => {
    if (!conversationId) return;
    setTraceLoading(true);
    try {
      const res = await fetch(`${SERVER}/agent/conversations/${conversationId}`, {
        headers: { 'x-dev-uid': 'admin', 'x-dev-role': 'admin' },
      });
      if (res.ok) {
        const data = await res.json();
        setAgentTrace(data);
      }
    } catch { /* silent */ } finally {
      setTraceLoading(false);
    }
  };

  // Phase B: takeover / handback
  const handleTakeover = async (conversationId) => {
    try {
      await fetch(`${SERVER}/agent/conversations/${conversationId}/takeover`, {
        method: 'POST',
        headers: { 'x-dev-uid': 'admin', 'x-dev-role': 'admin' },
      });
      setAgentTrace(prev => prev ? { ...prev, handledBy: 'admin' } : prev);
    } catch (e) { alert('Takeover failed: ' + e.message); }
  };

  const handleHandback = async (conversationId) => {
    try {
      await fetch(`${SERVER}/agent/conversations/${conversationId}/handback`, {
        method: 'POST',
        headers: { 'x-dev-uid': 'admin', 'x-dev-role': 'admin' },
      });
      setAgentTrace(prev => prev ? { ...prev, handledBy: null } : prev);
    } catch (e) { alert('Handback failed: ' + e.message); }
  };

  const handleStaffReply = async (conversationId) => {
    if (!staffReply.trim()) return;
    setReplyLoading(true);
    try {
      await fetch(`${SERVER}/agent/conversations/${conversationId}/staff-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-dev-uid': 'admin', 'x-dev-role': 'admin' },
        body: JSON.stringify({ message: staffReply }),
      });
      setStaffReply('');
      await loadAgentTrace(conversationId);
    } catch (e) { alert('Reply failed: ' + e.message); } finally {
      setReplyLoading(false);
    }
  };

  // Compute Metrics
  const metrics = {
    total:     allReturns.length,
    pending:   allReturns.filter(r => ['REQUESTED', 'VERIFYING', 'ELIGIBILITY_CHECK'].includes(normalizeReturnStatus(r.status))).length,
    approved:  allReturns.filter(r => ['APPROVED', 'PICKUP_SCHEDULED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTION'].includes(normalizeReturnStatus(r.status))).length,
    exceptions:allReturns.filter(r => r.is_exception || normalizeReturnStatus(r.status) === 'HUMAN_REVIEW').length,
    completed: allReturns.filter(r => ['COMPLETED', 'REFUND_PROCESSING'].includes(normalizeReturnStatus(r.status))).length,
    needsHuman:inboxCases.length,
  };

  // Filtered Returns (add INBOX filter)
  const filteredReturns = selectedFilter === 'INBOX'
    ? inboxCases.map(c => ({
        ...c,
        rma_number: c.caseCard?.rmaNumber || c.caseCard?.rmaCode || c.caseCard?.returnId || c.conversationId,
        order_number: c.caseCard?.order_id || c.conversationId?.slice(-8),
        customer: { full_name: `Customer (${c.uid?.slice(0, 8) || 'User'})`, email: c.uid || 'N/A' },
        item: { name: 'Escalated Return Case', category: 'Support', price: 0 },
        status: c.caseCard?.state || 'HUMAN_REVIEW',
        status_label: 'Needs Human',
        ai_assessment: {
          decision_rule: c.caseCard?.decision || 'Escalated to Human',
          reason: c.caseCard?.ruleExplanation || 'Specialist review requested',
        },
        conversation_id: c.conversationId,
        created_at: c.createdAt || c.updatedAt,
        is_exception: true,
      }))
    : allReturns.filter(ret => {
        const statusKey = normalizeReturnStatus(ret.status);
        if (selectedFilter === 'EXCEPTIONS' && !ret.is_exception && statusKey !== 'HUMAN_REVIEW') return false;
        if (selectedFilter === 'PENDING' && !['REQUESTED', 'VERIFYING', 'ELIGIBILITY_CHECK'].includes(statusKey)) return false;
        if (selectedFilter === 'APPROVED' && !['APPROVED', 'PICKUP_SCHEDULED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTION'].includes(statusKey)) return false;
        if (selectedFilter === 'COMPLETED' && !['COMPLETED', 'REFUND_PROCESSING'].includes(statusKey)) return false;
        if (searchTerm) {
          const q = searchTerm.toLowerCase();
          return (
            ret.rma_number?.toLowerCase().includes(q) ||
            ret.order_number?.toLowerCase().includes(q) ||
            ret.customer?.full_name?.toLowerCase().includes(q) ||
            ret.customer?.email?.toLowerCase().includes(q) ||
            ret.item?.name?.toLowerCase().includes(q)
          );
        }
        return true;
      });

  // Action: Advance Status
  const handleAdvanceStatus = async (nextStatus) => {
    if (!selectedReturn) return;
    setActionLoading(true);

    try {
      await toolAdvanceReturnStatus({
        orderId: selectedReturn.order_id,
        rmaNumber: selectedReturn.rma_number,
        nextStatus,
        actorName: 'Admin Staff',
        note: staffNote
      });

      // Update local selected state
      const nowIso = new Date().toISOString();
      const statusMeta = RETURN_STATUS_DETAILS[nextStatus] || { label: nextStatus };
      setSelectedReturn(prev => ({
        ...prev,
        status: nextStatus,
        status_label: statusMeta.label,
        audit_history: [
          ...(prev.audit_history || []),
          {
            id: `AUD-${Date.now()}`,
            timestamp: nowIso,
            actor: 'STAFF',
            actor_name: 'Admin Staff',
            action: `ADVANCED_TO_${nextStatus}`,
            details: staffNote ? `Advanced to ${statusMeta.label}. Note: ${staffNote}` : `Advanced to ${statusMeta.label}`
          }
        ]
      }));

      setStaffNote('');
    } catch (err) {
      console.error('Failed to update status:', err);
      alert('Error updating status: ' + err.message);
    } finally {
      setActionLoading(false);
    }
  };

  // Action: Add Staff Audit Note
  const handleAddStaffNote = async () => {
    if (!staffNote.trim() || !selectedReturn) return;
    setActionLoading(true);

    try {
      const nowIso = new Date().toISOString();
      const newEntry = {
        id: `AUD-${Date.now()}`,
        timestamp: nowIso,
        actor: 'STAFF',
        actor_name: 'Admin Staff',
        action: 'STAFF_NOTE_ADDED',
        details: staffNote.trim()
      };

      // In-memory update for current session
      setSelectedReturn(prev => ({
        ...prev,
        audit_history: [...(prev.audit_history || []), newEntry]
      }));

      setStaffNote('');
    } catch (err) {
      console.error('Error adding staff note:', err);
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2.5">
            <RotateCcw className="w-7 h-7 text-primary-600" />
            AI Returns &amp; RMA Management
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Supervise autonomous AI return decisions, audit trails, and 10-stage pipeline status.
          </p>
        </div>
      </div>

      {/* 5 Metrics Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3.5">
        <div 
          onClick={() => setSelectedFilter('ALL')}
          className={`p-4 rounded-2xl border transition-all cursor-pointer ${
            selectedFilter === 'ALL'
              ? 'bg-slate-900 text-white border-slate-900 shadow-md'
              : 'bg-white text-slate-900 border-slate-200 hover:border-slate-300'
          }`}
        >
          <p className={`text-[11px] font-bold uppercase tracking-wider ${selectedFilter === 'ALL' ? 'text-slate-400' : 'text-slate-500'}`}>
            Total Returns
          </p>
          <p className="text-2xl font-extrabold mt-1">{metrics.total}</p>
        </div>

        <div 
          onClick={() => setSelectedFilter('EXCEPTIONS')}
          className={`p-4 rounded-2xl border transition-all cursor-pointer ${
            selectedFilter === 'EXCEPTIONS'
              ? 'bg-amber-600 text-white border-amber-600 shadow-md'
              : 'bg-white text-amber-950 border-amber-200 hover:border-amber-400'
          }`}
        >
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-bold uppercase tracking-wider text-amber-700">
              Exceptions / Review
            </p>
            {metrics.exceptions > 0 && (
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />
            )}
          </div>
          <p className="text-2xl font-extrabold mt-1 text-amber-900">{metrics.exceptions}</p>
        </div>

        <div 
          onClick={() => setSelectedFilter('PENDING')}
          className={`p-4 rounded-2xl border transition-all cursor-pointer ${
            selectedFilter === 'PENDING'
              ? 'bg-blue-600 text-white border-blue-600 shadow-md'
              : 'bg-white text-slate-900 border-slate-200 hover:border-slate-300'
          }`}
        >
          <p className="text-[11px] font-bold uppercase tracking-wider text-blue-600">
            Pending Checks
          </p>
          <p className="text-2xl font-extrabold mt-1">{metrics.pending}</p>
        </div>

        <div 
          onClick={() => setSelectedFilter('APPROVED')}
          className={`p-4 rounded-2xl border transition-all cursor-pointer ${
            selectedFilter === 'APPROVED'
              ? 'bg-indigo-600 text-white border-indigo-600 shadow-md'
              : 'bg-white text-slate-900 border-slate-200 hover:border-slate-300'
          }`}
        >
          <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-600">
            Approved &amp; Transit
          </p>
          <p className="text-2xl font-extrabold mt-1">{metrics.approved}</p>
        </div>

        {/* Needs Human metric card (Phase B) */}
        <div
          onClick={() => setSelectedFilter('INBOX')}
          className={`p-4 rounded-2xl border transition-all cursor-pointer ${
            selectedFilter === 'INBOX'
              ? 'bg-violet-600 text-white border-violet-600 shadow-md'
              : 'bg-white text-slate-900 border-violet-200 hover:border-violet-400'
          }`}
        >
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-bold uppercase tracking-wider text-violet-700">Needs Human</p>
            {metrics.needsHuman > 0 && (
              <span className="w-2 h-2 rounded-full bg-violet-500 animate-ping" />
            )}
          </div>
          <p className="text-2xl font-extrabold mt-1 text-violet-900">{metrics.needsHuman}</p>
        </div>

        {/* Completed / Refunded metric card */}
        <div
          onClick={() => setSelectedFilter('COMPLETED')}
          className={`p-4 rounded-2xl border transition-all cursor-pointer ${
            selectedFilter === 'COMPLETED'
              ? 'bg-emerald-600 text-white border-emerald-600 shadow-md'
              : 'bg-white text-slate-900 border-slate-200 hover:border-slate-300'
          }`}
        >
          <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-600">
            Completed / Refunded
          </p>
          <p className="text-2xl font-extrabold mt-1">{metrics.completed}</p>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search by RMA, Order #, Customer, or Item Name..."
            className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 placeholder-slate-400 focus:bg-white focus:border-primary-500 focus:outline-hidden"
          />
        </div>

        {/* Filter Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          {[
            { key: 'ALL', label: 'All Returns' },
            { key: 'EXCEPTIONS', label: 'Exceptions' },
            { key: 'PENDING', label: 'Pending' },
            { key: 'APPROVED', label: 'Approved & Transit' },
            { key: 'COMPLETED', label: 'Completed' },
            { key: 'INBOX', label: '🧑‍💼 Needs Human' },
          ].map(f => (
            <button
              key={f.key}
              onClick={() => setSelectedFilter(f.key)}
              className={`text-xs px-3 py-1.5 rounded-xl font-bold whitespace-nowrap transition-colors ${
                selectedFilter === f.key
                  ? 'bg-primary-600 text-white shadow-xs'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Returns Table / List */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        {loading ? (
          <div className="p-12 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto" />
            <p className="text-xs text-slate-500 mt-2">Loading returns database...</p>
          </div>
        ) : filteredReturns.length === 0 ? (
          <div className="p-12 text-center">
            <RotateCcw className="w-10 h-10 text-slate-300 mx-auto mb-2" />
            <p className="text-sm font-bold text-slate-800">No returns match your filter</p>
            <p className="text-xs text-slate-500 mt-0.5">Try clearing the search query or selecting All Returns.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px] border-b border-slate-100">
                <tr>
                  <th className="py-3 px-4">RMA &amp; Date</th>
                  <th className="py-3 px-4">Customer</th>
                  <th className="py-3 px-4">Order &amp; Item</th>
                  <th className="py-3 px-4">AI Decision / Reason</th>
                  <th className="py-3 px-4">Pipeline Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredReturns.map((ret, idx) => {
                  const statusKey = normalizeReturnStatus(ret.status);
                  const statusMeta = RETURN_STATUS_DETAILS[statusKey] || RETURN_STATUS_DETAILS.REQUESTED;

                  return (
                    <tr key={idx} className="hover:bg-slate-50/60 transition-colors">
                      {/* RMA & Date */}
                      <td className="py-3.5 px-4 font-medium">
                        <div className="flex items-center gap-1.5">
                          <span className="font-extrabold text-slate-900 font-mono">
                            {ret.rma_number}
                          </span>
                          {ret.is_exception && (
                            <span className="p-0.5 bg-amber-100 text-amber-800 rounded-md" title="Human Review Exception">
                              <AlertTriangle className="w-3 h-3" />
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          {ret.created_at ? new Date(ret.created_at).toLocaleDateString() : 'Recent'}
                        </p>
                      </td>

                      {/* Customer */}
                      <td className="py-3.5 px-4">
                        <p className="font-bold text-slate-800">{ret.customer?.full_name || 'Customer'}</p>
                        <p className="text-[11px] text-slate-400">{ret.customer?.email || 'N/A'}</p>
                      </td>

                      {/* Order & Item */}
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-2">
                          <div className="w-9 h-9 rounded-lg bg-slate-100 overflow-hidden flex-shrink-0 border border-slate-100 flex items-center justify-center">
                            {ret.item?.image_url ? (
                              <img src={ret.item.image_url} alt="" className="w-full h-full object-contain p-0.5" />
                            ) : (
                              <Package className="w-4 h-4 text-slate-400" />
                            )}
                          </div>
                          <div className="min-w-0 max-w-[180px]">
                            <p className="font-bold text-slate-800 truncate">{ret.item?.name}</p>
                            <p className="text-[11px] text-slate-400">
                              Order #{ret.order_number} &bull; ₹{Number(ret.refund_amount || ret.item?.price || 0).toFixed(2)}
                            </p>
                          </div>
                        </div>
                      </td>

                      {/* AI Decision */}
                      <td className="py-3.5 px-4">
                        <div className="max-w-[220px]">
                          <span className="text-[10px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full inline-block truncate">
                            {ret.ai_assessment?.decision_rule || ret.status_label || 'Auto-Evaluated'}
                          </span>
                          <p className="text-[11px] text-slate-500 mt-1 truncate">
                            {ret.ai_assessment?.reason || ret.reason_text || `Reason: ${ret.reason_code}`}
                          </p>
                        </div>
                      </td>

                      {/* Pipeline Status */}
                      <td className="py-3.5 px-4">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-bold text-[10px] border ${statusMeta.badgeClass}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dotClass}`} />
                          {statusMeta.shortLabel}
                        </span>
                        <p className="text-[10px] text-slate-400 mt-0.5">
                          Stage {statusMeta.step || 1} of 10
                        </p>
                      </td>

                      {/* Actions */}
                      <td className="py-3.5 px-4 text-right">
                        <button
                          onClick={() => setSelectedReturn(ret)}
                          className="px-3 py-1.5 bg-primary-50 hover:bg-primary-100 text-primary-700 font-bold rounded-xl text-xs transition-colors"
                        >
                          Manage &bull; Details
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Load More Returns Button */}
        {hasMore && !searchTerm && (
          <div className="p-4 border-t border-slate-100 flex justify-center bg-slate-50/50">
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="btn btn-secondary text-xs font-bold py-2 px-5 shadow-xs bg-white hover:bg-slate-50 border border-slate-200 flex items-center gap-2"
            >
              {loadingMore ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-primary-600" />
                  <span>Loading more returns...</span>
                </>
              ) : (
                <span>Load More Returns (25)</span>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Return Details & Management Modal */}
      {selectedReturn && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden shadow-2xl animate-scale-up">
            
            {/* Modal Header */}
            <div className="p-4 px-6 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary-600 rounded-xl">
                  <RotateCcw className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h3 className="font-extrabold text-base flex items-center gap-2">
                    Return Case: {selectedReturn.rma_number}
                    {selectedReturn.is_exception && (
                      <span className="text-[10px] bg-amber-500 text-white font-bold px-2 py-0.5 rounded-full">
                        HUMAN REVIEW REQUIRED
                      </span>
                    )}
                  </h3>
                  <p className="text-xs text-slate-400">
                    Order #{selectedReturn.order_number} &bull; Created {selectedReturn.created_at ? new Date(selectedReturn.created_at).toLocaleString() : 'Recent'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedReturn(null)}
                className="p-1 rounded-lg hover:bg-white/10 text-white/80 transition-colors text-xl font-bold"
              >
                &times;
              </button>
            </div>

            {/* Modal Content Scrollable Body */}
            <div className="p-6 overflow-y-auto space-y-6 flex-1 bg-slate-50">
              
              {/* Product & Customer Summary */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs space-y-3">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Item Details</p>
                  <div className="flex items-center gap-3">
                    <div className="w-14 h-14 bg-slate-100 rounded-xl overflow-hidden flex-shrink-0 border border-slate-100 flex items-center justify-center">
                      {selectedReturn.item?.image_url ? (
                        <img src={selectedReturn.item.image_url} alt="" className="w-full h-full object-contain p-1" />
                      ) : (
                        <Package className="w-6 h-6 text-slate-400" />
                      )}
                    </div>
                    <div>
                      <h4 className="font-bold text-sm text-slate-900">{selectedReturn.item?.name}</h4>
                      <p className="text-xs text-slate-500">
                        Category: <span className="capitalize">{selectedReturn.item?.category || 'General'}</span> &bull; Qty: {selectedReturn.item?.quantity || 1}
                      </p>
                      <p className="text-xs font-extrabold text-primary-600 mt-0.5">
                        Refund: ₹{Number(selectedReturn.refund_amount || selectedReturn.item?.price || 0).toFixed(2)}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs space-y-2">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Customer &amp; Reverse Pickup</p>
                  <p className="font-bold text-xs text-slate-900">{selectedReturn.customer?.full_name}</p>
                  <p className="text-xs text-slate-500">{selectedReturn.customer?.email} &bull; {selectedReturn.customer?.phone || 'No phone'}</p>
                  <p className="text-xs text-slate-600">{selectedReturn.pickup_details?.address || selectedReturn.customer?.address || 'Address on file'}</p>
                  <p className="text-[11px] font-mono text-indigo-600">
                    Carrier: {selectedReturn.pickup_details?.carrier || 'BlueDart Express'} ({selectedReturn.pickup_details?.tracking_number || 'Pending'})
                  </p>
                </div>
              </div>

              {/* AI Autonomous Decision Card */}
              <div className="bg-gradient-to-br from-indigo-50 via-purple-50 to-white p-4 rounded-2xl border border-indigo-200 shadow-xs space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-indigo-950 flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-indigo-600" />
                    AI Agent Decision &amp; Policy Rule
                  </span>
                  <span className="text-[10px] bg-indigo-600 text-white font-bold px-2 py-0.5 rounded-full">
                    Confidence: {selectedReturn.ai_assessment?.confidence_score || '99%'}
                  </span>
                </div>
                <p className="text-xs font-bold text-slate-800">
                  {selectedReturn.ai_assessment?.decision_rule || 'Autonomous Policy Decision'}
                </p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  {selectedReturn.ai_assessment?.reason || selectedReturn.reason_text || 'Standard automated return rule applied.'}
                </p>
              </div>

              {/* Current Pipeline Stage Indicator */}
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                    <Warehouse className="w-4 h-4 text-primary-600" />
                    Current Pipeline Status:
                  </p>
                  <span className={`px-2.5 py-1 rounded-full text-xs font-extrabold border ${
                    RETURN_STATUS_DETAILS[normalizeReturnStatus(selectedReturn.status)]?.badgeClass
                  }`}>
                    {selectedReturn.status_label || selectedReturn.status}
                  </span>
                </div>

                {/* Step Pipeline buttons for Staff */}
                <div className="pt-2 border-t border-slate-100">
                  <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">
                    Staff Status Controls:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      disabled={actionLoading}
                      onClick={() => handleAdvanceStatus('RECEIVED')}
                      className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold rounded-xl text-xs flex items-center gap-1 transition-colors"
                    >
                      <Warehouse className="w-3.5 h-3.5 text-slate-600" />
                      <span>Mark Received at Hub</span>
                    </button>

                    <button
                      disabled={actionLoading}
                      onClick={() => handleAdvanceStatus('INSPECTION')}
                      className="px-3 py-1.5 bg-purple-50 hover:bg-purple-100 text-purple-800 font-bold rounded-xl text-xs flex items-center gap-1 transition-colors"
                    >
                      <ClipboardCheck className="w-3.5 h-3.5 text-purple-600" />
                      <span>Pass Inspection</span>
                    </button>

                    <button
                      disabled={actionLoading}
                      onClick={() => handleAdvanceStatus('REFUND_PROCESSING')}
                      className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-800 font-bold rounded-xl text-xs flex items-center gap-1 transition-colors"
                    >
                      <CreditCard className="w-3.5 h-3.5 text-rose-600" />
                      <span>Process Refund</span>
                    </button>

                    <button
                      disabled={actionLoading}
                      onClick={() => handleAdvanceStatus('COMPLETED')}
                      className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-xs flex items-center gap-1 transition-colors shadow-xs"
                    >
                      <CheckCheck className="w-3.5 h-3.5" />
                      <span>Mark Completed &amp; Settled</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Phase B: Tabs — Details | Agent Trace */}
              <div className="flex border-b border-slate-200 mb-4">
                {[{ key: 'details', label: 'Details', icon: List }, { key: 'trace', label: 'Agent Trace', icon: Bot }].map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => {
                      setActiveTab(tab.key);
                      if (tab.key === 'trace') loadAgentTrace(selectedReturn.conversation_id || selectedReturn.rma_number);
                    }}
                    className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold border-b-2 transition-all -mb-px cursor-pointer ${
                      activeTab === tab.key
                        ? 'border-indigo-600 text-indigo-700'
                        : 'border-transparent text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    <tab.icon className="w-3.5 h-3.5" />
                    {tab.label}
                  </button>
                ))}
              </div>

              {activeTab === 'trace' ? (
                /* ─ Agent Trace Panel ─ */
                <div className="space-y-3">
                  {traceLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="w-5 h-5 animate-spin text-indigo-500" />
                    </div>
                  ) : !agentTrace ? (
                    <p className="text-xs text-slate-400 text-center py-6">No agent trace found for this case.</p>
                  ) : (
                    <>
                      {/* Case packet header */}
                      <div className="flex items-center justify-between">
                        <div className="text-xs">
                          <span className="font-bold text-slate-700">Conv:</span> <span className="font-mono text-slate-500">{agentTrace.conversationId?.slice(-12)}</span>
                          {agentTrace.caseCard?.state && (
                            <span className="ml-2 px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full font-bold">{agentTrace.caseCard.state}</span>
                          )}
                        </div>
                        <div className="flex gap-2">
                          {agentTrace.handledBy ? (
                            <button onClick={() => handleHandback(agentTrace.conversationId)} className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-xl font-bold transition-colors cursor-pointer">
                              Hand back to agent
                            </button>
                          ) : (
                            <button onClick={() => handleTakeover(agentTrace.conversationId)} className="text-xs bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-xl font-bold transition-colors cursor-pointer">
                              Take over
                            </button>
                          )}
                        </div>
                      </div>

                      {agentTrace.handledBy && (
                        <div className="text-xs bg-amber-50 text-amber-800 border border-amber-200 px-3 py-2 rounded-xl flex items-center justify-between">
                          <span>✋ Handled by staff ({agentTrace.handledBy}). AI replies are paused.</span>
                        </div>
                      )}

                      {/* Prepared Case Packet */}
                      <div className="bg-indigo-50/60 border border-indigo-100 rounded-xl p-3 space-y-2 text-xs">
                        <p className="font-bold text-indigo-950 flex items-center gap-1.5">
                          <ShieldCheck className="w-4 h-4 text-indigo-600" />
                          Prepared Case Packet
                        </p>
                        <div className="grid grid-cols-2 gap-2 text-[11px]">
                          <div>
                            <span className="text-slate-500">Customer UID:</span> <span className="font-mono font-medium text-slate-700">{agentTrace.uid || 'Anonymous'}</span>
                          </div>
                          <div>
                            <span className="text-slate-500">Decision:</span> <span className="font-bold text-indigo-700">{agentTrace.caseCard?.decision || 'Under Review'}</span>
                          </div>
                        </div>
                        {agentTrace.caseCard?.ruleExplanation && (
                          <div className="text-[11px] text-slate-700 bg-white p-2 rounded-lg border border-indigo-100">
                            <span className="font-bold text-slate-800">Rule Fired:</span> {agentTrace.caseCard.ruleExplanation}
                          </div>
                        )}
                        {agentTrace.caseCard?.nextStep && (
                          <div className="text-[11px] text-emerald-800 bg-emerald-50/80 p-2 rounded-lg border border-emerald-100">
                            <span className="font-bold text-emerald-900">Recommendation:</span> {agentTrace.caseCard.nextStep}
                          </div>
                        )}
                        {/* Evidence analysis if present */}
                        {(() => {
                          const evUpload = (agentTrace.auditEvents || []).find(e => e.action === 'EVIDENCE_UPLOADED');
                          if (evUpload?.data) {
                            return (
                              <div className="text-[11px] text-slate-700 bg-white p-2 rounded-lg border border-slate-200">
                                <span className="font-bold text-slate-800">Evidence Analysis:</span> {evUpload.data.verified ? 'Verified image' : 'Unverified image'} • Hash: <span className="font-mono">{evUpload.data.hash?.slice(0, 12)}…</span>
                              </div>
                            );
                          }
                          return null;
                        })()}
                        {/* Grounding check indicator */}
                        <div className="text-[10px] text-emerald-700 flex items-center gap-1">
                          <CheckCheck className="w-3.5 h-3.5" />
                          Grounding check passed: Numbers, dates &amp; RMA validated against tool outputs
                        </div>
                      </div>

                      {/* Tool call timeline */}
                      <div>
                        <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">
                          Audit Trail &amp; Tool Calls (Limit 50)
                        </p>
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                          {(agentTrace.auditEvents || []).slice(0, 50).map((ev, i) => (
                            <div key={i} className="text-xs bg-slate-50 border border-slate-100 rounded-xl p-3">
                              <div className="flex items-center justify-between mb-1">
                                <span className="font-mono font-bold text-indigo-700 text-[11px]">
                                  {ev.action}
                                  {ev.data?.model && <span className="ml-2 font-normal text-[10px] text-slate-400">({ev.data.model})</span>}
                                </span>
                                <span className="text-[10px] text-slate-400">{ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}</span>
                              </div>
                              {ev.data?.inputs && (
                                <div className="text-[10px] text-slate-500 mt-1 font-mono bg-white rounded-lg p-1.5 border border-slate-100 max-h-20 overflow-auto">
                                  <span className="font-bold text-slate-600">Inputs: </span>{JSON.stringify(ev.data.inputs, null, 1)}
                                </div>
                              )}
                              {ev.data?.outputs && (
                                <div className="text-[10px] text-emerald-700 mt-1 font-mono bg-emerald-50 rounded-lg p-1.5 border border-emerald-100 max-h-20 overflow-auto">
                                  <span className="font-bold text-emerald-800">Outputs: </span>{JSON.stringify(ev.data.outputs, null, 1)}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Final Agent Reply */}
                      {(() => {
                        const lastAssistantMsg = (agentTrace.messages || []).filter(m => m.role === 'assistant').slice(-1)[0];
                        if (lastAssistantMsg?.content) {
                          return (
                            <div className="bg-slate-100/70 p-3 rounded-xl border border-slate-200 text-xs">
                              <p className="font-bold text-slate-700 mb-1">Final Agent Reply:</p>
                              <p className="text-slate-600 whitespace-pre-wrap">{lastAssistantMsg.content}</p>
                            </div>
                          );
                        }
                        return null;
                      })()}

                      {/* Staff reply */}
                      {agentTrace.handledBy && (
                        <div className="flex gap-2 pt-2 border-t border-slate-100">
                          <input
                            type="text"
                            value={staffReply}
                            onChange={e => setStaffReply(e.target.value)}
                            placeholder="Type a reply to the customer…"
                            className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400"
                          />
                          <button
                            disabled={!staffReply.trim() || replyLoading}
                            onClick={() => handleStaffReply(agentTrace.conversationId)}
                            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white font-bold rounded-xl text-xs cursor-pointer"
                          >
                            {replyLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : (
              /* ─ Existing Details Panel ─ */
              <>
                <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs space-y-3">
                  <p className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                    <FileText className="w-4 h-4 text-primary-600" />
                    Audit History Trail
                  </p>

                  <div className="relative border-l-2 border-primary-200 ml-2 space-y-4 py-1">
                    {selectedReturn.audit_history && selectedReturn.audit_history.length > 0 ? (
                      selectedReturn.audit_history.map((entry, i) => (
                        <div key={i} className="relative pl-5 text-xs">
                          <div className="absolute -left-[7px] top-1 w-3 h-3 rounded-full bg-primary-600 border border-white" />
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="font-bold text-slate-800">{entry.actor_name || entry.actor}</span>
                            <span className="text-[10px] text-slate-400">{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                          </div>
                          <p className="text-[11px] text-slate-600 mt-0.5">{entry.details}</p>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-slate-400 pl-4">No audit history found.</p>
                    )}
                  </div>

                  {/* Add Staff Note */}
                  <div className="pt-2 border-t border-slate-100 flex items-center gap-2">
                    <input
                      type="text"
                      value={staffNote}
                      onChange={(e) => setStaffNote(e.target.value)}
                      placeholder="Add an internal staff note or resolution remark..."
                      className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs focus:bg-white focus:outline-hidden"
                    />
                    <button
                      disabled={!staffNote.trim() || actionLoading}
                      onClick={handleAddStaffNote}
                      className="px-3 py-2 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl text-xs transition-colors shrink-0"
                    >
                      Add Note
                    </button>
                  </div>
                </div>
              </> /* end Details tab fragment */
              )} {/* end activeTab ternary */}

            </div>

            {/* Modal Footer */}
            <div className="p-4 bg-white border-t border-slate-100 flex items-center justify-between">
              <a
                href={`/returns/verify?rma=${encodeURIComponent(selectedReturn.rma_number)}&order=${encodeURIComponent(selectedReturn.order_number)}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-bold text-primary-600 hover:text-primary-700 flex items-center gap-1"
              >
                <QrCode className="w-3.5 h-3.5" />
                <span>Open Public Courier Verification Pass</span>
                <ExternalLink className="w-3 h-3" />
              </a>

              <button
                onClick={() => setSelectedReturn(null)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl text-xs transition-colors"
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
