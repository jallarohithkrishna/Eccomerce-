/**
 * Order & Delivery Verification — PS-01
 * 
 * Verifies that:
 * 1. The order exists and belongs to the requesting user
 * 2. The order is in a "delivered" state
 * 3. delivered_at is set (required for window calculation)
 * 4. The item to be returned is in the order
 * 5. The order hasn't already been fully returned
 *
 * Uses Firebase Admin SDK. No LLM. Pure deterministic checks.
 */

/**
 * @typedef {Object} VerificationResult
 * @property {boolean} verified
 * @property {string}  [failureCode]   - machine-readable reason on failure
 * @property {string}  [failureReason] - human-readable message on failure
 * @property {Object}  [order]         - full order doc if verified
 * @property {Object}  [item]          - matched order item if verified
 * @property {string}  [deliveredAt]   - ISO delivery timestamp
 */

/**
 * Verify an order for return eligibility.
 *
 * @param {Object} params
 * @param {import('firebase-admin/firestore').Firestore} params.db - Admin Firestore instance
 * @param {string} params.orderId    - Firestore order document ID
 * @param {string} params.userId     - Requesting user's UID
 * @param {string} params.productId  - Product ID to be returned
 * @param {number} [params.quantity] - Quantity to return (default 1)
 * @returns {Promise<VerificationResult>}
 */
export async function verifyOrderForReturn({ db, orderId, userId, productId, quantity = 1 }) {
  if (!db)        throw new Error('Firestore db instance is required');
  if (!orderId)   throw new Error('orderId is required');
  if (!userId)    throw new Error('userId is required');
  if (!productId) throw new Error('productId is required');

  let orderDoc;
  try {
    orderDoc = await db.collection('orders').doc(orderId).get();
  } catch (err) {
    return { verified: false, failureCode: 'DB_ERROR', failureReason: `Failed to fetch order: ${err.message}` };
  }

  if (!orderDoc.exists) {
    return { verified: false, failureCode: 'ORDER_NOT_FOUND', failureReason: `Order ${orderId} does not exist.` };
  }

  const order = { id: orderDoc.id, ...orderDoc.data() };

  // Ownership check
  if (order.user_id !== userId && order.userId !== userId) {
    return { verified: false, failureCode: 'UNAUTHORIZED', failureReason: 'Order does not belong to requesting user.' };
  }

  // Delivery status check
  const status = (order.status || '').toLowerCase();
  if (!['delivered', 'completed'].includes(status)) {
    return {
      verified: false,
      failureCode: 'NOT_DELIVERED',
      failureReason: `Order status is "${order.status}". Returns are only accepted for delivered orders.`,
    };
  }

  // delivered_at check
  const deliveredAt = order.delivered_at || order.deliveredAt;
  if (!deliveredAt) {
    return {
      verified: false,
      failureCode: 'MISSING_DELIVERY_DATE',
      failureReason: 'Order delivery date is missing. Cannot calculate return window.',
    };
  }

  // Find item in order
  const items = order.items || order.order_items || [];
  const item = items.find(i => i.product_id === productId || i.productId === productId || i.id === productId);

  if (!item) {
    return {
      verified: false,
      failureCode: 'ITEM_NOT_IN_ORDER',
      failureReason: `Product ${productId} was not found in order ${orderId}.`,
    };
  }

  // Quantity guard
  const orderedQty  = Number(item.quantity) || 1;
  const returnedQty = Number(item.returned_quantity || item.returnedQuantity) || 0;
  const available   = orderedQty - returnedQty;

  if (quantity > available) {
    return {
      verified: false,
      failureCode: 'QUANTITY_EXCEEDED',
      failureReason: `Only ${available} unit(s) available to return (${returnedQty} already returned of ${orderedQty} ordered).`,
    };
  }

  return {
    verified: true,
    order,
    item,
    deliveredAt: typeof deliveredAt === 'string' ? deliveredAt : deliveredAt.toDate().toISOString(),
  };
}
