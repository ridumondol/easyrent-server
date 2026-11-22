import { getDB } from '../config/db.js';
import { sendError, sendSuccess } from '../utils/response.js';
import { BOOKING_STATUSES, ALLOWED_BOOKING_TRANSITIONS } from '../utils/constants.js';
import { calculateRentalAmount, calculateRentalUnits } from '../utils/rental.js';
import {
  getBookingsCollection,
  getDateAvailability,
} from '../utils/availability.js';
import { isPositiveNumber, toObjectId } from '../utils/validation.js';

function getEquipmentCollection() {
  return getDB().collection('equipment');
}

const STATUS_FILTER_MESSAGE =
  `bookingStatus must be one of: ${BOOKING_STATUSES.join(', ')}.`;

function sameId(left, right) {
  if (!left || !right) return false;
  return left.toString() === right.toString();
}

function canAccessBooking(booking, user) {
  return (
    user.role === 'admin' ||
    sameId(booking.renterId, user.userId) ||
    sameId(booking.ownerId, user.userId)
  );
}

function isBookingOwner(booking, user) {
  return user.role === 'admin' || sameId(booking.ownerId, user.userId);
}

function resolveStatusFilter(request, response) {
  const value = request.query.bookingStatus ?? request.query.status;
  if (value === undefined || value === '') return { ok: true, value: null };

  if (!BOOKING_STATUSES.includes(value)) {
    sendError(response, { statusCode: 400, message: STATUS_FILTER_MESSAGE });
    return { ok: false };
  }

  return { ok: true, value };
}

// ── POST /api/bookings ────────────────────────────────────────────────────
export async function createBooking(request, response) {
  try {
    const {
      equipmentObjectId,
      startDate,
      endDate,
      quantity,
      totalDays,
      phone,
      address,
      notes,
    } = request.bookingInput;

    const equipment = await getEquipmentCollection().findOne({
      _id: equipmentObjectId,
    });

    if (!equipment) {
      return sendError(response, {
        statusCode: 404,
        message: 'Equipment not found.',
      });
    }

    if (equipment.approvalStatus !== 'approved') {
      return sendError(response, {
        statusCode: 400,
        message: 'Equipment is not approved for booking.',
      });
    }

    if (equipment.availability === false) {
      return sendError(response, {
        statusCode: 400,
        message: 'Equipment is currently unavailable for booking.',
      });
    }

    if (sameId(equipment.ownerId, request.user.userId)) {
      return sendError(response, {
        statusCode: 403,
        message: 'You cannot book your own equipment.',
      });
    }

    if (!isPositiveNumber(equipment.pricePerDay)) {
      return sendError(response, {
        statusCode: 500,
        message: 'Equipment pricing is invalid. Please contact support.',
      });
    }

    if (quantity > equipment.quantity) {
      return sendError(response, {
        statusCode: 400,
        message: 'Requested quantity exceeds the available equipment quantity.',
        data: { availableQuantity: equipment.quantity },
      });
    }

    // Server-side availability — pending holds expire, confirmed bookings count.
    const availability = await getDateAvailability({
      equipment,
      startDate,
      endDate,
    });

    if (availability.availableQuantity < quantity) {
      return sendError(response, {
        statusCode: 409,
        message: 'Equipment is not available for the selected dates.',
        data: {
          availableQuantity: availability.availableQuantity,
          requestedQuantity: quantity,
        },
      });
    }

    // Never trust client pricing: read everything from the database document.
    const pricePerDay = equipment.pricePerDay;
    const rentalType = equipment.rentalType ?? 'daily';
    const rentalUnits = calculateRentalUnits(totalDays, rentalType);
    const totalAmount = calculateRentalAmount(pricePerDay, quantity, totalDays, rentalType);
    const now = new Date();

    const booking = {
      equipmentId: equipmentObjectId,
      renterId: request.user.userId,
      ownerId: toObjectId(equipment.ownerId),
      startDate,
      endDate,
      quantity,
      pricePerDay,
      rentalType,
      rentalUnits,
      totalDays,
      totalAmount,
      phone,
      address,
      notes,
      bookingStatus: 'pending',
      paymentStatus: 'unpaid',
      createdAt: now,
      updatedAt: now,
    };

    const result = await getBookingsCollection().insertOne(booking);

    return sendSuccess(response, {
      statusCode: 201,
      message: 'Booking created successfully. Awaiting owner confirmation.',
      data: { booking: { _id: result.insertedId, ...booking } },
    });
  } catch (error) {
    console.error('createBooking error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to create booking. Please try again.',
    });
  }
}

// ── GET /api/bookings/availability (public) ───────────────────────────────
export async function checkAvailability(request, response) {
  try {
    const {
      equipmentObjectId,
      startDate,
      endDate,
      quantity,
      totalDays,
    } = request.availabilityInput;

    const equipment = await getEquipmentCollection().findOne({
      _id: equipmentObjectId,
    });

    if (!equipment || equipment.approvalStatus !== 'approved') {
      return sendError(response, {
        statusCode: 404,
        message: 'Equipment not found or not approved.',
      });
    }

    const availability = await getDateAvailability({
      equipment,
      startDate,
      endDate,
    });

    return sendSuccess(response, {
      message: 'Availability checked successfully.',
      data: {
        equipmentId: equipmentObjectId,
        equipmentName: equipment.title,
        startDate,
        endDate,
        totalDays,
        pricePerDay: equipment.pricePerDay,
        requestedQuantity: quantity,
        rentalType: equipment.rentalType ?? 'daily',
        rentalUnits: calculateRentalUnits(totalDays, equipment.rentalType ?? 'daily'),
        estimatedTotal: calculateRentalAmount(
          equipment.pricePerDay,
          quantity,
          totalDays,
          equipment.rentalType ?? 'daily',
        ),
        stock: availability.stock,
        blockedQuantity: availability.blockedQuantity,
        availableQuantity: availability.availableQuantity,
        isAvailable: availability.availableQuantity >= quantity,
      },
    });
  } catch (error) {
    console.error('checkAvailability error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to check availability.',
    });
  }
}

// ── GET /api/bookings/my ──────────────────────────────────────────────────
export async function getMyBookings(request, response) {
  try {
    const statusFilter = resolveStatusFilter(request, response);
    if (!statusFilter.ok) return undefined;

    const filter = { renterId: request.user.userId };
    if (statusFilter.value) filter.bookingStatus = statusFilter.value;

    const page = Number.parseInt(request.query.page ?? '1', 10);
    const limit = Number.parseInt(request.query.limit ?? '10', 10);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      return sendError(response, {
        statusCode: 400,
        message: 'page must be positive and limit must be between 1 and 50.',
      });
    }

    const collection = getBookingsCollection();
    const [bookings, totalItems] = await Promise.all([
      collection.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      collection.countDocuments(filter),
    ]);

    return sendSuccess(response, {
      message: 'Bookings retrieved successfully.',
      data: {
        bookings,
        count: totalItems,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(totalItems / limit),
          totalItems,
          itemsPerPage: limit,
        },
      },
    });
  } catch (error) {
    console.error('getMyBookings error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to retrieve bookings.',
    });
  }
}

// ── GET /api/bookings/owner ───────────────────────────────────────────────
export async function getOwnerBookings(request, response) {
  try {
    const statusFilter = resolveStatusFilter(request, response);
    if (!statusFilter.ok) return undefined;

    const filter = { ownerId: request.user.userId };
    if (statusFilter.value) filter.bookingStatus = statusFilter.value;

    const bookings = await getBookingsCollection()
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    return sendSuccess(response, {
      message: 'Owner bookings retrieved successfully.',
      data: { bookings, count: bookings.length },
    });
  } catch (error) {
    console.error('getOwnerBookings error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to retrieve owner bookings.',
    });
  }
}

// ── GET /api/bookings/:id ─────────────────────────────────────────────────
export async function getBookingById(request, response) {
  try {
    const booking = await getBookingsCollection().findOne({
      _id: toObjectId(request.params.id),
    });

    if (!booking) {
      return sendError(response, {
        statusCode: 404,
        message: 'Booking not found.',
      });
    }

    if (!canAccessBooking(booking, request.user)) {
      return sendError(response, {
        statusCode: 403,
        message: 'You are not authorized to view this booking.',
      });
    }

    return sendSuccess(response, {
      message: 'Booking details retrieved.',
      data: { booking },
    });
  } catch (error) {
    console.error('getBookingById error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to retrieve booking details.',
    });
  }
}

// ── PATCH /api/bookings/:id/cancel ────────────────────────────────────────
export async function cancelBooking(request, response) {
  try {
    const booking = await getBookingsCollection().findOne({
      _id: toObjectId(request.params.id),
    });

    if (!booking) {
      return sendError(response, {
        statusCode: 404,
        message: 'Booking not found.',
      });
    }

    if (!canAccessBooking(booking, request.user)) {
      return sendError(response, {
        statusCode: 403,
        message: 'You are not authorized to cancel this booking.',
      });
    }

    if (booking.bookingStatus === 'cancelled' || booking.bookingStatus === 'completed') {
      return sendError(response, {
        statusCode: 400,
        message: `A ${booking.bookingStatus} booking cannot be cancelled.`,
      });
    }

    const updatedPaymentStatus =
      booking.paymentStatus === 'paid' ? 'refunded' : booking.paymentStatus;

    const result = await getBookingsCollection().findOneAndUpdate(
      { _id: booking._id },
      {
        $set: {
          bookingStatus: 'cancelled',
          paymentStatus: updatedPaymentStatus,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    );

    return sendSuccess(response, {
      message: 'Booking cancelled successfully.',
      data: { booking: result },
    });
  } catch (error) {
    console.error('cancelBooking error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to cancel booking.',
    });
  }
}

// ── PATCH /api/bookings/:id/status ────────────────────────────────────────
export async function updateBookingStatus(request, response) {
  try {
    const { bookingStatus } = request.body;

    const booking = await getBookingsCollection().findOne({
      _id: toObjectId(request.params.id),
    });

    if (!booking) {
      return sendError(response, {
        statusCode: 404,
        message: 'Booking not found.',
      });
    }

    // Owners may only manage bookings for equipment they own.
    if (!isBookingOwner(booking, request.user)) {
      return sendError(response, {
        statusCode: 403,
        message: 'You are not authorized to update this booking.',
      });
    }

    const allowed = ALLOWED_BOOKING_TRANSITIONS[booking.bookingStatus] ?? [];
    if (!allowed.includes(bookingStatus)) {
      return sendError(response, {
        statusCode: 400,
        message:
          `Cannot change booking status from ${booking.bookingStatus} to ${bookingStatus}.`,
      });
    }

    // Re-validate inventory when moving a pending booking to confirmed,
    // otherwise stock could have been taken while the request was pending.
    if (bookingStatus === 'confirmed' && booking.bookingStatus === 'pending') {
      const equipment = await getEquipmentCollection().findOne({
        _id: booking.equipmentId,
      });

      if (!equipment || equipment.approvalStatus !== 'approved' || equipment.availability === false) {
        return sendError(response, {
          statusCode: 409,
          message: 'Equipment is no longer available for confirmation.',
        });
      }

      const availability = await getDateAvailability({
        equipment,
        startDate: booking.startDate,
        endDate: booking.endDate,
        excludeBookingId: booking._id,
      });

      if (booking.quantity > availability.availableQuantity) {
        return sendError(response, {
          statusCode: 409,
          message: 'Not enough equipment quantity available to confirm this booking.',
          data: { availableQuantity: availability.availableQuantity },
        });
      }
    }

    const result = await getBookingsCollection().findOneAndUpdate(
      { _id: booking._id },
      {
        $set: {
          bookingStatus,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    );

    return sendSuccess(response, {
      message: `Booking ${bookingStatus} successfully.`,
      data: { booking: result },
    });
  } catch (error) {
    console.error('updateBookingStatus error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to update booking status.',
    });
  }
}
