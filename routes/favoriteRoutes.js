import { Router } from 'express';
import { addFavorite, getMyFavorites, removeFavorite } from '../controllers/favoriteController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { roleMiddleware } from '../middleware/roleMiddleware.js';

const router = Router();
router.use(authMiddleware, roleMiddleware('renter'));
router.get('/', getMyFavorites);
router.post('/:equipmentId', addFavorite);
router.delete('/:equipmentId', removeFavorite);

export default router;
