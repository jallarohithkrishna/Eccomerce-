import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { ShoppingCart, User, Search, Menu, LogOut, Package, X, ArrowLeft, LayoutDashboard } from 'lucide-react';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';
import { motion, AnimatePresence } from 'framer-motion';

export default function Navbar() {
  const { cartCount, setIsCartOpen } = useCart();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.get('q') || '';
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const handleSearchChange = (e) => {
    const value = e.target.value;
    if (location.pathname !== '/') {
      navigate(`/?q=${encodeURIComponent(value)}`);
    } else {
      if (value) {
        navigate(`/?q=${encodeURIComponent(value)}`, { replace: true });
        
        // Scroll down to products if we're near the top of the page
        const productsSection = document.getElementById('products-section');
        if (productsSection && window.scrollY < productsSection.offsetTop - 150) {
          window.scrollTo({
            top: productsSection.offsetTop - 100,
            behavior: 'smooth'
          });
        }
      } else {
        navigate(`/`, { replace: true });
      }
    }
  };

  const [mobileSearchQuery, setMobileSearchQuery] = useState(searchQuery);

  useEffect(() => {
    setMobileSearchQuery(searchQuery);
  }, [searchQuery]);

  const handleMobileSearchSubmit = (e) => {
    e.preventDefault();
    if (location.pathname !== '/') {
      navigate(`/?q=${encodeURIComponent(mobileSearchQuery)}`);
    } else {
      if (mobileSearchQuery) {
        navigate(`/?q=${encodeURIComponent(mobileSearchQuery)}`, { replace: true });
        
        // Scroll down to products if we're near the top of the page
        const productsSection = document.getElementById('products-section');
        if (productsSection && window.scrollY < productsSection.offsetTop - 150) {
          window.scrollTo({
            top: productsSection.offsetTop - 100,
            behavior: 'smooth'
          });
        }
      } else {
        navigate(`/`, { replace: true });
      }
    }
    closeMobileMenu();
  };

  const closeMobileMenu = () => {
    setIsMobileMenuOpen(false);
  };

  return (
    <nav className="bg-white/80 backdrop-blur-md sticky top-0 z-40 border-b border-slate-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-20 items-center">
          
          {/* Logo & Back Button */}
          <div className="flex-shrink-0 flex items-center">
            {(location.pathname !== '/' || searchQuery) && (
              <Link to="/" onClick={closeMobileMenu} className="mr-3 text-slate-500 hover:text-primary-600 transition-colors bg-slate-100 hover:bg-primary-50 p-1.5 md:p-2 rounded-full" title="Back to Home">
                <ArrowLeft className="h-5 w-5" />
              </Link>
            )}
            <Link to="/" onClick={closeMobileMenu} className="flex items-center gap-2">
              <img src="/nova-logo.png" alt="Nova Store Logo" className="h-10 w-10 md:h-11 md:w-11 object-contain rounded-xl shadow-md" />
              <span className="hidden sm:block text-xl md:text-2xl font-bold tracking-tight bg-gradient-to-r from-indigo-600 to-violet-500 bg-clip-text text-transparent">Nova Store</span>
            </Link>
          </div>

          {/* Search Bar (Desktop) */}
          <div className="hidden md:flex flex-1 max-w-lg mx-8">
            <div className="relative w-full">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Search className="h-5 w-5 text-slate-400" />
              </div>
              <input
                type="text"
                value={searchQuery}
                onChange={handleSearchChange}
                className="block w-full pl-10 pr-3 py-2.5 border border-slate-200 rounded-full leading-5 bg-slate-50 placeholder-slate-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-primary-500 focus:border-primary-500 transition-colors sm:text-sm"
                placeholder="Search for products..."
              />
            </div>
          </div>

          {/* Right Navigation */}
          <div className="flex items-center space-x-4 sm:space-x-6">
            <button 
              onClick={() => {
                setIsCartOpen(true);
                closeMobileMenu();
              }}
              className="text-slate-600 hover:text-primary-600 transition-colors relative group"
            >
              <ShoppingCart className="h-6 w-6" />
              {cartCount > 0 && (
                <span className="absolute -top-2 -right-2 bg-primary-600 text-white text-[10px] font-bold h-5 w-5 rounded-full flex items-center justify-center border-2 border-white group-hover:scale-110 transition-transform">
                  {cartCount}
                </span>
              )}
            </button>
            <div className="h-6 w-px bg-slate-200 hidden sm:block"></div>
            
            {user ? (
              <div className="hidden sm:flex items-center space-x-4">
                <span className="text-sm font-medium text-slate-700">
                  Hi, {user.user_metadata?.full_name?.split(' ')[0] || 'User'}
                </span>
                {user.user_metadata?.role === 'admin' && (
                  <Link to="/admin" className="text-slate-600 hover:text-primary-600 transition-colors" title="Admin Dashboard">
                    <LayoutDashboard className="h-5 w-5" />
                  </Link>
                )}
                <Link to="/orders" className="text-slate-600 hover:text-primary-600 transition-colors" title="My Orders">
                  <Package className="h-5 w-5" />
                </Link>
                <button 
                  onClick={() => signOut()}
                  className="text-slate-600 hover:text-red-600 transition-colors"
                  title="Sign Out"
                >
                  <LogOut className="h-5 w-5" />
                </button>
              </div>
            ) : (
              <Link to="/login" className="hidden sm:flex items-center text-slate-600 hover:text-primary-600 font-medium transition-colors">
                <User className="h-5 w-5 mr-2" />
                Sign In
              </Link>
            )}

            <button 
              className="md:hidden text-slate-600 hover:text-primary-600"
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            >
              {isMobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="md:hidden absolute top-full left-0 w-full bg-white shadow-xl border-t border-slate-100 overflow-hidden"
          >
            <div className="px-4 py-6 space-y-6">
              {/* Mobile Search */}
              <form onSubmit={handleMobileSearchSubmit} className="relative w-full">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Search className="h-5 w-5 text-slate-400" />
                </div>
                <input
                  type="text"
                  value={mobileSearchQuery}
                  onChange={(e) => setMobileSearchQuery(e.target.value)}
                  className="block w-full pl-11 pr-20 py-3 border border-slate-200 rounded-xl leading-5 bg-slate-50 placeholder-slate-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-primary-500 focus:border-primary-500 transition-colors text-base shadow-sm"
                  placeholder="Search products..."
                />
                <button 
                  type="submit" 
                  className="absolute inset-y-1.5 right-1.5 px-3 py-1.5 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors"
                >
                  Search
                </button>
              </form>

              {/* Mobile User Actions */}
              <div className="pt-2 flex flex-col space-y-2">
                {user ? (
                  <>
                    <div className="flex items-center space-x-4 px-2 mb-4">
                      <div className="h-10 w-10 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center font-bold text-lg">
                        {(user.user_metadata?.full_name || 'U').charAt(0).toUpperCase()}
                      </div>
                      <span className="text-base font-semibold text-slate-900">
                        {user.user_metadata?.full_name || 'User'}
                      </span>
                    </div>
                    {user.user_metadata?.role === 'admin' && (
                      <Link 
                        to="/admin" 
                        onClick={closeMobileMenu}
                        className="flex items-center px-4 py-3 text-slate-700 hover:text-primary-700 hover:bg-slate-50 rounded-xl transition-all font-medium"
                      >
                        <LayoutDashboard className="h-5 w-5 mr-4 text-slate-400" />
                        Admin Dashboard
                      </Link>
                    )}
                    <Link 
                      to="/orders" 
                      onClick={closeMobileMenu}
                      className="flex items-center px-4 py-3 text-slate-700 hover:text-primary-700 hover:bg-slate-50 rounded-xl transition-all font-medium"
                    >
                      <Package className="h-5 w-5 mr-4 text-slate-400" />
                      My Orders
                    </Link>
                    <button 
                      onClick={() => {
                        signOut();
                        closeMobileMenu();
                      }}
                      className="flex items-center px-4 py-3 text-slate-700 hover:text-red-700 hover:bg-red-50 rounded-xl transition-all font-medium w-full text-left"
                    >
                      <LogOut className="h-5 w-5 mr-4 text-slate-400" />
                      Sign Out
                    </button>
                  </>
                ) : (
                  <Link 
                    to="/login" 
                    onClick={closeMobileMenu}
                    className="flex items-center px-4 py-3 text-slate-700 hover:text-primary-700 hover:bg-slate-50 rounded-xl transition-all font-medium"
                  >
                    <User className="h-5 w-5 mr-4 text-slate-400" />
                    Sign In
                  </Link>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}
