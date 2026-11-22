import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, closeTestDb, getTestDb, registerUser } from './helpers.js';
import { createPasswordResetToken } from '../utils/passwordSecurity.js';

after(closeTestDb);

describe('Authentication & OAuth API Endpoints', () => {
  it('registers a new user with email and password and returns a valid JWT', async () => {
    const timestamp = Date.now();
    const email = `auth_test_${timestamp}@example.test`;
    const res = await api('/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Alex Renter',
        email,
        password: 'Password123',
        role: 'renter',
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.user.email, email);
    assert.equal(res.body.data.user.role, 'renter');
    assert.equal(res.body.data.user.authProvider, 'email');
    assert.equal(res.body.data.user.status, 'active');
    assert.ok(res.body.data.token, 'Token must be present in response');
  });

  it('prevents duplicate account registration with the same email', async () => {
    const { email } = await registerUser('renter', 'duplicate_check');
    const duplicateRes = await api('/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Another Name',
        email,
        password: 'Password123',
        role: 'renter',
      },
    });

    assert.equal(duplicateRes.status, 409);
    assert.equal(duplicateRes.body.success, false);
    assert.match(duplicateRes.body.message, /already exists/i);
  });

  it('logs in an existing user with correct password', async () => {
    const timestamp = Date.now();
    const email = `login_test_${timestamp}@example.test`;
    await api('/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Test Login',
        email,
        password: 'Password123',
        role: 'renter',
      },
    });

    const loginRes = await api('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'Password123' },
    });

    assert.equal(loginRes.status, 200);
    assert.equal(loginRes.body.success, true);
    assert.equal(loginRes.body.data.user.email, email);
    assert.ok(loginRes.body.data.token);
  });

  it('rejects login with incorrect password', async () => {
    const { email } = await registerUser('renter', 'wrong_pw');
    const loginRes = await api('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'WrongPassword999' },
    });

    assert.equal(loginRes.status, 401);
    assert.equal(loginRes.body.success, false);
  });

  it('retrieves user profile via /api/auth/me with valid token', async () => {
    const { token, email } = await registerUser('renter', 'me_test');
    const meRes = await api('/api/auth/me', { token });

    assert.equal(meRes.status, 200);
    assert.equal(meRes.body.success, true);
    assert.equal(meRes.body.data.user.email, email);
  });

  it('validates password reset requests and protects password changes', async () => {
    const invalidEmail = await api('/api/auth/forgot-password', {
      method: 'POST',
      body: { email: 'not-an-email' },
    });
    assert.equal(invalidEmail.status, 400);

    const unauthenticatedChange = await api('/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword: 'Password123', newPassword: 'NewPassword123' },
    });
    assert.equal(unauthenticatedChange.status, 401);
  });

  it('does not disclose account existence when reset email is not configured', async () => {
    const { email } = await registerUser('renter', 'reset_email_config');
    const [existingAccount, unknownAccount] = await Promise.all([
      api('/api/auth/forgot-password', { method: 'POST', body: { email } }),
      api('/api/auth/forgot-password', {
        method: 'POST',
        body: { email: `unknown_${Date.now()}@example.test` },
      }),
    ]);

    assert.equal(existingAccount.status, 503);
    assert.equal(unknownAccount.status, 503);
    assert.equal(existingAccount.body.message, unknownAccount.body.message);

    const { db } = await getTestDb();
    const storedUser = await db.collection('users').findOne({ email });
    assert.equal(storedUser.passwordResetTokenHash, undefined);
    assert.equal(storedUser.passwordResetExpiresAt, undefined);
    assert.equal(storedUser.passwordResetRequestedAt, undefined);
  });

  it('changes an email account password and revokes older sessions', async () => {
    const { token, email } = await registerUser('renter', 'change_password');
    const mismatchedConfirmation = await api('/api/auth/change-password', {
      method: 'POST',
      token,
      body: {
        currentPassword: 'Secret123',
        newPassword: 'NewPassword123',
        confirmPassword: 'DifferentPassword123',
      },
    });
    assert.equal(mismatchedConfirmation.status, 400);

    const wrongCurrentPassword = await api('/api/auth/change-password', {
      method: 'POST',
      token,
      body: {
        currentPassword: 'WrongPassword123',
        newPassword: 'NewPassword123',
        confirmPassword: 'NewPassword123',
      },
    });
    assert.equal(wrongCurrentPassword.status, 401);

    const changed = await api('/api/auth/change-password', {
      method: 'POST',
      token,
      body: {
        currentPassword: 'Secret123',
        newPassword: 'NewPassword123',
        confirmPassword: 'NewPassword123',
      },
    });
    assert.equal(changed.status, 200);
    assert.ok(changed.body.data.token);

    assert.equal((await api('/api/auth/me', { token })).status, 401);
    assert.equal((await api('/api/auth/me', { token: changed.body.data.token })).status, 200);
    assert.equal((await api('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'Secret123' },
    })).status, 401);
    assert.equal((await api('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'NewPassword123' },
    })).status, 200);
  });

  it('resets a password once with a valid token and invalidates existing sessions', async () => {
    const { token: sessionToken, email } = await registerUser('renter', 'reset_password');
    const reset = createPasswordResetToken();
    const { db } = await getTestDb();
    await db.collection('users').updateOne(
      { email },
      {
        $set: {
          passwordResetTokenHash: reset.tokenHash,
          passwordResetExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      },
    );
    const profile = await api('/api/auth/me', { token: sessionToken });
    assert.equal(profile.status, 200);
    for (const field of [
      'passwordHash',
      'passwordResetTokenHash',
      'passwordResetExpiresAt',
      'passwordResetRequestedAt',
      'tokenVersion',
    ]) {
      assert.equal(field in profile.body.data.user, false);
    }

    const result = await api('/api/auth/reset-password', {
      method: 'POST',
      body: {
        token: reset.token,
        password: 'NewPassword123',
        confirmPassword: 'NewPassword123',
      },
    });
    assert.equal(result.status, 200);
    assert.equal(JSON.stringify(result.body).includes(reset.token), false);
    assert.equal((await api('/api/auth/reset-password', {
      method: 'POST',
      body: {
        token: reset.token,
        password: 'AnotherPassword123',
        confirmPassword: 'AnotherPassword123',
      },
    })).status, 400);
    assert.equal((await api('/api/auth/me', { token: sessionToken })).status, 401);
    assert.equal((await api('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'NewPassword123' },
    })).status, 200);
  });

  it('rejects expired password reset tokens without changing the existing password', async () => {
    const { email } = await registerUser('renter', 'expired_reset');
    const reset = createPasswordResetToken();
    const { db } = await getTestDb();
    await db.collection('users').updateOne(
      { email },
      {
        $set: {
          passwordResetTokenHash: reset.tokenHash,
          passwordResetExpiresAt: new Date(Date.now() - 1000),
        },
      },
    );

    const result = await api('/api/auth/reset-password', {
      method: 'POST',
      body: {
        token: reset.token,
        password: 'NewPassword123',
        confirmPassword: 'NewPassword123',
      },
    });
    assert.equal(result.status, 400);
    assert.equal((await api('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'Secret123' },
    })).status, 200);
  });

  it('allows completing and updating profile information via PATCH /api/auth/me', async () => {
    const { token } = await registerUser('renter', 'update_profile');
    const updateRes = await api('/api/auth/me', {
      method: 'PATCH',
      token,
      body: {
        name: 'Updated Name',
        phone: '+8801700000000',
        address: '123 Test Street, Dhaka',
        image: 'https://example.com/avatar.jpg',
      },
    });

    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.body.success, true);
    assert.equal(updateRes.body.data.user.name, 'Updated Name');
    assert.equal(updateRes.body.data.user.phone, '+8801700000000');
    assert.equal(updateRes.body.data.user.address, '123 Test Street, Dhaka');
  });

  it('validates Google login input', async () => {
    // Missing credential
    const emptyRes = await api('/api/auth/google', {
      method: 'POST',
      body: {},
    });
    // Either 400 (invalid/missing credential) or 503 (not configured)
    assert.ok([400, 503].includes(emptyRes.status));

    // Invalid non-string credential
    const invalidRes = await api('/api/auth/google', {
      method: 'POST',
      body: { credential: 12345 },
    });
    assert.ok([400, 503].includes(invalidRes.status));
  });

  it('validates GitHub login input', async () => {
    // Missing code
    const emptyRes = await api('/api/auth/github', {
      method: 'POST',
      body: {},
    });
    // Either 400 (invalid code) or 503 (not configured)
    assert.ok([400, 503].includes(emptyRes.status));

    // Invalid non-string code
    const invalidRes = await api('/api/auth/github', {
      method: 'POST',
      body: { code: 99999 },
    });
    assert.ok([400, 503].includes(invalidRes.status));
  });

  it('logs out successfully via /api/auth/logout', async () => {
    const getLogout = await api('/api/auth/logout');
    assert.equal(getLogout.status, 200);
    assert.equal(getLogout.body.success, true);

    const postLogout = await api('/api/auth/logout', { method: 'POST' });
    assert.equal(postLogout.status, 200);
    assert.equal(postLogout.body.success, true);
  });
});
