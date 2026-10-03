import { useState, useId } from 'react';
import { db } from '../lib/firebase';
import { doc, updateDoc, collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { resolvePolicyForCategory } from '../constants/returnPolicies';
import { useAuth } from '../context/AuthContext';
import { 
  X, RotateCcw, ShieldCheck, AlertCircle, CheckCircle2, 
  Truck, ArrowRight, Check, Clock, QrCode, CreditCard, RefreshCw, Sparkles,
  Wrench, MapPin, Phone 
} from 'lucide-react';

export default function ReturnModal({ isOpen, onClose, order, existingReturn = null }) {
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState(existingReturn ? 'track' : 'initiate');
  const [submitting, setSubmitting] = useState(false);
  const [successRma, setSuccessRma] = useState(null);
  const [advancingStage, setAdvancingStage] = useState(false);

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

  if (!isOpen || !order) return null;

  const targetRma = successRma?.rma_number || existingReturn?.rma_number;
  const matchingOrderReturn = order.returns?.find(r => r.rma_number === targetRma) || (order.returns && order.returns.length > 0 ? order.returns[0] : null);
  const currentReturn = matchingOrderReturn || successRma || existingReturn || null;

  const handleAdvanceWarehouseStage = async (stage) => {
    if (!currentReturn) return;
    setAdvancingStage(true);
    try {
      const updatedTimeline = [...(currentReturn.timeline || [])];
      let newStatus = currentReturn.status;
      let newStatusLabel = currentReturn.status_label;

      if (stage === 'inspect') {
        updatedTimeline[3] = {
          stage: 'Warehouse Inspection & Verification Passed',
          timestamp: new Date().toISOString(),
          done: true
        };
        newStatus = 'inspected';
        newStatusLabel = 'Inspection Passed at Central Warehouse';
      } else if (stage === 'refund') {
        if (!updatedTimeline[3]?.done) {
          updatedTimeline[3] = {
            stage: 'Warehouse Inspection & Verification Passed',
            timestamp: new Date().toISOString(),
            done: true
          };
        }
        updatedTimeline[4] = {
          stage: currentReturn.resolution_type === 'replacement' ? 'Replacement Order Dispatched' : 'Refund Credited to Account',
          timestamp: new Date().toISOString(),
          done: true
        };
        newStatus = 'refunded';
        newStatusLabel = currentReturn.resolution_type === 'replacement' ? 'Replacement Unit Shipped' : 'Refund Credited Successfully';
      }

      const updatedReturnRecord = {
        ...currentReturn,
        status: newStatus,
        status_label: newStatusLabel,
        timeline: updatedTimeline,
        updated_at: new Date().toISOString()
      };

      const newReturnsList = order.returns?.map(r => 
        r.rma_number === currentReturn.rma_number ? updatedReturnRecord : r
      ) || [updatedReturnRecord];

      const orderRef = doc(db, 'orders', order.id);
      await updateDoc(orderRef, {
        returns: newReturnsList,
        return_status: newStatus,
        updated_at: serverTimestamp()
      });

      setSuccessRma(updatedReturnRecord);
    } catch (err) {
      console.error('Error advancing return stage:', err);
      alert('Error updating warehouse status: ' + err.message);
    } finally {
      setAdvancingStage(false);
    }
  };

  const selectedItem = order.items?.[selectedItemIndex] || order.items?.[0] || {};
  const itemPolicy = selectedItem.return_policy || resolvePolicyForCategory(selectedItem.category);
  const isServiceCenterItem = itemPolicy.policy_type === 'service_center_only';

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
    setSubmitting(true);

    try {
      const rmaCode = `RMA-${Math.floor(100000 + Math.random() * 900000)}`;
      const trackingNumber = `RET-DEL-${Math.floor(10000000 + Math.random() * 90000000)}`;
      
      // Autonomous AI Decision Logic
      const isAutoApproved = isWithinWindow && (itemPolicy.eligible || ['defective', 'damaged_transit'].includes(reasonCode));
      const returnStatus = isAutoApproved ? 'approved' : 'pending_review';
      const statusLabel = isAutoApproved ? 'Approved by AI Agent' : 'Under Review by Store Team';
      const approvedBy = isAutoApproved ? 'Autonomous AI Policy Agent' : 'Pending Manual Review';

      const newReturnRecord = {
        rma_number: rmaCode,
        order_id: order.id ?? null,
        order_number: order.order_number ?? null,
        user_id: order.customer?.user_id ?? user?.uid ?? null,
        status: returnStatus,
        status_label: statusLabel,
        approved_by: approvedBy,
        ai_assessment: {
          days_elapsed: daysElapsed,
          policy_window: itemPolicy.window_days ?? null,
          category: selectedItem.category ?? null,
          policy_title: itemPolicy.title ?? null,
          decision_rule: isAutoApproved 
            ? `Auto-approved under ${itemPolicy.title}. Return window valid (${daysElapsed}/${itemPolicy.window_days} days).`
            : `Flagged for manual review: Order age (${daysElapsed}d) or category requires human inspection.`
        },
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
          { 
            stage: isAutoApproved ? 'RMA Authorized by AI Policy Agent' : 'Under Review by Store Team', 
            timestamp: isAutoApproved ? new Date().toISOString() : 'Pending Human Decision', 
            done: isAutoApproved 
          },
          { stage: 'Pickup Scheduled with Courier', timestamp: isAutoApproved ? 'Scheduled' : 'Awaiting Approval', done: isAutoApproved },
          { stage: 'Warehouse Inspection & Verification', timestamp: 'Estimated in 3 days', done: false },
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
      setActiveTab('track');
    } catch (err) {
      console.error('Error submitting return:', err);
      alert('Could not submit return: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden border border-slate-100">
        
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
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 rounded-full transition-colors ml-2"
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
                      {currentReturn.status_label || 'Approved & Scheduled'}
                    </span>
                    <h4 className="text-2xl font-black tracking-wide font-mono text-white">
                      {currentReturn.rma_number}
                    </h4>
                    <p className="text-xs text-slate-300 mt-1">
                      Carrier: <span className="font-semibold text-white">{currentReturn.pickup_details?.carrier}</span>
                    </p>
                    <p className="text-[11px] text-primary-300 mt-1 flex items-center gap-1.5 font-medium">
                      <Sparkles className="w-3.5 h-3.5 text-primary-400 flex-shrink-0" />
                      Approved by: {currentReturn.approved_by || 'Autonomous AI Policy Agent'}
                    </p>
                    {currentReturn.ai_assessment?.decision_rule && (
                      <p className="text-[10px] text-slate-300/80 italic mt-0.5 max-w-sm">
                        {currentReturn.ai_assessment.decision_rule}
                      </p>
                    )}
                  </div>

                  <div className="bg-white/10 backdrop-blur-md p-3 rounded-xl border border-white/10 text-center">
                    <QrCode className="w-10 h-10 text-white mx-auto mb-1" />
                    <span className="text-[10px] tracking-wider uppercase text-slate-300 font-mono">
                      {currentReturn.pickup_details?.tracking_number?.slice(0, 11)}
                    </span>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-white/10 flex flex-wrap gap-4 text-xs text-slate-300">
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

              {/* Progress Stepper */}
              <div className="bg-white border border-slate-200 rounded-2xl p-6">
                <h4 className="font-bold text-slate-900 text-sm mb-5 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-primary-600" />
                  Return Milestone Timeline
                </h4>

                <div className="relative border-l-2 border-primary-200 ml-3.5 space-y-6">
                  {currentReturn.timeline?.map((step, idx) => (
                    <div key={idx} className="relative pl-6">
                      <span className={`absolute -left-[9px] top-1.5 w-4 h-4 rounded-full border-2 border-white flex items-center justify-center ${
                        step.done ? 'bg-primary-600' : 'bg-slate-200'
                      }`}>
                        {step.done && <Check className="w-2.5 h-2.5 text-white stroke-[3]" />}
                      </span>
                      <p className={`text-sm font-semibold ${step.done ? 'text-slate-900' : 'text-slate-400'}`}>
                        {step.stage}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">{step.timestamp}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Warehouse Operations & Inspection Processing Panel */}
              <div className="bg-slate-900 text-white rounded-2xl p-5 shadow-md border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="p-2 bg-primary-500/20 text-primary-400 rounded-xl">
                      <Truck className="w-4 h-4" />
                    </div>
                    <div>
                      <h5 className="font-bold text-sm text-white">Warehouse Receiving & Inspection</h5>
                      <p className="text-xs text-slate-400">Barcode scanner & quality verification check-in</p>
                    </div>
                  </div>
                  <span className="text-[10px] font-mono tracking-wider uppercase px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                    Warehouse Hub #1
                  </span>
                </div>

                {/* Actions based on current stage */}
                {!currentReturn.timeline?.[3]?.done ? (
                  <div className="pt-2 flex flex-col sm:flex-row items-center justify-between gap-3 bg-slate-800/60 p-3.5 rounded-xl border border-slate-700/60">
                    <div className="text-xs text-slate-300">
                      <p className="font-semibold text-white">Item awaiting warehouse intake scan</p>
                      <p className="text-[11px] text-slate-400">Package in transit via BlueDart.</p>
                    </div>
                  </div>
                ) : !currentReturn.timeline?.[4]?.done ? (
                  <div className="pt-2 flex flex-col sm:flex-row items-center justify-between gap-3 bg-emerald-950/40 p-3.5 rounded-xl border border-emerald-800/40">
                    <div className="text-xs text-emerald-200">
                      <p className="font-semibold text-white flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        Inspection Passed! Item verified in original condition.
                      </p>
                      <p className="text-[11px] text-slate-300 mt-0.5">
                        Processing {currentReturn.resolution_type?.replace('_', ' ')} of ₹{Number(currentReturn.refund_amount).toFixed(2)}.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="pt-2 bg-emerald-900/30 p-3 rounded-xl border border-emerald-700/40 flex items-center gap-2.5 text-xs text-emerald-300">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                    <span>
                      <strong>Return Lifecycle Fully Completed:</strong> Item restocked at warehouse & refund disbursed.
                    </span>
                  </div>
                )}
              </div>

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
            </div>
          ) : (
            /* INITIATION WIZARD */
            <form onSubmit={handleSubmitReturn} className="space-y-6">
              
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
                    const pol = item.return_policy || resolvePolicyForCategory(item.category);
                    return (
                      <div
                        key={idx}
                        onClick={() => {
                          setSelectedItemIndex(idx);
                          setReturnQty(1);
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

              {/* Service Center Block for Electronics */}
              {isServiceCenterItem ? (
                <div className="space-y-5">
                  {/* Alert Banner */}
                  <div className="bg-orange-50 border border-orange-200 rounded-2xl p-4 space-y-2">
                    <div className="flex items-center gap-2">
                      <AlertCircle className="w-5 h-5 text-orange-600" />
                      <span className="font-bold text-orange-900 text-sm">Return Not Available for This Product</span>
                    </div>
                    <p className="text-xs text-orange-800">
                      Electronics items are not eligible for return or refund. Only <strong>Service Center Replacement</strong> is available under warranty. Please visit your nearest authorized service center for inspection and replacement.
                    </p>
                    <div className="text-[11px] text-orange-700 flex items-center gap-3 pt-1 border-t border-orange-200">
                      <span>Policy: <strong>Service Center Only</strong></span>
                      <span>Warranty: <strong>{itemPolicy.window_days} days</strong></span>
                      <span>Category: <strong className="capitalize">{selectedItem.category || 'Electronics'}</strong></span>
                    </div>
                  </div>

                  {scSubmitted ? (
                    /* Success State */
                    <div className="text-center py-8 space-y-4">
                      <div className="inline-flex items-center justify-center w-16 h-16 bg-green-100 text-green-600 rounded-full mx-auto">
                        <CheckCircle2 className="w-8 h-8" />
                      </div>
                      <h4 className="text-lg font-bold text-slate-900">Service Request Submitted!</h4>
                      <p className="text-sm text-slate-600 max-w-sm mx-auto">
                        Your service center replacement request has been submitted. Our team will review your request and contact you at <strong>{scPhone}</strong> within 24-48 hours.
                      </p>
                      <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-600 max-w-sm mx-auto">
                        <p><strong>Product:</strong> {selectedItem.name}</p>
                        <p><strong>IMEI/Serial:</strong> {scImei || 'Not provided'}</p>
                        <p><strong>Preferred City:</strong> {scCity || 'Not specified'}</p>
                      </div>
                      <button
                        type="button"
                        onClick={onClose}
                        className="btn btn-primary py-2.5 px-6 text-sm font-bold"
                      >
                        Done
                      </button>
                    </div>
                  ) : (
                    /* Service Center Request Form */
                    <form onSubmit={handleSubmitServiceCenter} className="space-y-4">
                      <div className="flex items-center gap-2 pb-2 border-b border-slate-200">
                        <Wrench className="w-4 h-4 text-orange-600" />
                        <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">Service Center Replacement Request</span>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-semibold text-slate-600 mb-1">Full Name *</label>
                          <input
                            type="text"
                            value={scName}
                            onChange={(e) => setScName(e.target.value)}
                            required
                            placeholder="Your full name"
                            className="input text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-slate-600 mb-1">Phone Number *</label>
                          <input
                            type="tel"
                            value={scPhone}
                            onChange={(e) => setScPhone(e.target.value)}
                            required
                            placeholder="+91 9876543210"
                            className="input text-sm"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-600 mb-1">IMEI / Serial Number</label>
                        <input
                          type="text"
                          value={scImei}
                          onChange={(e) => setScImei(e.target.value)}
                          placeholder="e.g. 356938035643809"
                          className="input text-sm"
                        />
                        <p className="text-[10px] text-slate-400 mt-1">Found on the product box or in device Settings → About Phone</p>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-600 mb-1">Describe the Issue *</label>
                        <textarea
                          rows="3"
                          value={scIssue}
                          onChange={(e) => setScIssue(e.target.value)}
                          required
                          placeholder="e.g. Screen flickering after 2 days, battery draining very fast, speaker not working..."
                          className="input text-sm h-auto py-2.5"
                        ></textarea>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-600 mb-1">
                          <MapPin className="w-3.5 h-3.5 inline mr-1 text-orange-500" />
                          Preferred Service Center City *
                        </label>
                        <input
                          type="text"
                          value={scCity}
                          onChange={(e) => setScCity(e.target.value)}
                          required
                          placeholder="e.g. Hyderabad, Mumbai, Delhi"
                          className="input text-sm"
                        />
                      </div>

                      {/* Conditions checklist */}
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs space-y-1.5">
                        <p className="font-bold text-amber-900 flex items-center gap-1.5">
                          <AlertCircle className="w-3.5 h-3.5" /> What to Carry to the Service Center
                        </p>
                        {itemPolicy.conditions.map((c, i) => (
                          <p key={i} className="text-amber-800 flex items-center gap-1.5">
                            <Check className="w-3 h-3 text-amber-600 flex-shrink-0" /> {c}
                          </p>
                        ))}
                      </div>

                      <div className="pt-2">
                        <button
                          type="submit"
                          disabled={submitting}
                          className="w-full btn bg-orange-600 hover:bg-orange-700 text-white py-3.5 text-sm font-bold flex items-center justify-center gap-2 shadow-lg shadow-orange-600/25 rounded-xl"
                        >
                          {submitting ? (
                            <>
                              <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                              <span>Submitting Request...</span>
                            </>
                          ) : (
                            <>
                              <Wrench className="w-4 h-4" />
                              <span>Submit Service Center Request</span>
                            </>
                          )}
                        </button>
                        <p className="text-[11px] text-slate-400 text-center mt-2">
                          Our team will contact you within 24-48 hours with the nearest authorized service center details.
                        </p>
                      </div>
                    </form>
                  )}
                </div>
              ) : (
              /* Normal Return Policy Card */
              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className={`w-5 h-5 ${isWithinWindow ? 'text-primary-600' : 'text-amber-600'}`} />
                    <span className="font-bold text-slate-900 text-sm">Policy Eligibility Assessment</span>
                  </div>
                  <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                    isWithinWindow ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
                  }`}>
                    {isWithinWindow ? 'Eligible for Return' : 'Review Exception'}
                  </span>
                </div>

                <p className="text-xs text-slate-600">
                  {itemPolicy.title}. {itemPolicy.description}
                </p>

                <div className="text-[11px] text-slate-500 flex items-center gap-3 pt-1 border-t border-slate-200">
                  <span>Order Age: <strong>{daysElapsed} days</strong></span>
                  <span>Return Window: <strong>{itemPolicy.window_days} days</strong></span>
                  <span>Category: <strong className="capitalize">{selectedItem.category || 'General'}</strong></span>
                </div>
              </div>
              )}

              {/* Regular Return Form (non-electronics) */}
              {!isServiceCenterItem && (
              <>
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

              {/* Submit CTA */}
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full btn btn-primary py-3.5 text-sm font-bold flex items-center justify-center gap-2 shadow-lg shadow-primary-600/25"
                >
                  {submitting ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                      <span>Authorizing Return & Scheduling Pickup...</span>
                    </>
                  ) : (
                    <>
                      <span>Authorize Return & Schedule Pickup</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
                <p className="text-[11px] text-slate-400 text-center mt-2">
                  Free reverse shipping. You will receive an instant RMA code and tracking updates.
                </p>
              </div>
              </>)

            </form>
          )}
        </div>
      </div>
    </div>
  );
}
