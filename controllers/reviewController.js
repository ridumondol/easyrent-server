import { ObjectId } from 'mongodb';
import { getDB } from '../config/db.js';
import { sendError, sendSuccess } from '../utils/response.js';
import { isValidObjectId } from '../utils/validation.js';

export async function getReviews(request, response) {
  const requestedLimit = Number.parseInt(request.query.limit ?? '12', 10);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    return sendError(response, { statusCode: 400, message: 'limit must be a positive integer.' });
  }
  const limit = Math.min(requestedLimit, 50);

  try {
    const reviews = await getDB().collection('reviews').aggregate([
      { $sort: { createdAt: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          pipeline: [{ $project: { name: 1, image: 1 } }],
          as: 'customer',
        },
      },
      { $set: { customer: { $first: '$customer' } } },
    ]).toArray();

    return sendSuccess(response, { message: 'Reviews retrieved successfully.', data: { reviews } });
  } catch (error) {
    console.error('getReviews error:', error);
    return sendError(response, { statusCode: 500, message: 'Failed to retrieve reviews.' });
  }
}

export async function createReview(request, response) {
  const { equipmentId, bookingId, rating, comment } = request.body ?? {};
  if (!isValidObjectId(equipmentId) || !isValidObjectId(bookingId)) {
    return sendError(response, { statusCode: 400, message: 'Valid equipmentId and bookingId are required.' });
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return sendError(response, { statusCode: 400, message: 'rating must be an integer from 1 to 5.' });
  }
  if (typeof comment !== 'string' || comment.trim().length < 3 || comment.length > 1500) {
    return sendError(response, { statusCode: 400, message: 'comment must be between 3 and 1500 characters.' });
  }

  try {
    const bookings = getDB().collection('bookings');
    const booking = await bookings.findOne({
      _id: new ObjectId(bookingId),
      equipmentId: new ObjectId(equipmentId),
      renterId: request.user.userId,
      bookingStatus: 'completed',
      paymentStatus: 'paid',
    });
    if (!booking) {
      return sendError(response, { statusCode: 403, message: 'Reviews require a completed, paid rental.' });
    }

    const review = {
      userId: request.user.userId,
      equipmentId: new ObjectId(equipmentId),
      bookingId: new ObjectId(bookingId),
      rating,
      comment: comment.trim(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await getDB().collection('reviews').insertOne(review);
    return sendSuccess(response, {
      statusCode: 201,
      message: 'Review submitted.',
      data: { review: { _id: result.insertedId, ...review } },
    });
  } catch (error) {
    if (error?.code === 11000) {
      return sendError(response, { statusCode: 409, message: 'You have already reviewed this equipment.' });
    }
    console.error('createReview error:', error);
    return sendError(response, { statusCode: 500, message: 'Failed to submit review.' });
  }
}
