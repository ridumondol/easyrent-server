import { Router } from 'express';
import {
  createCheckout,
  getMyPayments,
  verifyPayment,
} from '../controllers/paymentController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { roleMiddleware } from '../middleware/roleMiddleware.js';

const router = Router();

router.post('/checkout', authMiddleware, roleMiddleware('renter'), createCheckout);
router.get('/verify/:bookingId', authMiddleware, roleMiddleware('renter'), verifyPayment);
router.get('/my', authMiddleware, roleMiddleware('renter'), getMyPayments);

export default router;
