import { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, query, where, onSnapshot, doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { Package, Clock, CheckCircle, RotateCcw, Truck, ShieldCheck, ChevronRight, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import ReturnModal from '../components/ReturnModal';

export default function Orders() {
  const { user, loading: authLoading } = useAuth();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  // Return Modal State
  const [selectedOrderForReturn, setSelectedOrderForReturn] = useState(null);
  const [returnModalExistingReturn, setReturnModalExistingReturn] = useState(null);
  const [simulating, setSimulating] = useState(null);

  useEffect(() => {
    window.scrollTo(0, 0);
    if (!authLoading && !user) {
      navigate('/login');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'orders'),
      where('customer.user_id', '==', user.uid)
    );

    const unsubscribe = onSnapshot(q, (querySnapshot) => {
      let ordersList = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      // Sort descending by date in memory to avoid Firebase missing index error
      ordersList.sort((a, b) => {
        const timeA = a.created_at?.toMillis ? a.created_at.toMillis() : 0;
        const timeB = b.created_at?.toMillis ? b.created_at.toMillis() : 0;
        return timeB - timeA;
      });

      setOrders(ordersList);
      setLoading(false);
    }, (error) => {
      console.error("Error fetching orders:", error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user]);

  const openReturnModal = (order, existingReturn = null) => {
    setSelectedOrderForReturn(order);
    setReturnModalExistingReturn(existingReturn);
  };

  const simulateDelivery = async (orderId) => {
    setSimulating(orderId);
    try {
      const orderRef = doc(db, 'orders', orderId);
      await updateDoc(orderRef, {
        status: 'delivered',
        delivered_at: serverTimestamp(),
        updated_at: serverTimestamp()
      });
    } catch (err) {
      console.error("Failed to simulate delivery:", err);
      alert("Error marking as delivered: " + err.message);
    } finally {
      setSimulating(null);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-12">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center">
            <Package className="h-8 w-8 text-primary-600 mr-3" />
            <div>
              <h1 className="text-3xl font-bold text-slate-900">My Orders</h1>
              <p className="text-sm text-slate-500 mt-0.5">Manage your orders and return requests</p>
            </div>
          </div>
          <button 
            onClick={() => navigate('/')}
            className="hidden sm:inline-flex items-center text-sm font-semibold text-primary-600 hover:text-primary-700"
          >
            Continue Shopping &rarr;
          </button>
        </div>

        {orders.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-12 text-center">
            <Package className="mx-auto h-16 w-16 text-slate-300 mb-4" />
            <h2 className="text-xl font-bold text-slate-900 mb-2">No orders yet</h2>
            <p className="text-slate-500 mb-6">Looks like you haven't placed any orders.</p>
            <button onClick={() => navigate('/')} className="btn btn-primary">Start Shopping</button>
          </div>
        ) : (
          <div className="space-y-6">
            {orders.map((order) => {
              const hasReturns = order.returns && order.returns.length > 0;
              const latestReturn = hasReturns ? order.returns[order.returns.length - 1] : null;
              const isDelivered = order.status === 'delivered';
              const allItemsReturned = order.items?.length > 0 && order.returns?.length >= order.items.length;

              return (
                <div key={order.id} className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
                  
                  {/* Order Header */}
                  <div className="bg-slate-50 p-4 sm:p-6 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <p className="text-sm text-slate-500 mb-1">Order Number</p>
                      <p className="font-bold text-slate-900">{order.order_number}</p>
                    </div>
                    <div>
                      <p className="text-sm text-slate-500 mb-1">Date</p>
                      <p className="font-medium text-slate-900">
                        {order.created_at?.toDate ? new Date(order.created_at.toDate()).toLocaleDateString() : 'Just now'}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-slate-500 mb-1">Total</p>
                      <p className="font-bold text-primary-600">₹{order.pricing?.total?.toFixed(2)}</p>
                    </div>
                    <div>
                      <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
                        order.status === 'processing' ? 'bg-blue-50 text-blue-700' :
                        order.status === 'shipped' ? 'bg-indigo-50 text-indigo-700' :
                        order.status === 'delivered' ? 'bg-green-50 text-green-700' :
                        hasReturns ? 'bg-purple-50 text-purple-700' :
                        'bg-slate-100 text-slate-700'
                      }`}>
                        {order.status === 'processing' && <Clock className="w-4 h-4 mr-1.5" />}
                        {order.status === 'delivered' && <CheckCircle className="w-4 h-4 mr-1.5" />}
                        {hasReturns && <RotateCcw className="w-4 h-4 mr-1.5" />}
                        {order.status ? order.status.charAt(0).toUpperCase() + order.status.slice(1) : 'Pending'}
                      </span>
                    </div>
                  </div>

                  {/* Active Return Banner (if return already requested) */}
                  {hasReturns && latestReturn && (
                    <div className="bg-gradient-to-r from-purple-50 via-indigo-50 to-primary-50 border-b border-purple-100 p-4 px-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-purple-600 text-white rounded-xl shadow-sm">
                          <RotateCcw className="w-4 h-4" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-purple-950 text-sm">
                              Return in Progress ({latestReturn.rma_number})
                            </span>
                            <span className="bg-purple-200/80 text-purple-800 text-[11px] font-bold px-2 py-0.5 rounded-full">
                              {latestReturn.status_label || 'Approved'}
                            </span>
                          </div>
                          <p className="text-xs text-purple-700 mt-0.5">
                            Item: {latestReturn.item?.name} • Refund: ₹{Number(latestReturn.refund_amount).toFixed(2)}
                          </p>
                        </div>
                      </div>

                      <button
                        onClick={() => openReturnModal(order, latestReturn)}
                        className="btn bg-white hover:bg-purple-100 text-purple-800 border border-purple-200 text-xs font-bold py-2 px-4 shadow-sm flex items-center gap-1.5 self-start sm:self-auto"
                      >
                        <span>Track Return & QR</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                  
                  {/* Order Items List */}
                  <div className="p-4 sm:p-6">
                    <div className="space-y-4">
                      {order.items?.map((item, index) => (
                        <div key={index} className="flex items-center gap-4">
                          <div className="h-16 w-16 bg-slate-100 rounded-lg overflow-hidden flex-shrink-0">
                            {item.image_url ? (
                              <img src={item.image_url} alt={item.name} className="h-full w-full object-contain p-1" />
                            ) : (
                              <Package className="h-8 w-8 m-4 text-slate-300" />
                            )}
                          </div>
                          <div className="flex-1">
                            <h4 className="font-medium text-slate-900">{item.name}</h4>
                            <p className="text-sm text-slate-500">Qty: {item.quantity}</p>
                          </div>
                          <div className="font-medium text-slate-900">
                            ₹{(item.price * item.quantity).toFixed(2)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Order Actions Footer */}
                  <div className="bg-slate-50/70 p-4 sm:px-6 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-3">
                    <div className="text-xs text-slate-500 flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-primary-600" />
                      {isDelivered ? (
                        <span>Covered under category return & warranty policies.</span>
                      ) : (
                        <span>Returns become available once the package is delivered.</span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                      {/* Demo helper to simulate delivery if order is still processing/shipped */}
                      {!isDelivered && (
                        <button
                          onClick={() => simulateDelivery(order.id)}
                          disabled={simulating === order.id}
                          className="text-xs text-primary-600 hover:text-primary-800 font-semibold px-2.5 py-1.5 rounded-lg hover:bg-primary-50 transition-colors"
                          title="Simulate Package Delivery for Return Testing"
                        >
                          {simulating === order.id ? 'Marking...' : 'Mark Delivered (Test)'}
                        </button>
                      )}

                      {/* Primary Return / Replace Button */}
                      {isDelivered && !allItemsReturned && (
                        <button
                          onClick={() => openReturnModal(order, null)}
                          className="btn btn-secondary text-xs font-bold py-2 px-3.5 flex items-center gap-1.5 border border-slate-200 hover:border-primary-500 hover:text-primary-700 bg-white"
                        >
                          <RotateCcw className="w-3.5 h-3.5 text-primary-600" />
                          <span>{hasReturns ? 'Return Another Item' : 'Return or Replace Item'}</span>
                        </button>
                      )}
                    </div>
                  </div>

                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Return Modal Component */}
      <ReturnModal
        isOpen={Boolean(selectedOrderForReturn)}
        onClose={() => {
          setSelectedOrderForReturn(null);
          setReturnModalExistingReturn(null);
        }}
        order={orders.find(o => o.id === selectedOrderForReturn?.id) || selectedOrderForReturn}
        existingReturn={returnModalExistingReturn}
      />
    </div>
  );
}
