import { ObjectId } from 'mongodb';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getDB } from '../config/db.js';
import { sendError } from '../utils/response.js';
import { verifyToken as jwtVerifyToken } from '../utils/jwt.js';

let remoteJwks;

function getRemoteJwks() {
  const clientUrl = process.env.CLIENT_URL;
  if (!clientUrl) throw new Error('CLIENT_URL is required to verify BetterAuth tokens.');
  if (!remoteJwks) {
    remoteJwks = createRemoteJWKSet(new URL('/api/auth/jwks', clientUrl));
  }
  return remoteJwks;
}

async function verifyAccessToken(token) {
  try {
    return jwtVerifyToken(token);
  } catch (legacyTokenError) {
    const clientUrl = process.env.CLIENT_URL;
    if (!clientUrl) throw legacyTokenError;
    const { payload } = await jwtVerify(token, getRemoteJwks(), {
      issuer: clientUrl,
      audience: clientUrl,
    });
    return payload;
  }
}

export async function authMiddleware(request, response, next) {
  const authHeader = request.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : request.cookies?.token;

  if (!token) {
    return sendError(response, {
      statusCode: 401,
      message: 'Access denied. No token provided.',
    });
  }

  let decoded;
  try {
    decoded = await verifyAccessToken(token);
  } catch (error) {
    const message = error.name === 'TokenExpiredError'
      ? 'Token has expired. Please login again.'
      : 'Invalid token.';

    return sendError(response, {
      statusCode: 401,
      message,
    });
  }

  if (
    typeof (decoded.userId ?? decoded.sub) !== 'string' ||
    !/^[a-f\d]{24}$/i.test(decoded.userId ?? decoded.sub) ||
    !ObjectId.isValid(decoded.userId ?? decoded.sub) ||
    (decoded.tokenVersion !== undefined
      && (!Number.isSafeInteger(decoded.tokenVersion) || decoded.tokenVersion < 0))
  ) {
    return sendError(response, {
      statusCode: 401,
      message: 'Invalid token.',
    });
  }

  const userId = new ObjectId(decoded.userId ?? decoded.sub);
  const user = await getDB().collection('users').findOne(
    { _id: userId },
    { projection: { email: 1, role: 1, tokenVersion: 1 } },
  );

  if (!user) {
    return sendError(response, {
      statusCode: 401,
      message: 'Account no longer exists.',
    });
  }

  if ((decoded.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
    return sendError(response, {
      statusCode: 401,
      message: 'Session is no longer valid. Please sign in again.',
    });
  }

  request.user = {
    userId: user._id,
    email: user.email,
    role: user.role,
  };

  return next();
}

export { authMiddleware as verifyToken };


