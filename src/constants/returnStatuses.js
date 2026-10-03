/**
 * Canonical 10-Stage Return Pipeline Statuses & Metadata
 * 
 * Pipeline:
 * REQUESTED → VERIFYING → ELIGIBILITY_CHECK → APPROVED → PICKUP_SCHEDULED → 
 * IN_TRANSIT → RECEIVED → INSPECTION → REFUND_PROCESSING → COMPLETED
 * 
 * Exception State:
 * HUMAN_REVIEW (sent to staff for exception handling)
 */

export const RETURN_PIPELINE = [
  'REQUESTED',
  'VERIFYING',
  'ELIGIBILITY_CHECK',
  'APPROVED',
  'PICKUP_SCHEDULED',
  'IN_TRANSIT',
  'RECEIVED',
  'INSPECTION',
  'REFUND_PROCESSING',
  'COMPLETED'
];

export const RETURN_STATUS_DETAILS = {
  REQUESTED: {
    key: 'REQUESTED',
    step: 1,
    label: 'Return Requested',
    shortLabel: 'Requested',
    description: 'Customer submitted return request via AI Return Assistant',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200',
    dotClass: 'bg-blue-500',
    icon: 'FileText'
  },
  VERIFYING: {
    key: 'VERIFYING',
    step: 2,
    label: 'Verifying Order & Delivery',
    shortLabel: 'Verifying',
    description: 'AI Agent is verifying order number, delivery date, and authentic item data',
    badgeClass: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    dotClass: 'bg-indigo-500',
    icon: 'Search'
  },
  ELIGIBILITY_CHECK: {
    key: 'ELIGIBILITY_CHECK',
    step: 3,
    label: 'Eligibility & Policy Evaluation',
    shortLabel: 'Policy Check',
    description: 'Evaluating category policy window, damage condition, and item returnability',
    badgeClass: 'bg-violet-50 text-violet-700 border-violet-200',
    dotClass: 'bg-violet-500',
    icon: 'ShieldCheck'
  },
  APPROVED: {
    key: 'APPROVED',
    step: 4,
    label: 'Approved by AI Agent',
    shortLabel: 'Approved',
    description: 'Autonomous AI Policy approval granted with unique RMA code issued',
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dotClass: 'bg-emerald-500',
    icon: 'CheckCircle2'
  },
  PICKUP_SCHEDULED: {
    key: 'PICKUP_SCHEDULED',
    step: 5,
    label: 'Reverse Pickup Scheduled',
    shortLabel: 'Pickup Booked',
    description: 'Reverse courier pickup slot booked with BlueDart Express courier pass',
    badgeClass: 'bg-cyan-50 text-cyan-700 border-cyan-200',
    dotClass: 'bg-cyan-500',
    icon: 'Truck'
  },
  IN_TRANSIT: {
    key: 'IN_TRANSIT',
    step: 6,
    label: 'In Transit to Warehouse',
    shortLabel: 'In Transit',
    description: 'Package picked up by courier and in transit to central fulfillment center',
    badgeClass: 'bg-amber-50 text-amber-700 border-amber-200',
    dotClass: 'bg-amber-500',
    icon: 'Package'
  },
  RECEIVED: {
    key: 'RECEIVED',
    step: 7,
    label: 'Package Received at Hub',
    shortLabel: 'Received',
    description: 'Package delivered to central warehouse receiving dock and scanned',
    badgeClass: 'bg-orange-50 text-orange-700 border-orange-200',
    dotClass: 'bg-orange-500',
    icon: 'Warehouse'
  },
  INSPECTION: {
    key: 'INSPECTION',
    step: 8,
    label: 'Quality & Serial Inspection',
    shortLabel: 'Inspection',
    description: 'Central inspection team verifying product condition, tags, and serial matching',
    badgeClass: 'bg-purple-50 text-purple-700 border-purple-200',
    dotClass: 'bg-purple-500',
    icon: 'ClipboardCheck'
  },
  REFUND_PROCESSING: {
    key: 'REFUND_PROCESSING',
    step: 9,
    label: 'Refund / Exchange Processing',
    shortLabel: 'Processing Refund',
    description: 'Payment gateway or store credit wallet transfer in progress',
    badgeClass: 'bg-rose-50 text-rose-700 border-rose-200',
    dotClass: 'bg-rose-500',
    icon: 'CreditCard'
  },
  COMPLETED: {
    key: 'COMPLETED',
    step: 10,
    label: 'Return Completed & Settled',
    shortLabel: 'Completed',
    description: 'Refund credited to customer or replacement unit delivered successfully',
    badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-300',
    dotClass: 'bg-emerald-600',
    icon: 'CheckCheck'
  },
  HUMAN_REVIEW: {
    key: 'HUMAN_REVIEW',
    step: 0,
    label: 'Escalated to Human Review',
    shortLabel: 'Human Review',
    description: 'Exception flagged by AI Agent — assigned to specialist agent for manual review',
    badgeClass: 'bg-amber-100 text-amber-800 border-amber-300',
    dotClass: 'bg-amber-500',
    icon: 'AlertTriangle'
  },
  REJECTED: {
    key: 'REJECTED',
    step: 0,
    label: 'Return Request Declined',
    shortLabel: 'Declined',
    description: 'Return request rejected under non-returnable policy or warranty violation',
    badgeClass: 'bg-red-50 text-red-700 border-red-200',
    dotClass: 'bg-red-500',
    icon: 'XCircle'
  }
};

export function normalizeReturnStatus(status) {
  if (!status) return 'REQUESTED';
  const upper = String(status).toUpperCase().replace(/[\s-]/g, '_');
  
  if (RETURN_STATUS_DETAILS[upper]) return upper;
  
  // Legacy status mappings
  if (upper === 'APPROVED_BY_AI' || upper === 'APPROVED') return 'APPROVED';
  if (upper === 'PICKUP' || upper === 'SCHEDULED' || upper === 'PICKUP_SCHEDULED') return 'PICKUP_SCHEDULED';
  if (upper === 'IN_TRANSIT') return 'IN_TRANSIT';
  if (upper === 'RECEIVED') return 'RECEIVED';
  if (upper === 'INSPECTED' || upper === 'INSPECTION_PASSED' || upper === 'INSPECTION') return 'INSPECTION';
  if (upper === 'REFUND_PROCESSING') return 'REFUND_PROCESSING';
  if (upper === 'REFUNDED' || upper === 'REPLACED' || upper === 'COMPLETED') return 'COMPLETED';
  if (upper === 'PENDING') return 'VERIFYING';
  if (upper === 'EXCEPTION' || upper === 'MANUAL_REVIEW') return 'HUMAN_REVIEW';

  return 'REQUESTED';
}

export function buildInitialTimeline({ rmaCode, pickupSlot, nowIso = new Date().toISOString() }) {
  return [
    {
      status: 'REQUESTED',
      title: 'Return Requested',
      description: 'Submitted via AI Return Assistant',
      timestamp: nowIso,
      done: true
    },
    {
      status: 'VERIFYING',
      title: 'Order & Delivery Verified',
      description: 'Order authenticity and delivery date confirmed by AI Agent',
      timestamp: nowIso,
      done: true
    },
    {
      status: 'ELIGIBILITY_CHECK',
      title: 'Policy Eligibility Passed',
      description: 'Verified within category policy window',
      timestamp: nowIso,
      done: true
    },
    {
      status: 'APPROVED',
      title: 'Approved by AI Policy Agent',
      description: `RMA ${rmaCode} authorized autonomously`,
      timestamp: nowIso,
      done: true
    },
    {
      status: 'PICKUP_SCHEDULED',
      title: 'Reverse Pickup Scheduled',
      description: pickupSlot || 'Tomorrow (10 AM - 1 PM)',
      timestamp: nowIso,
      done: true
    },
    {
      status: 'IN_TRANSIT',
      title: 'In Transit to Warehouse',
      description: 'Pending courier collection',
      timestamp: 'Pending',
      done: false
    },
    {
      status: 'RECEIVED',
      title: 'Warehouse Intake Hub',
      description: 'Estimated within 2 business days',
      timestamp: 'Estimated in 2 days',
      done: false
    },
    {
      status: 'INSPECTION',
      title: 'Quality & Serial Inspection',
      description: 'Physical condition and tag verification',
      timestamp: 'Pending receipt',
      done: false
    },
    {
      status: 'REFUND_PROCESSING',
      title: 'Refund / Exchange Processing',
      description: 'Financial settlement via original payment / store credit',
      timestamp: 'Pending inspection',
      done: false
    },
    {
      status: 'COMPLETED',
      title: 'Return Completed',
      description: 'Settlement finalized',
      timestamp: 'Estimated upon inspection',
      done: false
    }
  ];
}
