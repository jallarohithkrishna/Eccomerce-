import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Suspense, lazy, useEffect } from 'react';
import { SplashScreen } from '@capacitor/splash-screen';
import Navbar from './components/Navbar';
import AdminLayout from './components/AdminLayout';
import { AuthProvider } from './context/AuthContext';
import CartSidebar from './components/CartSidebar';
import AiAssistantModal from './components/AiAssistantModal';

// Lazy loaded pages
const Home = lazy(() => import('./pages/Home'));
const Login = lazy(() => import('./pages/auth/Login'));
const Register = lazy(() => import('./pages/auth/Register'));
const Checkout = lazy(() => import('./pages/Checkout'));
const Orders = lazy(() => import('./pages/Orders'));
const ProductDetails = lazy(() => import('./pages/ProductDetails'));
const Category = lazy(() => import('./pages/Category'));

// Admin pages
const AdminDashboard = lazy(() => import('./pages/admin/Dashboard'));
const AdminProducts = lazy(() => import('./pages/admin/Products'));
const AdminOrders = lazy(() => import('./pages/admin/Orders'));

const Loader = () => (
  <div className="min-h-screen flex items-center justify-center">
    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
  </div>
);

function App() {
  useEffect(() => {
    const hideSplash = async () => {
      try {
        // Add a small delay to allow lazy-loaded components to render
        // and prevent the white loading screen from showing immediately
        setTimeout(async () => {
          await SplashScreen.hide();
        }, 2000);
      } catch (err) {
        console.warn('Error hiding splash screen', err);
      }
    };
    hideSplash();
  }, []);

  return (
    <AuthProvider>
      <CartProvider>
        <Router>
          <div className="min-h-screen flex flex-col bg-slate-50">
            <Suspense fallback={<Loader />}>
              <CartSidebar />
              <AiAssistantModal />
              <Routes>
                {/* Public Routes with Navbar */}
                <Route path="/" element={
                  <>
                    <Navbar />
                    <main className="flex-grow">
                      <Home />
                    </main>
                  </>
                } />
                
                <Route path="/login" element={
                  <>
                    <Navbar />
                    <main className="flex-grow">
                      <Login />
                    </main>
                  </>
                } />
                
                <Route path="/register" element={
                  <>
                    <Navbar />
                    <main className="flex-grow">
                      <Register />
                    </main>
                  </>
                } />
                
                <Route path="/checkout" element={
                  <>
                    <Navbar />
                    <main className="flex-grow">
                      <Checkout />
                    </main>
                  </>
                } />

                <Route path="/orders" element={
                  <>
                    <Navbar />
                    <main className="flex-grow">
                      <Orders />
                    </main>
                  </>
                } />
                
                <Route path="/product/:id" element={
                  <>
                    <Navbar />
                    <main className="flex-grow">
                      <ProductDetails />
                    </main>
                  </>
                } />

                <Route path="/category/:categoryId" element={
                  <>
                    <Navbar />
                    <main className="flex-grow">
                      <Category />
                    </main>
                  </>
                } />

                {/* Admin Routes with Sidebar */}
                <Route path="/admin" element={<AdminLayout />}>
                  <Route index element={<AdminDashboard />} />
                  <Route path="products" element={<AdminProducts />} />
                  <Route path="orders" element={<AdminOrders />} />
                </Route>
              </Routes>
            </Suspense>
          </div>
        </Router>
      </CartProvider>
    </AuthProvider>
  );
}

export default App;
