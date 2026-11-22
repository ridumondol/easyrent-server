import { Router } from 'express';
import {
  createBooking,
  checkAvailability,
  getMyBookings,
  getOwnerBookings,
  getBookingById,
  cancelBooking,
  updateBookingStatus,
} from '../controllers/bookingController.js';
import { authMiddleware, verifyToken } from '../middleware/authMiddleware.js';
import { roleMiddleware, verifyRenter, verifyOwner } from '../middleware/roleMiddleware.js';
import {
  validateCreateBooking,
  validateAvailabilityQuery,
  validateBookingId,
  validateBookingStatusUpdate,
} from '../middleware/bookingValidation.js';

const router = Router();

// ── Public availability helper (declared before /:id) ───────────────────
router.get('/availability', validateAvailabilityQuery, checkAvailability);

// ── Renter routes (declared before /:id) ────────────────────────────────
router.get('/my', verifyToken, verifyRenter, getMyBookings);
router.post('/', verifyToken, verifyRenter, validateCreateBooking, createBooking);

// ── Owner routes (declared before /:id) ─────────────────────────────────
router.get('/owner', verifyToken, verifyOwner, getOwnerBookings);
router.patch(
  '/:id/status',
  verifyToken,
  roleMiddleware('owner', 'admin'),
  validateBookingId,
  validateBookingStatusUpdate,
  updateBookingStatus,
);

// ── Shared detail / cancellation routes ─────────────────────────────────
router.get('/:id', verifyToken, validateBookingId, getBookingById);
router.patch('/:id/cancel', verifyToken, validateBookingId, cancelBooking);

export default router;
