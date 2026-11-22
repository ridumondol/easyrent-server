import { Router } from 'express';
import {
  getBookings,
  getEquipment,
  getOverview,
  getUsers,
  updateUserRole,
} from '../controllers/adminController.js';
import { authMiddleware, verifyToken } from '../middleware/authMiddleware.js';
import { roleMiddleware, verifyAdmin } from '../middleware/roleMiddleware.js';

const router = Router();

router.use(verifyToken, verifyAdmin);
router.get('/overview', getOverview);
router.get('/users', getUsers);
router.patch('/users/:id/role', updateUserRole);
router.get('/equipment', getEquipment);
router.get('/bookings', getBookings);

export default router;
