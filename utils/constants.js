// ── Booking domain constants ──────────────────────────────────────────────

export const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed'];
export const PAYMENT_STATUSES = ['unpaid', 'paid', 'refunded'];

// Only these statuses reserve equipment inventory.
export const INVENTORY_BLOCKING_STATUSES = ['pending', 'confirmed'];

// A pending booking reserves stock only for a short window. If the renter
// never confirms/pays, the hold expires so the equipment is not blocked
// forever. Confirmed bookings always reserve stock.
const configuredHoldMinutes = Number.parseInt(
  process.env.PENDING_BOOKING_HOLD_MINUTES ?? '30',
  10,
);
export const PENDING_HOLD_MINUTES =
  Number.isFinite(configuredHoldMinutes) && configuredHoldMinutes >= 0
    ? configuredHoldMinutes
    : 30;

// Allowed owner-driven status transitions.
export const ALLOWED_BOOKING_TRANSITIONS = {
  pending: ['confirmed', 'cancelled', 'completed'],
  confirmed: ['completed', 'cancelled'],
  cancelled: [],
  completed: [],
};
