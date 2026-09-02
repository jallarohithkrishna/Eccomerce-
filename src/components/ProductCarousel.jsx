import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ShoppingCart, Star, Image as ImageIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import { useCart } from '../context/CartContext';

export default function ProductCarousel({ title, subtitle, products, categoryId }) {
  const scrollContainerRef = useRef(null);
  const { addToCart } = useCart();

  const scroll = (direction) => {
    const container = scrollContainerRef.current;
    if (container) {
      const scrollAmount = direction === 'left' ? -container.offsetWidth / 2 : container.offsetWidth / 2;
      container.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  if (!products || products.length === 0) return null;

  return (
    <div className="my-12">
      <div className="flex justify-between items-end mb-6">
        <div>
          <h2 className="text-2xl md:text-3xl font-bold text-slate-900 mb-1">{title}</h2>
          {subtitle && <p className="text-slate-500">{subtitle}</p>}
        </div>
        {categoryId && (
          <Link to={`/category/${categoryId}`} className="text-primary-600 font-medium hover:text-primary-700 transition-colors flex items-center bg-primary-50 px-4 py-2 rounded-full text-sm">
            View All <ChevronRight className="h-4 w-4 ml-1" />
          </Link>
        )}
      </div>

      <div className="relative group/carousel">
        {/* Left Arrow */}
        <button 
          onClick={() => scroll('left')}
          className="absolute left-0 top-1/2 -translate-y-1/2 -ml-4 z-10 bg-white rounded-full p-3 shadow-lg border border-slate-100 text-slate-600 hover:text-primary-600 opacity-0 group-hover/carousel:opacity-100 transition-opacity hidden md:block hover:scale-110"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>

        {/* Scroll Container */}
        <div 
          ref={scrollContainerRef}
          className="flex overflow-x-auto gap-6 pb-6 snap-x snap-mandatory hide-scrollbar -mx-4 px-4 sm:mx-0 sm:px-0"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {products.map((product, index) => (
            <motion.div 
              key={product.id}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, delay: index * 0.05 }}
              className="snap-start shrink-0 w-[240px] sm:w-[280px] bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden group hover:shadow-md transition-shadow flex flex-col"
            >
              <Link to={`/product/${product.id}`} className="relative h-48 overflow-hidden bg-slate-100 flex items-center justify-center block cursor-pointer">
                {product.images && product.images.length > 0 ? (
                  <img 
                    src={product.images[0]} 
                    alt={product.name} 
                    className={`w-full h-full object-contain p-4 transition-transform duration-500 ${product.stock_quantity === 0 ? 'opacity-50 grayscale' : 'group-hover:scale-105'}`}
                    onError={(e) => { e.target.onerror = null; e.target.src = 'https://placehold.co/400x400/png?text=Image+Not+Found'; }}
                  />
                ) : (
                  <ImageIcon className="h-12 w-12 text-slate-300" />
                )}
                {product.stock_quantity === 0 && (
                  <div className="absolute inset-0 flex items-center justify-center bg-white/40 backdrop-blur-[2px]">
                    <span className="bg-slate-900 text-white text-xs font-bold px-3 py-1.5 rounded-full shadow-lg">
                      Out of Stock
                    </span>
                  </div>
                )}
              </Link>
              
              <div className="p-4 flex-grow flex flex-col justify-between">
                <div>
                  <Link to={`/product/${product.id}`} className="hover:text-primary-600 transition-colors">
                    <h3 className="text-base font-bold text-slate-900 line-clamp-1" title={product.name}>{product.name}</h3>
                  </Link>
                  <div className="flex items-center gap-1 my-1">
                    <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                    <span className="text-xs font-medium text-slate-700">4.5</span>
                  </div>
                  <div className="text-lg font-bold text-primary-600 mt-2">₹{Number(product.price).toFixed(2)}</div>
                </div>
                
                <button 
                  onClick={() => addToCart(product)}
                  disabled={product.stock_quantity === 0}
                  className={`w-full mt-4 btn btn-secondary py-2 text-sm hover:bg-primary-50 hover:text-primary-700 hover:border-primary-200 group/btn disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center`}
                >
                  <ShoppingCart className="h-4 w-4 mr-2 text-slate-400 group-hover/btn:text-primary-600 transition-colors" />
                  Add to Cart
                </button>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Right Arrow */}
        <button 
          onClick={() => scroll('right')}
          className="absolute right-0 top-1/2 -translate-y-1/2 -mr-4 z-10 bg-white rounded-full p-3 shadow-lg border border-slate-100 text-slate-600 hover:text-primary-600 opacity-0 group-hover/carousel:opacity-100 transition-opacity hidden md:block hover:scale-110"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      </div>
      <style dangerouslySetInnerHTML={{__html: `
        .hide-scrollbar::-webkit-scrollbar {
          display: none;
        }
      `}} />
    </div>
  );
}
