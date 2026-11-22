import { getDB } from '../config/db.js';
import { sendError, sendSuccess } from '../utils/response.js';

export async function getOwnerAnalytics(request, response) {
  try {
    const ownerId = request.user.userId;
    const db = getDB();
    const [totalEquipment, completedRentals, earningsByMonth, revenueResult] = await Promise.all([
      db.collection('equipment').countDocuments({ ownerId }),
      db.collection('bookings').countDocuments({ ownerId, bookingStatus: 'completed' }),
      db.collection('payments').aggregate([
        { $match: { status: 'success' } },
        {
          $lookup: {
            from: 'bookings',
            localField: 'bookingId',
            foreignField: '_id',
            as: 'booking',
          },
        },
        { $unwind: '$booking' },
        { $match: { 'booking.ownerId': ownerId } },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'UTC' },
            },
            earnings: { $sum: '$amount' },
          },
        },
        { $sort: { _id: 1 } },
      ]).toArray(),
      db.collection('payments').aggregate([
        { $match: { status: 'success' } },
        {
          $lookup: {
            from: 'bookings',
            localField: 'bookingId',
            foreignField: '_id',
            as: 'booking',
          },
        },
        { $unwind: '$booking' },
        { $match: { 'booking.ownerId': ownerId } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]).toArray(),
    ]);

    return sendSuccess(response, {
      message: 'Owner analytics retrieved successfully.',
      data: {
        analytics: {
          totalEquipment,
          completedRentals,
          totalEarnings: revenueResult[0]?.total ?? 0,
          monthlyEarnings: earningsByMonth.map(({ _id, earnings }) => ({ month: _id, earnings })),
        },
      },
    });
  } catch (error) {
    console.error('getOwnerAnalytics error:', error);
    return sendError(response, { statusCode: 500, message: 'Failed to retrieve owner analytics.' });
  }
}
