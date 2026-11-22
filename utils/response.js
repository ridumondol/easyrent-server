export function sendSuccess(response, {
  statusCode = 200,
  success = true,
  message,
  data,
}) {
  return response.status(statusCode).json({ success, message, data });
}

export function sendError(response, {
  statusCode = 500,
  message = 'Internal server error',
  data = null,
}) {
  return response.status(statusCode).json({
    success: false,
    message,
    data,
  });
}
