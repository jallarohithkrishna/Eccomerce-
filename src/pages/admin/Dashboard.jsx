import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../lib/firebase';
import { 
  collection, 
  query, 
  where, 
  getCountFromServer, 
  getAggregateFromServer, 
  sum, 
  count 
} from 'firebase/firestore';
import { getCachedProducts, ensureProductsLoaded } from '../../lib/productCache';
import { RefreshCw, RotateCcw, AlertTriangle, Users, ShoppingBag, DollarSign, Package } from 'lucide-react';

export default function Dashboard() {
  const [stats, setStats] = useState({
    totalUsers: 0,
    totalOrders: 0,
    totalRevenue: 0,
    lowStock: 0,
    totalReturns: 0,
    returnExceptions: 0
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errors, setErrors] = useState({});

  const loadStats = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) setRefreshing(true);
    else setLoading(true);

    const newErrors = {};

    // 1. Users count (server aggregation)
    let totalUsers = 0;
    try {
      const userCountSnap = await getCountFromServer(collection(db, 'users'));
      totalUsers = userCountSnap.data().count;
    } catch (err) {
      console.warn("Users count warning:", err.message);
      newErrors.users = "Permission Denied";
    }

    // 2. Orders aggregation (sum total + total count)
    let totalOrders = 0;
    let totalRevenue = 0;
    try {
      const ordersCol = collection(db, 'orders');
      const ordersAggSnap = await getAggregateFromServer(ordersCol, {
        totalOrders: count(),
        totalRevenue: sum('pricing.total')
      });
      totalOrders = ordersAggSnap.data().totalOrders || 0;
      totalRevenue = ordersAggSnap.data().totalRevenue || 0;
    } catch (err) {
      console.warn("Orders aggregation warning:", err.message);
      newErrors.orders = "Permission Denied";
    }

    // 3. Products low-stock count from in-memory product cache (0 extra reads)
    let lowStock = 0;
    try {
      const products = await ensureProductsLoaded();
      lowStock = products.filter(p => p.stock_quantity !== undefined && Number(p.stock_quantity) <= 5).length;
    } catch (err) {
      console.warn("Products cache warning:", err.message);
      const cached = getCachedProducts();
      lowStock = cached.filter(p => p.stock_quantity !== undefined && Number(p.stock_quantity) <= 5).length;
    }

    // 4. Returns & Exceptions count
    let totalReturns = 0;
    let returnExceptions = 0;
    try {
      const returnsCol = collection(db, 'returns');
      const retCountSnap = await getCountFromServer(returnsCol);
      totalReturns = retCountSnap.data().count;

      const excQuery = query(
        collection(db, 'returns'), 
        where('state', 'in', ['HUMAN_REVIEW', 'REFUND_FAILED'])
      );
      const excSnap = await getCountFromServer(excQuery);
      returnExceptions = excSnap.data().count;
    } catch (err) {
      console.warn("Returns count warning:", err.message);
    }

    setStats({
      totalUsers,
      totalOrders,
      totalRevenue,
      lowStock,
      totalReturns,
      returnExceptions
    });
    setErrors(newErrors);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  return (
    <div className="min-h-screen bg-slate-100 p-4 md:p-8">
      {/* Header with Title and Refresh Button */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">Admin Dashboard</h1>
          <p className="text-xs text-slate-500 mt-1">Live metrics powered by server-side aggregations</p>
        </div>
        <button
          onClick={() => loadStats(true)}
          disabled={loading || refreshing}
          className="btn btn-secondary text-xs font-bold py-2.5 px-4 shadow-xs bg-white hover:bg-slate-50 border border-slate-200 flex items-center gap-2 transition-all"
          title="Refresh Dashboard Metrics"
        >
          <RefreshCw className={`w-3.5 h-3.5 text-primary-600 ${refreshing ? 'animate-spin' : ''}`} />
          <span>{refreshing ? 'Refreshing...' : 'Refresh Metrics'}</span>
        </button>
      </div>

      {loading ? (
        <div className="p-16 text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary-600 mx-auto" />
          <p className="text-xs text-slate-500 mt-3 font-medium">Calculating platform aggregations...</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {/* Total Users */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Total Users</h3>
              <div className="p-2 bg-blue-50 text-blue-600 rounded-xl">
                <Users className="w-4 h-4" />
              </div>
            </div>
            {errors.users ? (
              <p className="text-xs font-bold text-red-500 mt-3">{errors.users}</p>
            ) : (
              <p className="text-3xl font-extrabold text-slate-900 mt-2">{stats.totalUsers}</p>
            )}
          </div>

          {/* Total Orders */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Total Orders</h3>
              <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
                <ShoppingBag className="w-4 h-4" />
              </div>
            </div>
            {errors.orders ? (
              <p className="text-xs font-bold text-red-500 mt-3">{errors.orders}</p>
            ) : (
              <p className="text-3xl font-extrabold text-slate-900 mt-2">{stats.totalOrders}</p>
            )}
          </div>

          {/* Total Revenue */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Total Revenue</h3>
              <div className="p-2 bg-emerald-50 text-emerald-600 rounded-xl">
                <DollarSign className="w-4 h-4" />
              </div>
            </div>
            {errors.orders ? (
              <p className="text-xs font-bold text-red-500 mt-3">{errors.orders}</p>
            ) : (
              <p className="text-3xl font-extrabold text-slate-900 mt-2">₹{stats.totalRevenue.toFixed(2)}</p>
            )}
          </div>

          {/* Low Stock (from product cache) */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Low Stock</h3>
              <div className="p-2 bg-amber-50 text-amber-600 rounded-xl">
                <Package className="w-4 h-4" />
              </div>
            </div>
            <p className="text-3xl font-extrabold text-slate-900 mt-2">{stats.lowStock}</p>
          </div>

          {/* Returns & RMA Link Card */}
          <Link 
            to="/admin/returns" 
            className="sm:col-span-2 lg:col-span-4 bg-gradient-to-r from-purple-900 to-indigo-900 text-white p-6 rounded-2xl shadow-md hover:shadow-lg transition-all group flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4"
          >
            <div>
              <div className="flex items-center gap-2">
                <RotateCcw className="w-5 h-5 text-purple-300" />
                <h3 className="text-sm font-bold uppercase tracking-wider text-purple-200">Autonomous Returns &amp; RMA Management</h3>
                {stats.returnExceptions > 0 && (
                  <span className="text-[10px] bg-amber-400 text-slate-950 font-extrabold px-2.5 py-0.5 rounded-full flex items-center gap-1 shadow-xs">
                    <AlertTriangle className="w-3 h-3" />
                    {stats.returnExceptions} Review Required
                  </span>
                )}
              </div>
              <p className="text-2xl font-black mt-2 text-white group-hover:text-purple-200 transition-colors">
                {stats.totalReturns} Active Cases
              </p>
              <p className="text-xs text-purple-200/80 mt-0.5">Policy-driven agent orchestrations, verification passes, and audit trails</p>
            </div>
            <span className="btn bg-white/10 hover:bg-white/20 text-white text-xs font-bold py-2.5 px-4 rounded-xl border border-white/20 group-hover:border-white/40 transition-all shrink-0">
              Open Returns Queue &rarr;
            </span>
          </Link>
        </div>
      )}
    </div>
  );
}
