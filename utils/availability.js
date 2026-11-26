import { getDB } from '../config/db.js';
import {
  INVENTORY_BLOCKING_STATUSES,
  PENDING_HOLD_MINUTES,
  BOOKING_STATUS,
} from './constants.js';
import { toObjectId } from './validation.js';

export function getBookingsCollection() {
  return getDB().collection('bookings');
}

/**
 * Build the query for bookings that reserve inventory over a date range.
 *
 * - Confirmed bookings always reserve stock.
 * - Paid pending bookings reserve stock until the owner acts or the 24-hour
 *   confirmation deadline triggers a refund.
 * - Unpaid pending bookings reserve stock only inside the short hold window.
 * - Cancelled and completed bookings never reserve stock.
 *
 * The range uses half-open overlap: existing.start < requestedEnd &&
 * existing.end > requestedStart.
 */
export function buildBlockingBookingsFilter({
  equipmentId,
  startDate,
  endDate,
  excludeBookingId,
  now = new Date(),
}) {
  const holdCutoff = new Date(now.getTime() - PENDING_HOLD_MINUTES * 60 * 1000);

  const filter = {
    equipmentId: toObjectId(equipmentId),
    bookingStatus: { $in: INVENTORY_BLOCKING_STATUSES },
    startDate: { $lt: endDate },
    endDate: { $gt: startDate },
    $or: [
      { bookingStatus: BOOKING_STATUS.CONFIRMED },
      { bookingStatus: BOOKING_STATUS.PENDING, paymentStatus: 'paid' },
      {
        bookingStatus: BOOKING_STATUS.PENDING,
        createdAt: { $gte: holdCutoff },
        $or: [
          { paymentStatus: 'unpaid' },
          { paymentStatus: { $exists: false } },
        ],
      },
    ],
  };

  // Needed when re-validating an existing pending booking on confirmation.
  if (excludeBookingId) {
    filter._id = { $ne: toObjectId(excludeBookingId) };
  }

  return filter;
}

export async function getBlockedQuantity(options) {
  const bookings = await getBookingsCollection()
    .find(buildBlockingBookingsFilter(options), { projection: { quantity: 1 } })
    .toArray();

  return bookings.reduce(
    (total, booking) =>
      total + (Number.isFinite(booking.quantity) ? booking.quantity : 0),
    0,
  );
}

/**
 * Return true availability for an equipment item over the requested range.
 * `equipment` is the live database document (source of truth for stock/price).
 */
export async function getDateAvailability({ equipment, startDate, endDate, excludeBookingId }) {
  const markedUnavailable = equipment.availability === false;
  const blockedQuantity = markedUnavailable
    ? 0
    : await getBlockedQuantity({
        equipmentId: equipment._id,
        startDate,
        endDate,
        excludeBookingId,
      });

  const stock = Number.isInteger(equipment.quantity) && equipment.quantity > 0
    ? equipment.quantity
    : 0;
  const availableQuantity = markedUnavailable
    ? 0
    : Math.max(0, stock - blockedQuantity);

  return {
    stock,
    blockedQuantity,
    availableQuantity,
    isAvailable: availableQuantity > 0,
  };
}
