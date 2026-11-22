import { Router } from 'express';
import { getOwnerAnalytics } from '../controllers/ownerController.js';
import { authMiddleware, verifyToken } from '../middleware/authMiddleware.js';
import { roleMiddleware, verifyOwner } from '../middleware/roleMiddleware.js';

const router = Router();
router.use(verifyToken, verifyOwner);
router.get('/analytics', getOwnerAnalytics);

export default router;
