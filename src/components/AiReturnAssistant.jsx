/**
 * AiReturnAssistant — Phase B Rewrite
 * All decisions happen server-side via POST /agent/chat.
 * Browser only renders: messages, typing indicator, case card, quick-reply chips, evidence upload.
 * No browser-side eligibility, RMA generation, or status decisions.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Bot, Send, Sparkles, CheckCircle2, AlertTriangle,
  RotateCcw, Package, Truck, ArrowRight, ShieldCheck,
  Upload, UserCheck, X, Loader2, FileCheck, Shield
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

// ─── Config ───────────────────────────────────────────────────────────────

const SERVER = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
const STORAGE_KEY_PREFIX = 'agent_conv_id_';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// ─── State stepper stages ─────────────────────────────────────────────────

const STATE_STEPS = [
  { key: 'REQUESTED',         label: 'Submitted',        icon: Package },
  { key: 'APPROVED',          label: 'Approved',         icon: CheckCircle2 },
  { key: 'PICKUP_SCHEDULED',  label: 'Pickup Booked',    icon: Truck },
  { key: 'IN_TRANSIT',        label: 'In Transit',       icon: ArrowRight },
  { key: 'RECEIVED',          label: 'Received',         icon: UserCheck },
  { key: 'COMPLETED',         label: 'Resolved',         icon: Sparkles },
];

const STATE_ORDER = STATE_STEPS.map(s => s.key);

// ─── Helpers ──────────────────────────────────────────────────────────────

function getConvStorageKey(uid) {
  return STORAGE_KEY_PREFIX + (uid || 'guest');
}

function getOrCreateConvId(uid) {
  const key = getConvStorageKey(uid);
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = `conv_${uid || 'g'}_${Date.now().toString(36)}`;
    sessionStorage.setItem(key, id);
  }
  return id;
}

function resetConvId(uid) {
  const key = getConvStorageKey(uid);
  const id = `conv_${uid || 'g'}_${Date.now().toString(36)}`;
  sessionStorage.setItem(key, id);
  return id;
}

/** Parse markdown bold (**text**) into <strong> spans */
function parseMarkdown(text = '') {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

/** Extract quick-reply options from agent message */
function extractChips(text = '') {
  const chips = [];

  // Order picker chips: match ord_xxx or Order #xxx
  const orderMatches = text.match(/(?:ord_[a-zA-Z0-9_-]+|order\s+#?[a-zA-Z0-9_-]{5,})/gi);
  if (orderMatches) {
    const seen = new Set();
    for (const match of orderMatches) {
      const clean = match.replace(/^order\s*#?/i, '').trim();
      if (!seen.has(clean)) {
        seen.add(clean);
        chips.push({ label: `📦 ${clean}`, value: `I want to return an item from order ${clean}` });
      }
    }
  }

  // Resolution options
  if (/refund|exchange|store credit/i.test(text)) {
    chips.push(
      { label: '💳 Refund to original', value: 'I want a refund to my original payment method' },
      { label: '🔄 Exchange', value: 'I want an exchange' },
      { label: '🛍️ Store credit', value: 'I want store credit' },
    );
  }

  // Reason options
  if (/reason|why.*return|return.*reason/i.test(text) && chips.length === 0) {
    chips.push(
      { label: '💥 Damaged / defective', value: 'The item is damaged or defective' },
      { label: '📦 Wrong item', value: 'I received the wrong item' },
      { label: '🚫 Not needed', value: 'I no longer need it' },
      { label: '📐 Size / fit issue', value: 'Size or fit issue' },
    );
  }

  // Yes/No confirmation
  if (/would you like|confirm|shall i|do you want/i.test(text) && chips.length === 0) {
    chips.push(
      { label: '✅ Yes, proceed', value: 'Yes, please proceed' },
      { label: '❌ No, cancel', value: 'No, cancel' },
    );
  }

  // Appeal option
  if (/appeal|file.*appeal|challenge/i.test(text) && chips.length === 0) {
    chips.push({ label: '📋 File an appeal', value: 'Yes, I want to file an appeal' });
  }

  // Human agent
  if (/specialist|human|team member/i.test(text) && chips.length === 0) {
    chips.push({ label: '🧑‍💼 Speak to a human', value: 'I want to speak to a human agent' });
  }

  return chips;
}

// ─── Case Card component ──────────────────────────────────────────────────

function CaseCard({ caseCard }) {
  if (!caseCard?.returnId && !caseCard?.state) return null;

  const currentIdx = STATE_ORDER.indexOf(caseCard.state);

  const stateColors = {
    APPROVED:         'bg-emerald-100 text-emerald-800',
    PICKUP_SCHEDULED: 'bg-blue-100 text-blue-800',
    IN_TRANSIT:       'bg-indigo-100 text-indigo-800',
    RECEIVED:         'bg-purple-100 text-purple-800',
    COMPLETED:        'bg-emerald-100 text-emerald-800',
    HUMAN_REVIEW:     'bg-amber-100 text-amber-800',
    REJECTED:         'bg-red-100 text-red-800',
    DENIED:           'bg-red-100 text-red-800',
    REQUESTED:        'bg-slate-100 text-slate-700',
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full max-w-sm mt-3 bg-gradient-to-br from-white to-indigo-50/40 border border-indigo-100 rounded-2xl p-4 shadow-sm"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
          <FileCheck className="w-3.5 h-3.5 text-indigo-500" />
          Case Summary
        </span>
        {caseCard.state && (
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${stateColors[caseCard.state] || 'bg-slate-100 text-slate-700'}`}>
            {caseCard.state?.replace(/_/g, ' ')}
          </span>
        )}
      </div>

      {/* RMA / Return ID */}
      {(caseCard.rmaNumber || caseCard.rmaCode || caseCard.returnId) && (
        <div className="mb-3 p-2.5 bg-indigo-600/5 rounded-xl border border-indigo-100 flex items-center justify-between">
          <div>
            <p className="text-[10px] text-slate-500 font-medium">RMA Number</p>
            <p className="text-sm font-mono font-bold text-indigo-700 mt-0.5">
              {caseCard.rmaNumber || caseCard.rmaCode || caseCard.returnId}
            </p>
          </div>
          {caseCard.returnId && caseCard.returnId !== (caseCard.rmaNumber || caseCard.rmaCode) && (
            <div className="text-right">
              <p className="text-[10px] text-slate-400 font-medium">Return ID</p>
              <p className="text-xs font-mono text-slate-600 mt-0.5">{caseCard.returnId}</p>
            </div>
          )}
        </div>
      )}

      {/* Decision & Policy Rule Explained */}
      {(caseCard.decision || caseCard.ruleExplanation) && (
        <div className="mb-3 p-2.5 bg-slate-50 rounded-xl border border-slate-100">
          <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
            Decision: <span className="text-slate-800">{caseCard.decision || 'Policy Evaluated'}</span>
          </p>
          {caseCard.ruleExplanation && (
            <p className="text-xs text-slate-700 mt-1 leading-relaxed">
              {caseCard.ruleExplanation}
            </p>
          )}
        </div>
      )}

      {/* Stepper */}
      {currentIdx >= 0 && (
        <div className="mt-3">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Progress</p>
          <div className="flex items-center gap-1">
            {STATE_STEPS.slice(0, 6).map((step, i) => {
              const done   = i <= currentIdx;
              const active = i === currentIdx;
              const Icon   = step.icon;
              return (
                <div key={step.key} className="flex items-center flex-1">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${
                    done
                      ? active
                        ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-300'
                        : 'bg-emerald-500 text-white'
                      : 'bg-slate-100 text-slate-400'
                  }`}>
                    <Icon className="w-3 h-3" />
                  </div>
                  {i < STATE_STEPS.length - 1 && (
                    <div className={`flex-1 h-0.5 mx-0.5 rounded-full transition-all ${done && i < currentIdx ? 'bg-emerald-400' : 'bg-slate-200'}`} />
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex justify-between mt-1">
            {STATE_STEPS.slice(0, 6).map((step, i) => (
              <span key={step.key} className={`text-[8px] font-medium ${i <= currentIdx ? 'text-indigo-700' : 'text-slate-400'}`}>
                {step.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {caseCard.nextStep && (
        <div className="mt-3 flex items-start gap-2 text-xs text-slate-600 bg-white rounded-xl p-2.5 border border-slate-100">
          <ArrowRight className="w-3.5 h-3.5 text-indigo-500 mt-0.5 flex-shrink-0" />
          <span>{caseCard.nextStep}</span>
        </div>
      )}

      {caseCard.state === 'HUMAN_REVIEW' && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 rounded-xl p-2 border border-amber-100">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          A specialist is reviewing your case. Response within 24 hours.
        </div>
      )}
    </motion.div>
  );
}

// ─── Evidence Upload component ────────────────────────────────────────────

function EvidenceUpload({ conversationId, userToken, onResult }) {
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const handleFile = async (file) => {
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      setError('File too large. Maximum 5 MB.');
      return;
    }

    setUploading(true);
    setError(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('conversationId', conversationId);

    try {
      const headers = {};
      if (userToken) headers['Authorization'] = `Bearer ${userToken}`;
      else headers['x-dev-uid'] = conversationId.split('_')[1] || 'dev';

      const res = await fetch(`${SERVER}/agent/evidence`, {
        method: 'POST',
        headers,
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Upload failed');
        setUploading(false);
        return;
      }

      setResult(data);
      onResult?.(data);
    } catch (e) {
      setError('Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  if (result) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="flex items-center gap-2 text-xs bg-emerald-50 text-emerald-800 px-3 py-2 rounded-xl border border-emerald-200 mt-2"
      >
        <FileCheck className="w-4 h-4 text-emerald-600 flex-shrink-0" />
        <div>
          <span className="font-bold">Evidence recorded</span>
          {result.verified
            ? ` • Confidence: ${result.confidence}`
            : ' • Unverified (vision analysis unavailable)'
          }
        </div>
      </motion.div>
    );
  }

  return (
    <div className="mt-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className="flex items-center gap-2 text-xs bg-indigo-50 hover:bg-indigo-100 text-indigo-700 px-3 py-2 rounded-xl border border-indigo-200 transition-colors cursor-pointer disabled:opacity-60"
      >
        {uploading ? (
          <><Loader2 className="w-4 h-4 animate-spin" /> Uploading & analysing...</>
        ) : (
          <><Upload className="w-4 h-4" /> Upload photo evidence</>
        )}
      </button>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────

export default function AiReturnAssistant({ preSelectedOrder = null, onReturnCreated = null }) {
  const { user } = useAuth();

  const [messages, setMessages]           = useState([]);
  const [inputText, setInputText]         = useState('');
  const [isTyping, setIsTyping]           = useState(false);
  const [caseCard, setCaseCard]           = useState(null);
  const [conversationId, setConversationId] = useState(() => getOrCreateConvId(user?.uid));
  const [handledByStaff, setHandledByStaff] = useState(false);
  const [agentOffline, setAgentOffline]   = useState(false);
  const [pendingEvidence, setPendingEvidence] = useState(null); // last evidence analysis to inject
  const [showEvidenceUpload, setShowEvidenceUpload] = useState(false);

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  // On mount: try to resume conversation
  useEffect(() => {
    async function resume() {
      const convId = getOrCreateConvId(user?.uid);
      setConversationId(convId);

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (user?.uid) headers['x-dev-uid'] = user.uid;
        const res = await fetch(`${SERVER}/agent/conversations/${convId}`, { headers });
        if (res.ok) {
          const data = await res.json();
          if (data.messages?.length > 0) {
            // Rehydrate last 10 turns from server
            const rehydrated = data.messages
              .filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'staff')
              .slice(-20)
              .map((m, i) => ({
                id:        `r-${i}`,
                sender:    m.role === 'user' ? 'user' : m.role === 'staff' ? 'staff' : 'ai',
                text:      m.content || '',
                timestamp: new Date(m.timestamp || Date.now()),
              }));
            if (rehydrated.length > 0) {
              setMessages(rehydrated);
              setCaseCard(data.caseCard || null);
              setHandledByStaff(!!data.handledBy);
              return;
            }
          }
        }
      } catch { /* not found or server not running — start fresh */ }

      // Fresh welcome
      pushWelcome(convId);
    }

    resume();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid]);

  // Handle preSelectedOrder (deep-link into a specific order)
  useEffect(() => {
    if (preSelectedOrder && messages.length > 0) {
      const msg = `I want to return an item from order ${preSelectedOrder.id || preSelectedOrder.order_id || preSelectedOrder.order_number}`;
      sendMessage(msg);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preSelectedOrder]);

  function pushWelcome(convId) {
    const name = user?.displayName?.split(' ')[0] || user?.email?.split('@')[0] || 'there';
    addMsg({
      sender: 'ai',
      text:   `👋 Hi ${name}! I'm your **Returns Agent**.\n\nI can help you return, exchange, or get a refund for any eligible item. Just tell me what's wrong with your order — or type your **Order ID** to get started.`,
    });
  }

  function addMsg(msgPartial) {
    const msg = {
      id:        `m-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      sender:    msgPartial.sender,
      text:      msgPartial.text || '',
      caseCard:  msgPartial.caseCard || null,
      chips:     msgPartial.chips || [],
      showEvidence: msgPartial.showEvidence || false,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, msg]);
    return msg;
  }

  const sendMessage = useCallback(async (textOverride = null) => {
    const text = (textOverride || inputText).trim();
    if (!text) return;
    setInputText('');

    // Inject evidence analysis as untrusted data block if pending
    let finalText = text;
    if (pendingEvidence) {
      finalText = text + `\n\n--- BEGIN UNTRUSTED EVIDENCE DATA ---\n${pendingEvidence.analysis}\nConfidence: ${pendingEvidence.confidence}\n--- END UNTRUSTED EVIDENCE DATA ---`;
      setPendingEvidence(null);
      setShowEvidenceUpload(false);
    }

    addMsg({ sender: 'user', text });
    setIsTyping(true);

    try {
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      };
      if (user?.uid) headers['x-dev-uid'] = user.uid;

      const res = await fetch(`${SERVER}/agent/chat`, {
        method:  'POST',
        headers,
        body:    JSON.stringify({ message: finalText, conversationId }),
      });

      if (!res.ok) {
        throw new Error(`Server error ${res.status}`);
      }

      const contentType = res.headers.get('content-type') || '';

      if (contentType.includes('text/event-stream') && res.body) {
        setIsTyping(false);
        const aiMsgId = `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        setMessages(prev => [...prev, {
          id: aiMsgId,
          sender: 'ai',
          text: '',
          timestamp: new Date(),
        }]);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let streamedReply = '';
        let finalCaseCard = null;
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
              try {
                const parsed = JSON.parse(trimmed.slice(6));
                if (parsed.token) {
                  streamedReply += parsed.token;
                  setMessages(prev => prev.map(m => m.id === aiMsgId ? { ...m, text: streamedReply } : m));
                }
                if (parsed.done) {
                  finalCaseCard = parsed.caseCard || null;
                }
              } catch { /* skip incomplete SSE packet */ }
            }
          }
        }

        const wantsEvidence = /upload|photo|evidence|image|picture/i.test(streamedReply);
        if (streamedReply.includes('A team member is currently helping')) {
          setHandledByStaff(true);
        }
        if (finalCaseCard) {
          setCaseCard(finalCaseCard);
          if (onReturnCreated && finalCaseCard.returnId) onReturnCreated(finalCaseCard);
        }

        setMessages(prev => prev.map(m => m.id === aiMsgId ? {
          ...m,
          text: streamedReply,
          caseCard: finalCaseCard,
          chips: extractChips(streamedReply),
          showEvidence: wantsEvidence,
        } : m));

        if (wantsEvidence) setShowEvidenceUpload(true);

      } else {
        // Fallback for single JSON response
        const data = await res.json();
        setIsTyping(false);

        if (data.caseCard) {
          setCaseCard(data.caseCard);
          if (onReturnCreated && data.caseCard.returnId) onReturnCreated(data.caseCard);
        }

        const wantsEvidence = /upload|photo|evidence|image|picture/i.test(data.reply || '');
        if (data.reply?.includes('A team member is currently helping')) {
          setHandledByStaff(true);
        }

        addMsg({
          sender:      'ai',
          text:        data.reply || '',
          caseCard:    data.caseCard,
          chips:       extractChips(data.reply || ''),
          showEvidence: wantsEvidence,
        });

        if (wantsEvidence) setShowEvidenceUpload(true);
      }

    } catch (err) {
      setIsTyping(false);
      setAgentOffline(true);
      addMsg({
        sender: 'ai',
        text:   "I've passed your request to our team — someone will follow up with you shortly.",
      });
      // Best-effort escalation call
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (user?.uid) headers['x-dev-uid'] = user.uid;
        await fetch(`${SERVER}/agent/chat`, {
          method: 'POST', headers,
          body: JSON.stringify({
            message: 'SYSTEM: escalate_to_human due to agent unavailability. Transcript: ' + text,
            conversationId,
          }),
        });
      } catch { /* best effort */ }
    }
  }, [inputText, conversationId, pendingEvidence, user?.uid, onReturnCreated]);

  const handleChipClick = (value) => {
    sendMessage(value);
  };

  const handleEvidenceResult = (data) => {
    setPendingEvidence(data);
    // Show confirmation in chat
    addMsg({
      sender: 'ai',
      text:   data.verified
        ? `📸 Photo received and analysed (confidence: **${data.confidence}**). Please describe the issue in a message and I'll include the evidence in your return request.`
        : `📸 Photo uploaded (analysis unavailable — recorded as unverified). Please describe the issue and I'll continue.`,
    });
  };

  const handleNewChat = () => {
    const newId = resetConvId(user?.uid);
    setConversationId(newId);
    setMessages([]);
    setCaseCard(null);
    setHandledByStaff(false);
    setAgentOffline(false);
    setPendingEvidence(null);
    setShowEvidenceUpload(false);
    setTimeout(() => pushWelcome(newId), 50);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full bg-slate-50/50 rounded-2xl overflow-hidden border border-slate-200 shadow-sm">

      {/* Header */}
      <div className="bg-gradient-to-r from-primary-600 via-indigo-600 to-violet-700 p-4 text-white flex items-center justify-between shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur-md flex items-center justify-center border border-white/30">
            <Bot className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="text-base font-bold flex items-center gap-2">
              Nova AI Return Agent
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${agentOffline ? 'bg-red-500' : 'bg-emerald-500'}`}>
                {agentOffline ? 'OFFLINE' : 'ONLINE'}
              </span>
            </h3>
            <p className="text-xs text-indigo-100">
              Autonomous Policy Orchestrator • Returns & Refunds
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {handledByStaff && (
            <span className="text-xs bg-amber-500 text-white px-2 py-1 rounded-xl font-bold flex items-center gap-1">
              <UserCheck className="w-3 h-3" /> Staff handling
            </span>
          )}
          {messages.length > 0 && (
            <button
              type="button"
              onClick={handleNewChat}
              className="text-xs bg-white/10 hover:bg-white/20 text-white px-2.5 py-1.5 rounded-xl border border-white/20 transition-colors flex items-center gap-1.5 cursor-pointer"
              title="Start a new return request"
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

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
        <AnimatePresence initial={false}>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
            >
              {/* Avatar for AI/staff */}
              {msg.sender !== 'user' && (
                <div className="flex items-center gap-1.5 mb-1 ml-1">
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center text-white ${msg.sender === 'staff' ? 'bg-amber-500' : 'bg-indigo-600'}`}>
                    {msg.sender === 'staff'
                      ? <UserCheck className="w-3 h-3" />
                      : <Bot className="w-3 h-3" />
                    }
                  </div>
                  <span className="text-[10px] text-slate-500 font-medium">
                    {msg.sender === 'staff' ? 'Staff Agent' : 'Nova AI'}
                  </span>
                </div>
              )}

              {/* Bubble */}
              <div className={`max-w-[92%] sm:max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-xs ${
                msg.sender === 'user'
                  ? 'bg-primary-600 text-white rounded-br-none'
                  : msg.sender === 'staff'
                  ? 'bg-amber-50 text-amber-900 border border-amber-200 rounded-bl-none'
                  : 'bg-white text-slate-800 border border-slate-200/80 rounded-bl-none'
              }`}>
                {msg.text.split('\n').map((line, i) => (
                  <p
                    key={i}
                    className="mb-0.5 last:mb-0"
                    dangerouslySetInnerHTML={{ __html: parseMarkdown(line) }}
                  />
                ))}
              </div>

              {/* Case card under agent reply */}
              {msg.sender === 'ai' && msg.caseCard?.returnId && (
                <CaseCard caseCard={msg.caseCard} />
              )}

              {/* Quick-reply chips */}
              {msg.sender === 'ai' && msg.chips?.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2 max-w-[90%]">
                  {msg.chips.map((chip, ci) => (
                    <button
                      key={ci}
                      type="button"
                      onClick={() => handleChipClick(chip.value)}
                      className="text-xs bg-white border border-indigo-200 text-indigo-700 hover:bg-indigo-50 px-3 py-1.5 rounded-full transition-colors cursor-pointer shadow-xs font-medium"
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Evidence upload button */}
              {msg.sender === 'ai' && msg.showEvidence && !pendingEvidence && (
                <EvidenceUpload
                  conversationId={conversationId}
                  userToken={null}
                  onResult={handleEvidenceResult}
                />
              )}

              {/* Timestamp */}
              <span className="text-[10px] text-slate-400 mt-1 px-1">
                {msg.timestamp?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Typing indicator */}
        <AnimatePresence>
          {isTyping && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="flex items-start gap-2"
            >
              <div className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Bot className="w-3 h-3 text-white" />
              </div>
              <div className="bg-white border border-slate-200 rounded-2xl rounded-bl-none px-4 py-3 flex items-center gap-1.5">
                {[0, 1, 2].map(i => (
                  <motion.div
                    key={i}
                    className="w-2 h-2 rounded-full bg-indigo-400"
                    animate={{ y: [0, -4, 0] }}
                    transition={{ duration: 0.6, delay: i * 0.15, repeat: Infinity }}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div ref={messagesEndRef} />
      </div>

      {/* Staff-handling banner */}
      {handledByStaff && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-t border-amber-100 text-xs text-amber-800">
          <UserCheck className="w-4 h-4 text-amber-500 flex-shrink-0" />
          A team member is handling your case. AI replies are paused.
        </div>
      )}

      {/* Global case card (if set) */}
      {caseCard?.returnId && !messages.some(m => m.caseCard?.returnId === caseCard.returnId) && (
        <div className="px-4 pb-2">
          <CaseCard caseCard={caseCard} />
        </div>
      )}

      {/* Input area */}
      <div className="border-t border-slate-200 bg-white p-4">
        {pendingEvidence && (
          <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 px-3 py-2 rounded-xl border border-emerald-100 mb-2">
            <FileCheck className="w-4 h-4 flex-shrink-0" />
            Photo evidence ready — send a message to include it in your return request.
            <button
              type="button"
              onClick={() => setPendingEvidence(null)}
              className="ml-auto text-slate-400 hover:text-slate-600 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={handledByStaff ? 'A staff member is helping you…' : 'Describe your issue or type your Order ID…'}
            disabled={handledByStaff || isTyping}
            rows={1}
            className="flex-1 resize-none rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50 transition-all"
            style={{ maxHeight: 120, overflowY: 'auto' }}
          />
          <button
            type="button"
            onClick={() => sendMessage()}
            disabled={!inputText.trim() || isTyping || handledByStaff}
            className="w-10 h-10 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center text-white transition-colors cursor-pointer flex-shrink-0"
          >
            {isTyping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>

        <div className="flex items-center justify-between mt-2">
          <p className="text-[10px] text-slate-400 flex items-center gap-1">
            <Shield className="w-3 h-3" />
            Powered by server-side AI • Policy-enforced decisions
          </p>
          <p className="text-[10px] text-slate-400">
            Conv: <span className="font-mono">{conversationId.slice(-8)}</span>
          </p>
        </div>
      </div>
    </div>
  );
}
