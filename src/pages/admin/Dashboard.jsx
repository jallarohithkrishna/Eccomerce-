import { useState, useEffect } from 'react';
import { db } from '../../lib/firebase';
import { collection, onSnapshot } from 'firebase/firestore';

export default function Dashboard() {
  const [stats, setStats] = useState({
    totalUsers: 0,
    totalOrders: 0,
    totalRevenue: 0,
    lowStock: 0
  });
  const [errors, setErrors] = useState({});

  useEffect(() => {
    const unsubUsers = onSnapshot(collection(db, 'users'), (snap) => {
      setStats(prev => ({ ...prev, totalUsers: snap.size }));
      setErrors(prev => ({ ...prev, users: null }));
    }, (err) => {
      console.error("Users error:", err);
      setErrors(prev => ({ ...prev, users: "Permission Denied" }));
    });

    const unsubOrders = onSnapshot(collection(db, 'orders'), (snap) => {
      let revenue = 0;
      snap.forEach(doc => {
        const order = doc.data();
        if (order.status !== 'cancelled' && order.pricing?.total) {
          revenue += order.pricing.total;
        }
      });
      setStats(prev => ({ ...prev, totalOrders: snap.size, totalRevenue: revenue }));
      setErrors(prev => ({ ...prev, orders: null }));
    }, (err) => {
      console.error("Orders error:", err);
      setErrors(prev => ({ ...prev, orders: "Permission Denied" }));
    });

    const unsubProducts = onSnapshot(collection(db, 'products'), (snap) => {
      let lowStockCount = 0;
      snap.forEach(doc => {
        const product = doc.data();
        if (product.stock_quantity !== undefined && product.stock_quantity <= 5) {
          lowStockCount++;
        }
      });
      setStats(prev => ({ ...prev, lowStock: lowStockCount }));
      setErrors(prev => ({ ...prev, products: null }));
    }, (err) => {
      console.error("Products error:", err);
      setErrors(prev => ({ ...prev, products: "Permission Denied" }));
    });

    return () => {
      unsubUsers();
      unsubOrders();
      unsubProducts();
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-100 p-8">
      <h1 className="text-3xl font-bold text-slate-900 mb-8">Admin Dashboard</h1>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="glass-panel p-6 rounded-xl">
          <h3 className="text-sm font-medium text-slate-500 mb-1">Total Users</h3>
          {errors.users ? (
            <p className="text-sm font-bold text-red-500 mt-2">{errors.users}</p>
          ) : (
            <p className="text-2xl font-bold text-slate-900">{stats.totalUsers}</p>
          )}
        </div>
        <div className="glass-panel p-6 rounded-xl">
          <h3 className="text-sm font-medium text-slate-500 mb-1">Total Orders</h3>
          {errors.orders ? (
            <p className="text-sm font-bold text-red-500 mt-2">{errors.orders}</p>
          ) : (
            <p className="text-2xl font-bold text-slate-900">{stats.totalOrders}</p>
          )}
        </div>
        <div className="glass-panel p-6 rounded-xl">
          <h3 className="text-sm font-medium text-slate-500 mb-1">Total Revenue</h3>
          {errors.orders ? (
            <p className="text-sm font-bold text-red-500 mt-2">{errors.orders}</p>
          ) : (
            <p className="text-2xl font-bold text-slate-900">₹{stats.totalRevenue.toFixed(2)}</p>
          )}
        </div>
        <div className="glass-panel p-6 rounded-xl">
          <h3 className="text-sm font-medium text-slate-500 mb-1">Low Stock</h3>
          {errors.products ? (
            <p className="text-sm font-bold text-red-500 mt-2">{errors.products}</p>
          ) : (
            <p className="text-2xl font-bold text-slate-900">{stats.lowStock}</p>
          )}
        </div>
      </div>
    </div>
  );
}
