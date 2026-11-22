import { Router } from 'express';
import {
  register,
  login,
  googleLogin,
  githubLogin,
  requestPasswordReset,
  resetPassword,
  changePassword,
  getMe,
  updateMe,
  deleteProfileImage,
  logout,
} from '../controllers/authController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = Router();

// Public routes
router.post('/register', register);
router.post('/login', login);
router.post('/google', googleLogin);
router.post('/github', githubLogin);
router.post('/forgot-password', requestPasswordReset);
router.post('/reset-password', resetPassword);

// Protected routes
router.get('/me', authMiddleware, getMe);
router.patch('/me', authMiddleware, updateMe);
router.post('/change-password', authMiddleware, changePassword);
router.delete('/profile-image', authMiddleware, deleteProfileImage);
router.get('/logout', logout);
router.post('/logout', logout);

export default router;
