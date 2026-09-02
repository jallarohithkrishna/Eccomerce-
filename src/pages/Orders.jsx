import { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { Package, Clock, CheckCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function Orders() {
  const { user, loading: authLoading } = useAuth();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

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
        <div className="flex items-center mb-8">
          <Package className="h-8 w-8 text-primary-600 mr-3" />
          <h1 className="text-3xl font-bold text-slate-900">My Orders</h1>
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
            {orders.map((order) => (
              <div key={order.id} className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
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
                      'bg-slate-100 text-slate-700'
                    }`}>
                      {order.status === 'processing' && <Clock className="w-4 h-4 mr-1.5" />}
                      {order.status === 'delivered' && <CheckCircle className="w-4 h-4 mr-1.5" />}
                      {order.status ? order.status.charAt(0).toUpperCase() + order.status.slice(1) : 'Pending'}
                    </span>
                  </div>
                </div>
                
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
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
