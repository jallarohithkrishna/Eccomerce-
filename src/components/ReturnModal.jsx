import { useState, useId, useEffect } from 'react';
import { db } from '../lib/firebase';
import { doc, updateDoc, collection, addDoc, serverTimestamp, query, where, getDocs } from 'firebase/firestore';
import { resolvePolicyForCategory, resolvePolicyForItem, isElectronicsItem } from '../constants/returnPolicies';
import { normalizeReturnStatus, RETURN_STATUS_DETAILS } from '../constants/returnStatuses';
import QRCodeDisplay from './QRCodeDisplay';
import { useAuth } from '../context/AuthContext';
import { 
  X, RotateCcw, ShieldCheck, AlertCircle, CheckCircle2, 
  Truck, ArrowRight, Check, Clock, QrCode, CreditCard, RefreshCw, Sparkles,
  Wrench, MapPin, Phone, Printer, Download, Copy
} from 'lucide-react';

export default function ReturnModal({ isOpen, onClose, order, existingReturn = null, initialTab = null }) {
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState(() => {
    return existingReturn || (order?.returns && order.returns.length > 0) ? 'track' : 'initiate';
  });
  const [submitting, setSubmitting] = useState(false);
  const [successRma, setSuccessRma] = useState(null);
  const [advancingStage, setAdvancingStage] = useState(false);
  const [showQrPassModal, setShowQrPassModal] = useState(false);
  const [copiedRma, setCopiedRma] = useState(false);

  useEffect(() => {
    if (isOpen) {
      if (initialTab) {
        setActiveTab(initialTab);
      } else if (existingReturn || (order?.returns && order.returns.length > 0) || successRma) {
        setActiveTab('track');
      } else {
        setActiveTab('initiate');
      }
    }
  }, [isOpen, existingReturn, order?.returns, successRma, initialTab]);

  // Form State for Return Initiation
  const [selectedItemIndex, setSelectedItemIndex] = useState(() => {
    const firstAvailable = order?.items?.findIndex(item => !order?.returns?.some(r => r.item?.name === item.name));
    return firstAvailable >= 0 ? firstAvailable : 0;
  });
  const [returnQty, setReturnQty] = useState(1);
  const [reasonCode, setReasonCode] = useState('wrong_size');
  const [customerNotes, setCustomerNotes] = useState('');
  const [resolutionType, setResolutionType] = useState('store_credit');
  const [pickupSlot, setPickupSlot] = useState('tomorrow_morning');
  const [photoProof, setPhotoProof] = useState('');

  // Service Center Form State
  const [scName, setScName] = useState(order?.customer?.full_name || '');
  const [scPhone, setScPhone] = useState('');
  const [scImei, setScImei] = useState('');
  const [scIssue, setScIssue] = useState('');
  const [scCity, setScCity] = useState('');
  const [scSubmitted, setScSubmitted] = useState(false);
  const [scBlocked, setScBlocked] = useState(false); // shown after electronics tries to submit

  const handleSafeClose = () => {
    setSuccessRma(null);
    setShowQrPassModal(false);
    setScBlocked(false);
    onClose();
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (showQrPassModal) {
          setShowQrPassModal(false);
        } else if (isOpen) {
          handleSafeClose();
        }
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, showQrPassModal]);

  if (!isOpen || !order) return null;

  const handleCopyRma = (text) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
    }
    setCopiedRma(true);
    setTimeout(() => setCopiedRma(false), 2000);
  };

  const handlePrintPass = () => {
    window.print();
  };

  const handleDownloadQr = () => {
    const imgEl = document.querySelector('#pickup-pass-modal img');
    if (imgEl && imgEl.src) {
      const a = document.createElement('a');
      a.href = imgEl.src;
      a.download = `Pickup-Pass-${currentReturn?.rma_number || 'Pass'}.png`;
      a.click();
    }
  };

  const targetRma = successRma?.rma_number || existingReturn?.rma_number;
  const matchingOrderReturn = order.returns?.find(r => r.rma_number === targetRma) || (order.returns && order.returns.length > 0 ? order.returns[order.returns.length - 1] : null);
  const currentReturn = matchingOrderReturn || successRma || existingReturn || null;

  // Distinguish AI agent returns from normal/manual returns
  const isNormalReturn = Boolean(
    currentReturn?.source === 'manual' ||
    currentReturn?.return_mode === 'manual' ||
    currentReturn?.is_agent === false ||
    (!currentReturn?.source && !currentReturn?.audit_history && Array.isArray(currentReturn?.timeline) && currentReturn?.timeline.some(t => t.stage)) ||
    (!currentReturn?.source && currentReturn?.status === 'approved' && !currentReturn?.audit_history)
  );

  const isAiAgentReturn = !isNormalReturn && Boolean(
    currentReturn?.source === 'ai_agent' ||
    currentReturn?.return_mode === 'ai_agent' ||
    currentReturn?.is_agent === true ||
    currentReturn?.approved_by === 'Autonomous AI Return Agent' ||
    currentReturn?.approved_by === 'Pending Staff Review' ||
    currentReturn?.is_exception === true ||
    (Array.isArray(currentReturn?.audit_history) && currentReturn.audit_history.length > 0)
  );

  const getQrVerificationUrl = (ret) => {
    if (!ret) return '';
    const origin = typeof window !== 'undefined' && window.location.origin.includes('http')
      ? window.location.origin
      : 'https://rrrrr-711b3.web.app';
    const params = new URLSearchParams({
      rma: ret.rma_number || '',
      order: ret.order_number || '',
      item: ret.item?.name || '',
      price: String(ret.item?.price || ret.original_price || ''),
      qty: String(ret.item?.quantity || 1),
      refund: String(ret.refund_amount || ''),
      carrier: ret.pickup_details?.carrier || 'BlueDart Express Reverse',
      track: ret.pickup_details?.tracking_number || '',
      slot: ret.pickup_details?.slot || '',
      addr: ret.pickup_details?.address || '',
      res: ret.resolution_type || 'store_credit'
    });
    return `${origin}/returns/verify?${params.toString()}`;
  };

  // Advance return through pipeline stages — works for both agent and manual returns
  const handleAdvanceWarehouseStage = async (nextStatus) => {
    if (!currentReturn || !order?.id) return;
    setAdvancingStage(true);
    const nowIso = new Date().toISOString();
    const statusMeta = RETURN_STATUS_DETAILS[nextStatus] || { label: nextStatus, step: 1 };

    try {
      // Map each pipeline status to the relevant timeline entry by status key
      const updatedTimeline = (currentReturn.timeline || []).map(step => {
        const stepStatus = step.status || '';
        // Mark this step done if it matches or precedes the target stage by step number
        const stepMeta = RETURN_STATUS_DETAILS[stepStatus];
        if (stepMeta && stepMeta.step <= statusMeta.step) {
          return { ...step, done: true, timestamp: step.done ? step.timestamp : nowIso };
        }
        return step;
      });

      // Build audit entry
      const auditEntry = {
        id: `AUD-${Date.now()}`,
        timestamp: nowIso,
        actor: 'STAFF',
        actor_name: 'Admin',
        action: `STATUS_CHANGED_TO_${nextStatus}`,
        details: `Return advanced to "${statusMeta.label}" by Admin.`
      };

      const updatedReturnRecord = {
        ...currentReturn,
        status: nextStatus,
        status_label: statusMeta.label,
        timeline: updatedTimeline,
        audit_history: [...(currentReturn.audit_history || []), auditEntry],
        updated_at: nowIso
      };

      const newReturnsList = order.returns?.map(r =>
        r.rma_number === currentReturn.rma_number ? updatedReturnRecord : r
      ) || [updatedReturnRecord];

      const orderRef = doc(db, 'orders', order.id);
      await updateDoc(orderRef, {
        returns: newReturnsList,
        return_status: nextStatus.toLowerCase(),
        updated_at: serverTimestamp()
      });

      // Also sync to top-level returns collection
      try {
        const retQ = query(collection(db, 'returns'), where('rma_number', '==', currentReturn.rma_number));
        const retSnap = await getDocs(retQ);
        if (!retSnap.empty) {
          await updateDoc(doc(db, 'returns', retSnap.docs[0].id), {
            status: nextStatus,
            status_label: statusMeta.label,
            timeline: updatedTimeline,
            audit_history: updatedReturnRecord.audit_history,
            updated_at: serverTimestamp()
          });
        }
      } catch (syncErr) {
        console.warn('Returns collection sync skipped:', syncErr.message);
      }

      setSuccessRma(updatedReturnRecord);
    } catch (err) {
      console.error('Error advancing return stage:', err);
      alert('Error updating status: ' + err.message);
    } finally {
      setAdvancingStage(false);
    }
  };

  const selectedItem = order.items?.[selectedItemIndex] || order.items?.[0] || {};
  const itemPolicy = resolvePolicyForItem(selectedItem);
  const isServiceCenterItem = itemPolicy.policy_type === 'service_center_only' || isElectronicsItem(selectedItem);

  const handleSubmitServiceCenter = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const scRequest = {
        type: 'service_center_request',
        order_id: order.id,
        order_number: order.order_number,
        user_id: order.customer?.user_id ?? user?.uid ?? null,
        item: {
          name: selectedItem.name,
          price: selectedItem.price,
          image_url: selectedItem.image_url || null,
          category: selectedItem.category || null,
          product_id: selectedItem.product_id || null
        },
        customer_name: scName,
        phone: scPhone,
        imei_serial: scImei,
        issue_description: scIssue,
        preferred_city: scCity,
        status: 'pending',
        created_at: new Date().toISOString()
      };

      // Save to returns collection as service_center type
      const updatedReturns = order.returns ? [...order.returns, scRequest] : [scRequest];
      const orderRef = doc(db, 'orders', order.id);
      await updateDoc(orderRef, {
        returns: updatedReturns,
        updated_at: serverTimestamp()
      });

      try {
        await addDoc(collection(db, 'returns'), {
          ...scRequest,
          created_at_server: serverTimestamp()
        });
      } catch (err) {
        console.warn('Service center request write to returns collection skipped:', err.message);
      }

      setScSubmitted(true);
    } catch (err) {
      console.error('Error submitting service center request:', err);
      alert('Could not submit request: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // Calculate order age
  const orderDate = order.created_at?.toDate ? order.created_at.toDate() : new Date();
  const daysElapsed = Math.max(0, Math.floor((new Date() - orderDate) / (1000 * 60 * 60 * 24)));
  const isWithinWindow = itemPolicy.window_days === 0 ? false : daysElapsed <= itemPolicy.window_days;

  const refundAmount = (Number(selectedItem.price) || 0) * returnQty;
  const storeCreditBonus = (refundAmount * 0.05);
  const totalStoreCredit = refundAmount + storeCreditBonus;

  const REASONS = [
    { id: 'wrong_size', label: 'Size / Fit Issue', eligible: true },
    { id: 'defective', label: 'Defective / Faulty Item', eligible: true },
    { id: 'damaged_transit', label: 'Damaged in Shipping', eligible: true },
    { id: 'not_as_described', label: 'Item Differs from Pictures', eligible: true },
    { id: 'changed_mind', label: 'Changed Mind / No Longer Needed', eligible: itemPolicy.eligible }
  ];

  const handleSubmitReturn = async (e) => {
    e.preventDefault();

    // Electronics — redirect to service center info card
    if (isElectronicsItem(selectedItem) || itemPolicy.policy_type === 'service_center_only') {
      setScBlocked(true);
      return;
    }

    setSubmitting(true);

    try {
      const rmaCode = `RMA-${Math.floor(100000 + Math.random() * 900000)}`;
      const trackingNumber = `RET-DEL-${Math.floor(10000000 + Math.random() * 90000000)}`;
      
      // Standard return without AI agent mode
      const returnStatus = 'approved';
      const statusLabel = 'Return Approved';
      const approvedBy = 'Standard Return Policy';

      const newReturnRecord = {
        rma_number: rmaCode,
        order_id: order.id ?? null,
        order_number: order.order_number ?? null,
        user_id: order.customer?.user_id ?? user?.uid ?? null,
        status: returnStatus,
        status_label: statusLabel,
        approved_by: approvedBy,
        source: 'manual',
        return_mode: 'manual',
        is_agent: false,
        created_at: new Date().toISOString(),
        item: {
          name: selectedItem.name ?? null,
          price: Number(selectedItem.price) || 0,
          quantity: returnQty,
          image_url: selectedItem.image_url ?? selectedItem.images?.[0] ?? null,
          category: selectedItem.category ?? 'General'
        },
        reason_code: reasonCode,
        customer_notes: customerNotes ?? '',
        resolution_type: resolutionType,
        refund_amount: resolutionType === 'store_credit' ? totalStoreCredit : refundAmount,
        original_price: refundAmount,
        store_credit_bonus: resolutionType === 'store_credit' ? storeCreditBonus : 0,
        pickup_details: {
          carrier: 'BlueDart Express Reverse',
          tracking_number: trackingNumber,
          slot: pickupSlot === 'tomorrow_morning' ? 'Tomorrow, 10:00 AM - 1:00 PM' : 'Tomorrow, 2:00 PM - 6:00 PM',
          address: order.customer?.address 
            ? `${order.customer.address.street ?? ''}, ${order.customer.address.city ?? ''} ${order.customer.address.zip_code ?? ''}`
            : 'Registered Customer Address'
        },
        timeline: [
          { stage: 'Return Requested', timestamp: new Date().toISOString(), done: true },
          { stage: 'Return Approved', timestamp: new Date().toISOString(), done: true },
          { stage: 'Pickup Scheduled with Courier', timestamp: 'Scheduled', done: true },
          { stage: 'Item Inspection & Verification', timestamp: 'Estimated in 3 days', done: false },
          { stage: 'Refund Credited', timestamp: 'Estimated in 3 days', done: false }
        ]
      };

      // 1. Update the order document directly
      const updatedReturns = order.returns ? [...order.returns, newReturnRecord] : [newReturnRecord];
      const orderRef = doc(db, 'orders', order.id);
      await updateDoc(orderRef, {
        returns: updatedReturns,
        return_status: 'approved',
        updated_at: serverTimestamp()
      });

      // 2. Also try creating a top-level return document (if collection allowed)
      try {
        await addDoc(collection(db, 'returns'), {
          ...newReturnRecord,
          created_at_server: serverTimestamp()
        });
      } catch (err) {
        console.warn('Top-level returns collection write skipped:', err.message);
      }

      setSuccessRma(newReturnRecord);
      // Immediately close the modal popup card on successful submission
      handleSafeClose();
    } catch (err) {
      console.error('Error submitting return:', err);
      alert('Could not submit return: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div 
      onClick={handleSafeClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200"
    >
      <div 
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden border border-slate-100"
      >
        
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-100 bg-slate-50/70">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-primary-100 text-primary-700 rounded-2xl">
              <RotateCcw className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-xl font-bold text-slate-900">
                {currentReturn && activeTab === 'track' ? 'Return Status & Tracking' : 'Request Return / Exchange'}
              </h3>
              <p className="text-xs text-slate-500">Order #{order.order_number}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSafeClose}
              className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 rounded-full transition-colors ml-2"
              title="Close Window"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="overflow-y-auto p-6 space-y-6 flex-1">
          {activeTab === 'track' && currentReturn ? (
            /* TRACKING VIEW */
            <div className="space-y-6">
              {/* RMA Banner */}
              <div className="bg-gradient-to-r from-primary-900 to-slate-900 text-white p-6 rounded-2xl relative overflow-hidden shadow-lg">
                <div className="flex justify-between items-start relative z-10">
                  <div>
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-primary-500/20 text-primary-300 border border-primary-500/30 mb-2">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {currentReturn.status_label || (isAiAgentReturn ? 'Approved & Scheduled' : 'Return Approved')}
                    </span>
                    <h4 className="text-2xl font-black tracking-wide font-mono text-white">
                      {currentReturn.rma_number}
                    </h4>
                    <p className="text-xs text-slate-300 mt-1">
                      Carrier: <span className="font-semibold text-white">{currentReturn.pickup_details?.carrier || 'BlueDart Express Reverse'}</span>
                    </p>
                    <p className="text-[11px] text-primary-300 mt-1 flex items-center gap-1.5 font-medium">
                      {isAiAgentReturn ? (
                        <Sparkles className="w-3.5 h-3.5 text-primary-400 flex-shrink-0" />
                      ) : (
                        <RotateCcw className="w-3.5 h-3.5 text-primary-400 flex-shrink-0" />
                      )}
                      Approved by: {currentReturn.approved_by || (isAiAgentReturn ? 'Autonomous AI Return Agent' : 'Standard Return Policy')}
                    </p>
                    {isAiAgentReturn && currentReturn.ai_assessment?.decision_rule && (
                      <p className="text-[10px] text-slate-300/80 italic mt-0.5 max-w-sm">
                        {currentReturn.ai_assessment.decision_rule}
                      </p>
                    )}
                  </div>

                  <div 
                    onClick={() => setShowQrPassModal(true)}
                    className="bg-white p-2.5 rounded-2xl shadow-xl border border-white/20 text-center cursor-pointer hover:scale-105 transition-all group flex flex-col items-center justify-center flex-shrink-0"
                    title="Click to view & print full Courier Pickup Pass"
                  >
                    <QRCodeDisplay
                      value={getQrVerificationUrl(currentReturn)}
                      size={68}
                      className="rounded-lg shadow-sm"
                    />
                    <span className="text-[10px] font-mono font-bold text-slate-800 mt-1">
                      {currentReturn.pickup_details?.tracking_number?.slice(0, 11)}
                    </span>
                    <span className="text-[9px] text-primary-600 font-semibold group-hover:underline flex items-center gap-0.5 mt-0.5">
                      <QrCode className="w-2.5 h-2.5" /> Tap for Pass
                    </span>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-white/10 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-300">
                  <div>
                    <span className="text-slate-400 block">Scheduled Pickup</span>
                    <span className="font-semibold text-white">{currentReturn.pickup_details?.slot}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Refund Expected</span>
                    <span className="font-semibold text-primary-400">₹{Number(currentReturn.refund_amount).toFixed(2)}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Resolution</span>
                    <span className="font-semibold text-white capitalize">{currentReturn.resolution_type?.replace('_', ' ')}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowQrPassModal(true)}
                    className="px-3 py-1.5 rounded-xl bg-white/15 hover:bg-white/25 text-white text-xs font-bold transition-colors flex items-center gap-1.5 backdrop-blur-sm border border-white/20 shadow-sm"
                  >
                    <QrCode className="w-3.5 h-3.5 text-primary-300" />
                    <span>View Pickup Pass &amp; QR</span>
                  </button>
                </div>
              </div>

              {/* Item Returned Details */}
              <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-4 flex items-center gap-4">
                <div className="h-16 w-16 bg-white rounded-xl border border-slate-200 flex items-center justify-center overflow-hidden flex-shrink-0 p-1">
                  {currentReturn.item?.image_url ? (
                    <img src={currentReturn.item.image_url} alt={currentReturn.item.name} className="h-full w-full object-contain" />
                  ) : (
                    <RotateCcw className="w-6 h-6 text-slate-300" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="font-bold text-slate-900 text-sm truncate">{currentReturn.item?.name}</h4>
                  <p className="text-xs text-slate-500">
                    Qty: {currentReturn.item?.quantity} • Reason: <span className="capitalize">{currentReturn.reason_code?.replace('_', ' ')}</span>
                  </p>
                  <p className="text-xs text-primary-600 font-semibold mt-0.5">
                    Original Price: ₹{Number(currentReturn.original_price || currentReturn.refund_amount).toFixed(2)}
                    {currentReturn.store_credit_bonus > 0 && (
                      <span className="text-emerald-600 ml-1.5">(+₹{currentReturn.store_credit_bonus.toFixed(2)} Store Bonus)</span>
                    )}
                  </p>
                </div>
              </div>

              {/* Progress Stepper — supports both 10-stage pipeline and legacy 5-step */}
              <div className="bg-white border border-slate-200 rounded-2xl p-6">
                <h4 className="font-bold text-slate-900 text-sm mb-5 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-primary-600" />
                  Return Milestone Timeline
                </h4>

                <div className="relative border-l-2 border-primary-200 ml-3.5 space-y-4">
                  {currentReturn.timeline?.filter(step => step.title !== 'Staff Decision Pending').map((step, idx) => (
                    <div key={idx} className="relative pl-6">
                      <span className={`absolute -left-[9px] top-1.5 w-4 h-4 rounded-full border-2 border-white flex items-center justify-center ${
                        step.done ? 'bg-primary-600' : 'bg-slate-200'
                      }`}>
                        {step.done && <Check className="w-2.5 h-2.5 text-white stroke-[3]" />}
                      </span>
                      <p className={`text-sm font-semibold ${
                        step.done ? 'text-slate-900' : 'text-slate-400'
                      }`}>
                        {/* Support both old format (stage) and new pipeline format (title) */}
                        {step.title || step.stage}
                      </p>
                      {(step.description) && (
                        <p className="text-[11px] text-slate-400">{step.description}</p>
                      )}
                      <p className="text-xs text-slate-500 mt-0.5">{step.timestamp}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Warehouse & Refund Management Panel — Admin Only AND AI Agent Mode Only */}
              {(() => {
                const adminEmails = ['k71540270@gmail.com', 'jallarohithkrishna@gmail.com'];
                const uEmail = user?.email || user?.user_metadata?.email || '';
                const uRole = user?.user_metadata?.role;
                const isAdminUser = uRole === 'admin' || adminEmails.includes(uEmail);
                if (!isAdminUser) return null;
                // Hide warehouse option if product was returned normally without AI agent mode
                if (!isAiAgentReturn) return null;
                return true;
              })() && (() => {
                const curStage = normalizeReturnStatus(currentReturn.status);
                const curStep = RETURN_STATUS_DETAILS[curStage]?.step || 0;
                const isCompleted = curStage === 'COMPLETED';
                const isRefundProcessing = curStage === 'REFUND_PROCESSING';
                const isInspected = curStage === 'INSPECTION';
                const isReceived = curStage === 'RECEIVED';
                const isInTransit = curStage === 'IN_TRANSIT';
                const isPickupOrBelow = curStep <= 5;

                return (
                  <div className="bg-slate-900 text-white rounded-2xl p-5 shadow-md border border-slate-800 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="p-2 bg-primary-500/20 text-primary-400 rounded-xl">
                          <Truck className="w-4 h-4" />
                        </div>
                        <div>
                          <h5 className="font-bold text-sm text-white">Warehouse & Refund Management</h5>
                          <p className="text-xs text-slate-400">Admin controls — advance pipeline stages</p>
                        </div>
                      </div>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                        RETURN_STATUS_DETAILS[curStage]?.badgeClass || 'bg-slate-800 text-slate-300 border-slate-700'
                      }`}>
                        {RETURN_STATUS_DETAILS[curStage]?.shortLabel || curStage}
                      </span>
                    </div>

                    {/* Current status message */}
                    {isCompleted ? (
                      <div className="bg-emerald-900/30 p-3.5 rounded-xl border border-emerald-700/40 flex items-center gap-2.5 text-xs text-emerald-300">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                        <span><strong>Return Completed & Settled:</strong> Item restocked & {currentReturn.resolution_type === 'replacement' ? 'replacement dispatched' : 'refund disbursed'}.</span>
                      </div>
                    ) : isRefundProcessing ? (
                      <div className="bg-emerald-950/40 p-3 rounded-xl border border-emerald-800/40 text-xs text-emerald-200">
                        <p className="font-semibold text-white flex items-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          Refund processing — ₹{Number(currentReturn.refund_amount).toFixed(2)} ({currentReturn.resolution_type?.replace('_', ' ')})
                        </p>
                      </div>
                    ) : isInspected ? (
                      <div className="bg-purple-900/30 p-3 rounded-xl border border-purple-700/40 text-xs text-purple-200">
                        <p className="font-semibold text-white">✓ Inspection passed — ready for refund initiation</p>
                      </div>
                    ) : isReceived ? (
                      <div className="bg-orange-900/30 p-3 rounded-xl border border-orange-700/40 text-xs text-orange-200">
                        <p className="font-semibold text-white">Package received at hub — pending quality inspection</p>
                      </div>
                    ) : (
                      <div className="bg-slate-800/60 p-3 rounded-xl border border-slate-700/60 text-xs text-slate-300">
                        <p className="font-semibold text-white">Item in transit via {currentReturn.pickup_details?.carrier || 'BlueDart Express'}</p>
                        <p className="text-slate-400 mt-0.5">Tracking: {currentReturn.pickup_details?.tracking_number}</p>
                      </div>
                    )}

                    {/* Admin Action Buttons */}
                    {!isCompleted && (
                      <div className="pt-1 border-t border-slate-800">
                        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Admin: Advance Pipeline Stage</p>
                        <div className="flex flex-wrap gap-2">
                          {isPickupOrBelow && (
                            <button
                              type="button"
                              disabled={advancingStage}
                              onClick={() => handleAdvanceWarehouseStage('RECEIVED')}
                              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 transition-colors disabled:opacity-50"
                            >
                              <Truck className="w-3.5 h-3.5 text-orange-400" />
                              <span>Warehouse Received</span>
                            </button>
                          )}
                          {(isPickupOrBelow || isReceived || isInTransit) && (
                            <button
                              type="button"
                              disabled={advancingStage}
                              onClick={() => handleAdvanceWarehouseStage('INSPECTION')}
                              className="px-3 py-1.5 bg-purple-700 hover:bg-purple-600 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 transition-colors disabled:opacity-50"
                            >
                              <ShieldCheck className="w-3.5 h-3.5 text-purple-200" />
                              <span>Pass Inspection</span>
                            </button>
                          )}
                          {!isCompleted && (
                            <button
                              type="button"
                              disabled={advancingStage}
                              onClick={() => handleAdvanceWarehouseStage('REFUND_PROCESSING')}
                              className="px-3 py-1.5 bg-rose-700 hover:bg-rose-600 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 transition-colors disabled:opacity-50"
                            >
                              <CreditCard className="w-3.5 h-3.5 text-rose-200" />
                              <span>Initiate Refund</span>
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={advancingStage}
                            onClick={() => handleAdvanceWarehouseStage('COMPLETED')}
                            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 transition-colors disabled:opacity-50 shadow-sm"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Mark Completed</span>
                          </button>
                        </div>
                        {advancingStage && (
                          <p className="text-[11px] text-slate-400 mt-2 flex items-center gap-1.5">
                            <span className="animate-spin inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full" />
                            Updating pipeline status...
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Handover Instructions */}
              <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 text-xs text-blue-800 space-y-1">
                <p className="font-bold flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-blue-600" />
                  Pickup Instructions
                </p>
                <p>
                  Keep the item in its original box or bag. Hand over the package to the courier agent when they arrive. Show the RMA QR code or provide the RMA number <strong className="font-mono">{currentReturn.rma_number}</strong>.
                </p>
              </div>

              {/* Option to return another item if more items exist */}
              {order.items?.some(item => !order.returns?.some(r => r.item?.name === item.name)) && (
                <div className="pt-2 text-center">
                  <button
                    type="button"
                    onClick={() => setActiveTab('initiate')}
                    className="inline-flex items-center gap-1.5 text-xs font-bold text-primary-600 hover:text-primary-800 bg-primary-50/70 hover:bg-primary-100/70 border border-primary-200/60 px-4 py-2 rounded-xl transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Return another item from this order</span>
                  </button>
                </div>
              )}

              {/* Bottom Action Footer for Tracking View */}
              <div className="pt-4 mt-2 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setShowQrPassModal(true)}
                  className="w-full sm:w-auto btn btn-secondary py-2.5 px-4 text-xs font-bold flex items-center justify-center gap-1.5 border border-slate-200 hover:border-primary-500 hover:text-primary-700 bg-white shadow-xs"
                >
                  <QrCode className="w-4 h-4 text-primary-600" />
                  <span>View &amp; Print QR Pass</span>
                </button>

                <button
                  type="button"
                  onClick={handleSafeClose}
                  className="w-full sm:w-auto btn btn-primary py-2.5 px-6 text-xs font-bold flex items-center justify-center gap-1.5 shadow-md shadow-primary-600/20"
                >
                  <Check className="w-4 h-4" />
                  <span>Done / Close Window</span>
                </button>
              </div>
            </div>
          ) : (
            /* INITIATION WIZARD */
            <div className="space-y-6">
              {currentReturn && (
                <button
                  type="button"
                  onClick={() => setActiveTab('track')}
                  className="text-xs text-primary-700 hover:text-primary-900 font-bold flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg transition-colors mb-2"
                >
                  <ArrowRight className="w-3.5 h-3.5 rotate-180" />
                  <span>Back to Active Return Details &amp; QR</span>
                </button>
              )}
              
              {/* Step 1: Select Item to Return */}
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                  1. Select Item to Return
                </label>
                <div className="space-y-2">
                  {order.items?.map((item, idx) => {
                    const isAlreadyReturned = order.returns?.some(r => r.item?.name === item.name);
                    if (isAlreadyReturned) return null;
                    
                    const isSelected = selectedItemIndex === idx;
                    const pol = resolvePolicyForItem(item);
                    return (
                      <div
                        key={idx}
                        onClick={() => {
                          setSelectedItemIndex(idx);
                          setReturnQty(1);
                          setScBlocked(false);
                        }}
                        className={`flex items-center justify-between p-3.5 rounded-2xl border cursor-pointer transition-all ${
                          isSelected 
                            ? 'border-primary-500 bg-primary-50/40 ring-2 ring-primary-500/20' 
                            : 'border-slate-200 hover:border-slate-300 bg-white'
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="h-12 w-12 bg-slate-100 rounded-xl overflow-hidden flex-shrink-0 p-1 flex items-center justify-center">
                            {item.image_url ? (
                              <img src={item.image_url} alt={item.name} className="h-full w-full object-contain" />
                            ) : (
                              <RotateCcw className="w-5 h-5 text-slate-300" />
                            )}
                          </div>
                          <div className="truncate">
                            <p className="font-semibold text-slate-900 text-sm truncate">{item.name}</p>
                            <p className="text-xs text-slate-500">
                              ₹{Number(item.price).toFixed(2)} • Ordered: {item.quantity}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${pol.badgeColor}`}>
                            {pol.badge}
                          </span>
                          <input
                            type="radio"
                            name="returnItem"
                            checked={isSelected}
                            onChange={() => setSelectedItemIndex(idx)}
                            className="text-primary-600 focus:ring-primary-500 h-4 w-4"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Return Policy Card */}
              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className={`w-5 h-5 ${isServiceCenterItem ? 'text-orange-500' : isWithinWindow ? 'text-primary-600' : 'text-amber-600'}`} />
                    <span className="font-bold text-slate-900 text-sm">Return Policy</span>
                  </div>
                  <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                    isServiceCenterItem
                      ? 'bg-orange-100 text-orange-700'
                      : isWithinWindow ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
                  }`}>
                    {isServiceCenterItem ? 'Service Center Only' : isWithinWindow ? 'Eligible for Return' : 'Review Exception'}
                  </span>
                </div>
                <p className="text-xs text-slate-600">
                  {itemPolicy.title}. {itemPolicy.description}
                </p>
                <div className="text-[11px] text-slate-500 flex items-center gap-3 pt-1 border-t border-slate-200">
                  <span>Order Age: <strong>{daysElapsed} days</strong></span>
                  <span>Policy Window: <strong>{itemPolicy.window_days} days</strong></span>
                  <span>Category: <strong className="capitalize">{selectedItem.category || 'General'}</strong></span>
                </div>
              </div>

              {/* Return Form — all items see this; electronics are blocked at submit */}
              <form onSubmit={handleSubmitReturn} className="space-y-6">
              {/* Quantity selector (if ordered > 1) */}
              {selectedItem.quantity > 1 && (
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                    Quantity to Return
                  </label>
                  <select
                    value={returnQty}
                    onChange={(e) => setReturnQty(Number(e.target.value))}
                    className="input w-36"
                  >
                    {Array.from({ length: selectedItem.quantity }, (_, i) => i + 1).map((q) => (
                      <option key={q} value={q}>
                        {q} unit{q > 1 ? 's' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Step 3: Return Reason */}
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                  2. Reason for Return
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
                  {REASONS.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setReasonCode(r.id)}
                      className={`text-left p-3 rounded-xl border text-xs font-medium transition-all ${
                        reasonCode === r.id
                          ? 'border-primary-600 bg-primary-50 text-primary-900 ring-1 ring-primary-600'
                          : 'border-slate-200 hover:border-slate-300 text-slate-700'
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>

                <textarea
                  rows="2"
                  value={customerNotes}
                  onChange={(e) => setCustomerNotes(e.target.value)}
                  placeholder="Additional details (e.g. Left shoe too tight, seams unraveling, missing cable)..."
                  className="input text-xs h-auto py-2.5"
                ></textarea>
              </div>

              {/* Step 4: Resolution Preference */}
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                  3. Choose Resolution Method
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  
                  {/* Store Credit */}
                  <div
                    onClick={() => setResolutionType('store_credit')}
                    className={`p-3.5 rounded-2xl border cursor-pointer relative transition-all ${
                      resolutionType === 'store_credit'
                        ? 'border-emerald-500 bg-emerald-50/50 ring-2 ring-emerald-500/20'
                        : 'border-slate-200 hover:border-slate-300 bg-white'
                    }`}
                  >
                    <span className="absolute -top-2.5 right-3 bg-emerald-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 shadow-sm">
                      <Sparkles className="w-2.5 h-2.5" /> +5% Bonus
                    </span>
                    <CreditCard className="w-5 h-5 text-emerald-600 mb-1.5" />
                    <h5 className="font-bold text-slate-900 text-xs">Store Credit</h5>
                    <p className="text-[11px] text-slate-500 mt-0.5">Instant wallet credit</p>
                    <p className="font-bold text-emerald-700 text-xs mt-2">
                      ₹{totalStoreCredit.toFixed(2)}
                    </p>
                  </div>

                  {/* Original Payment */}
                  <div
                    onClick={() => setResolutionType('original_payment')}
                    className={`p-3.5 rounded-2xl border cursor-pointer transition-all ${
                      resolutionType === 'original_payment'
                        ? 'border-primary-500 bg-primary-50/50 ring-2 ring-primary-500/20'
                        : 'border-slate-200 hover:border-slate-300 bg-white'
                    }`}
                  >
                    <RotateCcw className="w-5 h-5 text-primary-600 mb-1.5" />
                    <h5 className="font-bold text-slate-900 text-xs">Original Payment</h5>
                    <p className="text-[11px] text-slate-500 mt-0.5">3-5 business days</p>
                    <p className="font-bold text-slate-900 text-xs mt-2">
                      ₹{refundAmount.toFixed(2)}
                    </p>
                  </div>

                  {/* Replacement */}
                  <div
                    onClick={() => setResolutionType('replacement')}
                    className={`p-3.5 rounded-2xl border cursor-pointer transition-all ${
                      resolutionType === 'replacement'
                        ? 'border-blue-500 bg-blue-50/50 ring-2 ring-blue-500/20'
                        : 'border-slate-200 hover:border-slate-300 bg-white'
                    }`}
                  >
                    <RefreshCw className="w-5 h-5 text-blue-600 mb-1.5" />
                    <h5 className="font-bold text-slate-900 text-xs">Free Exchange</h5>
                    <p className="text-[11px] text-slate-500 mt-0.5">Send replacement unit</p>
                    <p className="font-bold text-blue-600 text-xs mt-2">₹0.00 Cost</p>
                  </div>
                </div>
              </div>

              {/* Step 5: Pickup Details */}
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                  4. Free Reverse Pickup Address & Slot
                </label>
                <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-xs space-y-3">
                  <div className="flex items-center gap-2 text-slate-700">
                    <Truck className="w-4 h-4 text-primary-600 flex-shrink-0" />
                    <span className="font-medium">
                      {order.customer?.address 
                        ? `${order.customer.address.street || ''}, ${order.customer.address.city || ''}, ${order.customer.address.zip_code || ''}`
                        : 'Address provided during order checkout'}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-200">
                    <button
                      type="button"
                      onClick={() => setPickupSlot('tomorrow_morning')}
                      className={`p-2.5 rounded-xl border text-xs font-medium text-center transition-all ${
                        pickupSlot === 'tomorrow_morning'
                          ? 'border-primary-600 bg-white text-primary-700 font-bold shadow-sm'
                          : 'border-slate-200 text-slate-600'
                      }`}
                    >
                      Tomorrow (10 AM - 1 PM)
                    </button>
                    <button
                      type="button"
                      onClick={() => setPickupSlot('tomorrow_evening')}
                      className={`p-2.5 rounded-xl border text-xs font-medium text-center transition-all ${
                        pickupSlot === 'tomorrow_evening'
                          ? 'border-primary-600 bg-white text-primary-700 font-bold shadow-sm'
                          : 'border-slate-200 text-slate-600'
                      }`}
                    >
                      Tomorrow (2 PM - 6 PM)
                    </button>
                  </div>
                </div>
              </div>

              {/* Electronics blocked message — shown after user tries to submit */}
              {scBlocked && (
                <div className="rounded-2xl overflow-hidden border-2 border-orange-400 shadow-lg animate-pulse-once">
                  <div className="bg-orange-600 px-4 py-3 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
                      <AlertCircle className="w-4 h-4 text-white" />
                    </div>
                    <div>
                      <p className="font-bold text-white text-sm">⚠️ Return Not Allowed for Electronics</p>
                      <p className="text-orange-100 text-[11px]">7-Day Service Center Replacement Policy</p>
                    </div>
                  </div>
                  <div className="bg-orange-50 px-4 py-4 space-y-3">
                    <p className="text-sm text-orange-900 font-medium">
                      Electronics items cannot be returned or refunded online.
                    </p>
                    <div className="bg-white border border-orange-200 rounded-xl p-3 space-y-2 text-xs text-slate-700">
                      <div className="flex items-center gap-2 font-bold text-slate-800">
                        <Wrench className="w-4 h-4 text-orange-600" />
                        7-Day Service Center Replacement Available
                      </div>
                      <p>Visit your <strong>nearest authorized service center</strong> with:</p>
                      <ul className="space-y-1 pl-4 list-disc text-slate-600">
                        <li>Original product &amp; packaging</li>
                        <li>Purchase invoice / order receipt</li>
                        <li>Warranty card</li>
                      </ul>
                      <div className="flex items-start gap-2 pt-1 border-t border-slate-100">
                        <MapPin className="w-3.5 h-3.5 text-orange-500 mt-0.5 flex-shrink-0" />
                        <span>Replacement is <strong>free of charge</strong> within the warranty period.</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={onClose}
                        className="flex-1 py-2.5 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-sm font-bold transition-colors"
                      >
                        Understood, Close
                      </button>
                      <button
                        type="button"
                        onClick={() => setScBlocked(false)}
                        className="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-600 text-sm hover:bg-slate-50 transition-colors"
                      >
                        Back
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Submit CTA — hide when blocked */}
              {!scBlocked && (
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full btn btn-primary py-3.5 text-sm font-bold flex items-center justify-center gap-2 shadow-lg shadow-primary-600/25"
                >
                  {submitting ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                      <span>Authorizing Return &amp; Scheduling Pickup...</span>
                    </>
                  ) : (
                    <>
                      <span>Authorize Return &amp; Schedule Pickup</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
                <p className="text-[11px] text-slate-400 text-center mt-2">
                  Free reverse shipping. You will receive an instant RMA code and tracking updates.
                </p>
              </div>
              )}
              </form>

            </div>
          )}
        </div>
      </div>

      {/* Full Pickup Pass & Shipping Label Modal */}
      {showQrPassModal && currentReturn && (
        <div 
          id="pickup-pass-modal"
          onClick={() => setShowQrPassModal(false)}
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-3xl shadow-2xl max-w-md w-full overflow-hidden border border-slate-200 animate-in zoom-in-95 duration-200"
          >
            {/* Header */}
            <div className="p-4 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Truck className="w-4 h-4 text-primary-400" />
                <span className="font-bold text-sm tracking-wide">Courier Pickup Pass &amp; Label</span>
              </div>
              <button
                type="button"
                onClick={() => setShowQrPassModal(false)}
                className="p-1.5 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Shipping Label Body */}
            <div className="p-6 space-y-4">
              <div className="border-2 border-dashed border-slate-300 rounded-2xl p-5 bg-slate-50/60 text-center space-y-3">
                <div className="flex justify-between items-center text-xs text-slate-500 border-b border-slate-200 pb-2">
                  <span className="font-bold text-slate-800 tracking-wide uppercase">{currentReturn.pickup_details?.carrier || 'BlueDart Express'}</span>
                  <span className="font-mono text-[11px] bg-slate-200/80 px-2 py-0.5 rounded font-semibold text-slate-700">
                    {currentReturn.pickup_details?.tracking_number}
                  </span>
                </div>

                {/* Scannable QR Code */}
                <div className="flex justify-center py-2">
                  <div className="p-3 bg-white rounded-2xl shadow-md border border-slate-200 inline-block">
                    <QRCodeDisplay
                      value={getQrVerificationUrl(currentReturn)}
                      size={170}
                    />
                  </div>
                </div>

                <div>
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold block">Authorized RMA Number</span>
                  <div className="flex items-center justify-center gap-2 mt-0.5">
                    <span className="text-2xl font-mono font-black text-slate-900 tracking-wider">{currentReturn.rma_number}</span>
                    <button
                      type="button"
                      onClick={() => handleCopyRma(currentReturn.rma_number)}
                      className="p-1.5 text-slate-400 hover:text-primary-600 rounded-lg transition-colors border border-slate-200 bg-white"
                      title="Copy RMA"
                    >
                      {copiedRma ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                <p className="text-[11px] text-slate-500">
                  Scan with courier scanner or mobile camera to verify return pickup.
                </p>

                {/* Details Card */}
                <div className="bg-white rounded-xl p-3 border border-slate-200 text-left text-xs space-y-1.5 text-slate-600">
                  <div className="truncate"><span className="font-semibold text-slate-800">Item:</span> {currentReturn.item?.name} (Qty: {currentReturn.item?.quantity})</div>
                  <div><span className="font-semibold text-slate-800">Slot:</span> {currentReturn.pickup_details?.slot}</div>
                  <div className="truncate"><span className="font-semibold text-slate-800">Address:</span> {currentReturn.pickup_details?.address}</div>
                  <div><span className="font-semibold text-slate-800">Refund:</span> ₹{Number(currentReturn.refund_amount).toFixed(2)} ({currentReturn.resolution_type?.replace('_', ' ')})</div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handlePrintPass}
                  className="flex-1 btn btn-secondary py-2.5 text-xs font-bold flex items-center justify-center gap-1.5 border border-slate-300"
                >
                  <Printer className="w-4 h-4 text-slate-600" />
                  <span>Print Label</span>
                </button>
                <button
                  type="button"
                  onClick={handleDownloadQr}
                  className="flex-1 btn btn-primary py-2.5 text-xs font-bold flex items-center justify-center gap-1.5"
                >
                  <Download className="w-4 h-4" />
                  <span>Download QR</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
