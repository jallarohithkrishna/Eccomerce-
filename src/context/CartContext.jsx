import { createContext, useContext, useState, useEffect } from 'react';
import { useAuth } from './AuthContext';

const CartContext = createContext();

export function CartProvider({ children }) {
  const { user } = useAuth();
  const storageKey = user ? `smartcart_user_${user.uid}_cart` : 'smartcart_guest_cart';

  const [cartItems, setCartItems] = useState(() => {
    // Initialize from local storage if available
    const savedCart = localStorage.getItem(storageKey);
    return savedCart ? JSON.parse(savedCart) : [];
  });
  
  const [isCartOpen, setIsCartOpen] = useState(false);

  // When user changes (login/logout), update cartItems from the new storage key
  useEffect(() => {
    const savedCart = localStorage.getItem(storageKey);
    setCartItems(savedCart ? JSON.parse(savedCart) : []);
  }, [storageKey]);

  // Save to local storage whenever cart changes
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(cartItems));
  }, [cartItems, storageKey]);

  const addToCart = (product) => {
    const currentQuantity = cartItems.find(i => i.id === product.id)?.quantity || 0;
    if (product.stock_quantity !== undefined && currentQuantity >= product.stock_quantity) {
      alert(`Sorry, we only have ${product.stock_quantity} of this item in stock.`);
      return;
    }

    setCartItems((prevItems) => {
      const existingItem = prevItems.find((item) => item.id === product.id);
      if (existingItem) {
        // If product already in cart, increment quantity
        return prevItems.map((item) =>
          item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      // Otherwise, add new product with quantity 1
      return [...prevItems, { ...product, quantity: 1 }];
    });
    // Automatically open the cart sidebar when an item is added
    setIsCartOpen(true);
  };

  const removeFromCart = (productId) => {
    setCartItems((prevItems) => prevItems.filter((item) => item.id !== productId));
  };

  const updateQuantity = (productId, newQuantity) => {
    if (newQuantity < 1) {
      removeFromCart(productId);
      return;
    }

    const item = cartItems.find(i => i.id === productId);
    if (item && item.stock_quantity !== undefined && newQuantity > item.stock_quantity) {
      alert(`Sorry, we only have ${item.stock_quantity} of this item in stock.`);
      return;
    }

    setCartItems((prevItems) =>
      prevItems.map((item) =>
        item.id === productId ? { ...item, quantity: newQuantity } : item
      )
    );
  };

  const clearCart = () => {
    setCartItems([]);
  };

  const cartTotal = cartItems.reduce(
    (total, item) => total + Number(item.price) * item.quantity,
    0
  );

  const cartCount = cartItems.reduce((count, item) => count + item.quantity, 0);

  return (
    <CartContext.Provider
      value={{
        cartItems,
        addToCart,
        removeFromCart,
        updateQuantity,
        clearCart,
        cartTotal,
        cartCount,
        isCartOpen,
        setIsCartOpen,
      }}
    >
      {children}
    </CartContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCart() {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return context;
}
