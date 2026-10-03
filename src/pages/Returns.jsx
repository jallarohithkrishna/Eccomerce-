import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { db } from '../lib/firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { 
  RotateCcw, Sparkles, Package, Clock, CheckCircle2, 
  Truck, ArrowRight, ShieldCheck, QrCode, AlertTriangle, 
  ExternalLink, ChevronRight, FileText, Activity, CreditCard
} from 'lucide-react';
import AiReturnAssistant from '../components/AiReturnAssistant';
import QRCodeDisplay from '../components/QRCodeDisplay';
import ReturnModal from '../components/ReturnModal';
import { RETURN_STATUS_DETAILS, normalizeReturnStatus, RETURN_PIPELINE } from '../constants/returnStatuses';
import { RETURN_POLICIES } from '../constants/returnPolicies';

export default function Returns() {
  const { user, loading: authLoading } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const tabParam = searchParams.get('tab') || 'assistant';
  const orderParam = searchParams.get('order') || null;

  const [activeTab, setActiveTab] = useState(tabParam);
  const [returnsList, setReturnsList] = useState([]);
  const [loadingReturns, setLoadingReturns] = useState(true);
  const [selectedReturnForAudit, setSelectedReturnForAudit] = useState(null);

  // Return Modal State for existing QR and tracking
  const [modalOrderForReturn, setModalOrderForReturn] = useState(null);
  const [modalReturnData, setModalReturnData] = useState(null);
  const [isReturnModalOpen, setIsReturnModalOpen] = useState(false);

  const handleOpenExistingReturnModal = (ret) => {
    const ord = {
      id: ret.order_id,
      order_number: ret.order_number,
      returns: [ret],
      customer: ret.customer || {
        full_name: user?.user_metadata?.full_name || 'Customer',
        email: user?.email,
        address: ret.pickup_details?.address || 'Registered Address'
      }
    };
    setModalOrderForReturn(ord);
    setModalReturnData(ret);
    setIsReturnModalOpen(true);
  };

  useEffect(() => {
    window.scrollTo(0, 0);
    if (!authLoading && !user) {
      navigate('/login');
    }
  }, [user, authLoading, navigate]);

  // Sync tab with URL search parameter
  useEffect(() => {
    if (searchParams.get('tab')) {
      setActiveTab(searchParams.get('tab'));
    }
  }, [searchParams]);

  const switchTab = (tab) => {
    setActiveTab(tab);
    setSearchParams({ tab });
  };

  // Real-time listener on customer's returns
  useEffect(() => {
    if (!user) return;

    // Listen to orders to gather all customer returns
    const qOrders = query(
      collection(db, 'orders'),
      where('customer.user_id', '==', user.uid)
    );

    const unsubscribe = onSnapshot(qOrders, (snapshot) => {
      const allReturns = [];

      snapshot.forEach(docSnap => {
        const orderData = docSnap.data();
        if (Array.isArray(orderData.returns)) {
          orderData.returns.forEach(ret => {
            allReturns.push({
              ...ret,
              order_id: docSnap.id,
              order_number: orderData.order_number,
              customer_address: orderData.customer?.address
            });
          });
        }
      });

      // Sort descending by created_at
      allReturns.sort((a, b) => {
        const timeA = new Date(a.created_at || 0).getTime();
        const timeB = new Date(b.created_at || 0).getTime();
        return timeB - timeA;
      });

      setReturnsList(allReturns);
      setLoadingReturns(false);
    }, (err) => {
      console.error('Error fetching returns:', err);
      setLoadingReturns(false);
    });

    return () => unsubscribe();
  }, [user]);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8 sm:py-12">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* Page Top Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-2 bg-primary-100 text-primary-700 rounded-xl">
                <RotateCcw className="w-6 h-6" />
              </span>
              <div>
                <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
                  Returns &amp; Exchanges Hub
                </h1>
                <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
                  Autonomous AI Return Orchestration &bull; 10-Stage Live Pipeline Tracking
                </p>
              </div>
            </div>
          </div>

          {/* Tab Navigation Pill Bar */}
          <div className="flex items-center bg-white p-1.5 rounded-2xl border border-slate-200/80 shadow-xs">
            <button
              onClick={() => switchTab('assistant')}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all ${
                activeTab === 'assistant'
                  ? 'bg-gradient-to-r from-primary-600 to-indigo-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              <Sparkles className="w-4 h-4 text-yellow-300" />
              <span>AI Return Assistant</span>
            </button>

            <button
              onClick={() => switchTab('history')}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all relative ${
                activeTab === 'history'
                  ? 'bg-primary-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              <Package className="w-4 h-4" />
              <span>My Returns &amp; Tracking</span>
              {returnsList.length > 0 && (
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                  activeTab === 'history' ? 'bg-white text-primary-700' : 'bg-primary-100 text-primary-700'
                }`}>
                  {returnsList.length}
                </span>
              )}
            </button>

            <button
              onClick={() => switchTab('policies')}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all ${
                activeTab === 'policies'
                  ? 'bg-primary-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              <ShieldCheck className="w-4 h-4" />
              <span>Policies</span>
            </button>
          </div>
        </div>

        {/* Tab 1: AI Return Assistant */}
        {activeTab === 'assistant' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
            {/* Main AI Chat Column */}
            <div className="lg:col-span-2 h-[720px] max-h-[82vh]">
              <AiReturnAssistant 
                onReturnCreated={() => {
                  // After return created, user can view in tracking tab
                }}
              />
            </div>

            {/* Sidebar Information Column */}
            <div className="space-y-4">
              {/* How it Works Card */}
              <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs">
                <h3 className="font-bold text-sm text-slate-900 flex items-center gap-2 mb-3">
                  <Sparkles className="w-4 h-4 text-primary-600" />
                  How AI Returns Work
                </h3>
                <ol className="space-y-3 text-xs text-slate-600">
                  <li className="flex items-start gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-primary-50 text-primary-700 font-bold flex items-center justify-center shrink-0 text-[10px]">1</span>
                    <span><strong>Order Selection:</strong> Select your delivered order in the chat.</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-primary-50 text-primary-700 font-bold flex items-center justify-center shrink-0 text-[10px]">2</span>
                    <span><strong>Policy Evaluation:</strong> Autonomous check against item window days and terms.</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-primary-50 text-primary-700 font-bold flex items-center justify-center shrink-0 text-[10px]">3</span>
                    <span><strong>Instant RMA Code:</strong> Unique tracking code and reverse pickup pass issued.</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-primary-50 text-primary-700 font-bold flex items-center justify-center shrink-0 text-[10px]">4</span>
                    <span><strong>Doorstep Pickup:</strong> BlueDart Express collects from your doorstep.</span>
                  </li>
                </ol>
              </div>

              {/* Status Pipeline Reference */}
              <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs">
                <h3 className="font-bold text-sm text-slate-900 flex items-center gap-2 mb-3">
                  <Activity className="w-4 h-4 text-primary-600" />
                  10-Stage Pipeline
                </h3>
                <div className="space-y-1.5">
                  {RETURN_PIPELINE.map((stKey, idx) => {
                    const st = RETURN_STATUS_DETAILS[stKey];
                    return (
                      <div key={stKey} className="flex items-center justify-between text-[11px] py-1 border-b border-slate-100 last:border-0">
                        <span className="text-slate-500 font-mono text-[10px]">Stage {idx + 1}</span>
                        <span className={`px-2 py-0.5 rounded-md font-bold text-[10px] ${st.badgeClass}`}>
                          {st.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Quick Link to My Orders */}
              <div className="bg-gradient-to-br from-indigo-50 to-violet-50 p-4 rounded-2xl border border-indigo-100 text-xs text-indigo-950 flex items-center justify-between">
                <div>
                  <p className="font-bold">Need your order receipt?</p>
                  <p className="text-[11px] text-indigo-700 mt-0.5">View full order history and invoices</p>
                </div>
                <Link
                  to="/orders"
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl shadow-xs transition-colors shrink-0"
                >
                  My Orders
                </Link>
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: My Returns & Tracking */}
        {activeTab === 'history' && (
          <div className="space-y-6">
            {returnsList.length === 0 ? (
              <div className="bg-white rounded-2xl p-12 text-center border border-slate-200 shadow-xs">
                <RotateCcw className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                <h3 className="text-base font-bold text-slate-900 mb-1">No return requests yet</h3>
                <p className="text-xs text-slate-500 mb-6">
                  You haven't initiated any product returns or exchanges.
                </p>
                <button
                  onClick={() => switchTab('assistant')}
                  className="btn btn-primary text-xs py-2.5 px-4 font-bold inline-flex items-center gap-2"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>Start a Return with AI Assistant</span>
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {returnsList.map((ret, index) => {
                  const statusKey = normalizeReturnStatus(ret.status);
                  const statusMeta = RETURN_STATUS_DETAILS[statusKey] || RETURN_STATUS_DETAILS.REQUESTED;
                  const currentStepIndex = statusMeta.step || 1;

                  return (
                    <div
                      key={index}
                      className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden"
                    >
                      {/* Return Card Header */}
                      <div className="bg-slate-50/80 p-4 sm:p-5 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div className="p-2.5 bg-primary-50 text-primary-600 rounded-xl">
                            <RotateCcw className="w-5 h-5" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-extrabold text-sm text-slate-900">
                                {ret.rma_number}
                              </span>
                              <span className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full border ${statusMeta.badgeClass}`}>
                                {statusMeta.label}
                              </span>
                              {ret.is_exception && (
                                <span className="text-[10px] bg-amber-100 text-amber-800 font-bold px-2 py-0.5 rounded-full border border-amber-300 flex items-center gap-1">
                                  <AlertTriangle className="w-3 h-3" /> Exception
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-slate-500 mt-0.5">
                              Order #{ret.order_number} &bull; Requested on {ret.created_at ? new Date(ret.created_at).toLocaleDateString() : 'Recent'}
                            </p>
                          </div>
                        </div>

                        {/* Top Action Buttons */}
                        <div className="flex items-center gap-2 self-start sm:self-auto">
                          <button
                            onClick={() => setSelectedReturnForAudit(ret)}
                            className="text-xs font-bold text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-100 px-3 py-1.5 rounded-xl border border-slate-200 shadow-xs flex items-center gap-1 transition-colors"
                          >
                            <FileText className="w-3.5 h-3.5 text-slate-500" />
                            <span>Audit History</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleOpenExistingReturnModal(ret)}
                            className="text-xs font-bold text-primary-700 hover:text-primary-800 bg-primary-50 hover:bg-primary-100 px-3 py-1.5 rounded-xl border border-primary-200 shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer"
                          >
                            <QrCode className="w-3.5 h-3.5 text-primary-600" />
                            <span>View QR Code &amp; Details</span>
                          </button>
                        </div>
                      </div>

                      {/* Item & Refund Summary */}
                      <div className="p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-100">
                        <div className="flex items-center gap-3">
                          <div className="w-14 h-14 bg-slate-100 rounded-xl overflow-hidden flex-shrink-0 border border-slate-100 flex items-center justify-center">
                            {ret.item?.image_url ? (
                              <img src={ret.item.image_url} alt={ret.item.name} className="w-full h-full object-contain p-1" />
                            ) : (
                              <Package className="w-6 h-6 text-slate-300" />
                            )}
                          </div>
                          <div>
                            <h4 className="font-bold text-sm text-slate-900">{ret.item?.name}</h4>
                            <p className="text-xs text-slate-500">
                              Qty: {ret.item?.quantity || 1} &bull; Reason: {ret.reason_code?.replace('_', ' ') || 'General'}
                            </p>
                            {ret.reason_text && (
                              <p className="text-[11px] text-slate-400 italic mt-0.5">"{ret.reason_text}"</p>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-6 text-xs">
                          <div>
                            <p className="text-[10px] text-slate-400 uppercase font-bold">Settlement</p>
                            <p className="font-bold text-slate-800 capitalize">
                              {ret.resolution_type?.replace('_', ' ') || 'Store Credit'}
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] text-slate-400 uppercase font-bold">Refund Amount</p>
                            <p className="font-extrabold text-sm text-emerald-600">
                              ₹{Number(ret.refund_amount || 0).toFixed(2)}
                            </p>
                          </div>
                          {ret.pickup_details?.slot && (
                            <div className="hidden sm:block">
                              <p className="text-[10px] text-slate-400 uppercase font-bold">Pickup Slot</p>
                              <p className="font-medium text-slate-700">{ret.pickup_details.slot}</p>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* 10-Stage Pipeline Horizontal Tracker */}
                      <div className="p-4 sm:p-5 bg-slate-50/50">
                        <div className="flex items-center justify-between mb-3">
                          <p className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                            <Activity className="w-3.5 h-3.5 text-primary-600" />
                            <span>10-Stage Return Pipeline Progress</span>
                          </p>
                          <span className="text-[11px] font-bold text-slate-500">
                            Stage {currentStepIndex} of 10 ({statusMeta.shortLabel})
                          </span>
                        </div>

                        {/* Progress Bar */}
                        <div className="relative mb-4">
                          <div className="overflow-hidden h-2 text-xs flex rounded-full bg-slate-200">
                            <div
                              style={{ width: `${Math.min(100, (currentStepIndex / 10) * 100)}%` }}
                              className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-gradient-to-r from-primary-600 to-emerald-500 transition-all duration-500"
                            />
                          </div>
                        </div>

                        {/* Stage Chips */}
                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                          {RETURN_PIPELINE.map((pipeKey, idx) => {
                            const pipeMeta = RETURN_STATUS_DETAILS[pipeKey];
                            const isDone = idx + 1 <= currentStepIndex;
                            const isCurrent = idx + 1 === currentStepIndex;

                            return (
                              <div
                                key={pipeKey}
                                className={`p-2 rounded-xl border text-[11px] transition-all ${
                                  isCurrent
                                    ? 'bg-primary-50 border-primary-400 text-primary-950 font-bold shadow-xs'
                                    : isDone
                                    ? 'bg-white border-slate-200 text-slate-700'
                                    : 'bg-slate-100/60 border-slate-200/60 text-slate-400'
                                }`}
                              >
                                <div className="flex items-center gap-1.5">
                                  <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold ${
                                    isDone ? 'bg-emerald-500 text-white' : 'bg-slate-300 text-slate-700'
                                  }`}>
                                    {idx + 1}
                                  </span>
                                  <span className="truncate">{pipeMeta.shortLabel}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Return Policies Reference */}
        {activeTab === 'policies' && (
          <div className="bg-white rounded-2xl p-6 sm:p-8 border border-slate-200 shadow-xs space-y-6">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Standard Return Policies</h2>
              <p className="text-xs text-slate-500 mt-1">
                Our AI Return Agent applies these exact category rules with zero deviation.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Object.entries(RETURN_POLICIES).map(([catKey, pol]) => (
                <div key={catKey} className="p-4 rounded-2xl border border-slate-200 space-y-2 hover:border-primary-400 transition-colors">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-sm text-slate-900 capitalize">{catKey}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${pol.badgeColor}`}>
                      {pol.badge}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600">{pol.description}</p>
                  <div className="text-[11px] text-slate-500 pt-2 border-t border-slate-100">
                    <strong>Conditions:</strong>
                    <ul className="list-disc pl-4 mt-1 space-y-0.5 text-slate-600">
                      {pol.conditions?.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>

      {/* Modal: Audit History Modal */}
      {selectedReturnForAudit && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-xl w-full max-h-[85vh] flex flex-col overflow-hidden shadow-2xl animate-scale-up">
            <div className="p-4 px-6 bg-slate-900 text-white flex items-center justify-between">
              <div>
                <h3 className="font-bold text-sm flex items-center gap-2">
                  <FileText className="w-4 h-4 text-primary-400" />
                  Audit History: {selectedReturnForAudit.rma_number}
                </h3>
                <p className="text-[11px] text-slate-400">
                  Immutable chronological record of all agent &amp; user actions
                </p>
              </div>
              <button
                onClick={() => setSelectedReturnForAudit(null)}
                className="p-1 rounded-lg hover:bg-white/10 text-white/80 transition-colors"
              >
                &times;
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4 flex-1 bg-slate-50">
              {selectedReturnForAudit.audit_history && selectedReturnForAudit.audit_history.length > 0 ? (
                <div className="relative border-l-2 border-primary-200 ml-3 space-y-6 py-2">
                  {selectedReturnForAudit.audit_history.map((entry, idx) => (
                    <div key={idx} className="relative pl-6">
                      <div className="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-primary-600 border-2 border-white shadow-xs" />
                      <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-xs">
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="font-bold text-slate-900">
                            {entry.actor_name || entry.actor || 'System'}
                          </span>
                          <span className="text-[10px] text-slate-400">
                            {entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'N/A'}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-600">{entry.details}</p>
                        <span className="inline-block mt-1 text-[9px] bg-slate-100 text-slate-500 px-1.5 py-0.2 rounded-sm font-mono">
                          {entry.action}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-500 text-center py-8">No audit entries recorded yet.</p>
              )}
            </div>

            <div className="p-4 bg-white border-t border-slate-100 flex justify-end">
              <button
                onClick={() => setSelectedReturnForAudit(null)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl transition-colors"
              >
                Close Audit View
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Existing Return Modal Popup Component */}
      {isReturnModalOpen && modalOrderForReturn && (
        <ReturnModal
          isOpen={isReturnModalOpen}
          onClose={() => {
            setIsReturnModalOpen(false);
            setModalOrderForReturn(null);
            setModalReturnData(null);
          }}
          order={modalOrderForReturn}
          existingReturn={modalReturnData}
          initialTab="track"
        />
      )}
    </div>
  );
}
