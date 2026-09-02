import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ShoppingCart, Star, ChevronRight } from 'lucide-react';
import { db } from '../lib/firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { useCart } from '../context/CartContext';
import { CATEGORIES } from '../constants/categories';
import ImageWithFallback from '../components/ImageWithFallback';
import { getCachedProducts, subscribeToProducts } from '../lib/productCache';

export default function Category() {
  const { categoryId } = useParams();
  const { addToCart } = useCart();

  const categoryInfo = CATEGORIES.find(c => c.id === categoryId) || { name: categoryId, id: categoryId };

  const categoryMap = {
    electronics: ['smartphones', 'laptops', 'tablets', 'electronics', 'smartphone', 'laptop'],
    clothing: ['mens-shirts', 'womens-dresses', 'tops', 'mens-shoes', 'womens-shoes', 'clothing', 'fashion', 'shirts', 'dresses'],
    home: ['home-decoration', 'furniture', 'home'],
    beauty: ['skincare', 'fragrances', 'beauty', 'cosmetics'],
    groceries: ['groceries', 'grocery'],
    fragrances: ['fragrances', 'perfume'],
    furniture: ['furniture', 'home-decoration']
  };

  // Filter cached products client-side instantly
  const [allProducts, setAllProducts] = useState(() => getCachedProducts());
  const [loading, setLoading] = useState(false);

  const targetCategories = useMemo(() => {
    const target = categoryId.toLowerCase().trim();
    return categoryMap[target] || [target];
  }, [categoryId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter from cache in real-time
  const products = useMemo(() => {
    return allProducts
      .filter(p => targetCategories.some(cat => p.category?.toLowerCase() === cat.toLowerCase()))
      .sort((a, b) => (b.created_at?.seconds || 0) - (a.created_at?.seconds || 0));
  }, [allProducts, targetCategories]);

  useEffect(() => {
    window.scrollTo(0, 0);
    // Subscribe to cache updates (instant if already populated)
    const unsub = subscribeToProducts((list) => {
      setAllProducts(list);
    });

    // If cache was empty on mount, also try a direct Firestore query as fallback
    if (getCachedProducts().length === 0) {
      setLoading(true);
      const q = query(
        collection(db, 'products'),
        where('category', 'in', targetCategories.slice(0, 30))
      );
      getDocs(q)
        .then(snap => {
          const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          setAllProducts(prev => {
            // Merge without duplicates
            const ids = new Set(prev.map(p => p.id));
            return [...prev, ...list.filter(p => !ids.has(p.id))];
          });
        })
        .catch(err => console.error('Category fallback fetch:', err.message))
        .finally(() => setLoading(false));
    }

    return unsub;
  }, [categoryId]); // eslint-disable-line react-hooks/exhaustive-deps


  return (
    <div className="min-h-screen bg-slate-50 pb-20 pt-10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* Breadcrumb */}
        <nav className="flex text-sm text-slate-500 mb-8" aria-label="Breadcrumb">
          <ol className="inline-flex items-center space-x-1 md:space-x-3">
            <li className="inline-flex items-center">
              <Link to="/" className="hover:text-primary-600 transition-colors">Home</Link>
            </li>
            <li>
              <div className="flex items-center">
                <ChevronRight className="w-4 h-4 mx-1" />
                <span className="text-slate-900 font-medium">{categoryInfo.name}</span>
              </div>
            </li>
          </ol>
        </nav>

        <div className="mb-10">
          <h1 className="text-3xl font-bold text-slate-900 capitalize">{categoryInfo.name} Products</h1>
          <p className="text-slate-500 mt-2">Showing {products.length} results for {categoryInfo.name}</p>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
          </div>
        ) : products.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-2xl border border-slate-100 shadow-sm">
            <ShoppingCart className="mx-auto h-12 w-12 text-slate-300 mb-4" />
            <h3 className="text-lg font-medium text-slate-900">No products found</h3>
            <p className="text-slate-500">We couldn't find any products in this category.</p>
            <Link to="/" className="mt-6 inline-block btn btn-primary px-6 py-2">
              Continue Shopping
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {products.map((product) => (
              <motion.div
                key={product.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden group hover:shadow-md transition-shadow flex flex-col"
              >
                <Link to={`/product/${product.id}`} className="relative h-56 overflow-hidden bg-slate-100 flex items-center justify-center block cursor-pointer">
                  <ImageWithFallback 
                    src={product.images && product.images.length > 0 ? product.images[0] : null}
                    alt={product.name}
                    className={`w-full h-full object-contain p-4 transition-transform duration-500 ${product.stock_quantity === 0 ? 'opacity-50 grayscale' : 'group-hover:scale-105'}`}
                  />
                  {product.stock_quantity === 0 && (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/40 backdrop-blur-[2px]">
                      <span className="bg-slate-900 text-white text-sm font-bold px-4 py-2 rounded-full shadow-lg">
                        Out of Stock
                      </span>
                    </div>
                  )}
                </Link>
                
                <div className="p-5 flex-grow flex flex-col justify-between">
                  <div>
                    <Link to={`/product/${product.id}`} className="hover:text-primary-600 transition-colors">
                      <h3 className="text-base font-bold text-slate-900 line-clamp-2 mb-1" title={product.name}>{product.name}</h3>
                    </Link>
                    
                    <div className="flex items-center gap-1 mb-3">
                      <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                      <span className="text-sm font-medium text-slate-700">4.5</span>
                      <span className="text-xs text-slate-400">(128)</span>
                    </div>

                    <div className="text-xl font-bold text-primary-600">₹{Number(product.price).toFixed(2)}</div>
                  </div>
                  
                  <button 
                    onClick={() => addToCart(product)}
                    disabled={product.stock_quantity === 0}
                    className={`w-full mt-4 btn btn-secondary hover:bg-primary-50 hover:text-primary-700 hover:border-primary-200 group/btn disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <ShoppingCart className="h-4 w-4 mr-2 text-slate-400 group-hover/btn:text-primary-600 transition-colors" />
                    Add to Cart
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
