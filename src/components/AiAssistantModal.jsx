import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Bot, 
  Send, 
  X, 
  Sparkles, 
  ShoppingCart, 
  Eye, 
  Loader2, 
  CheckCircle2, 
  AlertCircle,
  MessageSquare,
  RefreshCw,
  Minimize2,
  Maximize2
} from 'lucide-react';
import { useCart } from '../context/CartContext';
import { db } from '../lib/firebase';
import { collection, onSnapshot } from 'firebase/firestore';
import { askAiAssistant } from '../lib/aiAssistant';
import ImageWithFallback from './ImageWithFallback';

const QUICK_PROMPTS = [
  "Show me products for basketball",
  "Show products under ₹5,000",
  "What products are available?",
  "What is good for gaming?",
  "Find me something for my home"
];

export default function AiShoppingAssistant() {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [inputMessage, setInputMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [products, setProducts] = useState([]);
  const [messages, setMessages] = useState([
    {
      id: 'welcome',
      sender: 'ai',
      text: "👋 Hi! I'm your AI Shopping Assistant. Ask me anything like *\"Show me basketball products\"* or *\"Find phones under ₹20,000\"*.",
      products: [],
      timestamp: new Date()
    }
  ]);

  const { addToCart } = useCart();
  const navigate = useNavigate();
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Sync real-time products collection from Firestore to guarantee 100% real data
  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, 'products'), (snapshot) => {
      const items = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setProducts(items);
    }, (error) => {
      console.error("Error listening to products in AI Assistant:", error);
    });

    return () => unsubscribe();
  }, []);

  // Auto-scroll chat to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
      if (!isMinimized) {
        inputRef.current?.focus();
      }
    }
  }, [messages, isOpen, isMinimized]);

  const handleSendMessage = async (textToSend) => {
    const query = textToSend || inputMessage;
    if (!query.trim() || loading) return;

    const userMsg = {
      id: Date.now().toString(),
      sender: 'user',
      text: query.trim(),
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMsg]);
    setInputMessage('');
    setLoading(true);

    try {
      // Use hybrid RAG to search real Firestore products
      const response = await askAiAssistant(query, products);
      
      const aiMsg = {
        id: (Date.now() + 1).toString(),
        sender: 'ai',
        text: response.reply || "Here are the matching products from our store:",
        products: response.products || [],
        timestamp: new Date()
      };

      setMessages(prev => [...prev, aiMsg]);
    } catch (err) {
      console.error("AI assistant error:", err);
      setMessages(prev => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          sender: 'ai',
          text: "I encountered a problem searching the catalog. Please try again.",
          products: [],
          timestamp: new Date()
        }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleProductClick = (productId) => {
    navigate(`/product/${productId}`);
    // Optional: close or minimize modal on mobile
    if (window.innerWidth < 768) {
      setIsOpen(false);
    }
  };

  const handleAddToCart = (e, product) => {
    e.stopPropagation();
    addToCart(product);
  };

  return (
    <>
      {/* Floating Launcher Button */}
      <div className="fixed bottom-6 right-6 z-40 flex items-center">
        {!isOpen && (
          <motion.button
            initial={{ scale: 0, rotate: -20 }}
            animate={{ scale: 1, rotate: 0 }}
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.94 }}
            onClick={() => setIsOpen(true)}
            aria-label="Open AI Shopping Assistant"
            className="flex items-center gap-2.5 px-4 py-3.5 bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 text-white font-medium rounded-full shadow-xl hover:shadow-2xl transition-all duration-300 group border border-white/20"
          >
            <div className="relative">
              <Sparkles className="w-5 h-5 text-yellow-300 animate-pulse" />
              <span className="absolute -top-1 -right-1 flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
            </div>
            <span className="text-sm font-semibold tracking-wide">AI Assistant</span>
          </motion.button>
        )}
      </div>

      {/* Floating Chat Panel */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 30, scale: 0.95 }}
            animate={{ 
              opacity: 1, 
              y: 0, 
              scale: 1,
              height: isMinimized ? '64px' : '620px' 
            }}
            exit={{ opacity: 0, y: 30, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className={`fixed bottom-6 right-6 z-50 w-[92vw] sm:w-[420px] max-w-[450px] bg-white rounded-2xl shadow-2xl border border-slate-200/80 flex flex-col overflow-hidden backdrop-blur-md transition-all duration-300 ${
              isMinimized ? 'h-16' : 'h-[620px] max-h-[85vh]'
            }`}
          >
            {/* Header */}
            <div className="bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 p-4 text-white flex items-center justify-between shadow-sm select-none">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-white/20 backdrop-blur-md flex items-center justify-center border border-white/30">
                  <Bot className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h3 className="text-sm font-bold flex items-center gap-1.5 leading-tight">
                    AI Shopping Assistant
                    <span className="text-[10px] bg-emerald-500 text-white px-1.5 py-0.5 rounded-full font-medium">LIVE</span>
                  </h3>
                  <p className="text-[11px] text-blue-100 font-normal">Real Firestore Catalog RAG</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setIsMinimized(!isMinimized)}
                  className="p-1.5 hover:bg-white/20 rounded-lg transition-colors text-white/90"
                  aria-label={isMinimized ? "Maximize" : "Minimize"}
                >
                  {isMinimized ? <Maximize2 className="w-4 h-4" /> : <Minimize2 className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-1.5 hover:bg-white/20 rounded-lg transition-colors text-white/90"
                  aria-label="Close Assistant"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Chat Body */}
            {!isMinimized && (
              <>
                <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50/50">
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
                    >
                      <div
                        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
                          msg.sender === 'user'
                            ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-br-none'
                            : 'bg-white text-slate-800 border border-slate-200/70 rounded-bl-none'
                        }`}
                      >
                        <p className="whitespace-pre-wrap leading-relaxed">{msg.text}</p>
                      </div>

                      {/* Product Recommendation Cards (RAG Results) */}
                      {msg.products && msg.products.length > 0 && (
                        <div className="w-full mt-3 space-y-2.5">
                          <p className="text-xs font-semibold text-slate-500 flex items-center gap-1 px-1">
                            <Sparkles className="w-3.5 h-3.5 text-indigo-500" />
                            Catalog Matches ({msg.products.length}):
                          </p>
                          <div className="grid grid-cols-1 gap-2">
                            {msg.products.map((product) => {
                              const isOutOfStock = Number(product.stock_quantity) <= 0;
                              return (
                                <div
                                  key={product.id}
                                  onClick={() => handleProductClick(product.id)}
                                  className="group bg-white p-2.5 rounded-xl border border-slate-200 hover:border-indigo-400 hover:shadow-md transition-all duration-200 flex gap-3 items-center cursor-pointer"
                                >
                                  <div className="w-16 h-16 rounded-lg bg-slate-100 overflow-hidden flex-shrink-0 relative border border-slate-100">
                                    <ImageWithFallback
                                      src={product.images && product.images[0] ? product.images[0] : ''}
                                      alt={product.name}
                                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                    />
                                    {isOutOfStock && (
                                      <span className="absolute inset-0 bg-black/50 text-white text-[9px] font-bold flex items-center justify-center text-center p-0.5">
                                        Out of stock
                                      </span>
                                    )}
                                  </div>

                                  <div className="flex-1 min-w-0">
                                    <h4 className="text-xs font-bold text-slate-800 truncate group-hover:text-indigo-600 transition-colors">
                                      {product.name}
                                    </h4>
                                    <div className="flex items-center gap-2 mt-0.5">
                                      <span className="text-sm font-extrabold text-slate-900">
                                        ₹{Number(product.price).toLocaleString('en-IN')}
                                      </span>
                                      <span className={`text-[10px] font-medium px-1.5 py-0.2 rounded-full ${
                                        isOutOfStock 
                                          ? 'bg-rose-100 text-rose-700' 
                                          : 'bg-emerald-100 text-emerald-700'
                                      }`}>
                                        {isOutOfStock ? '0 stock' : `${product.stock_quantity} left`}
                                      </span>
                                    </div>

                                    {/* Action Buttons */}
                                    <div className="flex items-center gap-1.5 mt-2">
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleProductClick(product.id);
                                        }}
                                        className="text-[11px] font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 px-2 py-1 rounded-md flex items-center gap-1 transition-colors"
                                      >
                                        <Eye className="w-3 h-3" /> View
                                      </button>

                                      <button
                                        onClick={(e) => handleAddToCart(e, product)}
                                        disabled={isOutOfStock}
                                        className={`text-[11px] font-medium px-2.5 py-1 rounded-md flex items-center gap-1 transition-colors ${
                                          isOutOfStock 
                                            ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                                            : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm'
                                        }`}
                                      >
                                        <ShoppingCart className="w-3 h-3" /> Add
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}

                  {loading && (
                    <div className="flex items-center gap-2 text-slate-500 text-xs bg-white border border-slate-200/80 px-3 py-2 rounded-xl w-max shadow-sm animate-pulse">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-600" />
                      Searching real Firestore catalog...
                    </div>
                  )}

                  <div ref={messagesEndRef} />
                </div>

                {/* Quick Prompts Chips */}
                <div className="px-3 py-2 bg-slate-100/70 border-t border-slate-200/60 overflow-x-auto no-scrollbar flex gap-1.5 flex-nowrap">
                  {QUICK_PROMPTS.map((prompt, i) => (
                    <button
                      key={i}
                      onClick={() => handleSendMessage(prompt)}
                      disabled={loading}
                      className="text-[11px] whitespace-nowrap bg-white hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-300 text-slate-600 font-medium px-2.5 py-1 rounded-full border border-slate-200 shadow-xs transition-colors cursor-pointer"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>

                {/* Input Bar */}
                <div className="p-3 bg-white border-t border-slate-200">
                  <div className="flex items-center gap-2 bg-slate-100 rounded-xl px-3 py-2 border border-slate-200 focus-within:border-indigo-500 focus-within:bg-white transition-all">
                    <input
                      ref={inputRef}
                      type="text"
                      value={inputMessage}
                      onChange={(e) => setInputMessage(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Ask AI: e.g. 'phone under ₹20000'..."
                      disabled={loading}
                      className="flex-1 bg-transparent text-sm text-slate-800 placeholder-slate-400 outline-hidden"
                    />
                    <button
                      onClick={() => handleSendMessage()}
                      disabled={!inputMessage.trim() || loading}
                      className={`p-1.5 rounded-lg transition-all ${
                        inputMessage.trim() && !loading
                          ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm'
                          : 'text-slate-400 bg-transparent cursor-not-allowed'
                      }`}
                      aria-label="Send Message"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
