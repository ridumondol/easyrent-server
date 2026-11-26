// ── Booking domain constants ──────────────────────────────────────────────

export const BOOKING_STATUS = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
});
export const BOOKING_STATUSES = Object.freeze(Object.values(BOOKING_STATUS));
export const BOOKING_STATUS_VALIDATION_MESSAGE =
  `bookingStatus must be one of: ${BOOKING_STATUSES.join(', ')}.`;
export const PAYMENT_STATUSES = ['unpaid', 'paid', 'refunded'];

// Only these statuses reserve equipment inventory.
export const INVENTORY_BLOCKING_STATUSES = [BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED];

// Unpaid pending bookings reserve stock only for a short window. Paid pending
// bookings remain reserved until the owner acts or the confirmation deadline.
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
  [BOOKING_STATUS.PENDING]: [
    BOOKING_STATUS.CONFIRMED,
    BOOKING_STATUS.CANCELLED,
    BOOKING_STATUS.COMPLETED,
  ],
  [BOOKING_STATUS.CONFIRMED]: [BOOKING_STATUS.COMPLETED, BOOKING_STATUS.CANCELLED],
  [BOOKING_STATUS.CANCELLED]: [],
  [BOOKING_STATUS.COMPLETED]: [],
};
