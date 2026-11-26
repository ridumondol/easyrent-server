import { ObjectId } from 'mongodb';
import { getDB } from '../config/db.js';
import { sendError, sendSuccess } from '../utils/response.js';

const VALID_ROLES = ['customer', 'renter', 'owner', 'admin'];

function isValidObjectId(id) {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === String(id);
}

export async function getOverview(_request, response) {
  try {
    const db = getDB();
    const users = db.collection('users');
    const equipment = db.collection('equipment');
    const bookings = db.collection('bookings');
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const [
      totalUsers,
      totalEquipment,
      totalBookings,
      pendingEquipmentApprovals,
      completedRentals,
      revenueResult,
      confirmedBookingResult,
      bookingMonths,
    ] = await Promise.all([
      users.countDocuments(),
      equipment.countDocuments(),
      bookings.countDocuments(),
      equipment.countDocuments({ approvalStatus: 'pending' }),
      bookings.countDocuments({ bookingStatus: 'completed' }),
      bookings.aggregate([
        { $match: { paymentStatus: 'paid' } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } },
      ]).toArray(),
      bookings.aggregate([
        { $match: { bookingStatus: { $in: ['confirmed', 'completed'] } } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } },
      ]).toArray(),
      bookings.aggregate([
        { $match: { createdAt: { $gte: start, $lt: end } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y-%m',
                date: '$createdAt',
                timezone: 'UTC',
              },
            },
            bookings: { $sum: 1 },
          },
        },
      ]).toArray(),
    ]);

    const monthlyCounts = new Map(bookingMonths.map((month) => [month._id, month.bookings]));
    const monthlyBookings = Array.from({ length: 12 }, (_, index) => {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + index, 1));
      const month = date.toISOString().slice(0, 7);
      return { month, bookings: monthlyCounts.get(month) ?? 0 };
    });

    return sendSuccess(response, {
      message: 'Admin overview retrieved successfully.',
      data: {
        overview: {
          totalUsers,
          totalEquipment,
          totalBookings,
          pendingEquipmentApprovals,
          completedRentals,
          totalRevenue: revenueResult[0]?.total ?? 0,
          confirmedBookingValue: confirmedBookingResult[0]?.total ?? 0,
          monthlyBookings,
        },
      },
    });
  } catch (error) {
    console.error('getOverview error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to retrieve admin overview.',
    });
  }
}

export async function getUsers(_request, response) {
  try {
    const users = await getDB().collection('users')
      .find({}, {
        projection: {
          passwordHash: 0,
          passwordResetTokenHash: 0,
          passwordResetExpiresAt: 0,
          passwordResetRequestedAt: 0,
          tokenVersion: 0,
        },
      })
      .sort({ createdAt: -1 })
      .toArray();

    return sendSuccess(response, {
      message: 'Users retrieved successfully.',
      data: { users, count: users.length },
    });
  } catch (error) {
    console.error('getUsers error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to retrieve users.',
    });
  }
}

export async function updateUserRole(request, response) {
  try {
    const { id } = request.params;
    const { role } = request.body;

    if (!isValidObjectId(id)) {
      return sendError(response, { statusCode: 400, message: 'Invalid user ID.' });
    }
    if (typeof role !== 'string' || !VALID_ROLES.includes(role)) {
      return sendError(response, {
        statusCode: 400,
        message: `Role must be one of: ${VALID_ROLES.join(', ')}.`,
      });
    }
    if (String(request.user.userId) === id && role !== 'admin') {
      return sendError(response, {
        statusCode: 400,
        message: 'You cannot remove your own admin role.',
      });
    }

    const user = await getDB().collection('users').findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { role, updatedAt: new Date() } },
      {
        returnDocument: 'after',
        projection: {
          passwordHash: 0,
          passwordResetTokenHash: 0,
          passwordResetExpiresAt: 0,
          passwordResetRequestedAt: 0,
          tokenVersion: 0,
        },
      },
    );
    if (!user) {
      return sendError(response, { statusCode: 404, message: 'User not found.' });
    }

    return sendSuccess(response, {
      message: 'User role updated successfully.',
      data: { user },
    });
  } catch (error) {
    console.error('updateUserRole error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to update user role.',
    });
  }
}

export async function getEquipment(_request, response) {
  try {
    const equipment = await getDB().collection('equipment').aggregate([
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: 'users',
          localField: 'ownerId',
          foreignField: '_id',
          pipeline: [{ $project: { _id: 1, name: 1, email: 1 } }],
          as: 'owner',
        },
      },
      { $set: { owner: { $first: '$owner' } } },
    ]).toArray();

    return sendSuccess(response, {
      message: 'All equipment retrieved successfully.',
      data: { equipment, count: equipment.length },
    });
  } catch (error) {
    console.error('getEquipment error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to retrieve equipment.',
    });
  }
}

export async function getBookings(_request, response) {
  try {
    const bookings = await getDB().collection('bookings').aggregate([
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: 'users',
          localField: 'renterId',
          foreignField: '_id',
          pipeline: [{ $project: { _id: 1, name: 1, email: 1 } }],
          as: 'renter',
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'ownerId',
          foreignField: '_id',
          pipeline: [{ $project: { _id: 1, name: 1, email: 1 } }],
          as: 'owner',
        },
      },
      {
        $lookup: {
          from: 'equipment',
          localField: 'equipmentId',
          foreignField: '_id',
          pipeline: [{ $project: { _id: 1, title: 1 } }],
          as: 'equipment',
        },
      },
      {
        $set: {
          renter: { $first: '$renter' },
          owner: { $first: '$owner' },
          equipment: { $first: '$equipment' },
        },
      },
      {
        $project: {
          renterId: 1,
          ownerId: 1,
          equipmentId: 1,
          startDate: 1,
          endDate: 1,
          totalDays: 1,
          quantity: 1,
          totalAmount: 1,
          bookingStatus: 1,
          paymentStatus: 1,
          createdAt: 1,
          renter: 1,
          owner: 1,
          equipment: 1,
        },
      },
    ]).toArray();

    return sendSuccess(response, {
      message: 'All rentals retrieved successfully.',
      data: { bookings, count: bookings.length },
    });
  } catch (error) {
    console.error('getBookings error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to retrieve rentals.',
    });
  }
}
