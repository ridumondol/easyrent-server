import { getDatabaseStatus } from '../config/db.js';
import { sendSuccess } from '../utils/response.js';

export function getHealth(_request, response) {
  sendSuccess(response, {
    message: 'EasyRent API health status',
    data: {
      status: 'running',
      database: getDatabaseStatus(),
      timestamp: new Date().toISOString(),
    },
  });
}
