import { sendError } from '../utils/response.js';

/**
 * Factory that returns middleware allowing only the listed roles.
 * Usage:  router.get('/admin', authMiddleware, roleMiddleware('admin'), handler);
 */
export function roleMiddleware(...allowedRoles) {
  return (request, response, next) => {
    if (!request.user) {
      return sendError(response, {
        statusCode: 401,
        message: 'Authentication required.',
      });
    }

    const userRole = request.user.role === 'customer' ? 'renter' : request.user.role;
    const acceptedRoles = allowedRoles.map((role) => role === 'customer' ? 'renter' : role);
    if (!acceptedRoles.includes(userRole)) {
      return sendError(response, {
        statusCode: 403,
        message: 'Access denied. Insufficient permissions.',
      });
    }

    next();
  };
}

// Challenge 2: Custom Express role-based middlewares
export const verifyRenter = roleMiddleware('renter', 'customer');
export const verifyOwner = roleMiddleware('owner');
export const verifyAdmin = roleMiddleware('admin');
export { authMiddleware, verifyToken } from './authMiddleware.js';


