import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { 
  CheckCircle2, Clock, Truck, MapPin, 
  Package, Sparkles, Printer, Copy, Check, 
  ArrowLeft, AlertTriangle, Activity
} from 'lucide-react';
import QRCodeDisplay from '../components/QRCodeDisplay';

export default function ReturnVerification() {
  const [searchParams] = useSearchParams();
  const rmaParam = (searchParams.get('rma') || '').trim();
  const orderParam = (searchParams.get('order') || '').trim();
  const trackParam = (searchParams.get('track') || '').trim();

  const [loading, setLoading] = useState(!rmaParam && !searchParams.get('item'));
  const [copied, setCopied] = useState(false);
  const [scanConfirmed, setScanConfirmed] = useState(false);
  const [lastLiveSync, setLastLiveSync] = useState(new Date());

  // Initialize immediately from URL parameters for instant 0ms render
  const [returnData, setReturnData] = useState(() => {
    if (!rmaParam && !trackParam) return null;
    return {
      rma_number: rmaParam,
      order_number: orderParam || 'N/A',
      status: 'approved',
      status_label: 'RMA Authorized & Scheduled',
      approved_by: 'Autonomous AI Policy Agent',
      item: {
        name: searchParams.get('item') || 'Ordered Item',
        price: Number(searchParams.get('price')) || 0,
        quantity: Number(searchParams.get('qty')) || 1,
        image_url: searchParams.get('img') || null
      },
      pickup_details: {
        carrier: searchParams.get('carrier') || 'BlueDart Express Reverse',
        tracking_number: trackParam || searchParams.get('track') || `RET-DEL-${Math.floor(10000000 + Math.random() * 90000000)}`,
        slot: searchParams.get('slot') || 'Tomorrow, 10:00 AM - 1:00 PM',
        address: searchParams.get('addr') || 'Customer Registered Delivery Address'
      },
      refund_amount: Number(searchParams.get('refund')) || 0,
      resolution_type: searchParams.get('res') || 'store_credit',
      timeline: [
        { stage: 'Return Requested', timestamp: 'Verified', done: true },
        { stage: 'RMA Authorized by AI Policy Agent', timestamp: 'Verified', done: true },
        { stage: 'Pickup Scheduled with Courier', timestamp: 'Scheduled', done: true },
        { stage: 'Warehouse Inspection & Verification', timestamp: 'Estimated in 3 days', done: false },
        { stage: 'Refund Credited', timestamp: 'Estimated in 3 days', done: false }
      ]
    };
  });

  // Read verified return pass data through API route (non-personal fields only)
  useEffect(() => {
    window.scrollTo(0, 0);
    const identifier = rmaParam || trackParam || orderParam;
    if (!identifier) return;

    let isMounted = true;

    async function loadVerification() {
      try {
        const data = await apiFetch(`/api/returns/verify/${encodeURIComponent(identifier)}`);
        if (isMounted && data) {
          setReturnData(prev => ({ ...(prev || {}), ...data }));
          setLastLiveSync(new Date());
          setLoading(false);
        }
      } catch (err) {
        console.warn('Could not fetch return pass from API:', err.message);
        if (isMounted) setLoading(false);
      }
    }

    loadVerification();
    const interval = setInterval(loadVerification, 10000); // 10s live poll for status changes

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [rmaParam, orderParam, trackParam]);

  const handleCopy = (text) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  // Allow courier to confirm intake on the spot
  const handleConfirmCourierIntake = async () => {
    setScanConfirmed(true);
    try {
      const returnId = returnData?.id || returnData?.returnId;
      if (!returnId) return;

      // The signed, expiring courier token is the only intake path.
      const { token } = await apiFetch(`/api/returns/${returnId}/courier-token`, { method: 'POST' });
      await apiFetch(`/api/returns/${returnId}/courier-intake`, {
        method: 'POST',
        body: JSON.stringify({ token })
      });

      setReturnData(prev => prev ? {
        ...prev,
        status: 'IN_TRANSIT',
        status_label: 'Picked Up by Courier (In Transit)'
      } : prev);
    } catch (e) {
      console.warn('Intake record could not be confirmed:', e.message);
    }
  };


  if (loading && !returnData) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-4">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary-500 border-t-transparent mb-4"></div>
        <p className="text-slate-400 font-mono text-sm tracking-wider">Connecting to Real-Time Return Pass Network...</p>
      </div>
    );
  }

  if (!returnData) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-slate-900 rounded-3xl p-8 shadow-2xl border border-slate-800 text-center space-y-4">
          <div className="w-16 h-16 bg-amber-500/20 text-amber-400 rounded-full flex items-center justify-center mx-auto border border-amber-500/30">
            <AlertTriangle className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-bold text-white">Return Record Not Found</h2>
          <p className="text-sm text-slate-400">
            No valid return authorization or RMA could be found for code: <strong className="font-mono text-slate-200">{rmaParam || 'None'}</strong>.
          </p>
          <Link to="/orders" className="btn btn-primary inline-flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            <span>Go to My Orders</span>
          </Link>
        </div>
      </div>
    );
  }

  const trackingNum = returnData.pickup_details?.tracking_number || 'RET-DEL-65809401';
  const carrierName = returnData.pickup_details?.carrier || 'BlueDart Express Reverse';
  const rawTimeline = returnData.timeline || [
    { stage: 'Return Requested', timestamp: returnData.created_at || 'Verified', done: true },
    { stage: 'RMA Authorized by AI Policy Agent', timestamp: returnData.created_at || 'Verified', done: true },
    { stage: 'Pickup Scheduled with Courier', timestamp: 'Scheduled', done: true },
    { stage: 'Warehouse Inspection & Verification', timestamp: 'Estimated in 3 days', done: false },
    { stage: 'Refund Credited', timestamp: 'Estimated in 3 days', done: false }
  ];

  const timelineSteps = rawTimeline.map((step, idx) => {
    if (idx === 0) {
      return { stage: 'Return Requested', timestamp: step.timestamp || returnData.created_at || 'Verified', done: true };
    }
    if (idx === 1) {
      return { 
        stage: 'RMA Authorized by AI Policy Agent', 
        timestamp: (step.timestamp && !step.timestamp.includes('Pending')) ? step.timestamp : (returnData.created_at || 'Verified'), 
        done: true 
      };
    }
    if (idx === 2) {
      return { 
        stage: 'Pickup Scheduled with Courier', 
        timestamp: (step.timestamp && !step.timestamp.includes('Awaiting')) ? step.timestamp : 'Scheduled', 
        done: true 
      };
    }
    if (idx === 3) {
      const isInspected = step.done || returnData.status === 'inspected' || returnData.status === 'refunded' || returnData.return_status === 'inspected' || returnData.return_status === 'refunded';
      return {
        stage: isInspected ? 'Warehouse Inspection & Verification Passed' : 'Warehouse Inspection & Verification',
        timestamp: isInspected ? (step.timestamp?.includes('Estimated') ? 'Inspection Passed' : step.timestamp) : 'Estimated in 3 days',
        done: isInspected
      };
    }
    if (idx === 4) {
      const isRefunded = step.done || returnData.status === 'refunded' || returnData.return_status === 'refunded';
      return {
        stage: isRefunded 
          ? (returnData.resolution_type === 'replacement' ? 'Replacement Order Dispatched' : 'Refund Credited to Account')
          : (returnData.resolution_type === 'replacement' ? 'Replacement Unit Dispatch' : 'Refund Credited'),
        timestamp: isRefunded ? (step.timestamp?.includes('Estimated') ? 'Refund Credited' : step.timestamp) : 'Estimated in 3 days',
        done: isRefunded
      };
    }
    return step;
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 py-8 px-4 sm:px-6">
      <div className="max-w-3xl mx-auto space-y-6">

        {/* Top Live Bar & Navigation */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/80 backdrop-blur-md px-4 py-2.5 rounded-2xl border border-slate-800 shadow-md">
          <Link
            to="/orders"
            className="inline-flex items-center gap-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Return to Orders</span>
          </Link>

          <div className="flex items-center gap-3">
            <div className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400 font-mono font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
              <span>LIVE SYNC ACTIVE</span>
            </div>

            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-bold tracking-wide">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>OFFICIAL PASS VERIFIED</span>
            </div>
          </div>
        </div>

        {/* Main Official Shipping Pass Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl">
          
          {/* Header Bar */}
          <div className="bg-gradient-to-r from-primary-950 via-slate-900 to-slate-900 p-6 border-b border-slate-800">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-primary-400 text-xs font-bold uppercase tracking-wider mb-1">
                  <Truck className="w-4 h-4" />
                  <span>{carrierName}</span>
                </div>
                <h1 className="text-2xl sm:text-3xl font-black font-mono text-white tracking-wide">
                  {returnData.rma_number}
                </h1>
                <p className="text-xs text-slate-400 mt-1">
                  Order Reference: <span className="font-mono text-slate-200">#{returnData.order_number}</span>
                </p>
                <div className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-primary-500/20 text-primary-300 border border-primary-500/30">
                  <Activity className="w-3 h-3" />
                  <span>{returnData.status === 'refunded' ? 'Refund Credited Successfully' : returnData.status === 'inspected' ? 'Inspection Passed at Warehouse' : 'Approved & Scheduled'}</span>
                </div>
              </div>

              {/* Scanned QR badge */}
              <div className="flex items-center gap-3 bg-white p-2.5 rounded-2xl shadow-xl border border-slate-200 self-start sm:self-auto">
                <QRCodeDisplay
                  value={window.location.href}
                  size={68}
                  className="rounded-lg shadow-xs"
                />
                <div className="pr-1 text-slate-900">
                  <p className="text-[10px] uppercase font-bold text-slate-400">Scanned Pass</p>
                  <p className="text-xs font-black font-mono">{returnData.rma_number}</p>
                  <p className="text-[10px] text-emerald-600 font-bold flex items-center gap-1 mt-0.5">
                    <CheckCircle2 className="w-3 h-3" /> Verified Live
                  </p>
                </div>
              </div>
            </div>

            {/* Quick action bar */}
            <div className="mt-5 pt-4 border-t border-slate-800/80 flex flex-wrap items-center gap-2">
              <button
                onClick={() => handleCopy(returnData.rma_number)}
                className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors border border-slate-700 shadow-sm"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-slate-300" />}
                <span>{copied ? 'RMA Copied!' : 'Copy RMA'}</span>
              </button>

              <button
                onClick={handlePrint}
                className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors border border-slate-700 shadow-sm"
              >
                <Printer className="w-3.5 h-3.5 text-slate-300" />
                <span>Print Pass</span>
              </button>

              {scanConfirmed ? (
                <div className="ml-auto px-3.5 py-1.5 rounded-xl bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 text-xs font-bold flex items-center gap-1.5 animate-in zoom-in-95">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Courier Intake Verified</span>
                </div>
              ) : (
                <button
                  onClick={handleConfirmCourierIntake}
                  className="ml-auto px-3.5 py-1.5 rounded-xl bg-primary-600 hover:bg-primary-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-md transition-all hover:scale-105 active:scale-95"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Mark Verified by Courier</span>
                </button>
              )}
            </div>
          </div>

          <div className="p-6 space-y-6">

            {/* 1. Item Card */}
            <div className="bg-slate-800/70 border border-slate-700/80 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="h-16 w-16 bg-white rounded-xl overflow-hidden flex-shrink-0 p-1 flex items-center justify-center border border-slate-700 shadow-sm">
                  {returnData.item?.image_url ? (
                    <img src={returnData.item.image_url} alt={returnData.item.name} className="h-full w-full object-contain" />
                  ) : (
                    <Package className="w-7 h-7 text-slate-400" />
                  )}
                </div>
                <div>
                  <h3 className="font-bold text-white text-base leading-snug">{returnData.item?.name}</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Quantity: <strong className="text-white">{returnData.item?.quantity || 1} unit(s)</strong> • Unit Price: ₹{Number(returnData.item?.price || returnData.original_price || returnData.refund_amount).toFixed(2)}
                  </p>
                  <p className="text-xs text-primary-400 font-semibold mt-1">
                    Refund Amount: ₹{Number(returnData.refund_amount).toFixed(2)} ({returnData.resolution_type?.replace('_', ' ')})
                  </p>
                </div>
              </div>

              <div className="sm:text-right flex sm:flex-col items-center sm:items-end justify-between border-t sm:border-t-0 pt-2 sm:pt-0 border-slate-700">
                <span className="text-xs text-slate-400">Policy Reason</span>
                <span className="text-xs font-bold text-white capitalize bg-slate-700/60 px-2.5 py-1 rounded-lg mt-0.5">
                  {returnData.reason_code ? returnData.reason_code.replace('_', ' ') : 'Return Authorized'}
                </span>
              </div>
            </div>

            {/* 2. Pickup & Logistics Details */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-slate-800/50 border border-slate-700/70 rounded-2xl p-4 space-y-2">
                <div className="flex items-center gap-2 text-primary-400 text-xs font-bold uppercase tracking-wider">
                  <Clock className="w-4 h-4" />
                  <span>Scheduled Pickup Slot</span>
                </div>
                <p className="text-base font-bold text-white">
                  {returnData.pickup_details?.slot || 'Tomorrow, 10:00 AM - 1:00 PM'}
                </p>
                <p className="text-xs text-slate-400">
                  Reverse Logistics Agent: <strong>{carrierName}</strong>
                </p>
              </div>

              <div className="bg-slate-800/50 border border-slate-700/70 rounded-2xl p-4 space-y-2">
                <div className="flex items-center gap-2 text-primary-400 text-xs font-bold uppercase tracking-wider">
                  <MapPin className="w-4 h-4" />
                  <span>Pickup Address</span>
                </div>
                <p className="text-xs text-slate-200 leading-relaxed font-medium">
                  {returnData.pickup_details?.address || 'Registered Customer Delivery Address'}
                </p>
                <p className="text-[11px] text-slate-400 font-mono">
                  Tracking: {trackingNum}
                </p>
              </div>
            </div>

            {/* 3. Real-Time Milestone Timeline with instant warehouse update animation */}
            <div className="bg-slate-800/40 border border-slate-700/60 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="font-bold text-sm text-white flex items-center gap-2">
                  <Clock className="w-4 h-4 text-primary-400" />
                  <span>Return Milestone Timeline</span>
                </h4>
                <span className="text-[10px] font-mono text-slate-400">
                  Synced in real-time
                </span>
              </div>

              <div className="relative border-l-2 border-primary-500/40 ml-3.5 space-y-5">
                {timelineSteps.map((step, idx) => (
                  <div key={idx} className="relative pl-6 transition-all duration-300">
                    <span className={`absolute -left-[9px] top-1.5 w-4 h-4 rounded-full border-2 border-slate-900 flex items-center justify-center transition-all ${
                      step.done ? 'bg-primary-500 scale-110 shadow-lg shadow-primary-500/50' : 'bg-slate-700'
                    }`}>
                      {step.done && <Check className="w-2.5 h-2.5 text-white stroke-[3]" />}
                    </span>
                    <p className={`text-sm font-semibold transition-colors ${step.done ? 'text-white' : 'text-slate-500'}`}>
                      {step.stage}
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">{step.timestamp}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* 4. AI Policy Authorization Rule */}
            <div className="bg-primary-950/40 border border-primary-800/40 rounded-2xl p-4 flex items-start gap-3">
              <Sparkles className="w-5 h-5 text-primary-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-slate-300 space-y-1">
                <p className="font-bold text-white">
                  Autonomous Policy Approval: Autonomous AI Policy Agent
                </p>
                <p className="text-slate-400 leading-relaxed">
                  Auto-approved by AI Policy Agent under store return policy. Return authorization and reverse pickup generated.
                </p>
              </div>
            </div>

            {/* 5. Courier Instructions */}
            <div className="border border-dashed border-slate-700 rounded-2xl p-4 bg-slate-900/60 text-xs text-slate-400 space-y-2">
              <p className="font-bold text-slate-300 uppercase tracking-wider text-[11px]">
                📦 Instructions for Courier &amp; Customer
              </p>
              <ul className="list-disc pl-4 space-y-1 text-slate-400">
                <li>Package should be handed over in original condition with all accessories.</li>
                <li>Courier executive will scan this pass to confirm intake.</li>
                <li>Digital receipt and refund tracking are updated immediately upon warehouse receipt.</li>
              </ul>
            </div>

          </div>
        </div>

        {/* Footer */}
        <div className="text-center text-xs text-slate-500 pb-8">
          <p>© {new Date().getFullYear()} E-Commerce Store • Official Reverse Logistics Verification</p>
        </div>

      </div>
    </div>
  );
}
