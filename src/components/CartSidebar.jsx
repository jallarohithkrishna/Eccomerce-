import { X, Minus, Plus, ShoppingBag, ArrowRight } from 'lucide-react';
import { useCart } from '../context/CartContext';
import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';

export default function CartSidebar() {
  const { isCartOpen, setIsCartOpen, cartItems, removeFromCart, updateQuantity, cartTotal } = useCart();

  return (
    <AnimatePresence>
      {isCartOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsCartOpen(false)}
            className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-40"
          />

          {/* Sidebar */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed inset-y-0 right-0 w-full max-w-md bg-white shadow-2xl z-50 flex flex-col border-l border-slate-100"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-slate-100">
              <div className="flex items-center space-x-2">
                <ShoppingBag className="h-5 w-5 text-primary-600" />
                <h2 className="text-lg font-bold text-slate-900">Your Cart</h2>
                <span className="bg-slate-100 text-slate-600 text-xs font-semibold px-2 py-0.5 rounded-full">
                  {cartItems.length} {cartItems.length === 1 ? 'item' : 'items'}
                </span>
              </div>
              <button
                onClick={() => setIsCartOpen(false)}
                className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-full transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Cart Items */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6">
              {cartItems.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center space-y-4">
                  <div className="h-24 w-24 bg-slate-50 rounded-full flex items-center justify-center mb-4">
                    <ShoppingBag className="h-10 w-10 text-slate-300" />
                  </div>
                  <h3 className="text-lg font-medium text-slate-900">Your cart is empty</h3>
                  <p className="text-slate-500 max-w-[250px]">
                    Looks like you haven't added anything to your cart yet.
                  </p>
                  <button 
                    onClick={() => setIsCartOpen(false)}
                    className="btn btn-secondary mt-4"
                  >
                    Start Shopping
                  </button>
                </div>
              ) : (
                <div className="space-y-6">
                  {cartItems.map((item) => (
                    <div key={item.id} className="flex gap-4 bg-white">
                      <div className="h-24 w-24 rounded-lg bg-slate-100 overflow-hidden flex-shrink-0 border border-slate-100">
                        {item.images && item.images.length > 0 ? (
                          <img
                            src={item.images[0]}
                            alt={item.name}
                            className="h-full w-full object-contain p-1"
                            onError={(e) => { e.target.onerror = null; e.target.src = 'https://placehold.co/400x400/png?text=Image+Not+Found'; }}
                          />
                        ) : (
                          <div className="h-full w-full flex items-center justify-center text-slate-400">
                            No Image
                          </div>
                        )}
                      </div>
                      
                      <div className="flex flex-col flex-1 py-1">
                        <div className="flex justify-between items-start">
                          <div>
                            <h4 className="font-medium text-slate-900 line-clamp-1" title={item.name}>{item.name}</h4>
                            <p className="text-sm text-slate-500 mt-0.5">₹{Number(item.price).toFixed(2)}</p>
                          </div>
                          <button
                            onClick={() => removeFromCart(item.id)}
                            className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                        
                        <div className="mt-auto flex items-center justify-between">
                          <div className="flex items-center border border-slate-200 rounded-lg bg-slate-50">
                            <button
                              onClick={() => updateQuantity(item.id, item.quantity - 1)}
                              className="p-1.5 text-slate-600 hover:bg-white hover:text-slate-900 rounded-l-lg transition-colors"
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </button>
                            <span className="w-8 text-center text-sm font-medium text-slate-900">
                              {item.quantity}
                            </span>
                            <button
                              onClick={() => updateQuantity(item.id, item.quantity + 1)}
                              className="p-1.5 text-slate-600 hover:bg-white hover:text-slate-900 rounded-r-lg transition-colors"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <p className="font-semibold text-slate-900">
                            ₹{(Number(item.price) * item.quantity).toFixed(2)}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer / Checkout */}
            {cartItems.length > 0 && (
              <div className="border-t border-slate-100 p-4 sm:p-6 bg-slate-50">
                <div className="space-y-3 mb-6">
                  <div className="flex justify-between text-slate-500 text-sm">
                    <span>Subtotal</span>
                    <span>₹{cartTotal.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-slate-500 text-sm">
                    <span>Shipping</span>
                    <span>Calculated at checkout</span>
                  </div>
                  <div className="flex justify-between text-slate-900 font-bold text-lg pt-3 border-t border-slate-200">
                    <span>Total</span>
                    <span>₹{cartTotal.toFixed(2)}</span>
                  </div>
                </div>
                
                <Link 
                  to="/checkout"
                  onClick={() => setIsCartOpen(false)}
                  className="w-full btn btn-primary py-4 text-base flex justify-center items-center shadow-lg shadow-primary-500/20 group"
                >
                  Proceed to Checkout
                  <ArrowRight className="h-5 w-5 ml-2 group-hover:translate-x-1 transition-transform" />
                </Link>
                <p className="text-center text-xs text-slate-500 mt-4 flex items-center justify-center">
                  Secure checkout powered by Stripe
                </p>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
