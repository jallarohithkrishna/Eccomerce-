import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Bot, Send, Sparkles, CheckCircle2, AlertCircle, AlertTriangle,
  RotateCcw, Package, Truck, ArrowRight, ShieldCheck, Clock,
  Upload, Image as ImageIcon, QrCode, CreditCard, RefreshCw,
  UserCheck, ExternalLink, ChevronRight, X
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { normalizeReturnStatus } from '../constants/returnStatuses';
import { 
  toolLookupCustomerOrders, 
  toolVerifyOrderAndDelivery, 
  toolCheckProductPolicy, 
  toolEvaluateEligibility,
  toolCreateReturnRMA,
  toolEscalateToHumanReview
} from '../lib/returnAgent';
import QRCodeDisplay from './QRCodeDisplay';
import ReturnModal from './ReturnModal';

const COMMON_REASONS = [
  { code: 'wrong_size', label: 'Size / Fit Issue', desc: 'Item is too tight, loose, or incorrect dimensions' },
  { code: 'defective', label: 'Defective or Damaged', desc: 'Item arrived with physical damage or does not work' },
  { code: 'not_as_described', label: 'Different from Description', desc: 'Color, style, or specifications differ from website' },
  { code: 'quality_unsatisfactory', label: 'Quality Below Expectation', desc: 'Material or finishing not satisfactory' },
  { code: 'changed_mind', label: 'Changed My Mind', desc: 'No longer need the product in original sealed box' }
];

// Helper to read cached chat from localStorage synchronously on initial render
const getInitialChatData = () => {
  try {
    if (typeof window === 'undefined') return null;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('nova_ai_chat_')) {
        const raw = localStorage.getItem(k);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed?.messages) && parsed.messages.length > 0) {
            return parsed;
          }
        }
      }
    }
  } catch {}
  return null;
};

export default function AiReturnAssistant({ preSelectedOrder = null, onReturnCreated = null }) {
  const { user } = useAuth();
  const initialSaved = useRef(getInitialChatData()).current;

  const [orders, setOrders] = useState([]);
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [messages, setMessages] = useState(() => initialSaved?.messages || []);
  const [inputText, setInputText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // Flow State
  const [currentStep, setCurrentStep] = useState(() => initialSaved?.currentStep || 'SELECT_ORDER'); 
  // 'SELECT_ORDER' | 'SELECT_PRODUCT' | 'VERIFYING' | 'SELECT_REASON' | 'SELECT_RESOLUTION' | 'SCHEDULE_PICKUP' | 'COMPLETED' | 'EXCEPTION_ESCALATED'

  const [selectedOrder, setSelectedOrder] = useState(() => initialSaved?.selectedOrder || null);
  const [selectedItem, setSelectedItem] = useState(() => initialSaved?.selectedItem || null);
  const [verificationResult, setVerificationResult] = useState(() => initialSaved?.verificationResult || null);
  const [eligibilityResult, setEligibilityResult] = useState(() => initialSaved?.eligibilityResult || null);
  const [selectedReason, setSelectedReason] = useState(() => initialSaved?.selectedReason || 'wrong_size');
  const [reasonNotes, setReasonNotes] = useState(() => initialSaved?.reasonNotes || '');
  const [photoPreview, setPhotoPreview] = useState(() => initialSaved?.photoPreview || '');
  const [selectedResolution, setSelectedResolution] = useState(() => initialSaved?.selectedResolution || 'store_credit');
  const [selectedSlot, setSelectedSlot] = useState(() => initialSaved?.selectedSlot || 'tomorrow_morning');
  const [createdRma, setCreatedRma] = useState(() => initialSaved?.createdRma || null);
  // Track which exception cards have had warehouse/payment checked
  const [warehouseChecked, setWarehouseChecked] = useState(() => initialSaved?.warehouseChecked || {});
  const [paymentChecked, setPaymentChecked] = useState(() => initialSaved?.paymentChecked || {});
  const [statusCheckLoading, setStatusCheckLoading] = useState({});

  // Existing Return Modal State
  const [isReturnModalOpen, setIsReturnModalOpen] = useState(false);
  const [modalReturnData, setModalReturnData] = useState(null);
  const [modalOrderData, setModalOrderData] = useState(null);

  const messagesEndRef = useRef(null);
  const isInitialized = useRef(false);

  const getStorageKey = (uid) => uid ? `nova_ai_chat_${uid}` : 'nova_ai_chat_guest';

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isProcessing]);

  // Load user orders from Firestore & restore chat from localStorage if not already loaded
  useEffect(() => {
    async function loadOrders() {
      if (!user) {
        setLoadingOrders(false);
        return;
      }
      try {
        const userOrders = await toolLookupCustomerOrders(user.uid);
        setOrders(userOrders);

        // Check if user-specific key exists in localStorage
        const storageKey = getStorageKey(user.uid);
        let userSaved = null;
        try {
          const raw = localStorage.getItem(storageKey);
          if (raw) userSaved = JSON.parse(raw);
        } catch {}

        if (userSaved && Array.isArray(userSaved.messages) && userSaved.messages.length > 0) {
          setMessages(userSaved.messages);
          if (userSaved.currentStep) setCurrentStep(userSaved.currentStep);
          if (userSaved.selectedOrder) setSelectedOrder(userSaved.selectedOrder);
          if (userSaved.selectedItem) setSelectedItem(userSaved.selectedItem);
          if (userSaved.verificationResult) setVerificationResult(userSaved.verificationResult);
          if (userSaved.eligibilityResult) setEligibilityResult(userSaved.eligibilityResult);
          if (userSaved.selectedReason) setSelectedReason(userSaved.selectedReason);
          if (userSaved.reasonNotes) setReasonNotes(userSaved.reasonNotes);
          if (userSaved.photoPreview) setPhotoPreview(userSaved.photoPreview);
          if (userSaved.selectedResolution) setSelectedResolution(userSaved.selectedResolution);
          if (userSaved.selectedSlot) setSelectedSlot(userSaved.selectedSlot);
          if (userSaved.createdRma) setCreatedRma(userSaved.createdRma);
          if (userSaved.warehouseChecked) setWarehouseChecked(userSaved.warehouseChecked);
          if (userSaved.paymentChecked) setPaymentChecked(userSaved.paymentChecked);
        } else if (!messages || messages.length === 0) {
          // Initial welcome message only if no saved chat exists
          const welcome = {
            id: 'welcome',
            sender: 'ai',
            text: `👋 Hi ${user.user_metadata?.full_name?.split(' ')[0] || 'there'}! I'm your **Autonomous AI Return Agent**.\n\nI can verify your order details, evaluate category policies, approve eligible returns autonomously, issue your unique **RMA number**, and schedule reverse courier pickup in under 60 seconds.`,
            showOrderPicker: true,
            timestamp: new Date()
          };

          if (preSelectedOrder) {
            handleSelectOrder(preSelectedOrder, [welcome]);
          } else {
            setMessages([welcome]);
          }
        }
      } catch (err) {
        console.error('Failed to load user orders:', err);
      } finally {
        isInitialized.current = true;
        setLoadingOrders(false);
      }
    }
    loadOrders();
  }, [user, preSelectedOrder]);

  // Persist chat and workflow state to localStorage
  useEffect(() => {
    if (!messages || messages.length === 0) return;
    const storageKey = getStorageKey(user?.uid);
    try {
      const dataToSave = {
        messages,
        currentStep,
        selectedOrder,
        selectedItem,
        verificationResult,
        eligibilityResult,
        selectedReason,
        reasonNotes,
        photoPreview: photoPreview && photoPreview.length < 500000 ? photoPreview : '',
        selectedResolution,
        selectedSlot,
        createdRma,
        warehouseChecked,
        paymentChecked,
        savedAt: Date.now()
      };
      localStorage.setItem(storageKey, JSON.stringify(dataToSave));
    } catch (err) {
      console.warn('Failed to save chat to localStorage:', err);
    }
  }, [
    messages,
    currentStep,
    selectedOrder,
    selectedItem,
    verificationResult,
    eligibilityResult,
    selectedReason,
    reasonNotes,
    photoPreview,
    selectedResolution,
    selectedSlot,
    createdRma,
    warehouseChecked,
    paymentChecked,
    user?.uid
  ]);

  // Reset / Clear chat and start a fresh return request
  const handleClearChat = () => {
    const storageKey = getStorageKey(user?.uid);
    try {
      localStorage.removeItem(storageKey);
      localStorage.removeItem('nova_ai_chat_guest');
    } catch (e) {
      console.warn('Failed to clear chat storage:', e);
    }

    const welcome = {
      id: `welcome-${Date.now()}`,
      sender: 'ai',
      text: `👋 Hi ${user?.user_metadata?.full_name?.split(' ')[0] || 'there'}! I'm your **Autonomous AI Return Agent**.\n\nI can verify your order details, evaluate category policies, approve eligible returns autonomously, issue your unique **RMA number**, and schedule reverse courier pickup in under 60 seconds.`,
      showOrderPicker: true,
      timestamp: new Date()
    };

    setMessages([welcome]);
    setCurrentStep('SELECT_ORDER');
    setSelectedOrder(null);
    setSelectedItem(null);
    setVerificationResult(null);
    setEligibilityResult(null);
    setSelectedReason('wrong_size');
    setReasonNotes('');
    setPhotoPreview('');
    setSelectedResolution('store_credit');
    setSelectedSlot('tomorrow_morning');
    setCreatedRma(null);
    setWarehouseChecked({});
    setPaymentChecked({});
  };

  // Handler 1: Order Selected
  const handleSelectOrder = (order, existingMessages = null) => {
    setSelectedOrder(order);
    setCurrentStep('SELECT_PRODUCT');

    const msgs = existingMessages || messages;
    const userMsg = {
      id: `u-${Date.now()}`,
      sender: 'user',
      text: `I'd like to return an item from Order #${order.order_number}`,
      timestamp: new Date()
    };

    const aiMsg = {
      id: `ai-${Date.now()}`,
      sender: 'ai',
      text: `Great. Please select which item from **Order #${order.order_number}** you would like to return:`,
      showProductPicker: true,
      targetOrder: order,
      timestamp: new Date()
    };

    setMessages([...msgs, userMsg, aiMsg]);
  };

  // Handler 2: Product Selected -> Verifying & Policy Check
  const handleSelectProduct = async (item) => {
    setSelectedItem(item);
    setIsProcessing(true);

    const userMsg = {
      id: `u-${Date.now()}`,
      sender: 'user',
      text: `Return item: ${item.name}`,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMsg]);

    // Simulate Agent Step Verification (Order -> Delivery -> Policy -> Eligibility)
    setTimeout(() => {
      const verification = toolVerifyOrderAndDelivery(selectedOrder);
      setVerificationResult(verification);

      const eligibility = toolEvaluateEligibility({
        order: selectedOrder,
        item,
        daysElapsed: verification.daysElapsed ?? 0,
        reasonCode: 'general'
      });
      setEligibilityResult(eligibility);
      setIsProcessing(false);

      if (!verification.isDelivered) {
        // Not delivered yet
        setCurrentStep('SELECT_ORDER');
        setMessages(prev => [
          ...prev,
          {
            id: `ai-${Date.now()}`,
            sender: 'ai',
            text: `⚠️ **Delivery Verification Notice**:\n${verification.message}\n\nReturns cannot be initiated before the delivery carrier marks the parcel as completed. If you wish to cancel an in-transit order, please contact customer support.`,
            isWarning: true,
            timestamp: new Date()
          }
        ]);
        return;
      }

      if (eligibility.status === 'ELECTRONICS_SERVICE_CENTER') {
        // Electronics
        setCurrentStep('SELECT_ORDER');
        setMessages(prev => [
          ...prev,
          {
            id: `ai-${Date.now()}`,
            sender: 'ai',
            text: `📱 **Electronics 7-Day Service Center Policy**:\n\nUnder our consumer electronics terms, items in the **${item.category || 'Electronics'}** category are covered under authorized service center replacement rather than online courier returns.\n\n### How to get a free replacement:\n1. Visit your nearest brand authorized service center.\n2. Carry the device, original packaging, and accessories.\n3. Show your order invoice from **My Orders**.\n\n*Replacement is 100% free of charge under standard warranty.*`,
            isServiceCenter: true,
            timestamp: new Date()
          }
        ]);
        return;
      }

      if (!eligibility.eligible && eligibility.canEscalate) {
        // Window expired or non-returnable grocery -> Offer escalation to Human Review
        setCurrentStep('SELECT_REASON');
        setMessages(prev => [
          ...prev,
          {
            id: `ai-${Date.now()}`,
            sender: 'ai',
            text: `⚠️ **Policy Window Alert**:\n${eligibility.reason}\n\nBecause this case falls outside standard automatic approval limits, our AI Agent can forward this request directly to our **Human Operations Review Team** for priority exception review.`,
            showReasonForm: true,
            isExceptionMode: true,
            timestamp: new Date()
          }
        ]);
        return;
      }

      // Eligible!
      setCurrentStep('SELECT_REASON');
      setMessages(prev => [
        ...prev,
        {
          id: `ai-${Date.now()}`,
          sender: 'ai',
          text: `✅ **Eligibility Verified!**\n- Policy: **${eligibility.policy?.title}**\n- Days since delivery: **${verification.daysElapsed} day(s)** (Limit: ${eligibility.policy?.window_days} days)\n- Return type: **${eligibility.policy?.badge || 'Standard Return'}**\n\nPlease select the reason for your return below to proceed:`,
          showReasonForm: true,
          timestamp: new Date()
        }
      ]);
    }, 900);
  };

  // Handler 3: Submit Reason
  const handleSubmitReason = () => {
    const reasonObj = COMMON_REASONS.find(r => r.code === selectedReason);
    const userMsg = {
      id: `u-${Date.now()}`,
      sender: 'user',
      text: `Reason: ${reasonObj?.label || selectedReason}${reasonNotes ? ` - "${reasonNotes}"` : ''}`,
      timestamp: new Date()
    };

    if (eligibilityResult && !eligibilityResult.eligible && eligibilityResult.canEscalate) {
      // Escalate to human review
      handleTriggerEscalation(userMsg);
      return;
    }

    setCurrentStep('SELECT_RESOLUTION');
    const aiMsg = {
      id: `ai-${Date.now()}`,
      sender: 'ai',
      text: `Got it. How would you like to receive your resolution? You can choose instant **Store Credit with a 10% Extra Bonus**, return to **Original Payment Method**, or a direct **Exchange**:`,
      showResolutionPicker: true,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMsg, aiMsg]);
  };

  // Handler 4: Resolution Selected -> Schedule Reverse Pickup
  const handleSelectResolution = (resType) => {
    setSelectedResolution(resType);
    setCurrentStep('SCHEDULE_PICKUP');

    const userMsg = {
      id: `u-${Date.now()}`,
      sender: 'user',
      text: resType === 'store_credit' 
        ? 'Resolution: Store Credit (+10% Bonus)' 
        : resType === 'exchange' ? 'Resolution: Direct Exchange' : 'Resolution: Original Payment Method',
      timestamp: new Date()
    };

    const aiMsg = {
      id: `ai-${Date.now()}`,
      sender: 'ai',
      text: `Perfect. When should our courier partner (BlueDart Express Reverse) collect the parcel from your registered delivery address?`,
      showPickupSlotPicker: true,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMsg, aiMsg]);
  };

  // Handler 5: Confirm Reverse Pickup -> Generate RMA & Timeline
  const handleConfirmPickup = async () => {
    setIsProcessing(true);

    const userMsg = {
      id: `u-${Date.now()}`,
      sender: 'user',
      text: `Confirm pickup slot: ${selectedSlot === 'tomorrow_evening' ? 'Tomorrow, 2:00 PM - 6:00 PM' : 'Tomorrow, 10:00 AM - 1:00 PM'}`,
      timestamp: new Date()
    };
    setMessages(prev => [...prev, userMsg]);

    try {
      const record = await toolCreateReturnRMA({
        order: selectedOrder,
        item: selectedItem,
        returnQty: 1,
        reasonCode: selectedReason,
        reasonText: reasonNotes,
        resolutionType: selectedResolution,
        pickupSlot: selectedSlot,
        photoEvidence: photoPreview,
        user,
        eligibilityResult
      });

      setCreatedRma(record);
      setCurrentStep('COMPLETED');
      setIsProcessing(false);

      if (onReturnCreated) {
        onReturnCreated(record);
      }

      setMessages(prev => [
        ...prev,
        {
          id: `ai-${Date.now()}`,
          sender: 'ai',
          text: `🎉 **Return Authorized Successfully!**\n\nYour Return Authorization ID is **${record.rma_number}**.\n\nA BlueDart reverse courier pickup has been scheduled. Your digital **Pickup Pass & QR Code** has been generated below.`,
          showRmaCard: true,
          rmaData: record,
          timestamp: new Date()
        }
      ]);
    } catch (err) {
      console.error('Failed to create RMA:', err);
      setIsProcessing(false);
      alert('Could not submit return: ' + err.message);
    }
  };

  // Handler 6: Escalate to Human Review
  const handleTriggerEscalation = async (priorUserMsg) => {
    setIsProcessing(true);
    setMessages(prev => [...prev, priorUserMsg]);

    try {
      const excRecord = await toolEscalateToHumanReview({
        order: selectedOrder,
        item: selectedItem,
        reasonCode: selectedReason,
        reasonText: reasonNotes,
        exceptionType: eligibilityResult?.status || 'MANUAL_REVIEW_REQUESTED',
        photoEvidence: photoPreview,
        user
      });

      setCreatedRma(excRecord);
      setCurrentStep('EXCEPTION_ESCALATED');
      setIsProcessing(false);

      if (onReturnCreated) {
        onReturnCreated(excRecord);
      }

      setMessages(prev => [
        ...prev,
        {
          id: `ai-${Date.now()}`,
          sender: 'ai',
          text: `📋 **Case Escalated to Human Review (Ticket: ${excRecord.rma_number})**\n\nYour request has been routed to our Senior Returns Specialist team. You will receive an email update within **24 business hours** with the decision.`,
          showExceptionCard: true,
          rmaData: excRecord,
          timestamp: new Date()
        }
      ]);
    } catch (err) {
      console.error('Failed to escalate:', err);
      setIsProcessing(false);
      alert('Error escalating to review: ' + err.message);
    }
  };

  // Handler 7: Check Warehouse Status from Firestore
  const handleCheckWarehouseStatus = async (rmaNumber, msgId) => {
    setStatusCheckLoading(prev => ({ ...prev, [`wh-${msgId}`]: true }));
    try {
      const q = query(collection(db, 'returns'), where('rma_number', '==', rmaNumber));
      const snap = await getDocs(q);
      let status = 'HUMAN_REVIEW';
      if (!snap.empty) {
        status = normalizeReturnStatus(snap.docs[0].data().status);
      }

      const warehouseStages = ['RECEIVED', 'INSPECTION', 'REFUND_PROCESSING', 'COMPLETED'];
      const isAtWarehouse = warehouseStages.includes(status);

      if (isAtWarehouse) {
        setWarehouseChecked(prev => ({ ...prev, [msgId]: status }));
        setMessages(prev => [
          ...prev,
          {
            id: `ai-wh-${Date.now()}`,
            sender: 'ai',
            text: `✅ **Warehouse Update for ${rmaNumber}**\n\nGood news! Your item has been **received and accepted at our central warehouse hub**. Current pipeline stage: **${status.replace('_', ' ')}**.\n\nOnce quality inspection is complete, your refund/exchange will be initiated. You can check payment status below.`,
            statusBadge: status,
            timestamp: new Date()
          }
        ]);
      } else {
        setMessages(prev => [
          ...prev,
          {
            id: `ai-wh-${Date.now()}`,
            sender: 'ai',
            text: `🕐 **Warehouse Status Check — ${rmaNumber}**\n\nYour item has **not yet been received** at our warehouse. Current status: **${status.replace('_', ' ')}**.\n\nThis typically takes 1-3 business days after pickup. Please check again later.`,
            statusBadge: status,
            timestamp: new Date()
          }
        ]);
      }
    } catch (err) {
      console.error('Warehouse check error:', err);
      setMessages(prev => [
        ...prev,
        { id: `ai-wh-err-${Date.now()}`, sender: 'ai', text: `⚠️ Could not fetch warehouse status at this moment. Please try again in a few seconds.`, timestamp: new Date() }
      ]);
    } finally {
      setStatusCheckLoading(prev => ({ ...prev, [`wh-${msgId}`]: false }));
    }
  };

  // Handler 8: Check Payment / Refund Status from Firestore
  const handleCheckPaymentStatus = async (rmaNumber, msgId) => {
    setStatusCheckLoading(prev => ({ ...prev, [`pay-${msgId}`]: true }));
    try {
      const q = query(collection(db, 'returns'), where('rma_number', '==', rmaNumber));
      const snap = await getDocs(q);
      let status = 'HUMAN_REVIEW';
      let refundAmount = 0;
      let resolutionType = 'store_credit';
      if (!snap.empty) {
        const d = snap.docs[0].data();
        status = normalizeReturnStatus(d.status);
        refundAmount = d.refund_amount || 0;
        resolutionType = d.resolution_type || 'store_credit';
      }

      if (status === 'COMPLETED') {
        setPaymentChecked(prev => ({ ...prev, [msgId]: true }));
        setMessages(prev => [
          ...prev,
          {
            id: `ai-pay-${Date.now()}`,
            sender: 'ai',
            text: `🎉 **Refund Confirmed — ${rmaNumber}**\n\n✅ Your **₹${Number(refundAmount).toFixed(2)}** ${resolutionType === 'replacement' ? 'replacement has been dispatched' : resolutionType === 'store_credit' ? 'has been credited to your store wallet' : 'refund has been processed to your original payment method'}.\n\nReturn case fully resolved. Thank you for shopping with us!`,
            timestamp: new Date()
          }
        ]);
      } else if (status === 'REFUND_PROCESSING') {
        setMessages(prev => [
          ...prev,
          {
            id: `ai-pay-${Date.now()}`,
            sender: 'ai',
            text: `⏳ **Payment is being Processed — ${rmaNumber}**\n\nYour refund of **₹${Number(refundAmount).toFixed(2)}** is currently in **Refund Processing** stage. This usually completes within 2-3 business days. Please check again shortly.`,
            timestamp: new Date()
          }
        ]);
      } else {
        setMessages(prev => [
          ...prev,
          {
            id: `ai-pay-${Date.now()}`,
            sender: 'ai',
            text: `🔄 **Payment Not Yet Initiated — ${rmaNumber}**\n\nCurrent status is **${status.replace('_', ' ')}**. Payment will be initiated once our warehouse completes quality inspection. Please check warehouse status first.`,
            timestamp: new Date()
          }
        ]);
      }
    } catch (err) {
      console.error('Payment check error:', err);
      setMessages(prev => [
        ...prev,
        { id: `ai-pay-err-${Date.now()}`, sender: 'ai', text: `⚠️ Could not fetch payment status. Please try again in a moment.`, timestamp: new Date() }
      ]);
    } finally {
      setStatusCheckLoading(prev => ({ ...prev, [`pay-${msgId}`]: false }));
    }
  };

  // Freeform user text input
  const handleSendTextMessage = () => {
    if (!inputText.trim()) return;
    const text = inputText.trim();
    setInputText('');

    const userMsg = {
      id: `u-${Date.now()}`,
      sender: 'user',
      text,
      timestamp: new Date()
    };
    setMessages(prev => [...prev, userMsg]);

    // Check if user mentions an order number e.g. ORD-1234
    const match = text.match(/(ORD-\w+|#\w+)/i);
    if (match) {
      const found = orders.find(o => o.order_number?.toLowerCase() === match[0].replace('#', '').toLowerCase());
      if (found) {
        handleSelectOrder(found);
        return;
      }
    }

    // Default polite AI agent guidance
    setTimeout(() => {
      setMessages(prev => [
        ...prev,
        {
          id: `ai-${Date.now()}`,
          sender: 'ai',
          text: `I'm analyzing your request: "${text}".\n\nTo make sure our policy engine applies the exact return terms, please select your order from the list above or provide your **Order #** (e.g. *ORD-1002*).`,
          showOrderPicker: true,
          timestamp: new Date()
        }
      ]);
    }, 600);
  };

  return (
    <div className="flex flex-col h-full bg-slate-50/50 rounded-2xl overflow-hidden border border-slate-200 shadow-sm">
      {/* Agent Header Banner */}
      <div className="bg-gradient-to-r from-primary-600 via-indigo-600 to-violet-700 p-4 text-white flex items-center justify-between shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur-md flex items-center justify-center border border-white/30">
            <Bot className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="text-base font-bold flex items-center gap-2">
              Nova AI Return Agent
              <span className="text-[10px] bg-emerald-500 text-white font-bold px-2 py-0.5 rounded-full">
                ONLINE
              </span>
            </h3>
            <p className="text-xs text-indigo-100">
              Autonomous Policy Orchestrator &bull; 10-Stage Pipeline
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={handleClearChat}
              className="text-xs bg-white/10 hover:bg-white/20 text-white px-2.5 py-1.5 rounded-xl border border-white/20 transition-colors flex items-center gap-1.5 cursor-pointer shadow-xs"
              title="Start a new chat session"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">New Chat</span>
            </button>
          )}
          <div className="hidden sm:flex items-center gap-2 text-xs bg-white/10 backdrop-blur-xs px-3 py-1.5 rounded-xl border border-white/20 text-indigo-100">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>Strict Policy Enforcement</span>
          </div>
        </div>
      </div>

      {/* Chat Messages Body */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
          >
            {/* Chat Bubble */}
            <div
              className={`max-w-[92%] sm:max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-xs ${
                msg.sender === 'user'
                  ? 'bg-primary-600 text-white rounded-br-none'
                  : msg.isWarning
                  ? 'bg-amber-50 text-amber-900 border border-amber-200 rounded-bl-none'
                  : msg.isServiceCenter
                  ? 'bg-orange-50 text-orange-950 border border-orange-200 rounded-bl-none'
                  : 'bg-white text-slate-800 border border-slate-200/80 rounded-bl-none'
              }`}
            >
              <div className="whitespace-pre-wrap font-normal">
                {msg.text.split('\n').map((line, i) => (
                  <p key={i} className={line.startsWith('#') ? 'font-bold mt-1 mb-0.5' : ''}>
                    {line.replace(/^#+\s*/, '')}
                  </p>
                ))}
              </div>
            </div>

            {/* Interactive Widget: Order Picker */}
            {msg.showOrderPicker && orders.length > 0 && currentStep === 'SELECT_ORDER' && (
              <div className="w-full sm:max-w-[85%] mt-3 space-y-2">
                <p className="text-xs font-bold text-slate-500 uppercase tracking-wider px-1">
                  Select an Order to Return:
                </p>
                <div className="grid grid-cols-1 gap-2">
                  {orders.map((ord) => {
                    const isDelivered = ord.status === 'delivered';
                    return (
                      <button
                        key={ord.id}
                        onClick={() => handleSelectOrder(ord)}
                        className="group bg-white p-3.5 rounded-xl border border-slate-200 hover:border-primary-500 hover:shadow-md transition-all text-left flex items-center justify-between cursor-pointer"
                      >
                        <div className="flex items-center gap-3">
                          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                            isDelivered ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'
                          }`}>
                            <Package className="w-5 h-5" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-sm text-slate-900 group-hover:text-primary-600 transition-colors">
                                #{ord.order_number}
                              </span>
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                isDelivered 
                                  ? 'bg-emerald-100 text-emerald-700' 
                                  : 'bg-slate-100 text-slate-600'
                              }`}>
                                {ord.status?.toUpperCase() || 'ORDERED'}
                              </span>
                            </div>
                            <p className="text-xs text-slate-500 mt-0.5">
                              {ord.items?.length || 0} item(s) &bull; Total: ₹{ord.pricing?.total?.toFixed(2) || '0.00'}
                            </p>
                          </div>
                        </div>
                        <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-primary-600 group-hover:translate-x-0.5 transition-all" />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Interactive Widget: Product Picker */}
            {msg.showProductPicker && msg.targetOrder && currentStep === 'SELECT_PRODUCT' && (
              <div className="w-full sm:max-w-[85%] mt-3 space-y-2">
                <p className="text-xs font-bold text-slate-500 uppercase tracking-wider px-1">
                  Select Product to Return:
                </p>
                <div className="grid grid-cols-1 gap-2">
                  {msg.targetOrder.items?.map((item, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleSelectProduct(item)}
                      className="group bg-white p-3 rounded-xl border border-slate-200 hover:border-primary-500 hover:shadow-md transition-all text-left flex items-center gap-3 cursor-pointer"
                    >
                      <div className="w-14 h-14 rounded-lg bg-slate-100 overflow-hidden flex-shrink-0 border border-slate-100 flex items-center justify-center">
                        {item.image_url || item.images?.[0] ? (
                          <img 
                            src={item.image_url || item.images?.[0]} 
                            alt={item.name} 
                            className="w-full h-full object-contain p-1"
                          />
                        ) : (
                          <Package className="w-6 h-6 text-slate-300" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-sm font-bold text-slate-900 truncate group-hover:text-primary-600 transition-colors">
                          {item.name}
                        </h4>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs font-bold text-slate-800">
                            ₹{Number(item.price).toFixed(2)}
                          </span>
                          <span className="text-[11px] text-slate-400">
                            Qty: {item.quantity || 1}
                          </span>
                          <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.2 rounded-sm capitalize">
                            {item.category || 'General'}
                          </span>
                        </div>
                      </div>
                      <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-primary-600 group-hover:translate-x-0.5 transition-all" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Interactive Widget: Reason Selection Form */}
            {msg.showReasonForm && currentStep === 'SELECT_REASON' && (
              <div className="w-full sm:max-w-[85%] mt-3 bg-white p-4 rounded-2xl border border-slate-200 shadow-sm space-y-3">
                <p className="text-xs font-bold text-slate-700">
                  {msg.isExceptionMode ? 'Reason for Exception Request:' : 'Select Return Reason:'}
                </p>

                <div className="space-y-1.5">
                  {COMMON_REASONS.map((r) => (
                    <label
                      key={r.code}
                      onClick={() => setSelectedReason(r.code)}
                      className={`flex items-start gap-3 p-2.5 rounded-xl border text-xs cursor-pointer transition-all ${
                        selectedReason === r.code
                          ? 'border-primary-600 bg-primary-50/40 text-primary-950 font-medium'
                          : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                      }`}
                    >
                      <input
                        type="radio"
                        name="return_reason"
                        checked={selectedReason === r.code}
                        onChange={() => setSelectedReason(r.code)}
                        className="mt-0.5 text-primary-600 focus:ring-primary-500"
                      />
                      <div>
                        <p className="font-bold">{r.label}</p>
                        <p className="text-[11px] text-slate-500 mt-0.5">{r.desc}</p>
                      </div>
                    </label>
                  ))}
                </div>

                <div>
                  <label className="text-[11px] font-bold text-slate-600 block mb-1">
                    Customer Comments / Additional Details (Optional):
                  </label>
                  <textarea
                    value={reasonNotes}
                    onChange={(e) => setReasonNotes(e.target.value)}
                    placeholder="Describe the issue or specify preferred exchange size..."
                    rows={2}
                    className="w-full text-xs p-2.5 rounded-xl border border-slate-200 focus:border-primary-500 focus:outline-hidden"
                  />
                </div>

                <button
                  onClick={handleSubmitReason}
                  className="w-full py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-1.5 shadow-sm"
                >
                  <span>{msg.isExceptionMode ? 'Submit Exception to Human Review' : 'Continue to Resolution'}</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Interactive Widget: Resolution Selection */}
            {msg.showResolutionPicker && currentStep === 'SELECT_RESOLUTION' && (
              <div className="w-full sm:max-w-[85%] mt-3 bg-white p-4 rounded-2xl border border-slate-200 shadow-sm space-y-3">
                <p className="text-xs font-bold text-slate-700">Choose your preferred settlement:</p>

                <div className="space-y-2">
                  <div
                    onClick={() => handleSelectResolution('store_credit')}
                    className="group p-3 rounded-xl border border-emerald-300 bg-emerald-50/50 hover:bg-emerald-50 transition-all cursor-pointer relative overflow-hidden"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CreditCard className="w-4 h-4 text-emerald-600" />
                        <span className="font-bold text-xs text-emerald-950">
                          Store Credit + 10% Extra Bonus
                        </span>
                      </div>
                      <span className="text-[10px] bg-emerald-600 text-white font-bold px-2 py-0.5 rounded-full">
                        RECOMMENDED
                      </span>
                    </div>
                    <p className="text-[11px] text-emerald-800 mt-1">
                      Instant wallet credit of <strong>₹{(Number(selectedItem?.price || 0) * 1.10).toFixed(2)}</strong> immediately upon pickup scan.
                    </p>
                  </div>

                  <div
                    onClick={() => handleSelectResolution('original_payment')}
                    className="p-3 rounded-xl border border-slate-200 hover:border-primary-400 hover:bg-slate-50 transition-all cursor-pointer"
                  >
                    <div className="flex items-center gap-2 font-bold text-xs text-slate-800">
                      <RefreshCw className="w-4 h-4 text-primary-600" />
                      <span>Original Payment Method</span>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      Refund of <strong>₹{Number(selectedItem?.price || 0).toFixed(2)}</strong> credited back to your bank card/UPI in 3 business days.
                    </p>
                  </div>

                  <div
                    onClick={() => handleSelectResolution('exchange')}
                    className="p-3 rounded-xl border border-slate-200 hover:border-primary-400 hover:bg-slate-50 transition-all cursor-pointer"
                  >
                    <div className="flex items-center gap-2 font-bold text-xs text-slate-800">
                      <RotateCcw className="w-4 h-4 text-violet-600" />
                      <span>Free Size / Color Exchange</span>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      We dispatch an exchange unit right as the courier collects this package. Free pickup.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Interactive Widget: Pickup Slot Picker */}
            {msg.showPickupSlotPicker && currentStep === 'SCHEDULE_PICKUP' && (
              <div className="w-full sm:max-w-[85%] mt-3 bg-white p-4 rounded-2xl border border-slate-200 shadow-sm space-y-3">
                <div className="flex items-center gap-2 text-xs font-bold text-slate-800">
                  <Truck className="w-4 h-4 text-primary-600" />
                  <span>BlueDart Express Reverse Pickup Slot</span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedSlot('tomorrow_morning')}
                    className={`p-3 rounded-xl border text-xs font-medium text-center transition-all ${
                      selectedSlot === 'tomorrow_morning'
                        ? 'border-primary-600 bg-primary-50/50 text-primary-800 font-bold shadow-xs'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    Tomorrow Morning<br />
                    <span className="text-[10px] text-slate-500 font-normal">10:00 AM - 1:00 PM</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setSelectedSlot('tomorrow_evening')}
                    className={`p-3 rounded-xl border text-xs font-medium text-center transition-all ${
                      selectedSlot === 'tomorrow_evening'
                        ? 'border-primary-600 bg-primary-50/50 text-primary-800 font-bold shadow-xs'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    Tomorrow Evening<br />
                    <span className="text-[10px] text-slate-500 font-normal">2:00 PM - 6:00 PM</span>
                  </button>
                </div>

                <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-100 text-[11px] text-slate-600">
                  <strong>Pickup Location:</strong> {selectedOrder?.customer?.address?.street || 'Registered Address'}, {selectedOrder?.customer?.address?.city || ''}
                </div>

                <button
                  disabled={isProcessing}
                  onClick={handleConfirmPickup}
                  className="w-full py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-1.5 shadow-md shadow-primary-600/20"
                >
                  {isProcessing ? (
                    <div className="flex items-center gap-2">
                      <div className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-white border-t-transparent" />
                      <span>Authorizing RMA & Booking BlueDart...</span>
                    </div>
                  ) : (
                    <>
                      <span>Authorize Return &amp; Schedule Reverse Pickup</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </>
                  )}
                </button>
              </div>
            )}

            {/* Interactive Widget: Successful RMA Card */}
            {msg.showRmaCard && msg.rmaData && (
              <div className="w-full sm:max-w-[85%] mt-3 bg-white rounded-2xl border-2 border-emerald-400 shadow-lg overflow-hidden">
                <div className="bg-emerald-600 p-3.5 text-white flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-white" />
                    <div>
                      <h4 className="font-bold text-sm leading-tight">
                        RMA Authorized: {msg.rmaData.rma_number}
                      </h4>
                      <p className="text-[11px] text-emerald-100">
                        Autonomous AI Approval &bull; Reverse Courier Pass Active
                      </p>
                    </div>
                  </div>
                  <span className="text-[10px] bg-white/20 px-2 py-0.5 rounded-full font-bold">
                    STAGE 5/10
                  </span>
                </div>

                <div className="p-4 space-y-3">
                  <div className="flex items-center justify-between text-xs pb-3 border-b border-slate-100">
                    <div>
                      <p className="text-slate-400 text-[10px]">Product</p>
                      <p className="font-bold text-slate-800 truncate max-w-[200px]">{msg.rmaData.item?.name}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-slate-400 text-[10px]">Refund Amount</p>
                      <p className="font-extrabold text-sm text-emerald-600">
                        ₹{Number(msg.rmaData.refund_amount).toFixed(2)}
                      </p>
                    </div>
                  </div>

                  {/* QR Code Courier Pass - Click opens existing ReturnModal */}
                  <div 
                    onClick={() => {
                      setModalReturnData(msg.rmaData);
                      setModalOrderData(selectedOrder);
                      setIsReturnModalOpen(true);
                    }}
                    className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200 cursor-pointer hover:bg-slate-100/90 transition-all group"
                    title="Click to open existing Return Details & QR Pass"
                  >
                    <div className="bg-white p-1 rounded-lg border border-slate-200 shadow-xs flex-shrink-0 group-hover:scale-105 transition-transform">
                      <QRCodeDisplay
                        value={msg.rmaData.rma_number || 'RMA'}
                        size={64}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-slate-800 flex items-center justify-between">
                        <span>Courier Pickup Pass</span>
                        <span className="text-[10px] text-primary-600 font-semibold underline">Tap to open</span>
                      </p>
                      <p className="text-[11px] text-slate-500 font-mono truncate">
                        Tracking: {msg.rmaData.pickup_details?.tracking_number}
                      </p>
                      <p className="text-[10px] text-emerald-700 font-medium mt-0.5">
                        Slot: {msg.rmaData.pickup_details?.slot}
                      </p>
                    </div>
                  </div>

                  {/* Timeline Preview */}
                  <div className="pt-1">
                    <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">
                      Pipeline Status: PICKUP_SCHEDULED (Stage 5 of 10)
                    </p>
                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((step) => (
                        <div
                          key={step}
                          className={`h-1.5 flex-1 rounded-full ${
                            step <= 5 ? 'bg-emerald-500' : 'bg-slate-200'
                          }`}
                          title={`Stage ${step}`}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Button opens existing ReturnModal with QR and tracking */}
                  <div className="pt-1 flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setModalReturnData(msg.rmaData);
                        setModalOrderData(selectedOrder);
                        setIsReturnModalOpen(true);
                      }}
                      className="flex-1 py-2.5 bg-primary-600 hover:bg-primary-700 text-white text-xs font-bold rounded-xl text-center flex items-center justify-center gap-2 transition-colors cursor-pointer shadow-sm"
                    >
                      <QrCode className="w-4 h-4 text-white" />
                      <span>View QR Code &amp; Return Details</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Interactive Widget: Exception Escalation Ticket Card */}
            {msg.showExceptionCard && msg.rmaData && (
              <div className="w-full sm:max-w-[85%] mt-3 bg-white rounded-2xl border-2 border-amber-400 shadow-lg p-4 space-y-3">
                <div className="flex items-center gap-2 text-amber-800 font-bold text-sm">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  <span>Human Review Ticket: {msg.rmaData.rma_number}</span>
                </div>
                <p className="text-xs text-slate-600">
                  Case is currently in status: <span className="font-bold text-amber-700">HUMAN_REVIEW</span>.
                </p>
                <div className="p-2.5 bg-amber-50 rounded-xl text-[11px] text-amber-900 border border-amber-200">
                  Our returns operations staff will inspect your order and notes. You will receive real-time notifications right on your Returns portal.
                </div>

                {/* ── Status Check Buttons ── */}
                <div className="pt-1 border-t border-amber-200 space-y-2">
                  <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Live Status Updates</p>

                  {/* Button 1: Check Warehouse Status */}
                  {!warehouseChecked[msg.id] ? (
                    <button
                      type="button"
                      disabled={statusCheckLoading[`wh-${msg.id}`]}
                      onClick={() => handleCheckWarehouseStatus(msg.rmaData.rma_number, msg.id)}
                      className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded-xl transition-colors disabled:opacity-60 shadow-sm"
                    >
                      {statusCheckLoading[`wh-${msg.id}`] ? (
                        <><span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full" /><span>Checking Warehouse...</span></>
                      ) : (
                        <><Truck className="w-3.5 h-3.5 text-orange-400" /><span>Check Warehouse Status</span></>
                      )}
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 py-2 px-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-700 font-semibold">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Warehouse accepted ✓ — Stage: {warehouseChecked[msg.id]?.replace('_', ' ')}</span>
                    </div>
                  )}

                  {/* Button 2: Check Payment Status — shown after warehouse is accepted */}
                  {warehouseChecked[msg.id] && !paymentChecked[msg.id] && (
                    <button
                      type="button"
                      disabled={statusCheckLoading[`pay-${msg.id}`]}
                      onClick={() => handleCheckPaymentStatus(msg.rmaData.rma_number, msg.id)}
                      className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-primary-600 hover:bg-primary-700 text-white text-xs font-bold rounded-xl transition-colors disabled:opacity-60 shadow-sm"
                    >
                      {statusCheckLoading[`pay-${msg.id}`] ? (
                        <><span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full" /><span>Checking Payment...</span></>
                      ) : (
                        <><CreditCard className="w-3.5 h-3.5 text-primary-200" /><span>Check Payment Status</span></>
                      )}
                    </button>
                  )}

                  {/* Done state */}
                  {paymentChecked[msg.id] && (
                    <div className="flex items-center gap-2 py-2 px-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-700 font-semibold">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Refund Confirmed ✓ — Case fully resolved</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}

        {isProcessing && (
          <div className="flex items-center gap-2 text-slate-500 text-xs bg-white border border-slate-200/80 px-3.5 py-2.5 rounded-2xl w-max shadow-xs">
            <div className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-primary-600 border-t-transparent" />
            <span>AI Policy Agent evaluating parameters...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Bar */}
      <div className="p-3 bg-white border-t border-slate-200">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSendTextMessage();
          }}
          className="flex items-center gap-2 bg-slate-100 rounded-xl px-3 py-2 border border-slate-200 focus-within:border-primary-500 focus-within:bg-white transition-all"
        >
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Type your return question or enter Order # (e.g. ORD-1002)..."
            className="flex-1 bg-transparent text-xs sm:text-sm text-slate-800 placeholder-slate-400 outline-hidden"
          />
          <button
            type="submit"
            disabled={!inputText.trim() || isProcessing}
            className={`p-2 rounded-lg transition-all ${
              inputText.trim() && !isProcessing
                ? 'bg-primary-600 hover:bg-primary-700 text-white shadow-sm'
                : 'text-slate-400 bg-transparent cursor-not-allowed'
            }`}
            aria-label="Send message"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>

      {/* Existing Return Modal Popup Component */}
      {isReturnModalOpen && (modalOrderData || selectedOrder) && (
        <ReturnModal
          isOpen={isReturnModalOpen}
          onClose={() => {
            setIsReturnModalOpen(false);
            setModalReturnData(null);
            setModalOrderData(null);
          }}
          order={modalOrderData || selectedOrder}
          existingReturn={modalReturnData || createdRma}
          initialTab="track"
        />
      )}
    </div>
  );
}
