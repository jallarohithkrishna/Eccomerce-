import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { db } from '../lib/firebase';
import { collection, addDoc, serverTimestamp, writeBatch, doc, getDoc } from 'firebase/firestore';
import { CheckCircle, CreditCard, Truck, ShieldCheck, ArrowRight } from 'lucide-react';
import { resolvePolicyForItem } from '../constants/returnPolicies';

export default function Checkout() {
  const { user, loading: authLoading } = useAuth();
  const { cartItems, cartTotal, clearCart } = useCart();
  const navigate = useNavigate();

  const [shipping, setShipping] = useState({
    fullName: user?.user_metadata?.full_name || user?.displayName || '',
    address: '',
    city: '',
    zipCode: '',
  });

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [orderId, setOrderId] = useState('');
  const [error, setError] = useState('');

  // Redirect if not logged in or cart is empty
  useEffect(() => {
    if (!authLoading) {
      if (!user) {
        navigate('/login');
      } else if (cartItems.length === 0 && !success) {
        navigate('/');
      }
    }
  }, [user, authLoading, cartItems, navigate, success]);

  const generateOrderNumber = () => {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `ORD-${timestamp}-${random}`;
  };

  const handleCheckout = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const orderNumber = generateOrderNumber();
      
      const orderData = {
        order_number: orderNumber,
        customer: {
          user_id: user.uid,
          email: user.email || '',
          full_name: user?.user_metadata?.full_name || user?.displayName || 'Customer'
        },
        shipping_address: shipping,
        billing_address: {
          same_as_shipping: true,
          ...shipping
        },
        pricing: {
          subtotal: cartTotal,
          shipping: 0,
          tax: 0,
          total: cartTotal
        },
        payment: {
          method: 'Credit Card',
          status: 'paid',
          last_four: '4242'
        },
        items: cartItems.map(item => ({
          product_id: item.id,
          name: item.name,
          quantity: item.quantity,
          price: Number(item.price),
          subtotal: Number(item.price) * item.quantity,
          image_url: item.images?.[0] || null,
          category: item.category || 'General',
          return_policy: item.return_policy || resolvePolicyForItem(item)
        })),
        status: 'processing',
        created_at: serverTimestamp(),
        updated_at: serverTimestamp()
      };

      // Verify products exist and have enough stock
      for (const item of cartItems) {
        if (item.stock_quantity !== undefined) {
          const productRef = doc(db, 'products', item.id);
          const productSnap = await getDoc(productRef);
          
          if (!productSnap.exists()) {
            throw new Error(`The product "${item.name}" is no longer available.`);
          }
          
          const currentStock = productSnap.data().stock_quantity;
          if (currentStock !== undefined && currentStock < item.quantity) {
            throw new Error(`Not enough stock for "${item.name}". Only ${currentStock} left.`);
          }
        }
      }

      // 1. Create the order first (customers always have permission for this)
      await addDoc(collection(db, 'orders'), orderData);

      // 2. Try to update stock (may fail if user isn't admin — that's okay)
      try {
        const stockBatch = writeBatch(db);
        for (const item of cartItems) {
          if (item.stock_quantity !== undefined) {
            const productRef = doc(db, 'products', item.id);
            const productSnap = await getDoc(productRef);
            if (productSnap.exists()) {
              const currentStock = productSnap.data().stock_quantity;
              if (currentStock !== undefined) {
                stockBatch.update(productRef, { 
                  stock_quantity: Math.max(0, currentStock - item.quantity) 
                });
              }
            }
          }
        }
        await stockBatch.commit();
      } catch (stockErr) {
        console.warn("Stock update skipped (admin will handle):", stockErr.message);
      }

      // Success!
      setOrderId(orderNumber);
      setSuccess(true);
      clearCart();

    } catch (err) {
      setError(err.message || 'Failed to place order. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (authLoading) return <div className="min-h-screen flex items-center justify-center">Loading...</div>;

  if (success) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-3xl p-8 max-w-md w-full text-center shadow-xl">
          <div className="h-20 w-20 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-6 text-green-500">
            <CheckCircle className="h-10 w-10" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">Payment Successful!</h2>
          <p className="text-slate-500 mb-6">Your order has been placed and is being processed.</p>
          
          <div className="bg-slate-50 rounded-xl p-4 mb-8 text-left">
            <p className="text-sm text-slate-500 font-medium mb-1">Order Number</p>
            <p className="text-lg font-bold text-slate-900 truncate" title={orderId}>{orderId}</p>
          </div>

          <button 
            onClick={() => navigate('/')}
            className="btn btn-primary w-full py-3"
          >
            Continue Shopping
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8 sm:py-12">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <h1 className="text-3xl font-bold text-slate-900 mb-8">Checkout</h1>

        {error && (
          <div className="bg-red-50 text-red-600 p-4 rounded-xl mb-8 border border-red-100">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10">
          
          {/* Left Column - Forms */}
          <div className="lg:col-span-7 space-y-8">
            <form id="checkout-form" onSubmit={handleCheckout}>
              
              {/* Shipping Section */}
              <div className="bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-100 mb-8">
                <div className="flex items-center mb-6">
                  <div className="h-8 w-8 rounded-full bg-primary-50 text-primary-600 flex items-center justify-center mr-3">
                    <Truck className="h-4 w-4" />
                  </div>
                  <h2 className="text-xl font-bold text-slate-900">Shipping Information</h2>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-slate-700 mb-1">Full Name</label>
                    <input required type="text" className="input" value={shipping.fullName} onChange={e => setShipping({...shipping, fullName: e.target.value})} />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-slate-700 mb-1">Street Address</label>
                    <input required type="text" className="input" value={shipping.address} onChange={e => setShipping({...shipping, address: e.target.value})} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">City</label>
                    <input required type="text" className="input" value={shipping.city} onChange={e => setShipping({...shipping, city: e.target.value})} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">ZIP / Postal Code</label>
                    <input required type="text" className="input" value={shipping.zipCode} onChange={e => setShipping({...shipping, zipCode: e.target.value})} />
                  </div>
                </div>
              </div>

              {/* Payment Section */}
              <div className="bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-100">
                <div className="flex items-center mb-6">
                  <div className="h-8 w-8 rounded-full bg-primary-50 text-primary-600 flex items-center justify-center mr-3">
                    <CreditCard className="h-4 w-4" />
                  </div>
                  <h2 className="text-xl font-bold text-slate-900">Payment Details</h2>
                </div>

                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 mb-6 flex items-start space-x-3">
                  <ShieldCheck className="h-5 w-5 text-green-500 mt-0.5" />
                  <p className="text-sm text-slate-600">
                    This is a secure 128-bit SSL encrypted payment. (Mock Demo Mode)
                  </p>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-slate-700 mb-1">Card Number</label>
                    <input required type="text" className="input font-mono" placeholder="4242 4242 4242 4242" defaultValue="4242 4242 4242 4242" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Expiration Date</label>
                    <input required type="text" className="input" placeholder="MM/YY" defaultValue="12/26" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">CVC</label>
                    <input required type="text" className="input" placeholder="123" defaultValue="123" />
                  </div>
                </div>
              </div>
            </form>
          </div>

          {/* Right Column - Order Summary */}
          <div className="lg:col-span-5">
            <div className="bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-100 sticky top-28">
              <h2 className="text-xl font-bold text-slate-900 mb-6">Order Summary</h2>
              
              <div className="space-y-4 mb-6 max-h-64 overflow-y-auto pr-2">
                {cartItems.map((item) => (
                  <div key={item.id} className="flex gap-4">
                    <div className="h-16 w-16 bg-slate-100 rounded-lg overflow-hidden flex-shrink-0">
                      {item.images && item.images[0] && (
                        <img src={item.images[0]} alt={item.name} className="h-full w-full object-contain p-1" onError={(e) => { e.target.onerror = null; e.target.src = 'https://placehold.co/400x400/png?text=Image+Not+Found'; }} />
                      )}
                    </div>
                    <div className="flex-1">
                      <h4 className="font-medium text-slate-900 line-clamp-1 text-sm">{item.name}</h4>
                      <p className="text-sm text-slate-500">Qty: {item.quantity}</p>
                    </div>
                    <div className="font-medium text-slate-900 text-sm">
                      ₹{(Number(item.price) * item.quantity).toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>

              <div className="border-t border-slate-100 pt-4 space-y-3 mb-6">
                <div className="flex justify-between text-slate-600 text-sm">
                  <span>Subtotal</span>
                  <span>₹{cartTotal.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-slate-600 text-sm">
                  <span>Shipping</span>
                  <span className="text-green-600 font-medium">Free</span>
                </div>
                <div className="flex justify-between text-lg font-bold text-slate-900 pt-3 border-t border-slate-100">
                  <span>Total</span>
                  <span>₹{cartTotal.toFixed(2)}</span>
                </div>
              </div>

              <button 
                form="checkout-form"
                type="submit"
                disabled={loading}
                className="w-full btn btn-primary py-4 text-base flex justify-center items-center shadow-lg shadow-primary-500/20 group"
              >
                {loading ? 'Processing...' : `Pay ₹${cartTotal.toFixed(2)}`}
                {!loading && <ArrowRight className="h-5 w-5 ml-2 group-hover:translate-x-1 transition-transform" />}
              </button>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
