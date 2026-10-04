import { useState, useEffect } from 'react';
import { db } from '../../lib/firebase';
import { collection, onSnapshot, doc, updateDoc, query, orderBy, limit, startAfter, getDocs, where, serverTimestamp } from 'firebase/firestore';
import { Package, Clock, CheckCircle, X, MapPin, Search, RotateCcw, Loader2 } from 'lucide-react';

export default function AdminOrders() {
  const PAGE_SIZE = 25;
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [lastDoc, setLastDoc] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [updating, setUpdating] = useState(null);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    const q = query(collection(db, 'orders'), orderBy('created_at', 'desc'), limit(PAGE_SIZE));
    const unsubscribe = onSnapshot(q, (querySnapshot) => {
      const ordersList = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      setOrders(ordersList);
      setLastDoc(querySnapshot.docs[querySnapshot.docs.length - 1] || null);
      setHasMore(querySnapshot.docs.length === PAGE_SIZE);
      setLoading(false);
    }, (error) => {
      console.error("Error fetching orders:", error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const handleLoadMore = async () => {
    if (!lastDoc || loadingMore) return;
    setLoadingMore(true);
    try {
      const q = query(
        collection(db, 'orders'),
        orderBy('created_at', 'desc'),
        startAfter(lastDoc),
        limit(PAGE_SIZE)
      );
      const querySnapshot = await getDocs(q);
      const moreOrders = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      setOrders(prev => [...prev, ...moreOrders]);
      setLastDoc(querySnapshot.docs[querySnapshot.docs.length - 1] || null);
      setHasMore(querySnapshot.docs.length === PAGE_SIZE);
    } catch (error) {
      console.error("Error loading more orders:", error);
    } finally {
      setLoadingMore(false);
    }
  };

  const handleStatusChange = async (orderId, newStatus) => {
    setUpdating(orderId);
    try {
      const orderRef = doc(db, 'orders', orderId);
      await updateDoc(orderRef, {
        status: newStatus
      });
      
      // Update local state
      setOrders(orders.map(order => 
        order.id === orderId ? { ...order, status: newStatus } : order
      ));
    } catch (error) {
      console.error("Error updating order status:", error);
      alert("Failed to update status");
    } finally {
      setUpdating(null);
    }
  };

  const handleAdminUpdateReturn = async (orderId, rmaNumber, action) => {
    try {
      const orderToUpdate = orders.find(o => o.id === orderId);
      if (!orderToUpdate || !orderToUpdate.returns) return;

      let newOrderStatus = orderToUpdate.status;

      const updatedReturns = orderToUpdate.returns.map(ret => {
        if (ret.rma_number !== rmaNumber) return ret;
        const timeline = [...(ret.timeline || [])];
        let newStatus = ret.status;
        let newStatusLabel = ret.status_label;

        if (action === 'inspect') {
          timeline[3] = {
            stage: 'Warehouse Inspection & Verification Passed',
            timestamp: new Date().toISOString(),
            done: true
          };
          newStatus = 'inspected';
          newStatusLabel = 'Inspection Passed at Central Warehouse';
          newOrderStatus = 'returned';
        } else if (action === 'refund') {
          if (!timeline[3]?.done) {
            timeline[3] = {
              stage: 'Warehouse Inspection & Verification Passed',
              timestamp: new Date().toISOString(),
              done: true
            };
          }
          timeline[4] = {
            stage: ret.resolution_type === 'replacement' ? 'Replacement Order Dispatched' : 'Refund Credited to Account',
            timestamp: new Date().toISOString(),
            done: true
          };
          newStatus = 'refunded';
          newStatusLabel = ret.resolution_type === 'replacement' ? 'Replacement Unit Shipped' : 'Refund Credited Successfully';
          newOrderStatus = 'refunded';
        }

        return {
          ...ret,
          status: newStatus,
          status_label: newStatusLabel,
          timeline,
          updated_at: new Date().toISOString()
        };
      });

      const orderRef = doc(db, 'orders', orderId);
      await updateDoc(orderRef, {
        returns: updatedReturns,
        status: newOrderStatus,
        return_status: action === 'refund' ? 'refunded' : 'inspected',
        updated_at: serverTimestamp()
      });

      // Also sync to returns collection for live QR page
      try {
        const retQ = query(collection(db, 'returns'), where('rma_number', '==', rmaNumber));
        const retSnap = await getDocs(retQ);
        if (!retSnap.empty) {
          const matchedReturn = updatedReturns.find(r => r.rma_number === rmaNumber);
          if (matchedReturn) {
            await updateDoc(doc(db, 'returns', retSnap.docs[0].id), {
              status: matchedReturn.status,
              status_label: matchedReturn.status_label,
              timeline: matchedReturn.timeline,
              updated_at: serverTimestamp()
            });
          }
        }
      } catch (syncErr) {
        console.warn('Sync to returns collection skipped in admin:', syncErr.message);
      }

      if (selectedOrder && selectedOrder.id === orderId) {
        setSelectedOrder({
          ...selectedOrder,
          returns: updatedReturns,
          status: newOrderStatus,
          return_status: action === 'refund' ? 'refunded' : 'inspected'
        });
      }
    } catch (err) {
      console.error('Error updating return in admin:', err);
      alert('Error updating return: ' + err.message);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  const filteredOrders = orders.filter(order => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    const orderId = (order.order_number || order.id.slice(0, 8)).toLowerCase();
    return orderId.includes(term);
  });

  return (
    <div>
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Orders</h1>
          <p className="text-slate-500 mt-1">Manage all customer orders</p>
        </div>
        
        <form 
          onSubmit={(e) => {
            e.preventDefault();
            const term = searchTerm.toLowerCase().trim();
            const match = orders.find(o => 
              (o.order_number && o.order_number.toLowerCase() === term) || 
              (o.id.toLowerCase() === term) ||
              (o.id.slice(0, 8).toLowerCase() === term)
            );
            if (match) {
              setSelectedOrder(match);
              setSearchTerm(''); // Clear search after opening
            } else {
              alert("Order not found! Please check the ID.");
            }
          }}
          className="relative"
        >
          <Search className="w-5 h-5 absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400" />
          <input 
            type="text" 
            placeholder="Enter Order ID & press Enter" 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 pr-4 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 w-full sm:w-64 bg-white"
          />
        </form>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[800px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="p-4 font-semibold text-slate-600 text-sm whitespace-nowrap">Order ID</th>
                <th className="p-4 font-semibold text-slate-600 text-sm whitespace-nowrap">Items</th>
                <th className="p-4 font-semibold text-slate-600 text-sm whitespace-nowrap">Customer</th>
                <th className="p-4 font-semibold text-slate-600 text-sm whitespace-nowrap">Date</th>
                <th className="p-4 font-semibold text-slate-600 text-sm whitespace-nowrap">Total</th>
                <th className="p-4 font-semibold text-slate-600 text-sm whitespace-nowrap">Status</th>
                <th className="p-4 font-semibold text-slate-600 text-sm whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan="7" className="p-8 text-center text-slate-500">
                    No orders found matching your search.
                  </td>
                </tr>
              ) : (
                filteredOrders.map((order) => (
                  <tr key={order.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                    <td className="p-4 text-sm font-medium text-slate-900">
                      {order.order_number || order.id.slice(0, 8)}
                    </td>
                    <td className="p-4">
                      <div className="flex -space-x-2 overflow-hidden">
                        {order.items?.slice(0, 4).map((item, i) => (
                          <div key={i} className="inline-block h-10 w-10 rounded-full ring-2 ring-white bg-white border border-slate-200">
                            {item.image_url ? (
                              <img src={item.image_url} alt={item.name} className="h-full w-full object-contain p-1 rounded-full bg-white" title={item.name} />
                            ) : (
                              <Package className="h-full w-full p-2 text-slate-400 bg-slate-100 rounded-full" title={item.name} />
                            )}
                          </div>
                        ))}
                        {order.items?.length > 4 && (
                          <div className="inline-flex items-center justify-center h-10 w-10 rounded-full ring-2 ring-white bg-slate-100 border border-slate-200 text-xs font-bold text-slate-600">
                            +{order.items.length - 4}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="p-4">
                      <div className="text-sm font-medium text-slate-900">{order.customer?.full_name || order.customer?.name || 'Unknown'}</div>
                      <div className="text-xs text-slate-500">{order.customer?.email}</div>
                    </td>
                    <td className="p-4 text-sm text-slate-600">
                      {order.created_at?.toDate ? new Date(order.created_at.toDate()).toLocaleDateString() : 'N/A'}
                    </td>
                    <td className="p-4 text-sm font-bold text-slate-900">
                      ₹{order.pricing?.total?.toFixed(2) || '0.00'}
                    </td>
                    <td className="p-4">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        order.status === 'processing' ? 'bg-blue-50 text-blue-700' :
                        order.status === 'shipped' ? 'bg-indigo-50 text-indigo-700' :
                        order.status === 'delivered' ? 'bg-green-50 text-green-700' :
                        'bg-slate-100 text-slate-700'
                      }`}>
                        {order.status === 'processing' && <Clock className="w-3 h-3 mr-1" />}
                        {order.status === 'delivered' && <CheckCircle className="w-3 h-3 mr-1" />}
                        {order.status ? order.status.charAt(0).toUpperCase() + order.status.slice(1) : 'Pending'}
                      </span>
                      {order.returns && order.returns.length > 0 && (
                        <div className="mt-1">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-200">
                            <RotateCcw className="w-2.5 h-2.5" />
                            {order.returns[0].rma_number}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="p-4 text-sm flex items-center gap-2">
                      <select 
                        value={order.status || 'pending'}
                        onChange={(e) => handleStatusChange(order.id, e.target.value)}
                        disabled={updating === order.id}
                        className="bg-white border border-slate-300 text-slate-900 text-sm rounded-lg focus:ring-primary-500 focus:border-primary-500 block p-2"
                      >
                        <option value="pending">Pending</option>
                        <option value="processing">Processing</option>
                        <option value="shipped">Shipped</option>
                        <option value="delivered">Delivered</option>
                        <option value="cancelled">Cancelled</option>
                      </select>
                      <button
                        onClick={() => setSelectedOrder(order)}
                        className="bg-primary-50 hover:bg-primary-100 text-primary-700 px-3 py-2 rounded-lg text-xs font-bold whitespace-nowrap border border-primary-200 transition-colors"
                      >
                        View Details
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Load More Button */}
        {hasMore && !searchTerm && (
          <div className="p-4 border-t border-slate-100 flex justify-center bg-slate-50/50">
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="btn btn-secondary text-xs font-bold py-2 px-5 shadow-xs bg-white hover:bg-slate-50 border border-slate-200 flex items-center gap-2"
            >
              {loadingMore ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-primary-600" />
                  <span>Loading more orders...</span>
                </>
              ) : (
                <span>Load More Orders (25)</span>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Order Details Modal */}
      {selectedOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto flex flex-col animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center p-6 border-b border-slate-100 sticky top-0 bg-white z-10">
              <div>
                <h2 className="text-xl font-bold text-slate-900">
                  Order #{selectedOrder.order_number || selectedOrder.id.slice(0, 8)}
                </h2>
                <p className="text-sm text-slate-500">
                  {selectedOrder.created_at?.toDate ? new Date(selectedOrder.created_at.toDate()).toLocaleString() : 'N/A'}
                </p>
              </div>
              <button 
                onClick={() => setSelectedOrder(null)} 
                className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>
            
            <div className="p-6 space-y-8">
              {/* Customer & Shipping */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <h3 className="text-sm font-bold text-slate-900 mb-3 uppercase tracking-wider">Customer Details</h3>
                  <div className="bg-slate-50 p-4 rounded-xl h-full border border-slate-100">
                    <p className="font-medium text-slate-900">{selectedOrder.customer?.full_name || 'Unknown'}</p>
                    <p className="text-slate-600 text-sm mt-1">{selectedOrder.customer?.email}</p>
                  </div>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900 mb-3 uppercase tracking-wider flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-slate-400" /> Shipping Address
                  </h3>
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 text-sm text-slate-600 leading-relaxed h-full">
                    <p className="font-medium text-slate-900">{selectedOrder.shipping_address?.full_name}</p>
                    <p>{selectedOrder.shipping_address?.address_line1}</p>
                    {selectedOrder.shipping_address?.address_line2 && <p>{selectedOrder.shipping_address?.address_line2}</p>}
                    <p>{selectedOrder.shipping_address?.city}, {selectedOrder.shipping_address?.state} {selectedOrder.shipping_address?.postal_code}</p>
                  </div>
                </div>
              </div>

              {/* Order Items */}
              <div>
                <h3 className="text-sm font-bold text-slate-900 mb-3 uppercase tracking-wider">Order Items</h3>
                <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
                  {selectedOrder.items?.map((item, index) => (
                    <div key={index} className="flex items-center p-4 gap-4">
                      <div className="h-16 w-16 bg-white rounded-lg border border-slate-200 p-1 flex-shrink-0">
                        {item.image_url ? (
                          <img src={item.image_url} alt={item.name} className="h-full w-full object-contain rounded-md" />
                        ) : (
                          <Package className="h-full w-full text-slate-300 p-2" />
                        )}
                      </div>
                      <div className="flex-grow">
                        <p className="font-medium text-slate-900">{item.name}</p>
                        <p className="text-sm text-slate-500 mt-0.5">Qty: {item.quantity} &times; ₹{Number(item.price).toFixed(2)}</p>
                      </div>
                      <div className="font-bold text-slate-900 whitespace-nowrap">
                        ₹{(Number(item.price) * item.quantity).toFixed(2)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Return & RMA Requests (if any) */}
              {selectedOrder.returns && selectedOrder.returns.length > 0 && (
                <div>
                  <h3 className="text-sm font-bold text-purple-900 mb-3 uppercase tracking-wider flex items-center gap-2">
                    <RotateCcw className="w-4 h-4 text-purple-600" />
                    Return Requests ({selectedOrder.returns.length})
                  </h3>
                  <div className="space-y-3">
                    {selectedOrder.returns.map((ret, idx) => (
                      <div key={idx} className="bg-purple-50/70 border border-purple-200 rounded-xl p-4 text-xs space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-bold text-sm text-purple-950">{ret.rma_number}</span>
                          <span className="bg-purple-200 text-purple-800 font-bold px-2 py-0.5 rounded-full text-[11px]">
                            {ret.status_label || ret.status}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-slate-700 pt-1 border-t border-purple-200/60">
                          <div>
                            <span className="text-slate-400 block">Item:</span>
                            <span className="font-semibold text-slate-900">{ret.item?.name}</span>
                          </div>
                          <div>
                            <span className="text-slate-400 block">Reason:</span>
                            <span className="font-semibold capitalize">{ret.reason_code?.replace('_', ' ')}</span>
                          </div>
                          <div>
                            <span className="text-slate-400 block">Resolution:</span>
                            <span className="font-semibold capitalize text-purple-900">{ret.resolution_type?.replace('_', ' ')}</span>
                          </div>
                          <div>
                            <span className="text-slate-400 block">Refund:</span>
                            <span className="font-bold text-emerald-700">₹{Number(ret.refund_amount).toFixed(2)}</span>
                          </div>
                        </div>
                        {ret.customer_notes && (
                          <p className="text-slate-600 italic bg-white/70 p-2 rounded-lg border border-purple-100">
                            &ldquo;{ret.customer_notes}&rdquo;
                          </p>
                        )}
                        <div className="text-[11px] text-slate-500 flex justify-between items-center pt-1 border-t border-purple-200/50">
                          <span>Carrier: {ret.pickup_details?.carrier} ({ret.pickup_details?.tracking_number})</span>
                          <span>Slot: {ret.pickup_details?.slot}</span>
                        </div>

                        {/* Warehouse Action Buttons */}
                        <div className="flex items-center justify-between pt-2 border-t border-purple-200/70 mt-2">
                          <span className="text-[11px] font-semibold text-purple-900">
                            Current Stage: {ret.status_label || ret.status}
                          </span>
                          <div className="flex items-center gap-2">
                            {!ret.timeline?.[3]?.done && (
                              <button
                                type="button"
                                onClick={() => handleAdminUpdateReturn(selectedOrder.id, ret.rma_number, 'inspect')}
                                className="btn bg-primary-600 hover:bg-primary-700 text-white text-[11px] font-bold py-1.5 px-3 rounded-lg shadow-sm"
                              >
                                Pass Warehouse Inspection
                              </button>
                            )}
                            {ret.timeline?.[3]?.done && !ret.timeline?.[4]?.done && (
                              <button
                                type="button"
                                onClick={() => handleAdminUpdateReturn(selectedOrder.id, ret.rma_number, 'refund')}
                                className="btn bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold py-1.5 px-3 rounded-lg shadow-sm"
                              >
                                Release Refund (₹{Number(ret.refund_amount).toFixed(2)})
                              </button>
                            )}
                            {ret.timeline?.[4]?.done && (
                              <span className="text-[11px] font-bold text-emerald-800 bg-emerald-100 border border-emerald-200 px-2.5 py-1 rounded-full">
                                ✓ Return Resolved & Refunded
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Totals */}
              <div className="flex justify-end pt-4">
                <div className="w-full sm:w-64 space-y-3">
                  <div className="flex justify-between text-slate-600 text-sm">
                    <span>Subtotal</span>
                    <span>₹{selectedOrder.pricing?.subtotal?.toFixed(2) || '0.00'}</span>
                  </div>
                  <div className="flex justify-between text-slate-600 text-sm">
                    <span>Shipping</span>
                    <span>₹{selectedOrder.pricing?.shipping?.toFixed(2) || '0.00'}</span>
                  </div>
                  <div className="flex justify-between text-lg font-bold text-slate-900 pt-3 border-t border-slate-200">
                    <span>Total</span>
                    <span>₹{selectedOrder.pricing?.total?.toFixed(2) || '0.00'}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
