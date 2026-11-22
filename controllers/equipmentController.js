import { ObjectId } from 'mongodb';
import { getDB } from '../config/db.js';
import { sendError, sendSuccess } from '../utils/response.js';

// ── Validation helpers ─────────────────────────────────────────
const VALID_CONDITIONS = ['new', 'like-new', 'good', 'fair', 'worn'];
const VALID_CATEGORIES = [
  'construction',
  'photography',
  'electronics',
  'sports',
  'camping',
  'music',
  'tools',
  'vehicles',
  'party',
  'agriculture',
  'events',
  'other',
];
const VALID_RENTAL_TYPES = ['daily', 'weekly', 'monthly'];

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isValidObjectId(id) {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === String(id);
}

function getEquipmentCollection() {
  return getDB().collection('equipment');
}

// ── POST /api/equipment ────────────────────────────────────────
export async function addEquipment(request, response) {
  try {
    const {
      title,
      description,
      category,
      pricePerDay,
      location,
      image,
      quantity,
      condition,
      availability,
      rentalType,
      brand,
      model,
      rentalTerms,
    } = request.body;

    // ── Required-field validation ──────────────────────────────
    if (!title || !description || !category || !pricePerDay || !location || !image) {
      return sendError(response, {
        statusCode: 400,
        message: 'Title, description, category, pricePerDay, location, and image are required.',
      });
    }

    if (typeof title !== 'string' || title.trim().length < 3) {
      return sendError(response, {
        statusCode: 400,
        message: 'Title must be at least 3 characters.',
      });
    }

    if (typeof description !== 'string' || description.trim().length < 10) {
      return sendError(response, {
        statusCode: 400,
        message: 'Description must be at least 10 characters.',
      });
    }

    if (!VALID_CATEGORIES.includes(category)) {
      return sendError(response, {
        statusCode: 400,
        message: `Category must be one of: ${VALID_CATEGORIES.join(', ')}.`,
      });
    }

    if (!isPositiveNumber(pricePerDay)) {
      return sendError(response, {
        statusCode: 400,
        message: 'pricePerDay must be a positive number.',
      });
    }

    if (typeof location !== 'string' || location.trim().length < 2) {
      return sendError(response, {
        statusCode: 400,
        message: 'Location must be at least 2 characters.',
      });
    }

    if (typeof image !== 'string' || image.trim().length === 0) {
      return sendError(response, {
        statusCode: 400,
        message: 'Image URL is required.',
      });
    }

    if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1)) {
      return sendError(response, {
        statusCode: 400,
        message: 'Quantity must be a positive integer.',
      });
    }

    if (condition !== undefined && !VALID_CONDITIONS.includes(condition)) {
      return sendError(response, {
        statusCode: 400,
        message: `Condition must be one of: ${VALID_CONDITIONS.join(', ')}.`,
      });
    }

    if (rentalType !== undefined && !VALID_RENTAL_TYPES.includes(rentalType)) {
      return sendError(response, {
        statusCode: 400,
        message: `rentalType must be one of: ${VALID_RENTAL_TYPES.join(', ')}.`,
      });
    }

    if (brand !== undefined && (typeof brand !== 'string' || brand.length > 100)) {
      return sendError(response, { statusCode: 400, message: 'Brand must be at most 100 characters.' });
    }
    if (model !== undefined && (typeof model !== 'string' || model.length > 100)) {
      return sendError(response, { statusCode: 400, message: 'Model must be at most 100 characters.' });
    }
    if (rentalTerms !== undefined && (typeof rentalTerms !== 'string' || rentalTerms.length > 3000)) {
      return sendError(response, { statusCode: 400, message: 'Rental terms must be at most 3000 characters.' });
    }

    // ── Build document ────────────────────────────────────────
    const now = new Date();

    const equipment = {
      title: title.trim(),
      description: description.trim(),
      category,
      pricePerDay,
      location: location.trim(),
      image: image.trim(),
      quantity: quantity ?? 1,
      condition: condition ?? 'good',
      rentalType: rentalType ?? 'daily',
      brand: typeof brand === 'string' ? brand.trim() : '',
      model: typeof model === 'string' ? model.trim() : '',
      rentalTerms: typeof rentalTerms === 'string' ? rentalTerms.trim() : '',
      ownerId: request.user.userId,          // always from token
      availability: availability !== undefined ? Boolean(availability) : true,
      approvalStatus: 'pending',             // always starts as pending
      createdAt: now,
      updatedAt: now,
    };

    const result = await getEquipmentCollection().insertOne(equipment);

    return sendSuccess(response, {
      statusCode: 201,
      message: 'Equipment added successfully. Awaiting admin approval.',
      data: { equipment: { _id: result.insertedId, ...equipment } },
    });
  } catch (error) {
    console.error('addEquipment error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to add equipment. Please try again.',
    });
  }
}

// ── GET /api/equipment ─────────────────────────────────────────
export async function getAllEquipment(request, response) {
  try {
    const {
      search,
      category,
      location,
      minPrice,
      maxPrice,
      rentalType,
      availability,
      sort,
      page = '1',
      limit = '12',
    } = request.query;

    // ── Build filter (only approved) ──────────────────────────
    const filter = { approvalStatus: 'approved' };

    if (search && typeof search === 'string' && search.trim()) {
      const sanitized = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { title: { $regex: sanitized, $options: 'i' } },
        { location: { $regex: sanitized, $options: 'i' } },
      ];
    }

    if (category && typeof category === 'string' && category.trim()) {
      filter.category = category.trim();
    }

    if (rentalType && typeof rentalType === 'string' && rentalType.trim()) {
      if (!VALID_RENTAL_TYPES.includes(rentalType.trim())) {
        return sendError(response, { statusCode: 400, message: 'Invalid rentalType filter.' });
      }
      filter.rentalType = rentalType.trim();
    }

    if (availability !== undefined && availability !== '') {
      if (availability !== 'true' && availability !== 'false') {
        return sendError(response, { statusCode: 400, message: 'availability must be true or false.' });
      }
      filter.availability = availability === 'true';
    }

    if (location && typeof location === 'string' && location.trim()) {
      const sanitized = location.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.location = { $regex: sanitized, $options: 'i' };
    }

    if (minPrice !== undefined && minPrice !== '') {
      const min = Number(minPrice);
      if (!Number.isFinite(min) || min < 0) {
        return sendError(response, { statusCode: 400, message: 'minPrice must be a non-negative number.' });
      }
      filter.pricePerDay = filter.pricePerDay || {};
      filter.pricePerDay.$gte = min;
    }

    if (maxPrice !== undefined && maxPrice !== '') {
      const max = Number(maxPrice);
      if (!Number.isFinite(max) || max < 0) {
        return sendError(response, { statusCode: 400, message: 'maxPrice must be a non-negative number.' });
      }
      filter.pricePerDay = filter.pricePerDay || {};
      filter.pricePerDay.$lte = max;
    }

    if (filter.pricePerDay?.$gte !== undefined && filter.pricePerDay?.$lte !== undefined
      && filter.pricePerDay.$gte > filter.pricePerDay.$lte) {
      return sendError(response, { statusCode: 400, message: 'minPrice must not exceed maxPrice.' });
    }

    // ── Sorting ───────────────────────────────────────────────
    let sortOption = { createdAt: -1 }; // default: newest
    if (sort === 'price_asc') sortOption = { pricePerDay: 1 };
    else if (sort === 'price_desc') sortOption = { pricePerDay: -1 };
    else if (sort === 'newest') sortOption = { createdAt: -1 };

    // ── Pagination ────────────────────────────────────────────
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 12));
    const skip = (pageNum - 1) * limitNum;

    const collection = getEquipmentCollection();

    const [equipment, totalCount] = await Promise.all([
      collection.find(filter).sort(sortOption).skip(skip).limit(limitNum).toArray(),
      collection.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(totalCount / limitNum);

    return sendSuccess(response, {
      message: 'Equipment retrieved successfully.',
      data: {
        equipment,
        pagination: {
          currentPage: pageNum,
          totalPages,
          totalItems: totalCount,
          itemsPerPage: limitNum,
        },
      },
    });
  } catch (error) {
    console.error('getAllEquipment error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to retrieve equipment.',
    });
  }
}

// ── GET /api/equipment/my ─────────────────────────────────────
export async function getMyEquipment(request, response) {
  try {
    const equipment = await getEquipmentCollection()
      .find({ ownerId: request.user.userId })
      .sort({ createdAt: -1 })
      .toArray();

    return sendSuccess(response, {
      message: 'Your equipment retrieved successfully.',
      data: { equipment, count: equipment.length },
    });
  } catch (error) {
    console.error('getMyEquipment error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to retrieve your equipment.',
    });
  }
}

// ── GET /api/equipment/:id ─────────────────────────────────────
export async function getEquipmentById(request, response) {
  try {
    const { id } = request.params;

    if (!isValidObjectId(id)) {
      return sendError(response, {
        statusCode: 400,
        message: 'Invalid equipment ID.',
      });
    }

    const equipment = await getEquipmentCollection().findOne({
      _id: new ObjectId(id),
      approvalStatus: 'approved',
    });

    if (!equipment) {
      return sendError(response, {
        statusCode: 404,
        message: 'Equipment not found.',
      });
    }

    const owner = await getDB().collection('users').findOne(
      { _id: equipment.ownerId },
      { projection: { name: 1, image: 1, role: 1, createdAt: 1 } },
    );

    return sendSuccess(response, {
      message: 'Equipment details retrieved.',
      data: { equipment: { ...equipment, owner: owner ?? null } },
    });
  } catch (error) {
    console.error('getEquipmentById error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to retrieve equipment details.',
    });
  }
}

// ── PATCH /api/equipment/:id ───────────────────────────────────
export async function updateEquipment(request, response) {
  try {
    const { id } = request.params;

    if (!isValidObjectId(id)) {
      return sendError(response, {
        statusCode: 400,
        message: 'Invalid equipment ID.',
      });
    }

    // ── Fetch existing document ───────────────────────────────
    const equipment = await getEquipmentCollection().findOne({
      _id: new ObjectId(id),
    });

    if (!equipment) {
      return sendError(response, {
        statusCode: 404,
        message: 'Equipment not found.',
      });
    }

    // ── Authorization: owner or admin ─────────────────────────
    const isOwner = equipment.ownerId.toString() === request.user.userId.toString();
    const isAdmin = request.user.role === 'admin';

    if (!isOwner && !isAdmin) {
      return sendError(response, {
        statusCode: 403,
        message: 'You are not authorized to update this equipment.',
      });
    }

    // ── Build update (strip disallowed fields) ────────────────
    const allowedFields = [
      'title',
      'description',
      'category',
      'pricePerDay',
      'location',
      'image',
      'quantity',
      'condition',
      'availability',
      'rentalType',
      'brand',
      'model',
      'rentalTerms',
    ];

    const updates = {};

    for (const field of allowedFields) {
      if (request.body[field] !== undefined) {
        updates[field] = request.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return sendError(response, {
        statusCode: 400,
        message: 'No valid fields to update.',
      });
    }

    // ── Validate updated values ───────────────────────────────
    if (updates.title !== undefined) {
      if (typeof updates.title !== 'string' || updates.title.trim().length < 3) {
        return sendError(response, {
          statusCode: 400,
          message: 'Title must be at least 3 characters.',
        });
      }
      updates.title = updates.title.trim();
    }

    if (updates.description !== undefined) {
      if (typeof updates.description !== 'string' || updates.description.trim().length < 10) {
        return sendError(response, {
          statusCode: 400,
          message: 'Description must be at least 10 characters.',
        });
      }
      updates.description = updates.description.trim();
    }

    if (updates.category !== undefined && !VALID_CATEGORIES.includes(updates.category)) {
      return sendError(response, {
        statusCode: 400,
        message: `Category must be one of: ${VALID_CATEGORIES.join(', ')}.`,
      });
    }

    if (updates.rentalType !== undefined && !VALID_RENTAL_TYPES.includes(updates.rentalType)) {
      return sendError(response, { statusCode: 400, message: 'Invalid rentalType.' });
    }

    for (const field of ['brand', 'model']) {
      if (updates[field] !== undefined) {
        if (typeof updates[field] !== 'string' || updates[field].length > 100) {
          return sendError(response, { statusCode: 400, message: `${field} must be at most 100 characters.` });
        }
        updates[field] = updates[field].trim();
      }
    }

    if (updates.rentalTerms !== undefined) {
      if (typeof updates.rentalTerms !== 'string' || updates.rentalTerms.length > 3000) {
        return sendError(response, { statusCode: 400, message: 'Rental terms must be at most 3000 characters.' });
      }
      updates.rentalTerms = updates.rentalTerms.trim();
    }

    if (updates.pricePerDay !== undefined && !isPositiveNumber(updates.pricePerDay)) {
      return sendError(response, {
        statusCode: 400,
        message: 'pricePerDay must be a positive number.',
      });
    }

    if (updates.location !== undefined) {
      if (typeof updates.location !== 'string' || updates.location.trim().length < 2) {
        return sendError(response, {
          statusCode: 400,
          message: 'Location must be at least 2 characters.',
        });
      }
      updates.location = updates.location.trim();
    }

    if (updates.image !== undefined) {
      if (typeof updates.image !== 'string' || updates.image.trim().length === 0) {
        return sendError(response, {
          statusCode: 400,
          message: 'Image URL cannot be empty.',
        });
      }
      updates.image = updates.image.trim();
    }

    if (updates.quantity !== undefined) {
      if (!Number.isInteger(updates.quantity) || updates.quantity < 1) {
        return sendError(response, {
          statusCode: 400,
          message: 'Quantity must be a positive integer.',
        });
      }
    }

    if (updates.condition !== undefined && !VALID_CONDITIONS.includes(updates.condition)) {
      return sendError(response, {
        statusCode: 400,
        message: `Condition must be one of: ${VALID_CONDITIONS.join(', ')}.`,
      });
    }

    if (updates.availability !== undefined) {
      updates.availability = Boolean(updates.availability);
    }

    updates.updatedAt = new Date();

    // ── Perform update ────────────────────────────────────────
    const result = await getEquipmentCollection().findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: updates },
      { returnDocument: 'after' },
    );

    return sendSuccess(response, {
      message: 'Equipment updated successfully.',
      data: { equipment: result },
    });
  } catch (error) {
    console.error('updateEquipment error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to update equipment.',
    });
  }
}

// ── DELETE /api/equipment/:id ──────────────────────────────────
export async function deleteEquipment(request, response) {
  try {
    const { id } = request.params;

    if (!isValidObjectId(id)) {
      return sendError(response, {
        statusCode: 400,
        message: 'Invalid equipment ID.',
      });
    }

    const equipment = await getEquipmentCollection().findOne({
      _id: new ObjectId(id),
    });

    if (!equipment) {
      return sendError(response, {
        statusCode: 404,
        message: 'Equipment not found.',
      });
    }

    // ── Authorization: owner or admin ─────────────────────────
    const isOwner = equipment.ownerId.toString() === request.user.userId.toString();
    const isAdmin = request.user.role === 'admin';

    if (!isOwner && !isAdmin) {
      return sendError(response, {
        statusCode: 403,
        message: 'You are not authorized to delete this equipment.',
      });
    }

    await getEquipmentCollection().deleteOne({ _id: new ObjectId(id) });

    return sendSuccess(response, {
      message: 'Equipment deleted successfully.',
      data: { equipmentId: id },
    });
  } catch (error) {
    console.error('deleteEquipment error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to delete equipment.',
    });
  }
}

// ── PATCH /api/equipment/:id/approval (admin only) ─────────────
export async function updateApprovalStatus(request, response) {
  try {
    const { id } = request.params;
    const { approvalStatus } = request.body;

    if (!isValidObjectId(id)) {
      return sendError(response, {
        statusCode: 400,
        message: 'Invalid equipment ID.',
      });
    }

    const validStatuses = ['pending', 'approved', 'rejected'];
    if (!approvalStatus || !validStatuses.includes(approvalStatus)) {
      return sendError(response, {
        statusCode: 400,
        message: `approvalStatus must be one of: ${validStatuses.join(', ')}.`,
      });
    }

    const equipment = await getEquipmentCollection().findOne({
      _id: new ObjectId(id),
    });

    if (!equipment) {
      return sendError(response, {
        statusCode: 404,
        message: 'Equipment not found.',
      });
    }

    const result = await getEquipmentCollection().findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { approvalStatus, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    return sendSuccess(response, {
      message: `Equipment ${approvalStatus} successfully.`,
      data: { equipment: result },
    });
  } catch (error) {
    console.error('updateApprovalStatus error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to update approval status.',
    });
  }
}

