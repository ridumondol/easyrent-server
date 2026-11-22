import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import {
  api,
  registerUser,
  getTestDb,
  createEquipment,
  closeTestDb,
  assertError,
  assertSuccess,
} from './helpers.js';

describe('Regression — existing Authentication & Equipment APIs', () => {
  let renter;
  let owner;
  let otherOwner;
  let adminToken;

  before(async () => {
    [renter, owner, otherOwner] = await Promise.all([
      registerUser('renter', 'regRenter'),
      registerUser('owner', 'regOwner'),
      registerUser('owner', 'regOwner2'),
    ]);
    const admin = await registerUser('renter', 'regAdmin');
    const { db } = await getTestDb();
    await db.collection('users').updateOne(
      { _id: new ObjectId(admin.user._id) },
      { $set: { role: 'admin' } },
    );
    adminToken = admin.token;
  });

  describe('Authentication API', () => {
    it('GET /api/health reports a connected database', async () => {
      const data = assertSuccess(await api('/api/health'));
      assert.equal(data.database, 'connected');
    });

    it('registers users with the requested role', () => {
      assert.equal(renter.user.role, 'renter');
      assert.equal(owner.user.role, 'owner');
      assert.ok(!('passwordHash' in renter.user));
    });

    it('logs in with valid credentials', async () => {
      const data = assertSuccess(
        await api('/api/auth/login', {
          method: 'POST',
          body: { email: renter.email, password: 'Secret123' },
        }),
      );
      assert.ok(data.token);
      assert.equal(data.user.email, renter.user.email);
    });

    it('rejects an invalid password (401)', async () => {
      assertError(
        await api('/api/auth/login', {
          method: 'POST',
          body: { email: renter.email, password: 'wrong-password' },
        }),
        401,
        'invalid email or password',
      );
    });

    it('rejects registration passwords without both letter cases', async () => {
      const response = await api('/api/auth/register', {
        method: 'POST',
        body: {
          name: 'Password Rule Test',
          email: `password_rule_${Date.now()}@example.test`,
          password: 'lowercase123',
        },
      });
      assertError(response, 400, 'uppercase and a lowercase letter');
    });

    it('GET /api/auth/me returns the authenticated user', async () => {
      const data = assertSuccess(await api('/api/auth/me', { token: owner.token }));
      assert.equal(data.user.email, owner.user.email);
      assert.ok(!('passwordHash' in data.user));
    });
  });

  describe('Equipment API', () => {
    it('requires authentication and an owner role to add equipment', async () => {
      const payload = {
        title: 'Test Item',
        description: 'A sufficiently long test description.',
        category: 'tools',
        pricePerDay: 10,
        location: 'Dhaka',
        image: 'https://example.com/item.jpg',
      };
      assertError(
        await api('/api/equipment', { method: 'POST', body: payload }),
        401,
        'no token',
      );
      assertError(
        await api('/api/equipment', { method: 'POST', token: renter.token, body: payload }),
        403,
        'insufficient permissions',
      );
    });

    it('creates pending equipment that is hidden from public details', async () => {
      const equipmentId = await createEquipment(
        owner.token,
        { title: 'Regression Drill' },
        { approve: false },
      );
      assertError(
        await api(`/api/equipment/${equipmentId}`),
        404,
        'not found',
      );
    });

    it('lists only approved equipment publicly', async () => {
      const approvedId = await createEquipment(owner.token, { title: 'Approved Item' });
      const unapprovedId = await createEquipment(
        owner.token,
        { title: 'Unapproved Item' },
        { approve: false },
      );

      const data = assertSuccess(await api('/api/equipment?limit=50'));
      const ids = data.equipment.map((item) => item._id);
      assert.ok(ids.includes(approvedId));
      assert.ok(!ids.includes(unapprovedId));
      assert.ok(
        data.equipment.every((item) => item.approvalStatus === 'approved'),
      );
    });

    it('searches approved equipment by location as well as title', async () => {
      const equipmentId = await createEquipment(owner.token, {
        title: 'Regional Search Demo',
        location: 'Boulder, Colorado',
      });
      const data = assertSuccess(await api('/api/equipment?search=Boulder'));
      assert.ok(data.equipment.some((item) => item._id === equipmentId));
    });

    it('lists all and only the authenticated owner’s equipment', async () => {
      const ownerItem = await createEquipment(owner.token, { title: 'Owner Dashboard Item' }, { approve: false });
      await createEquipment(otherOwner.token, { title: 'Another Owner Item' }, { approve: false });

      const data = assertSuccess(
        await api('/api/equipment/my', { token: owner.token }),
      );
      const ownerListing = data.equipment.find((item) => item._id === ownerItem);
      assert.ok(ownerListing);
      assert.equal(ownerListing.approvalStatus, 'pending');
      assert.ok(data.equipment.every(
        (item) => item.ownerId === (owner.user.id ?? owner.user._id),
      ));
      assertError(await api('/api/equipment/my', { token: renter.token }), 403);
    });

    it('allows an admin to approve equipment', async () => {
      const equipmentId = await createEquipment(
        owner.token,
        { title: 'Approval Item' },
        { approve: false },
      );
      const data = assertSuccess(
        await api(`/api/equipment/${equipmentId}/approval`, {
          method: 'PATCH',
          token: adminToken,
          body: { approvalStatus: 'approved' },
        }),
      );
      assert.equal(data.equipment.approvalStatus, 'approved');
    });

    it('prevents a non-owner from updating equipment (403)', async () => {
      const equipmentId = await createEquipment(owner.token);
      assertError(
        await api(`/api/equipment/${equipmentId}`, {
          method: 'PATCH',
          token: otherOwner.token,
          body: { pricePerDay: 999 },
        }),
        403,
        'not authorized',
      );
    });

    it('allows the owner to update and delete equipment', async () => {
      const equipmentId = await createEquipment(owner.token);
      const updated = assertSuccess(
        await api(`/api/equipment/${equipmentId}`, {
          method: 'PATCH',
          token: owner.token,
          body: { pricePerDay: 222 },
        }),
      );
      assert.equal(updated.equipment.pricePerDay, 222);

      assertSuccess(
        await api(`/api/equipment/${equipmentId}`, {
          method: 'DELETE',
          token: owner.token,
        }),
      );
      assertError(
        await api(`/api/equipment/${equipmentId}`),
        404,
        'not found',
      );
    });
  });

  after(async () => {
    await closeTestDb();
  });
});
