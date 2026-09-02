import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { ShoppingCart, Star } from 'lucide-react';
import { useSearchParams, Link } from 'react-router-dom';
import { useCart } from '../context/CartContext';
import { subscribeToProducts, getCachedProducts } from '../lib/productCache';

import CategoryNav from '../components/CategoryNav';
import ImageWithFallback from '../components/ImageWithFallback';

export default function Home() {
  // Seed state from cache synchronously — instant render on revisit, no flicker
  const [products, setProducts] = useState(() => getCachedProducts());
  const [initialLoad, setInitialLoad] = useState(() => getCachedProducts().length === 0);
  const { addToCart } = useCart();
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.get('q') || '';

  useEffect(() => {
    // subscribeToProducts immediately fires with cached data (empty [] on first ever load,
    // full list on every subsequent navigation). No spinner flicker on revisit.
    const unsub = subscribeToProducts((list) => {
      setProducts(list);
      if (list.length > 0) setInitialLoad(false);
    });

    // If cache already had data, mark load complete right away
    if (products.length > 0) setInitialLoad(false);

    return unsub;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredProducts = products.filter(product => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      product.name?.toLowerCase().includes(q) ||
      product.description?.toLowerCase().includes(q) ||
      product.category?.toLowerCase().includes(q)
    );
  });

  // Show skeleton only on the very first ever load (cache empty)
  const showSkeleton = initialLoad && products.length === 0;

  return (
    <div className="min-h-screen bg-slate-50 pb-20">

      {/* Category Navigation Bar */}
      {!searchQuery && <CategoryNav />}

      {/* Hero Section */}
      {!searchQuery && (
        <section className="bg-white relative overflow-hidden">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 md:py-20 lg:py-32">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="relative z-10 text-center max-w-3xl mx-auto"
            >
              <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-slate-900 tracking-tight mb-6">
                Shop the <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary-600 to-primary-400">Future</span> of Commerce
              </h1>
              <p className="text-lg md:text-xl text-slate-600 mb-10">
                Discover premium products curated just for you. Fast shipping, secure payments, and a seamless shopping experience.
              </p>
              <div className="flex flex-col sm:flex-row justify-center gap-4">
                <button 
                  onClick={() => {
                    const el = document.getElementById('products-section');
                    if (el) {
                      const y = el.getBoundingClientRect().top + window.scrollY - 80;
                      window.scrollTo({ top: y, behavior: 'smooth' });
                    }
                  }}
                  className="btn btn-primary text-lg px-8 py-3 w-full sm:w-auto"
                >
                  Shop Now
                </button>
                <button 
                  onClick={() => {
                    const el = document.getElementById('products-section');
                    if (el) {
                      const y = el.getBoundingClientRect().top + window.scrollY - 80;
                      window.scrollTo({ top: y, behavior: 'smooth' });
                    }
                  }}
                  className="btn btn-secondary text-lg px-8 py-3 w-full sm:w-auto"
                >
                  View Offers
                </button>
              </div>
            </motion.div>
          </div>

          {/* Decorative background blur */}
          <div className="absolute top-0 right-0 -mr-32 -mt-32 w-96 h-96 rounded-full bg-primary-100 opacity-50 blur-3xl pointer-events-none"></div>
          <div className="absolute bottom-0 left-0 -ml-32 -mb-32 w-96 h-96 rounded-full bg-blue-100 opacity-50 blur-3xl pointer-events-none"></div>
        </section>
      )}

      {/* Featured Products */}
      <section id="products-section" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-10">
        <div className="flex justify-between items-end mb-10">
          <div>
            <h2 className="text-3xl font-bold text-slate-900 mb-2">
              {searchQuery ? `Search Results for "${searchQuery}"` : 'Trending Now'}
            </h2>
            {!searchQuery && <p className="text-slate-500">Our most popular items this week.</p>}
          </div>
          {!searchQuery && (
            <button className="text-primary-600 font-medium hover:text-primary-700 transition-colors">
              View All →
            </button>
          )}
        </div>

        {showSkeleton ? (
          /* Skeleton cards — same grid, no spinner flicker */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden animate-pulse">
                <div className="h-64 bg-slate-100" />
                <div className="p-6 space-y-3">
                  <div className="h-4 bg-slate-100 rounded w-3/4" />
                  <div className="h-4 bg-slate-100 rounded w-1/2" />
                  <div className="h-10 bg-slate-100 rounded mt-4" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-2xl border border-slate-100 shadow-sm">
            <ShoppingCart className="mx-auto h-12 w-12 text-slate-300 mb-4" />
            <h3 className="text-lg font-medium text-slate-900">No products found</h3>
            <p className="text-slate-500">Try adjusting your search query.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
            {filteredProducts.map((product) => (
              /* No staggered delay — all cards appear together */
              <motion.div
                key={product.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden group hover:shadow-md transition-shadow flex flex-col"
              >
                <Link to={`/product/${product.id}`} className="relative h-64 overflow-hidden bg-slate-100 flex items-center justify-center block cursor-pointer">
                  <ImageWithFallback
                    src={product.images && product.images.length > 0 ? product.images[0] : null}
                    alt={product.name}
                    className={`w-full h-full object-contain p-2 transition-transform duration-500 ${product.stock_quantity === 0 ? 'opacity-50 grayscale' : 'group-hover:scale-105'}`}
                  />
                  {product.category && (
                    <div className="absolute top-4 left-4 flex flex-col gap-2">
                      <span className="bg-white/90 backdrop-blur-sm text-xs font-bold px-3 py-1 rounded-full text-slate-700 shadow-sm w-fit">
                        {product.category}
                      </span>
                    </div>
                  )}
                  {product.stock_quantity === 0 && (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/40 backdrop-blur-[2px]">
                      <span className="bg-slate-900 text-white text-sm font-bold px-4 py-2 rounded-full shadow-lg">
                        Out of Stock
                      </span>
                    </div>
                  )}
                </Link>

                <div className="p-6 flex-grow flex flex-col justify-between">
                  <div>
                    <div className="flex justify-between items-start mb-2 gap-4">
                      <Link to={`/product/${product.id}`} className="hover:text-primary-600 transition-colors">
                        <h3 className="text-lg font-bold text-slate-900 line-clamp-1" title={product.name}>{product.name}</h3>
                      </Link>
                      <span className="text-lg font-bold text-primary-600">₹{Number(product.price).toFixed(2)}</span>
                    </div>

                    <div className="flex items-center gap-1 mb-4">
                      <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                      <span className="text-sm font-medium text-slate-700">4.5</span>
                      <span className="text-sm text-slate-400">(0)</span>
                    </div>

                    {product.description && (
                      <p className="text-sm text-slate-500 line-clamp-2 mb-4">
                        {product.description}
                      </p>
                    )}

                    {product.stock_quantity > 0 && product.stock_quantity <= 5 && (
                      <p className="text-xs font-bold text-red-500 mb-2 mt-auto">
                        Only {product.stock_quantity} left in stock!
                      </p>
                    )}
                  </div>

                  <button
                    onClick={() => addToCart(product)}
                    disabled={product.stock_quantity === 0}
                    className={`w-full ${product.stock_quantity <= 5 && product.stock_quantity > 0 ? 'mt-2' : 'mt-auto'} btn btn-secondary hover:bg-primary-50 hover:text-primary-700 hover:border-primary-200 group/btn disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <ShoppingCart className="h-4 w-4 mr-2 text-slate-400 group-hover/btn:text-primary-600 transition-colors" />
                    Add to Cart
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
