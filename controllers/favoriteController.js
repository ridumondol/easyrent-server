import { ObjectId } from 'mongodb';
import { getDB } from '../config/db.js';
import { sendError, sendSuccess } from '../utils/response.js';
import { isValidObjectId } from '../utils/validation.js';

export async function getMyFavorites(request, response) {
  try {
    const favorites = await getDB().collection('favorites').aggregate([
      { $match: { userId: request.user.userId } },
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: 'equipment',
          localField: 'equipmentId',
          foreignField: '_id',
          as: 'equipment',
        },
      },
      { $unwind: { path: '$equipment', preserveNullAndEmptyArrays: true } },
      { $match: { 'equipment.approvalStatus': 'approved' } },
    ]).toArray();

    return sendSuccess(response, {
      message: 'Favorites retrieved successfully.',
      data: { favorites, count: favorites.length },
    });
  } catch (error) {
    console.error('getMyFavorites error:', error);
    return sendError(response, { statusCode: 500, message: 'Failed to retrieve favorites.' });
  }
}

export async function addFavorite(request, response) {
  const { equipmentId } = request.params;
  if (!isValidObjectId(equipmentId)) {
    return sendError(response, { statusCode: 400, message: 'Invalid equipment ID.' });
  }

  try {
    const objectId = new ObjectId(equipmentId);
    const equipment = await getDB().collection('equipment').findOne({
      _id: objectId,
      approvalStatus: 'approved',
    });
    if (!equipment) return sendError(response, { statusCode: 404, message: 'Equipment not found.' });

    const now = new Date();
    const result = await getDB().collection('favorites').updateOne(
      { userId: request.user.userId, equipmentId: objectId },
      { $setOnInsert: { userId: request.user.userId, equipmentId: objectId, createdAt: now, updatedAt: now } },
      { upsert: true },
    );

    return sendSuccess(response, {
      statusCode: result.upsertedCount ? 201 : 200,
      message: result.upsertedCount ? 'Equipment added to favorites.' : 'Equipment is already in favorites.',
      data: { equipmentId: objectId },
    });
  } catch (error) {
    console.error('addFavorite error:', error);
    return sendError(response, { statusCode: 500, message: 'Failed to add favorite.' });
  }
}

export async function removeFavorite(request, response) {
  const { equipmentId } = request.params;
  if (!isValidObjectId(equipmentId)) {
    return sendError(response, { statusCode: 400, message: 'Invalid equipment ID.' });
  }

  try {
    const result = await getDB().collection('favorites').deleteOne({
      userId: request.user.userId,
      equipmentId: new ObjectId(equipmentId),
    });
    if (!result.deletedCount) return sendError(response, { statusCode: 404, message: 'Favorite not found.' });

    return sendSuccess(response, {
      message: 'Equipment removed from favorites.',
      data: { equipmentId },
    });
  } catch (error) {
    console.error('removeFavorite error:', error);
    return sendError(response, { statusCode: 500, message: 'Failed to remove favorite.' });
  }
}
