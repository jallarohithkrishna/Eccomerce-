import { useState, useEffect } from 'react';
import { db } from '../../lib/firebase';
import { collection, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { Plus, Pencil, Trash2, Image as ImageIcon, ShieldCheck } from 'lucide-react';
import { useOutletContext } from 'react-router-dom';
import { resolvePolicyForCategory } from '../../constants/returnPolicies';
import { subscribeToProducts } from '../../lib/productCache';

export default function AdminProducts() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [editingId, setEditingId] = useState(null);

  // Register openAddModal with the voice assistant ref
  const outletContext = useOutletContext();
  useEffect(() => {
    if (outletContext?.addProductTriggerRef) {
      outletContext.addProductTriggerRef.current = openAddModal;
    }
    return () => {
      if (outletContext?.addProductTriggerRef) {
        outletContext.addProductTriggerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outletContext]);
  
  const [formData, setFormData] = useState({
    name: '',
    category: '',
    price: '',
    stock_quantity: '',
    description: ''
  });
  const [imageUrl, setImageUrl] = useState('');

  useEffect(() => {
    // Subscribe to shared real-time product cache
    const unsubscribe = subscribeToProducts((productsList) => {
      setProducts(productsList);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);


  function openAddModal() {
    setFormData({ name: '', category: '', price: '', stock_quantity: '', description: '' });
    setImageUrl('');
    setEditingId(null);
    setShowModal(true);
  }

  function openEditModal(product) {
    setFormData({
      name: product.name,
      category: product.category || '',
      price: product.price,
      stock_quantity: product.stock_quantity,
      description: product.description || ''
    });
    setEditingId(product.id);
    setImageUrl(product.images && product.images.length > 0 ? product.images[0] : '');
    setShowModal(true);
  }

  async function handleDelete(id) {
    if (!window.confirm('Are you sure you want to delete this product? This action cannot be undone.')) {
      return;
    }
    
    try {
      await deleteDoc(doc(db, 'products', id));
      // Local state is updated automatically via onSnapshot
    } catch (error) {
      alert('Error deleting product: ' + error.message);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setUploading(true);
    
    try {
      let imageUrls = [];

      // Use the provided Image URL instead of uploading to Firebase Storage
      if (imageUrl.trim() !== '') {
        imageUrls = [imageUrl.trim()];
      }

      // 2. Prepare Data
      const productData = {
        name: formData.name,
        category: formData.category,
        price: parseFloat(formData.price),
        stock_quantity: parseInt(formData.stock_quantity, 10),
        description: formData.description,
        return_policy: resolvePolicyForCategory(formData.category),
        policy_updated_at: new Date().toISOString()
      };

      // Only update images if a new one was uploaded
      if (imageUrls.length > 0) {
        productData.images = imageUrls;
      }

      // 3. Save Product to Firestore
      if (editingId) {
        // Update existing document
        const productRef = doc(db, 'products', editingId);
        await updateDoc(productRef, productData);
      } else {
        // Add new document
        productData.created_at = serverTimestamp();
        await addDoc(collection(db, 'products'), productData);
      }
      
      setShowModal(false);
    } catch (error) {
      alert('Error saving product: ' + error.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Products</h1>
          <p className="text-slate-500">Manage your product catalog</p>
        </div>
        <button 
          onClick={openAddModal}
          className="btn btn-primary"
        >
          <Plus className="h-5 w-5 mr-2" /> Add Product
        </button>
      </div>

      <div className="glass-panel rounded-xl overflow-hidden border border-slate-200">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[600px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="px-6 py-4 text-sm font-medium text-slate-500 whitespace-nowrap">Image</th>
                <th className="px-6 py-4 text-sm font-medium text-slate-500 whitespace-nowrap">Name</th>
                <th className="px-6 py-4 text-sm font-medium text-slate-500 whitespace-nowrap">Category</th>
                <th className="px-6 py-4 text-sm font-medium text-slate-500 whitespace-nowrap">Return Policy</th>
                <th className="px-6 py-4 text-sm font-medium text-slate-500 whitespace-nowrap">Price</th>
                <th className="px-6 py-4 text-sm font-medium text-slate-500 whitespace-nowrap">Stock</th>
                <th className="px-6 py-4 text-sm font-medium text-slate-500 whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="7" className="px-6 py-8 text-center text-slate-500">Loading products...</td>
                </tr>
              ) : products.length === 0 ? (
                <tr>
                  <td colSpan="7" className="px-6 py-8 text-center text-slate-500">No products found. Add your first product!</td>
                </tr>
              ) : (
                products.map((product) => {
                  const policy = product.return_policy || resolvePolicyForCategory(product.category);
                  return (
                    <tr key={product.id} className="hover:bg-slate-50">
                      <td className="px-6 py-4">
                        {product.images && product.images.length > 0 ? (
                          <img src={product.images[0]} alt={product.name} className="h-10 w-10 rounded-md object-cover" />
                        ) : (
                          <div className="h-10 w-10 bg-slate-100 rounded-md flex items-center justify-center text-slate-400">
                            <ImageIcon className="h-5 w-5" />
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 font-medium text-slate-900 whitespace-nowrap max-w-[200px] truncate" title={product.name}>{product.name}</td>
                      <td className="px-6 py-4 text-slate-500 whitespace-nowrap text-xs">
                        <span className="bg-slate-100 px-2 py-1 rounded-md">{product.category || 'General'}</span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${policy.badgeColor || 'bg-slate-100 text-slate-700 border-slate-200'}`}>
                          <ShieldCheck className="w-3.5 h-3.5" />
                          {policy.badge || (policy.eligible ? `${policy.window_days}D Return` : 'Non-Returnable')}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-slate-600 whitespace-nowrap">₹{Number(product.price).toFixed(2)}</td>
                      <td className="px-6 py-4 text-slate-600">{product.stock_quantity}</td>
                      <td className="px-6 py-4 flex items-center space-x-3">
                        <button 
                          onClick={() => openEditModal(product)}
                          className="text-slate-400 hover:text-primary-600 transition-colors"
                          title="Edit Product"
                        >
                          <Pencil className="h-5 w-5" />
                        </button>
                        <button 
                          onClick={() => handleDelete(product.id)}
                          className="text-slate-400 hover:text-red-500 transition-colors"
                          title="Delete Product"
                        >
                          <Trash2 className="h-5 w-5" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add/Edit Product Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-xl">
            <h2 className="text-xl font-bold text-slate-900 mb-6">
              {editingId ? 'Edit Product' : 'Add New Product'}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              
              {/* Image URL Input */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Product Image URL (e.g. from Unsplash)
                </label>
                <input 
                  type="url" 
                  placeholder="https://images.unsplash.com/..."
                  value={imageUrl}
                  onChange={e => setImageUrl(e.target.value)}
                  className="input"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Product Name</label>
                <input 
                  type="text" 
                  required
                  className="input" 
                  value={formData.name}
                  onChange={e => setFormData({...formData, name: e.target.value})}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Category (e.g. Electronics)</label>
                <input 
                  type="text" 
                  className="input" 
                  value={formData.category}
                  onChange={e => setFormData({...formData, category: e.target.value})}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Price (₹)</label>
                  <input 
                    type="number" 
                    step="0.01" 
                    required
                    className="input" 
                    value={formData.price}
                    onChange={e => setFormData({...formData, price: e.target.value})}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Stock</label>
                  <input 
                    type="number" 
                    required
                    className="input" 
                    value={formData.stock_quantity}
                    onChange={e => setFormData({...formData, stock_quantity: e.target.value})}
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
                <textarea 
                  rows="3" 
                  className="input h-auto py-3"
                  value={formData.description}
                  onChange={e => setFormData({...formData, description: e.target.value})}
                ></textarea>
              </div>

              {/* Dynamic Policy Preview */}
              {(() => {
                const pol = resolvePolicyForCategory(formData.category);
                return (
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 text-xs space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-700 flex items-center gap-1.5">
                        <ShieldCheck className="w-4 h-4 text-primary-600" />
                        Assigned Return Policy:
                      </span>
                      <span className={`px-2 py-0.5 rounded-full font-medium border ${pol.badgeColor}`}>
                        {pol.badge}
                      </span>
                    </div>
                    <p className="text-slate-600">{pol.title}</p>
                    <p className="text-slate-400 text-[11px]">{pol.description}</p>
                  </div>
                );
              })()}

              <div className="flex justify-end space-x-3 mt-8">
                <button 
                  type="button" 
                  onClick={() => setShowModal(false)}
                  className="btn btn-secondary"
                  disabled={uploading}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={uploading}>
                  {uploading ? 'Saving...' : (editingId ? 'Update Product' : 'Save Product')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
