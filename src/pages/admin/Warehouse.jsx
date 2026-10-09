import { useState, useEffect } from 'react';
import { db } from '../../lib/firebase';
import { collection, query, where, limit, onSnapshot } from 'firebase/firestore';
import { 
  Warehouse, PackageCheck, AlertCircle, CheckCircle2, 
  XCircle, Clock, Search, RefreshCw, FileText, 
  ShieldCheck, ArrowRight, Truck, Box
} from 'lucide-react';
import { apiFetch } from '../../lib/api';

export default function AdminWarehouse() {
  const [returnsList, setReturnsList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  // Condition notes per return item (keyed by returnId)
  const [conditionNotes, setConditionNotes] = useState({});
  // Loading state per return item (keyed by returnId)
  const [actionLoading, setActionLoading] = useState({});
  // Notification / toast feedback
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    // Query returns collection where status in ['IN_TRANSIT', 'RECEIVED', 'INSPECTION'] limit 25
    const q = query(
      collection(db, 'returns'),
      where('status', 'in', ['IN_TRANSIT', 'RECEIVED', 'INSPECTION']),
      limit(25)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const items = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        }));

        // Sort items: IN_TRANSIT first, then RECEIVED, then INSPECTION
        const orderPriority = { IN_TRANSIT: 1, RECEIVED: 2, INSPECTION: 3 };
        items.sort((a, b) => {
          const pA = orderPriority[a.status] || 99;
          const pB = orderPriority[b.status] || 99;
          if (pA !== pB) return pA - pB;
          const timeA = new Date(a.updatedAt || a.createdAt || 0).getTime();
          const timeB = new Date(b.updatedAt || b.createdAt || 0).getTime();
          return timeB - timeA;
        });

        setReturnsList(items);
        setLoading(false);
      },
      (err) => {
        console.error('Failed to subscribe to warehouse returns:', err);
        setError(err.message || 'Error fetching warehouse return items.');
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  const handleNoteChange = (returnId, text) => {
    setConditionNotes((prev) => ({
      ...prev,
      [returnId]: text,
    }));
  };

  const setPresetNote = (returnId, preset) => {
    setConditionNotes((prev) => ({
      ...prev,
      [returnId]: preset,
    }));
  };

  // POST /warehouse/returns/:id/receive
  const handleReceive = async (returnId) => {
    setActionLoading((prev) => ({ ...prev, [returnId]: 'receive' }));
    setFeedback(null);
    try {
      const res = await apiFetch(`/warehouse/returns/${returnId}/receive`, {
        method: 'POST',
      });
      setFeedback({
        type: 'success',
        message: `Package ${returnId} marked as RECEIVED at warehouse intake dock.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: `Failed to receive package ${returnId}: ${err.message}`,
      });
    } finally {
      setActionLoading((prev) => ({ ...prev, [returnId]: null }));
    }
  };

  // POST /warehouse/returns/:id/inspect
  const handleInspect = async (returnId, passed) => {
    const note = conditionNotes[returnId] || '';
    if (!passed && !note.trim()) {
      setFeedback({
        type: 'error',
        message: 'A condition note / failure reason is required when failing an inspection.',
      });
      return;
    }

    setActionLoading((prev) => ({ ...prev, [returnId]: passed ? 'pass' : 'fail' }));
    setFeedback(null);
    try {
      const res = await apiFetch(`/warehouse/returns/${returnId}/inspect`, {
        method: 'POST',
        body: JSON.stringify({
          passed,
          conditionNotes: note,
          failureReason: passed ? '' : note,
        }),
      });

      setFeedback({
        type: 'success',
        message: passed
          ? `Package ${returnId} passed inspection. Status advanced to ${res.status || 'REFUND_PROCESSING'}.`
          : `Package ${returnId} failed inspection and marked as REJECTED.`,
      });

      // Clear note
      setConditionNotes((prev) => {
        const next = { ...prev };
        delete next[returnId];
        return next;
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: `Failed to record inspection for ${returnId}: ${err.message}`,
      });
    } finally {
      setActionLoading((prev) => ({ ...prev, [returnId]: null }));
    }
  };

  // Filter list
  const filteredReturns = returnsList.filter((ret) => {
    const matchesFilter =
      statusFilter === 'ALL' || ret.status === statusFilter;
    const matchesQuery =
      searchQuery === '' ||
      (ret.rma_number && ret.rma_number.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (ret.id && ret.id.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (ret.orderId && ret.orderId.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (ret.item?.name && ret.item.name.toLowerCase().includes(searchQuery.toLowerCase()));

    return matchesFilter && matchesQuery;
  });

  const countInTransit = returnsList.filter((r) => r.status === 'IN_TRANSIT').length;
  const countReceived = returnsList.filter((r) => r.status === 'RECEIVED').length;
  const countInspection = returnsList.filter((r) => r.status === 'INSPECTION').length;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 bg-amber-500/10 text-amber-600 rounded-xl">
              <Warehouse className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-black text-slate-900 tracking-tight">Warehouse Dock &amp; Inspection</h1>
              <p className="text-xs text-slate-500 font-medium mt-0.5">
                Intake receiving dock and physical inspection station for active RMA packages
              </p>
            </div>
          </div>
        </div>

        {/* Quick status summary counts */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 px-3 py-1.5 rounded-xl text-xs font-semibold text-blue-700">
            <Truck className="w-3.5 h-3.5" />
            <span>In Transit: <strong>{countInTransit}</strong></span>
          </div>
          <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-xl text-xs font-semibold text-amber-700">
            <Box className="w-3.5 h-3.5" />
            <span>Received: <strong>{countReceived}</strong></span>
          </div>
          <div className="flex items-center gap-2 bg-purple-50 border border-purple-200 px-3 py-1.5 rounded-xl text-xs font-semibold text-purple-700">
            <PackageCheck className="w-3.5 h-3.5" />
            <span>Inspection: <strong>{countInspection}</strong></span>
          </div>
        </div>
      </div>

      {/* Toast Feedback */}
      {feedback && (
        <div
          className={`p-4 rounded-2xl border flex items-center justify-between text-xs font-medium animate-fadeIn ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          <div className="flex items-center gap-2">
            {feedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
            )}
            <span>{feedback.message}</span>
          </div>
          <button
            onClick={() => setFeedback(null)}
            className="text-[11px] underline opacity-70 hover:opacity-100 ml-4 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Search and Filters Toolbar */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search RMA, Order ID, item..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:bg-white transition-all"
          />
        </div>

        <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0">
          {['ALL', 'IN_TRANSIT', 'RECEIVED', 'INSPECTION'].map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-colors whitespace-nowrap cursor-pointer ${
                statusFilter === status
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {status === 'ALL'
                ? `All Dock Items (${returnsList.length})`
                : status.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {/* Main Content Area */}
      {loading ? (
        <div className="py-20 text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary-600 mx-auto mb-3"></div>
          <p className="text-xs text-slate-500 font-medium">Scanning warehouse dock returns...</p>
        </div>
      ) : error ? (
        <div className="p-8 text-center bg-red-50 rounded-2xl border border-red-200 text-red-700">
          <AlertCircle className="w-8 h-8 mx-auto mb-2 text-red-500" />
          <h3 className="font-bold text-sm">Failed to Load Warehouse Queue</h3>
          <p className="text-xs mt-1 text-red-600">{error}</p>
        </div>
      ) : filteredReturns.length === 0 ? (
        <div className="p-12 text-center bg-white rounded-2xl border border-slate-200 shadow-2xs">
          <div className="w-16 h-16 bg-slate-50 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-slate-100 text-slate-400">
            <Warehouse className="w-8 h-8 text-slate-300" />
          </div>
          <h3 className="text-base font-bold text-slate-900">Dock Queue Is Clear</h3>
          <p className="text-xs text-slate-500 max-w-sm mx-auto mt-1">
            No returns currently in transit, awaiting intake receipt, or under inspection. All packages processed!
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {filteredReturns.map((ret) => {
            const isLoadingReceive = actionLoading[ret.id] === 'receive';
            const isLoadingPass = actionLoading[ret.id] === 'pass';
            const isLoadingFail = actionLoading[ret.id] === 'fail';
            const currentNote = conditionNotes[ret.id] || '';

            return (
              <div
                key={ret.id}
                className="bg-white rounded-2xl border border-slate-200 shadow-2xs hover:border-slate-300 transition-all overflow-hidden"
              >
                {/* Header row */}
                <div className="p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/50">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs font-bold text-slate-900 bg-white px-2.5 py-1 rounded-lg border border-slate-200 shadow-2xs">
                      {ret.rma_number || ret.id}
                    </span>
                    <span
                      className={`text-[10px] font-extrabold px-2.5 py-0.5 rounded-full uppercase tracking-wider ${
                        ret.status === 'IN_TRANSIT'
                          ? 'bg-blue-100 text-blue-700'
                          : ret.status === 'RECEIVED'
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-purple-100 text-purple-700'
                      }`}
                    >
                      {ret.status.replace('_', ' ')}
                    </span>
                    {ret.orderId && (
                      <span className="text-xs text-slate-500">
                        Order: <strong className="text-slate-700 font-mono">{ret.orderId}</strong>
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-4 text-xs text-slate-500">
                    {ret.pickup_slot && (
                      <span className="flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5 text-slate-400" /> Slot: {ret.pickup_slot}
                      </span>
                    )}
                    {ret.warehouse_received_at && (
                      <span className="flex items-center gap-1 text-emerald-700">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Received at {new Date(ret.warehouse_received_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                </div>

                {/* Details & Action Body */}
                <div className="p-4 sm:p-5 grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
                  {/* Left Column: Product & Return Metadata */}
                  <div className="lg:col-span-6 space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="w-12 h-12 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center shrink-0">
                        {ret.item?.image ? (
                          <img
                            src={ret.item.image}
                            alt={ret.item.name || 'Product'}
                            className="w-full h-full object-cover rounded-xl"
                          />
                        ) : (
                          <Box className="w-6 h-6 text-slate-400" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <h4 className="text-xs font-bold text-slate-900 truncate">
                          {ret.item?.name || ret.product_name || 'Standard Retail Item'}
                        </h4>
                        <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-3">
                          <span>Qty: <strong>{ret.quantity || ret.item?.quantity || 1}</strong></span>
                          <span>Category: <strong className="capitalize">{ret.item?.category || 'General'}</strong></span>
                          <span>Refund: <strong className="text-emerald-700">₹{ret.refund_amount || (ret.item?.price ? ret.item.price * (ret.quantity || 1) : 0)}</strong></span>
                        </div>
                        {ret.reason && (
                          <p className="text-[11px] text-slate-600 mt-1 italic">
                            Reason: "{ret.reason}"
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right Column: Workflow Actions */}
                  <div className="lg:col-span-6 flex flex-col justify-end bg-slate-50/70 p-4 rounded-xl border border-slate-200">
                    {/* Action A: If IN_TRANSIT -> Receive */}
                    {ret.status === 'IN_TRANSIT' && (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                            <Truck className="w-4 h-4 text-blue-600" />
                            Dock Intake Receipt
                          </span>
                          <span className="text-[11px] text-slate-500">Step 1 of 2</span>
                        </div>
                        <p className="text-xs text-slate-600 leading-relaxed">
                          Package arrived at warehouse unloading bay. Scan barcode or confirm physical box arrival to record intake.
                        </p>
                        <button
                          type="button"
                          disabled={isLoadingReceive}
                          onClick={() => handleReceive(ret.id)}
                          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs py-2.5 px-4 rounded-xl shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50"
                        >
                          {isLoadingReceive ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              <span>Receiving Package...</span>
                            </>
                          ) : (
                            <>
                              <Box className="w-4 h-4" />
                              <span>Receive Package into Dock</span>
                            </>
                          )}
                        </button>
                      </div>
                    )}

                    {/* Action B: If RECEIVED or INSPECTION -> Physical Inspection Station */}
                    {(ret.status === 'RECEIVED' || ret.status === 'INSPECTION') && (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                            <PackageCheck className="w-4 h-4 text-purple-600" />
                            Physical Item Inspection
                          </span>
                          <span className="text-[11px] text-slate-500">Step 2 of 2</span>
                        </div>

                        {/* Condition Note Input */}
                        <div>
                          <label className="block text-[11px] font-bold text-slate-700 mb-1">
                            Condition &amp; Verification Note:
                          </label>
                          <textarea
                            rows={2}
                            placeholder="e.g. Original packaging intact, tags verified, no signs of wear..."
                            value={currentNote}
                            onChange={(e) => handleNoteChange(ret.id, e.target.value)}
                            className="w-full text-xs p-2.5 bg-white border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                          />
                        </div>

                        {/* Quick preset chips */}
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[10px] text-slate-400 font-semibold">Presets:</span>
                          <button
                            type="button"
                            onClick={() => setPresetNote(ret.id, 'Pristine condition, original tags attached and packaging sealed')}
                            className="text-[10px] bg-white hover:bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-lg text-slate-600 cursor-pointer"
                          >
                            Pristine / Intact
                          </button>
                          <button
                            type="button"
                            onClick={() => setPresetNote(ret.id, 'Opened box, minor cosmetic wear, acceptable for restocking')}
                            className="text-[10px] bg-white hover:bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-lg text-slate-600 cursor-pointer"
                          >
                            Opened / Good
                          </button>
                          <button
                            type="button"
                            onClick={() => setPresetNote(ret.id, 'Packaging damaged, missing accessories or signs of heavy usage')}
                            className="text-[10px] bg-white hover:bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-lg text-red-600 cursor-pointer"
                          >
                            Damaged / Missing
                          </button>
                        </div>

                        {/* Pass and Fail Buttons */}
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            type="button"
                            disabled={isLoadingPass || isLoadingFail}
                            onClick={() => handleInspect(ret.id, true)}
                            className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs py-2 px-3 rounded-xl shadow-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                          >
                            {isLoadingPass ? (
                              <>
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                <span>Verifying...</span>
                              </>
                            ) : (
                              <>
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                <span>Pass Inspection</span>
                              </>
                            )}
                          </button>

                          <button
                            type="button"
                            disabled={isLoadingPass || isLoadingFail}
                            onClick={() => handleInspect(ret.id, false)}
                            className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold text-xs py-2 px-3 rounded-xl shadow-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                          >
                            {isLoadingFail ? (
                              <>
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                <span>Rejecting...</span>
                              </>
                            ) : (
                              <>
                                <XCircle className="w-3.5 h-3.5" />
                                <span>Fail Inspection</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
