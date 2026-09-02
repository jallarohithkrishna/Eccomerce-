import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { doc, getDoc, collection, query, orderBy, getDocs, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';
import { ShoppingCart, Star, ArrowLeft, Image as ImageIcon, Send } from 'lucide-react';
import { getProductById, subscribeToProducts } from '../lib/productCache';

export default function ProductDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { addToCart } = useCart();
  const { user } = useAuth();

  // Seed from cache immediately — zero wait if user came from home page
  const [product, setProduct] = useState(() => getProductById(id));
  const [reviews, setReviews] = useState([]);
  // Only show loading if product isn't already in cache
  const [loading, setLoading] = useState(() => !getProductById(id));

  const [reviewRating, setReviewRating] = useState(5);
  const [reviewText, setReviewText] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);

  useEffect(() => {
    window.scrollTo(0, 0);
    let cancelled = false;

    async function fetchData() {
      // If we already have the product from cache, skip the product fetch
      let currentProduct = getProductById(id);

      if (!currentProduct) {
        // Not in cache yet — fetch directly from Firestore
        try {
          const productRef = doc(db, 'products', id);
          const productSnap = await getDoc(productRef);
          if (!cancelled) {
            if (productSnap.exists()) {
              currentProduct = { id: productSnap.id, ...productSnap.data() };
              setProduct(currentProduct);
            } else {
              setProduct(null);
            }
          }
        } catch (error) {
          console.error('Error fetching product:', error);
        } finally {
          if (!cancelled) setLoading(false);
        }
      } else {
        // Already have product — immediately mark loading done
        setLoading(false);
      }

      // Always fetch reviews (independent of product cache)
      let reviewsList = [];
      try {
        const reviewsRef = collection(db, 'products', id, 'reviews');
        const q = query(reviewsRef, orderBy('created_at', 'desc'));
        const reviewsSnap = await getDocs(q);
        reviewsList = reviewsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      } catch {
        console.warn('Could not fetch reviews from Firebase, relying on local storage.');
      }

      // Merge with local reviews
      const localReviews = JSON.parse(localStorage.getItem(`reviews_${id}`)) || [];
      const combined = [...localReviews, ...reviewsList];
      const unique = Array.from(new Map(combined.map(item => [item.id, item])).values());
      unique.sort((a, b) => {
        const timeA = a.created_at?.toDate ? a.created_at.toDate().getTime() : new Date(a.created_at).getTime();
        const timeB = b.created_at?.toDate ? b.created_at.toDate().getTime() : new Date(b.created_at).getTime();
        return timeB - timeA;
      });

      if (!cancelled) setReviews(unique);
    }

    fetchData();

    // Also keep product in sync if cache updates (e.g. stock changes)
    const unsub = subscribeToProducts(() => {
      const updated = getProductById(id);
      if (updated && !cancelled) setProduct(updated);
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [id]);

  const handleAddReview = async (e) => {
    e.preventDefault();
    if (!user) {
      navigate('/login');
      return;
    }

    if (!reviewText.trim()) return;

    setSubmittingReview(true);

    const newReview = {
      id: Date.now().toString(),
      user_id: user.uid,
      user_name: user.user_metadata?.full_name || 'Anonymous User',
      rating: reviewRating,
      text: reviewText.trim(),
      created_at: new Date().toISOString()
    };

    // Save to local storage
    const localReviews = JSON.parse(localStorage.getItem(`reviews_${id}`)) || [];
    localStorage.setItem(`reviews_${id}`, JSON.stringify([newReview, ...localReviews]));

    // Optimistically update UI
    setReviews([newReview, ...reviews]);
    setReviewText('');
    setReviewRating(5);

    try {
      const reviewsRef = collection(db, 'products', id, 'reviews');
      await addDoc(reviewsRef, {
        ...newReview,
        created_at: serverTimestamp()
      });
    } catch (error) {
      console.error('Error saving review to database:', error);
    } finally {
      setSubmittingReview(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden mb-12 animate-pulse">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-0">
              <div className="bg-slate-100 aspect-square md:aspect-auto md:min-h-96" />
              <div className="p-8 md:p-12 space-y-4">
                <div className="h-6 bg-slate-100 rounded w-1/4" />
                <div className="h-10 bg-slate-100 rounded w-3/4" />
                <div className="h-8 bg-slate-100 rounded w-1/3" />
                <div className="h-24 bg-slate-100 rounded" />
                <div className="h-14 bg-slate-100 rounded mt-8" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50">
        <h2 className="text-2xl font-bold text-slate-800 mb-4">Product not found</h2>
        <Link to="/" className="text-primary-600 hover:underline">Return to Home</Link>
      </div>
    );
  }

  const avgRating = reviews.length > 0
    ? (reviews.reduce((acc, curr) => acc + curr.rating, 0) / reviews.length).toFixed(1)
    : 0;

  return (
    <div className="min-h-screen bg-slate-50 py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">

        {/* Back button */}
        <Link to="/" className="inline-flex items-center text-slate-500 hover:text-primary-600 transition-colors mb-8">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to products
        </Link>

        {/* Product Details Section */}
        <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden mb-12">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-0">
            {/* Image Gallery */}
            <div className="bg-slate-100 aspect-square md:aspect-auto md:h-full relative flex items-center justify-center p-4 sm:p-8">
              {product.images && product.images.length > 0 ? (
                <img
                  src={product.images[0]}
                  alt={product.name}
                  className={`w-full h-full object-contain ${product.stock_quantity === 0 ? 'opacity-50 grayscale' : ''}`}
                  onError={(e) => { e.target.onerror = null; e.target.src = 'https://placehold.co/400x400/png?text=Image+Not+Found'; }}
                />
              ) : (
                <ImageIcon className="h-32 w-32 text-slate-300" />
              )}

              {product.stock_quantity === 0 && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/40 backdrop-blur-[2px]">
                  <span className="bg-slate-900 text-white text-lg font-bold px-6 py-3 rounded-full shadow-lg">
                    Out of Stock
                  </span>
                </div>
              )}
            </div>

            {/* Product Info */}
            <div className="p-6 sm:p-8 md:p-12 flex flex-col justify-center">
              {product.category && (
                <span className="inline-block bg-primary-50 text-primary-700 text-sm font-bold px-3 py-1 rounded-full mb-4 w-fit">
                  {product.category}
                </span>
              )}

              <h1 className="text-2xl md:text-4xl font-extrabold text-slate-900 mb-4">{product.name}</h1>

              <div className="flex items-center gap-4 mb-6">
                <span className="text-3xl font-bold text-primary-600">₹{Number(product.price).toFixed(2)}</span>

                {/* Rating display */}
                <div className="flex items-center gap-1 bg-yellow-50 px-2 py-1 rounded-lg">
                  <Star className="w-5 h-5 text-yellow-500 fill-current" />
                  <span className="font-bold text-yellow-700">{avgRating > 0 ? avgRating : 'New'}</span>
                  <span className="text-xs text-yellow-600 ml-1">({reviews.length} reviews)</span>
                </div>
              </div>

              <div className="prose prose-slate mb-8">
                <p className="text-slate-600 leading-relaxed text-lg">
                  {product.description || 'No description available for this product.'}
                </p>
              </div>

              {/* Stock Status */}
              <div className="mb-8">
                {product.stock_quantity > 5 && (
                  <p className="text-green-600 font-medium flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500"></span> In Stock
                  </p>
                )}
                {product.stock_quantity > 0 && product.stock_quantity <= 5 && (
                  <p className="text-red-500 font-bold flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span> Only {product.stock_quantity} left in stock - order soon!
                  </p>
                )}
                {product.stock_quantity === 0 && (
                  <p className="text-slate-500 font-medium flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-slate-300"></span> Currently unavailable
                  </p>
                )}
              </div>

              <button
                onClick={() => addToCart(product)}
                disabled={product.stock_quantity === 0}
                className="w-full md:w-auto px-8 py-4 btn btn-primary text-lg flex items-center justify-center gap-2 shadow-xl shadow-primary-600/20 hover:shadow-primary-600/40 transition-all disabled:opacity-50 disabled:shadow-none"
              >
                <ShoppingCart className="w-6 h-6" />
                {product.stock_quantity === 0 ? 'Out of Stock' : 'Add to Cart'}
              </button>
            </div>
          </div>
        </div>

        {/* Reviews Section */}
        <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6 sm:p-8 md:p-12">
          <h2 className="text-2xl font-bold text-slate-900 mb-8 flex items-center gap-3">
            Customer Reviews
            <span className="bg-slate-100 text-slate-600 text-sm py-1 px-3 rounded-full">{reviews.length}</span>
          </h2>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">

            {/* Write a Review Form */}
            <div className="lg:col-span-1">
              <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100">
                <h3 className="font-bold text-slate-900 mb-4">Write a Review</h3>
                {user ? (
                  <form onSubmit={handleAddReview} className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">Rating</label>
                      <div className="flex gap-2">
                        {[1, 2, 3, 4, 5].map((star) => (
                          <button
                            key={star}
                            type="button"
                            onClick={() => setReviewRating(star)}
                            className="focus:outline-none"
                          >
                            <Star className={`w-8 h-8 ${reviewRating >= star ? 'text-yellow-400 fill-current' : 'text-slate-300'}`} />
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">Your Review</label>
                      <textarea
                        rows="4"
                        value={reviewText}
                        onChange={(e) => setReviewText(e.target.value)}
                        placeholder="What did you think about this product?"
                        className="w-full rounded-xl border-slate-200 focus:border-primary-500 focus:ring-primary-500 resize-none"
                        required
                      ></textarea>
                    </div>
                    <button
                      type="submit"
                      disabled={submittingReview || !reviewText.trim()}
                      className="w-full btn btn-primary flex items-center justify-center gap-2"
                    >
                      {submittingReview ? 'Submitting...' : (
                        <>
                          <Send className="w-4 h-4" /> Submit Review
                        </>
                      )}
                    </button>
                  </form>
                ) : (
                  <div className="text-center py-6">
                    <p className="text-slate-500 mb-4">Please sign in to write a review.</p>
                    <Link to="/login" className="btn btn-secondary w-full">Sign In</Link>
                  </div>
                )}
              </div>
            </div>

            {/* Reviews List */}
            <div className="lg:col-span-2 space-y-6">
              {reviews.length === 0 ? (
                <div className="text-center py-12 border-2 border-dashed border-slate-100 rounded-2xl">
                  <Star className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                  <p className="text-slate-500 font-medium">No reviews yet.</p>
                  <p className="text-slate-400 text-sm">Be the first to review this product!</p>
                </div>
              ) : (
                reviews.map((review) => (
                  <div key={review.id} className="border-b border-slate-100 pb-6 last:border-0 last:pb-0">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center font-bold">
                          {review.user_name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-bold text-slate-900">{review.user_name}</p>
                          <p className="text-xs text-slate-400">
                            {review.created_at?.toDate ? new Date(review.created_at.toDate()).toLocaleDateString() : (typeof review.created_at === 'string' ? new Date(review.created_at).toLocaleDateString() : 'Just now')}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center">
                        {[...Array(5)].map((_, i) => (
                          <Star
                            key={i}
                            className={`w-4 h-4 ${i < review.rating ? 'text-yellow-400 fill-current' : 'text-slate-200'}`}
                          />
                        ))}
                      </div>
                    </div>
                    <p className="text-slate-600 leading-relaxed mt-3">{review.text}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
