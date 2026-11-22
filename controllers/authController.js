import bcrypt from 'bcryptjs';
import { getDB } from '../config/db.js';
import { sendError, sendSuccess } from '../utils/response.js';
import { generateToken } from '../utils/jwt.js';
import { assertEmailServiceConfigured, sendPasswordResetEmail } from '../services/emailService.js';
import {
  createPasswordResetToken,
  hashPasswordResetToken,
  isValidPassword,
  PASSWORD_RESET_COOLDOWN_MS,
  PASSWORD_RESET_TTL_MS,
} from '../utils/passwordSecurity.js';

const VALID_ROLES = ['renter', 'owner'];
const SALT_ROUNDS = 10;

/**
 * Shared helper: omit password and session-management fields from responses.
 */
function safeUserObject(user) {
  const safe = { ...user };
  delete safe.passwordHash;
  delete safe.passwordResetTokenHash;
  delete safe.passwordResetExpiresAt;
  delete safe.passwordResetRequestedAt;
  delete safe.tokenVersion;
  return safe;
}

/**
 * Shared helper: given a user document, generate a JWT and return { user, token }.
 */
function buildAuthResponse(user) {
  const token = generateToken({
    userId: user._id,
    email: user.email,
    role: user.role,
    tokenVersion: user.tokenVersion ?? 0,
  });
  return { user: safeUserObject(user), token };
}

function getPasswordResetUrl(token) {
  const clientUrl = process.env.CLIENT_URL?.split(',')[0].trim();
  if (!clientUrl) throw new Error('CLIENT_URL is required for password reset links.');
  const url = new URL('/reset-password', clientUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('CLIENT_URL must use HTTP or HTTPS.');
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('CLIENT_URL must use HTTPS in production.');
  }
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

const PASSWORD_RESET_REQUEST_MESSAGE =
  'If an account exists for that email, a password reset link will be sent.';
const INVALID_PASSWORD_RESET_MESSAGE = 'This reset link is invalid or has expired.';

// POST /api/auth/register
export async function register(request, response) {
  try {
    const { name, email, password, role, image } = request.body;

    // ── Validate required fields ──────────────────────────────
    if (!name || !email || !password) {
      return sendError(response, {
        statusCode: 400,
        message: 'Name, email, and password are required.',
      });
    }

    if (typeof name !== 'string' || name.trim().length < 2) {
      return sendError(response, {
        statusCode: 400,
        message: 'Name must be at least 2 characters.',
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (typeof email !== 'string' || !emailRegex.test(email)) {
      return sendError(response, {
        statusCode: 400,
        message: 'Please provide a valid email address.',
      });
    }

    if (!isValidPassword(password)) {
      return sendError(response, {
        statusCode: 400,
        message: 'Password must be at least 6 characters and include an uppercase and a lowercase letter.',
      });
    }

    let profileImage = '';
    if (image !== undefined && image !== '') {
      try {
        const parsedImage = new URL(image);
        if (!['http:', 'https:'].includes(parsedImage.protocol)) throw new Error('Unsupported protocol.');
        profileImage = parsedImage.toString();
      } catch {
        return sendError(response, { statusCode: 400, message: 'Profile image must be a valid HTTP(S) URL.' });
      }
    }

    // ── Prevent registering as admin ──────────────────────────
    const userRole = role && VALID_ROLES.includes(role) ? role : 'renter';

    // ── Check duplicate email ─────────────────────────────────
    const db = getDB();
    const usersCollection = db.collection('users');

    const existingUser = await usersCollection.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return sendError(response, {
        statusCode: 409,
        message: 'An account with this email already exists.',
      });
    }

    // ── Hash password & insert ────────────────────────────────
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const newUser = {
      name: name.trim(),
      email: email.toLowerCase().trim(),
      image: profileImage,
      passwordHash,
      role: userRole,
      phone: '',
      address: '',
      authProvider: 'email',
      status: 'active',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await usersCollection.insertOne(newUser);

    // ── Generate token ────────────────────────────────────────
    const authResult = buildAuthResponse({ _id: result.insertedId, ...newUser });

    return sendSuccess(response, {
      statusCode: 201,
      message: 'Registration successful.',
      data: authResult,
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return sendError(response, {
        statusCode: 409,
        message: 'An account with this email already exists.',
      });
    }
    console.error('Register error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Registration failed. Please try again.',
    });
  }
}

// POST /api/auth/google
export async function googleLogin(request, response) {
  const { credential } = request.body ?? {};
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return sendError(response, { statusCode: 503, message: 'Google sign-in is not configured.' });
  }
  if (typeof credential !== 'string' || credential.length === 0 || credential.length > 10000) {
    return sendError(response, { statusCode: 400, message: 'A valid Google credential is required.' });
  }

  let claims;
  try {
    const verification = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!verification.ok) {
      return sendError(response, { statusCode: 401, message: 'Google sign-in could not verify your account.' });
    }
    claims = await verification.json();
  } catch (error) {
    console.error('Google credential verification failed:', error);
    return sendError(response, { statusCode: 502, message: 'Google sign-in is temporarily unavailable.' });
  }

  if (
    claims.aud !== clientId
    || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)
    || claims.email_verified !== 'true'
    || typeof claims.sub !== 'string'
    || typeof claims.email !== 'string'
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)
  ) {
    return sendError(response, { statusCode: 401, message: 'Google sign-in returned an invalid or unverified account.' });
  }

  try {
    const users = getDB().collection('users');
    const email = claims.email.toLowerCase();
    let user = await users.findOne({ email });
    const now = new Date();
    if (!user) {
      const picture = typeof claims.picture === 'string' && /^https?:\/\//i.test(claims.picture)
        ? claims.picture
        : '';
      const newUser = {
        name: typeof claims.name === 'string' && claims.name.trim()
          ? claims.name.trim().slice(0, 100)
          : email.split('@')[0],
        email,
        image: picture,
        googleId: claims.sub,
        role: 'renter',
        phone: '',
        address: '',
        authProvider: 'google',
        status: 'active',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      };
      try {
        const result = await users.insertOne(newUser);
        user = { _id: result.insertedId, ...newUser };
      } catch (error) {
        if (error?.code !== 11000) throw error;
        user = await users.findOne({ email });
      }
    }
    if (!user) throw new Error('Google account could not be loaded after sign-in.');
    if (user.googleId && user.googleId !== claims.sub) {
      return sendError(response, { statusCode: 409, message: 'A different Google account is already linked to this email.' });
    }
    if (!user.googleId) {
      await users.updateOne(
        { _id: user._id, googleId: { $exists: false } },
        { $set: { googleId: claims.sub, updatedAt: now } },
      );
      user.googleId = claims.sub;
    }
    const picture = typeof claims.picture === 'string' && /^https?:\/\//i.test(claims.picture)
      ? claims.picture
      : '';
    if (!user.image && picture) {
      await users.updateOne(
        { _id: user._id },
        { $set: { image: picture, updatedAt: now } },
      );
      user.image = picture;
    }

    return sendSuccess(response, {
      message: 'Google sign-in successful.',
      data: buildAuthResponse(user),
    });
  } catch (error) {
    console.error('Google sign-in failed:', error);
    return sendError(response, { statusCode: 500, message: 'Google sign-in failed. Please try again.' });
  }
}

// POST /api/auth/github
export async function githubLogin(request, response) {
  const { code } = request.body ?? {};
  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!githubClientId || !githubClientSecret) {
    return sendError(response, { statusCode: 503, message: 'GitHub sign-in is not configured on this server.' });
  }
  if (typeof code !== 'string' || code.length === 0 || code.length > 500) {
    return sendError(response, { statusCode: 400, message: 'A valid GitHub authorization code is required.' });
  }

  // ── Step 1: Exchange authorization code for access token ──────
  let accessToken;
  try {
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: githubClientId,
        client_secret: githubClientSecret,
        code,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!tokenResponse.ok) {
      console.error('GitHub token exchange HTTP error:', tokenResponse.status);
      return sendError(response, { statusCode: 502, message: 'GitHub sign-in is temporarily unavailable.' });
    }

    const tokenData = await tokenResponse.json();
    if (tokenData.error || !tokenData.access_token) {
      console.error('GitHub token exchange error:', tokenData.error_description || tokenData.error);
      return sendError(response, {
        statusCode: 401,
        message: tokenData.error === 'bad_verification_code'
          ? 'The GitHub authorization code has expired. Please try signing in again.'
          : 'GitHub sign-in could not verify your account.',
      });
    }
    accessToken = tokenData.access_token;
  } catch (error) {
    console.error('GitHub token exchange failed:', error);
    return sendError(response, { statusCode: 502, message: 'GitHub sign-in is temporarily unavailable.' });
  }

  // ── Step 2: Fetch GitHub user profile ────────────────────────
  let githubUser;
  try {
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!userResponse.ok) {
      console.error('GitHub user API error:', userResponse.status);
      return sendError(response, { statusCode: 502, message: 'Could not retrieve your GitHub profile.' });
    }
    githubUser = await userResponse.json();
  } catch (error) {
    console.error('GitHub user fetch failed:', error);
    return sendError(response, { statusCode: 502, message: 'GitHub sign-in is temporarily unavailable.' });
  }

  if (!githubUser.id || typeof githubUser.id !== 'number') {
    return sendError(response, { statusCode: 401, message: 'GitHub returned an invalid user profile.' });
  }

  const githubId = String(githubUser.id);

  // ── Step 3: Fetch GitHub email (may be private) ──────────────
  let email = typeof githubUser.email === 'string' && githubUser.email.includes('@')
    ? githubUser.email.toLowerCase().trim()
    : '';

  if (!email) {
    try {
      const emailsResponse = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(5000),
      });

      if (emailsResponse.ok) {
        const emails = await emailsResponse.json();
        if (Array.isArray(emails)) {
          const primary = emails.find((e) => e.primary && e.verified);
          const verified = emails.find((e) => e.verified);
          const best = primary || verified;
          if (best && typeof best.email === 'string') {
            email = best.email.toLowerCase().trim();
          }
        }
      }
    } catch (error) {
      console.error('GitHub email fetch failed (non-critical):', error);
    }
  }

  if (!email) {
    return sendError(response, {
      statusCode: 400,
      message: 'Your GitHub account does not have a verified public email address. Please add and verify an email on GitHub, then try again.',
    });
  }

  // ── Step 4: Find or create user ──────────────────────────────
  try {
    const users = getDB().collection('users');
    const now = new Date();

    // Try to find user by githubId first, then by email
    let user = await users.findOne({ githubId });
    if (!user) {
      user = await users.findOne({ email });
    }

    if (!user) {
      // Create new user with Customer role
      const picture = typeof githubUser.avatar_url === 'string' && /^https?:\/\//i.test(githubUser.avatar_url)
        ? githubUser.avatar_url
        : '';
      const name = (typeof githubUser.name === 'string' && githubUser.name.trim())
        ? githubUser.name.trim().slice(0, 100)
        : (typeof githubUser.login === 'string' && githubUser.login.trim())
          ? githubUser.login.trim().slice(0, 100)
          : email.split('@')[0];

      const newUser = {
        name,
        email,
        image: picture,
        githubId,
        role: 'renter',
        phone: '',
        address: '',
        authProvider: 'github',
        status: 'active',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      };

      try {
        const result = await users.insertOne(newUser);
        user = { _id: result.insertedId, ...newUser };
      } catch (error) {
        if (error?.code !== 11000) throw error;
        // Race condition: another request created the user
        user = await users.findOne({ email });
      }
    }

    if (!user) throw new Error('GitHub account could not be loaded after sign-in.');

    // Check for conflicting githubId
    if (user.githubId && user.githubId !== githubId) {
      return sendError(response, { statusCode: 409, message: 'A different GitHub account is already linked to this email.' });
    }

    // Link githubId to existing account if not yet linked
    if (!user.githubId) {
      await users.updateOne(
        { _id: user._id, githubId: { $exists: false } },
        { $set: { githubId, updatedAt: now } },
      );
      user.githubId = githubId;
    }

    // Update profile picture if the user doesn't have one
    if (!user.image && githubUser.avatar_url) {
      await users.updateOne(
        { _id: user._id },
        { $set: { image: githubUser.avatar_url, updatedAt: now } },
      );
      user.image = githubUser.avatar_url;
    }

    return sendSuccess(response, {
      message: 'GitHub sign-in successful.',
      data: buildAuthResponse(user),
    });
  } catch (error) {
    console.error('GitHub sign-in failed:', error);
    return sendError(response, { statusCode: 500, message: 'GitHub sign-in failed. Please try again.' });
  }
}

// POST /api/auth/login
export async function login(request, response) {
  try {
    const { email, password } = request.body;

    // ── Validate ──────────────────────────────────────────────
    if (!email || !password) {
      return sendError(response, {
        statusCode: 400,
        message: 'Email and password are required.',
      });
    }

    // ── Find user ─────────────────────────────────────────────
    const db = getDB();
    const user = await db.collection('users').findOne({ email: email.toLowerCase() });

    if (!user) {
      return sendError(response, {
        statusCode: 401,
        message: 'Invalid email or password.',
      });
    }

    // ── Compare password ──────────────────────────────────────
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return sendError(response, {
        statusCode: 401,
        message: 'Invalid email or password.',
      });
    }

    // ── Generate token ────────────────────────────────────────
    return sendSuccess(response, {
      message: 'Login successful.',
      data: buildAuthResponse(user),
    });
  } catch (error) {
    console.error('Login error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Login failed. Please try again.',
    });
  }
}

// POST /api/auth/forgot-password
export async function requestPasswordReset(request, response) {
  const email = request.body?.email;
  if (
    typeof email !== 'string'
    || email.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  ) {
    return sendError(response, { statusCode: 400, message: 'Please provide a valid email address.' });
  }

  try {
    assertEmailServiceConfigured();
    getPasswordResetUrl('');
  } catch (error) {
    console.error(
      'Password reset service configuration error:',
      error instanceof Error ? error.message : 'Unknown configuration error.',
    );
    return sendError(response, {
      statusCode: 503,
      message: 'Password reset is temporarily unavailable. Please try again later.',
    });
  }

  try {
    const users = getDB().collection('users');
    const user = await users.findOne(
      { email: email.trim().toLowerCase(), passwordHash: { $type: 'string' } },
      { projection: { name: 1, email: 1 } },
    );

    if (user) {
      const now = new Date();
      const cooldownCutoff = new Date(now.getTime() - PASSWORD_RESET_COOLDOWN_MS);
      const { token, tokenHash } = createPasswordResetToken();
      const update = await users.updateOne(
        {
          _id: user._id,
          $or: [
            { passwordResetRequestedAt: { $exists: false } },
            { passwordResetRequestedAt: { $lte: cooldownCutoff } },
          ],
        },
        {
          $set: {
            passwordResetTokenHash: tokenHash,
            passwordResetExpiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
            passwordResetRequestedAt: now,
          },
        },
      );

      if (update.modifiedCount === 1) {
        try {
          await sendPasswordResetEmail({
            name: user.name,
            email: user.email,
            resetUrl: getPasswordResetUrl(token),
          });
        } catch (error) {
          const details = error instanceof Error
            ? {
                name: error.name,
                code: error.code,
                responseCode: error.responseCode,
                command: error.command,
              }
            : { name: 'UnknownError' };
          console.error('Password reset email delivery failed.', details);

          try {
            const cleanup = await users.updateOne(
              { _id: user._id, passwordResetTokenHash: tokenHash },
              {
                $unset: {
                  passwordResetTokenHash: '',
                  passwordResetExpiresAt: '',
                  passwordResetRequestedAt: '',
                },
              },
            );
            if (cleanup.modifiedCount !== 1) {
              console.error('Failed password reset email token cleanup did not remove the pending token.');
            }
          } catch (cleanupError) {
            const cleanupDetails = cleanupError instanceof Error
              ? { name: cleanupError.name, code: cleanupError.code }
              : { name: 'UnknownError' };
            console.error('Failed password reset email token cleanup.', cleanupDetails);
          }

          return sendError(response, {
            statusCode: 503,
            message: 'Password reset is temporarily unavailable. Please try again later.',
          });
        }
      }
    }

    return sendSuccess(response, {
      statusCode: 202,
      message: PASSWORD_RESET_REQUEST_MESSAGE,
      data: {},
    });
  } catch (error) {
    const details = error instanceof Error
      ? { name: error.name, code: error.code }
      : { name: 'UnknownError' };
    console.error('Password reset request could not be completed.', details);
    return sendError(response, {
      statusCode: 500,
      message: 'Unable to process the password reset request.',
    });
  }
}

// POST /api/auth/reset-password
export async function resetPassword(request, response) {
  const { token, password, confirmPassword } = request.body ?? {};
  if (typeof token !== 'string' || token.length !== 64) {
    return sendError(response, { statusCode: 400, message: INVALID_PASSWORD_RESET_MESSAGE });
  }
  if (typeof confirmPassword !== 'string' || password !== confirmPassword) {
    return sendError(response, { statusCode: 400, message: 'Password and confirmation do not match.' });
  }
  if (!isValidPassword(password)) {
    return sendError(response, {
      statusCode: 400,
      message: 'Password must be at least 6 characters and include an uppercase and a lowercase letter.',
    });
  }

  try {
    const users = getDB().collection('users');
    const tokenHash = hashPasswordResetToken(token);
    const now = new Date();
    const user = await users.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { $gt: now },
    });
    if (!user) {
      return sendError(response, { statusCode: 400, message: INVALID_PASSWORD_RESET_MESSAGE });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await users.updateOne(
      {
        _id: user._id,
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: { $gt: now },
      },
      {
        $set: { passwordHash, updatedAt: now },
        $inc: { tokenVersion: 1 },
        $unset: {
          passwordResetTokenHash: '',
          passwordResetExpiresAt: '',
          passwordResetRequestedAt: '',
        },
      },
    );
    if (result.modifiedCount !== 1) {
      return sendError(response, { statusCode: 400, message: INVALID_PASSWORD_RESET_MESSAGE });
    }

    return sendSuccess(response, {
      message: 'Your password has been reset. Please sign in with your new password.',
      data: {},
    });
  } catch {
    console.error('Password reset could not be completed.');
    return sendError(response, {
      statusCode: 500,
      message: 'Unable to reset your password. Please try again.',
    });
  }
}

// POST /api/auth/change-password (requires authMiddleware)
export async function changePassword(request, response) {
  const { currentPassword, newPassword, confirmPassword } = request.body ?? {};
  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    return sendError(response, { statusCode: 400, message: 'Current password is required.' });
  }
  if (!isValidPassword(newPassword)) {
    return sendError(response, {
      statusCode: 400,
      message: 'New password must be at least 6 characters and include an uppercase and a lowercase letter.',
    });
  }
  if (typeof confirmPassword !== 'string' || newPassword !== confirmPassword) {
    return sendError(response, { statusCode: 400, message: 'New password and confirmation do not match.' });
  }
  if (currentPassword === newPassword) {
    return sendError(response, { statusCode: 400, message: 'New password must be different from your current password.' });
  }

  try {
    const users = getDB().collection('users');
    const user = await users.findOne(
      { _id: request.user.userId },
      { projection: { passwordHash: 1, email: 1, role: 1, tokenVersion: 1 } },
    );
    if (!user?.passwordHash) {
      return sendError(response, {
        statusCode: 400,
        message: 'Password changes are unavailable for accounts without a password.',
      });
    }
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      return sendError(response, { statusCode: 401, message: 'Current password is incorrect.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    const result = await users.updateOne(
      { _id: user._id, passwordHash: user.passwordHash },
      { $set: { passwordHash, updatedAt: new Date() }, $inc: { tokenVersion: 1 } },
    );
    if (result.modifiedCount !== 1) {
      return sendError(response, {
        statusCode: 409,
        message: 'Your password changed in another request. Sign in again and retry.',
      });
    }

    const token = generateToken({
      userId: user._id,
      email: user.email,
      role: user.role,
      tokenVersion: (user.tokenVersion ?? 0) + 1,
    });
    return sendSuccess(response, {
      message: 'Password changed successfully. Other sessions have been signed out.',
      data: { token },
    });
  } catch {
    console.error('Password change could not be completed.');
    return sendError(response, {
      statusCode: 500,
      message: 'Unable to change your password. Please try again.',
    });
  }
}

// GET /api/auth/me  (requires authMiddleware)
export async function getMe(request, response) {
  try {
    const db = getDB();
    const user = await db.collection('users').findOne(
      { _id: request.user.userId },
      { projection: { passwordHash: 0 } },
    );

    if (!user) {
      return sendError(response, {
        statusCode: 404,
        message: 'User not found.',
      });
    }

    return sendSuccess(response, {
      message: 'User profile retrieved.',
      data: { user: safeUserObject(user) },
    });
  } catch (error) {
    console.error('GetMe error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to retrieve user profile.',
    });
  }
}

// PATCH /api/auth/me (requires authMiddleware)
export async function updateMe(request, response) {
  try {
    const updates = {};

    if (request.body.name !== undefined) {
      if (typeof request.body.name !== 'string' || request.body.name.trim().length < 2) {
        return sendError(response, {
          statusCode: 400,
          message: 'Name must be at least 2 characters.',
        });
      }
      updates.name = request.body.name.trim();
    }

    if (request.body.email !== undefined) {
      if (typeof request.body.email !== 'string') {
        return sendError(response, {
          statusCode: 400,
          message: 'Please provide a valid email address.',
        });
      }
      const email = request.body.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return sendError(response, {
          statusCode: 400,
          message: 'Please provide a valid email address.',
        });
      }

      const existingUser = await getDB().collection('users').findOne({
        email,
        _id: { $ne: request.user.userId },
      });
      if (existingUser) {
        return sendError(response, {
          statusCode: 409,
          message: 'An account with this email already exists.',
        });
      }
      updates.email = email;
    }

    if (request.body.image !== undefined) {
      if (request.body.image === '' || request.body.image === null) {
        updates.image = '';
      } else if (typeof request.body.image === 'string') {
        const trimmedImage = request.body.image.trim();
        if (/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(trimmedImage)) {
          if (trimmedImage.length > 7 * 1024 * 1024) {
            return sendError(response, { statusCode: 400, message: 'Image payload is too large (maximum 5MB).' });
          }
          updates.image = trimmedImage;
        } else {
          if (trimmedImage.length > 2048) {
            return sendError(response, { statusCode: 400, message: 'Profile image URL is too long.' });
          }
          try {
            const imageUrl = new URL(trimmedImage);
            if (!['http:', 'https:'].includes(imageUrl.protocol)) throw new Error('Unsupported URL scheme.');
            updates.image = trimmedImage;
          } catch {
            return sendError(response, { statusCode: 400, message: 'Profile image must be a valid HTTP(S) URL or data URI.' });
          }
        }
      } else {
        return sendError(response, { statusCode: 400, message: 'Invalid profile image format.' });
      }
    }

    if (request.body.phone !== undefined) {
      if (typeof request.body.phone !== 'string' || request.body.phone.trim().length > 50) {
        return sendError(response, { statusCode: 400, message: 'Phone number must be at most 50 characters.' });
      }
      updates.phone = request.body.phone.trim();
    }

    if (request.body.address !== undefined) {
      if (typeof request.body.address !== 'string' || request.body.address.trim().length > 500) {
        return sendError(response, { statusCode: 400, message: 'Address must be at most 500 characters.' });
      }
      updates.address = request.body.address.trim();
    }

    if (Object.keys(updates).length === 0) {
      return sendError(response, {
        statusCode: 400,
        message: 'At least one editable profile field is required.',
      });
    }

    updates.updatedAt = new Date();
    const user = await getDB().collection('users').findOneAndUpdate(
      { _id: request.user.userId },
      { $set: updates },
      { returnDocument: 'after', projection: { passwordHash: 0 } },
    );

    return sendSuccess(response, {
      message: 'Profile updated successfully.',
      data: { user: safeUserObject(user) },
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return sendError(response, {
        statusCode: 409,
        message: 'An account with this email already exists.',
      });
    }
    console.error('Update profile error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to update user profile.',
    });
  }
}

// DELETE /api/auth/profile-image (requires authMiddleware)
export async function deleteProfileImage(request, response) {
  try {
    const user = await getDB().collection('users').findOneAndUpdate(
      { _id: request.user.userId },
      { $set: { image: '', updatedAt: new Date() } },
      { returnDocument: 'after', projection: { passwordHash: 0 } },
    );

    return sendSuccess(response, {
      message: 'Profile image removed successfully.',
      data: { user: safeUserObject(user) },
    });
  } catch (error) {
    console.error('Delete profile image error:', error);
    return sendError(response, {
      statusCode: 500,
      message: 'Failed to remove profile image.',
    });
  }
}

// GET /api/auth/logout
export function logout(_request, response) {
  return sendSuccess(response, {
    message: 'Logged out successfully.',
  });
}

