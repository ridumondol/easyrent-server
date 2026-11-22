import { Router } from 'express';
import { createReview, getReviews } from '../controllers/reviewController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { roleMiddleware } from '../middleware/roleMiddleware.js';

const router = Router();
router.get('/', getReviews);
router.post('/', authMiddleware, roleMiddleware('renter'), createReview);

export default router;
