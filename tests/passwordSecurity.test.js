import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPasswordResetToken,
  hashPasswordResetToken,
  isValidPassword,
} from '../utils/passwordSecurity.js';

describe('Password security helpers', () => {
  it('creates high-entropy reset tokens and stores only a deterministic digest', () => {
    const first = createPasswordResetToken();
    const second = createPasswordResetToken();

    assert.match(first.token, /^[a-f\d]{64}$/);
    assert.notEqual(first.token, first.tokenHash);
    assert.equal(first.tokenHash, hashPasswordResetToken(first.token));
    assert.notEqual(first.tokenHash, second.tokenHash);
  });

  it('applies the existing account password policy', () => {
    assert.equal(isValidPassword('Password123'), true);
    assert.equal(isValidPassword('password123'), false);
    assert.equal(isValidPassword('PASSWORD123'), false);
    assert.equal(isValidPassword('Aa1'), false);
    assert.equal(isValidPassword(null), false);
  });
});
