import { sendError } from '../utils/response.js';

export function errorHandler(error, _request, response, _next) {
  if (response.headersSent) return;

  const errorStatus = error.statusCode ?? error.status;
  const statusCode = Number.isInteger(errorStatus) ? errorStatus : 500;
  const message = statusCode >= 500 ? 'Internal server error' : error.message;

  if (statusCode >= 500) {
    console.error(error);
  }

  sendError(response, { statusCode, message });
}
