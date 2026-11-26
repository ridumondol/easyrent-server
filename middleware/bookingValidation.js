import { BOOKING_STATUSES } from '../utils/constants.js';
import { parseRentalDate, calculateTotalDays, todayUtc } from '../utils/rental.js';
import {
  isNonEmptyString,
  isPositiveInteger,
  isValidObjectId,
  toObjectId,
} from '../utils/validation.js';
import { sendError } from '../utils/response.js';

/**
 * Shared date-range validation used by both the create-booking route and the
 * public availability route. Returns a normalized payload or sends a 400.
 */
function validateDateRange(request, response) {
  const { startDate: rawStart, endDate: rawEnd } = request.body ?? {};

  if (!isNonEmptyString(rawStart) || !isNonEmptyString(rawEnd)) {
    sendError(response, {
      statusCode: 400,
      message: 'startDate and endDate are required.',
    });
    return null;
  }

  const startDate = parseRentalDate(rawStart);
  if (!startDate) {
    sendError(response, { statusCode: 400, message: 'Invalid start date.' });
    return null;
  }

  const endDate = parseRentalDate(rawEnd);
  if (!endDate) {
    sendError(response, { statusCode: 400, message: 'Invalid end date.' });
    return null;
  }

  if (startDate.getTime() < todayUtc().getTime()) {
    sendError(response, {
      statusCode: 400,
      message: 'Start date cannot be in the past.',
    });
    return null;
  }

  const totalDays = calculateTotalDays(startDate, endDate);
  if (totalDays < 1) {
    sendError(response, {
      statusCode: 400,
      message: 'End date must be after start date.',
    });
    return null;
  }

  return { startDate, endDate, totalDays };
}

/** POST /api/bookings and GET /api/bookings/availability */
export function validateCreateBooking(request, response, next) {
  const { equipmentId, quantity, phone, address, notes } = request.body ?? {};

  if (!isNonEmptyString(equipmentId) || !isValidObjectId(equipmentId)) {
    return sendError(response, {
      statusCode: 400,
      message: 'Invalid equipment ID.',
    });
  }

  const dates = validateDateRange(request, response);
  if (!dates) return undefined;

  if (!isPositiveInteger(quantity)) {
    return sendError(response, {
      statusCode: 400,
      message: 'Quantity must be a positive integer.',
    });
  }

  if (!isNonEmptyString(phone) || phone.trim().length > 50) {
    return sendError(response, {
      statusCode: 400,
      message: 'A valid phone number is required.',
    });
  }

  if (!isNonEmptyString(address) || address.trim().length > 500) {
    return sendError(response, {
      statusCode: 400,
      message: 'A valid address is required.',
    });
  }

  if (notes !== undefined && notes !== null && notes !== '') {
    if (typeof notes !== 'string' || notes.length > 1000) {
      return sendError(response, {
        statusCode: 400,
        message: 'Notes must be a string of at most 1000 characters.',
      });
    }
  }

  // Only trusted, server-derived values are forwarded to the controller.
  // Client-supplied pricePerDay / totalAmount / status fields are discarded.
  request.bookingInput = {
    equipmentObjectId: toObjectId(equipmentId),
    ...dates,
    quantity,
    phone: phone.trim(),
    address: address.trim(),
    notes: typeof notes === 'string' ? notes.trim() : '',
  };

  return next();
}

/** Availability route does not need contact details. */
export function validateAvailabilityQuery(request, response, next) {
  const { equipmentId, quantity: rawQuantity } = request.query ?? {};

  if (!isNonEmptyString(equipmentId) || !isValidObjectId(equipmentId)) {
    return sendError(response, {
      statusCode: 400,
      message: 'Invalid equipment ID.',
    });
  }

  const dates = validateDateRange({ body: request.query }, response);
  if (!dates) return undefined;

  const quantity = Number(rawQuantity ?? 1);
  if (!isPositiveInteger(quantity)) {
    return sendError(response, {
      statusCode: 400,
      message: 'Quantity must be a positive integer.',
    });
  }

  request.availabilityInput = {
    equipmentObjectId: toObjectId(equipmentId),
    ...dates,
    quantity,
  };

  return next();
}

/** Any route with an :id booking parameter. */
export function validateBookingId(request, response, next) {
  const { id } = request.params;

  if (!isValidObjectId(id)) {
    return sendError(response, { statusCode: 400, message: 'Invalid booking ID.' });
  }

  return next();
}

/** PATCH /api/bookings/:id/status */
export function validateBookingStatusUpdate(request, response, next) {
  const { bookingStatus, paymentStatus } = request.body ?? {};

  if (bookingStatus !== undefined && !BOOKING_STATUSES.includes(bookingStatus)) {
    return sendError(response, {
      statusCode: 400,
      message: `bookingStatus must be one of: ${BOOKING_STATUSES.join(', ')}.`,
    });
  }

  if (paymentStatus !== undefined && !['paid', 'unpaid'].includes(paymentStatus)) {
    return sendError(response, {
      statusCode: 400,
      message: 'paymentStatus must be paid or unpaid.',
    });
  }

  if (bookingStatus === undefined && paymentStatus === undefined) {
    return sendError(response, {
      statusCode: 400,
      message: 'Either bookingStatus or paymentStatus must be provided.',
    });
  }

  return next();
}
