import { createHash, randomBytes } from 'node:crypto';

export const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;
export const PASSWORD_RESET_COOLDOWN_MS = 60 * 1000;

export function isValidPassword(password) {
  return typeof password === 'string'
    && password.length >= 6
    && /[A-Z]/.test(password)
    && /[a-z]/.test(password);
}

export function createPasswordResetToken() {
  const token = randomBytes(32).toString('hex');
  return {
    token,
    tokenHash: hashPasswordResetToken(token),
  };
}

export function hashPasswordResetToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
