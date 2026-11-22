import { getDatabaseStatus } from '../config/db.js';
import { sendError, sendSuccess } from '../utils/response.js';

export function getHealth(_request, response) {
  const database = getDatabaseStatus();
  const data = {
    status: database === 'connected' ? 'running' : 'unavailable',
    database,
    timestamp: new Date().toISOString(),
  };

  if (database !== 'connected') {
    return sendError(response, {
      statusCode: 503,
      message: 'Rentora API is not ready.',
      data,
    });
  }

  sendSuccess(response, {
    message: 'Rentora API health status',
    data,
  });
}
