import { Router } from 'express';
import {
  addEquipment,
  getAllEquipment,
  getMyEquipment,
  getEquipmentById,
  updateEquipment,
  deleteEquipment,
  updateApprovalStatus,
} from '../controllers/equipmentController.js';
import { authMiddleware, verifyToken } from '../middleware/authMiddleware.js';
import { roleMiddleware, verifyOwner, verifyAdmin } from '../middleware/roleMiddleware.js';

const router = Router();

// ── Owner specific inventory (before /:id) ────────────────────
router.get('/my', verifyToken, verifyOwner, getMyEquipment);
router.get('/', getAllEquipment);
router.get('/:id', getEquipmentById);

// ── Protected: authenticated owners (or admins) ───────────────
router.post('/', verifyToken, roleMiddleware('owner', 'admin'), addEquipment);
router.patch('/:id', verifyToken, updateEquipment);
router.delete('/:id', verifyToken, deleteEquipment);

// ── Admin-only: approval management ───────────────────────────
router.patch('/:id/approval', verifyToken, verifyAdmin, updateApprovalStatus);

export default router;

