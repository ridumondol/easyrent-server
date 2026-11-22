import { getDB } from '../config/db.js';
import { sendError, sendSuccess } from '../utils/response.js';

export async function createContactMessage(request, response) {
  const { name, email, subject, message } = request.body ?? {};
  if (typeof name !== 'string' || name.trim().length < 2 || name.length > 100) {
    return sendError(response, { statusCode: 400, message: 'Name must be between 2 and 100 characters.' });
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return sendError(response, { statusCode: 400, message: 'A valid email address is required.' });
  }
  if (typeof subject !== 'string' || subject.trim().length < 3 || subject.length > 120) {
    return sendError(response, { statusCode: 400, message: 'Subject must be between 3 and 120 characters.' });
  }
  if (typeof message !== 'string' || message.trim().length < 10 || message.length > 3000) {
    return sendError(response, { statusCode: 400, message: 'Message must be between 10 and 3000 characters.' });
  }

  try {
    const now = new Date();
    const contactMessage = {
      name: name.trim(),
      email: email.trim().toLowerCase(),
      subject: subject.trim(),
      message: message.trim(),
      status: 'new',
      createdAt: now,
      updatedAt: now,
    };
    const result = await getDB().collection('contactMessages').insertOne(contactMessage);
    return sendSuccess(response, {
      statusCode: 201,
      message: 'Your message has been received.',
      data: { messageId: result.insertedId },
    });
  } catch (error) {
    console.error('createContactMessage error:', error);
    return sendError(response, { statusCode: 500, message: 'Unable to save your message.' });
  }
}
