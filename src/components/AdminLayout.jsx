import { Link, Outlet, Navigate, useLocation } from 'react-router-dom';
import { Package, LayoutDashboard, LogOut, ShieldX, ClipboardList } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useState, useEffect, useRef } from 'react';
import { db } from '../lib/firebase';
import { doc, getDoc } from 'firebase/firestore';
import VoiceAssistant from './VoiceAssistant';

export default function AdminLayout() {
  const { user, loading, signOut } = useAuth();
  const [role, setRole] = useState(null);
  const [roleLoading, setRoleLoading] = useState(true);
  const location = useLocation();
  // Ref callback so VoiceAssistant can trigger the Add Product modal
  const addProductTriggerRef = useRef(null);
  const handleVoiceAddProduct = () => {
    if (addProductTriggerRef.current) addProductTriggerRef.current();
  };

  // Ref to open the JARVIS panel from the sidebar button
  const openJarvisRef = useRef(null);
  const handleOpenJarvis = () => {
    if (openJarvisRef.current) openJarvisRef.current();
  };

  useEffect(() => {
    async function fetchRole() {
      if (!user) { setRoleLoading(false); return; }
      try {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        setRole(userDoc.exists() ? userDoc.data().role : 'customer');
      } catch {
        setRole('customer');
      } finally {
        setRoleLoading(false);
      }
    }
    fetchRole();
  }, [user]);

  // Show spinner while checking auth + role
  if (loading || roleLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  // If not logged in at all → redirect to login
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  // If logged in but NOT an admin → show Access Restricted screen
  if (role !== 'admin') {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-3xl p-10 max-w-md w-full text-center shadow-xl border border-slate-100">
          <div className="h-20 w-20 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-6">
            <ShieldX className="h-10 w-10 text-red-500" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">Access Restricted</h1>
          <p className="text-slate-500 mb-2">
            You don't have permission to view this page.
          </p>
          <p className="text-sm text-slate-400 mb-8">
            Logged in as: <span className="font-medium text-slate-600">{user.email}</span>
          </p>
          <div className="flex flex-col gap-3">
            <Link to="/" className="btn btn-primary py-3">
              Go Back to Store
            </Link>
            <button
              onClick={signOut}
              className="btn btn-secondary py-3 text-red-500 hover:bg-red-50 hover:border-red-200"
            >
              <LogOut className="h-4 w-4 mr-2" /> Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Admin user — show the full admin panel
  return (
    <div className="min-h-screen bg-slate-100 flex flex-col md:flex-row">
      {/* Sidebar */}
      <aside className="w-full md:w-64 bg-white border-b md:border-b-0 md:border-r border-slate-200 shadow-sm flex flex-col md:min-h-screen">
        <div className="p-6">
          <Link to="/" className="flex items-center gap-2 text-2xl font-bold text-primary-600 tracking-tight">
            <img src="/nova-logo.png" alt="Nova Store Logo" className="h-8 w-8 object-contain" />
            <div>
              Smart<span className="text-slate-900">Cart</span>
              <span className="text-xs text-slate-500 uppercase ml-1 block mt-[-4px]">Admin</span>
            </div>
          </Link>
        </div>
        <nav className="px-4 space-y-1 mt-2 md:mt-6 flex flex-row md:flex-col overflow-x-auto md:flex-1 pb-4 md:pb-0 hide-scrollbar">
          <Link to="/admin" className="flex items-center whitespace-nowrap px-4 py-3 text-slate-700 hover:bg-slate-50 hover:text-primary-600 rounded-lg font-medium transition-colors">
            <LayoutDashboard className="h-5 w-5 mr-2 md:mr-3" /> <span className="hidden sm:inline md:block">Dashboard</span>
          </Link>
          <Link to="/admin/products" className="flex items-center whitespace-nowrap px-4 py-3 text-slate-700 hover:bg-slate-50 hover:text-primary-600 rounded-lg font-medium transition-colors">
            <Package className="h-5 w-5 mr-2 md:mr-3" /> <span className="hidden sm:inline md:block">Products</span>
          </Link>
          <Link to="/admin/orders" className="flex items-center whitespace-nowrap px-4 py-3 text-slate-700 hover:bg-slate-50 hover:text-primary-600 rounded-lg font-medium transition-colors">
            <ClipboardList className="h-5 w-5 mr-2 md:mr-3" /> <span className="hidden sm:inline md:block">Orders</span>
          </Link>

          {/* ── Mobile JARVIS Button ── */}
          <button
            onClick={handleOpenJarvis}
            className="md:hidden flex items-center whitespace-nowrap px-3 py-2 text-amber-700 bg-gradient-to-r from-amber-50 to-orange-50 hover:from-amber-100 hover:to-orange-100 rounded-lg font-bold border border-amber-300 text-xs transition-all shrink-0 shadow-sm"
          >
            <span className="relative flex h-2 w-2 mr-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
            </span>
            NOVA AI AGENT
          </button>

          {/* ── JARVIS CEO Voice Button ── */}
          <div className="hidden md:block mt-4 pt-4 border-t border-slate-100">
            <button
              onClick={handleOpenJarvis}
              id="jarvis-sidebar-btn"
              style={{
                width:'100%', padding:'10px 16px', borderRadius:10,
                background:'linear-gradient(135deg,#1a0800,#2d1200)',
                border:'1px solid rgba(255,140,30,0.5)',
                boxShadow:'0 0 14px rgba(255,100,0,0.25)',
                cursor:'pointer', display:'flex', alignItems:'center', gap:10,
                transition:'all 0.3s',
              }}
              onMouseEnter={e=>{ e.currentTarget.style.boxShadow='0 0 24px rgba(255,140,0,0.6)'; e.currentTarget.style.borderColor='rgba(255,160,40,0.9)'; }}
              onMouseLeave={e=>{ e.currentTarget.style.boxShadow='0 0 14px rgba(255,100,0,0.25)'; e.currentTarget.style.borderColor='rgba(255,140,30,0.5)'; }}
            >
              <span style={{
                width:32, height:32, borderRadius:'50%', flexShrink:0,
                background:'radial-gradient(circle,rgba(255,180,50,0.4),rgba(150,60,0,0.3))',
                border:'1px solid rgba(255,150,40,0.6)',
                display:'flex', alignItems:'center', justifyContent:'center',
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,180,60,1)" strokeWidth="1.8">
                  <circle cx="12" cy="12" r="3" fill="rgba(255,200,80,0.9)"/>
                  <path d="M12 2v3M12 19v3M2 12h3M19 12h3" strokeLinecap="round"/>
                  <path d="M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" strokeLinecap="round" opacity="0.7"/>
                </svg>
              </span>
              <div style={{ textAlign:'left' }}>
                <div style={{ fontSize:11, fontWeight:700, color:'rgba(255,180,50,0.95)', letterSpacing:'0.1em', fontFamily:'monospace' }}>J.A.R.V.I.S</div>
                <div style={{ fontSize:9, color:'rgba(255,130,30,0.65)', letterSpacing:'0.12em', fontFamily:'monospace' }}>CEO VOICE MODE</div>
              </div>
            </button>
          </div>
        </nav>

        {/* User info + Logout at the bottom (Hidden on mobile for space, or stacked) */}
        <div className="p-4 border-t border-slate-100 hidden md:block">
          <div className="flex items-center gap-3 px-2 mb-3">
            <div className="h-9 w-9 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-sm">
              {(user.displayName || user.email || 'A')[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-slate-800 truncate">{user.displayName || 'Admin'}</p>
              <p className="text-xs text-slate-400 truncate">{user.email}</p>
            </div>
          </div>
          <button
            onClick={signOut}
            className="w-full flex items-center px-4 py-2 text-sm text-red-500 hover:bg-red-50 rounded-lg font-medium transition-colors"
          >
            <LogOut className="h-4 w-4 mr-2" /> Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-4 md:p-8 overflow-x-hidden">
        <Outlet context={{ addProductTriggerRef }} />
      </main>

      {/* JARVIS Voice Assistant */}
      <VoiceAssistant onAddProduct={handleVoiceAddProduct} openRef={openJarvisRef} />
    </div>
  );
}
