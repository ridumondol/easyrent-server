import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { generateToken } from '../utils/jwt.js';
import {
  api,
  registerUser,
  createEquipment,
  getTestDb,
  closeTestDb,
  assertError,
  assertSuccess,
} from './helpers.js';

describe('Admin API', () => {
  let admin;
  let renter;
  let owner;

  before(async () => {
    [renter, owner] = await Promise.all([
      registerUser('renter', 'adminTestRenter'),
      registerUser('owner', 'adminTestOwner'),
    ]);

    const { db } = await getTestDb();
    const adminUser = {
      name: 'Test Admin',
      email: `admin_${Date.now()}@example.test`,
      passwordHash: 'not-used-by-this-test',
      role: 'admin',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection('users').insertOne(adminUser);
    admin = {
      user: { _id: result.insertedId.toString(), ...adminUser },
      token: generateToken({
        userId: result.insertedId,
        email: adminUser.email,
        role: 'renter',
      }),
    };
  });

  it('requires authentication and checks the current database role', async () => {
    assertError(await api('/api/admin/users'), 401, 'no token');
    assertError(await api('/api/admin/users', { token: renter.token }), 403, 'permissions');

    const forgedRoleClaim = generateToken({
      userId: new ObjectId(renter.user._id),
      email: renter.user.email,
      role: 'admin',
    });
    assertError(await api('/api/admin/users', { token: forgedRoleClaim }), 403, 'permissions');
    assertSuccess(await api('/api/admin/users', { token: admin.token }));
  });

  it('returns real overview data and joins equipment and rental records', async () => {
    const equipmentId = await createEquipment(owner.token, { title: 'Admin listing' }, { approve: false });
    const { db } = await getTestDb();
    const equipmentObjectId = new ObjectId(equipmentId);
    const renterId = new ObjectId(renter.user._id);
    const ownerId = new ObjectId(owner.user._id);
    await db.collection('bookings').insertOne({
      equipmentId: equipmentObjectId,
      renterId,
      ownerId,
      startDate: new Date('2031-02-01T00:00:00.000Z'),
      endDate: new Date('2031-02-04T00:00:00.000Z'),
      totalDays: 3,
      quantity: 1,
      totalAmount: 360,
      bookingStatus: 'completed',
      paymentStatus: 'paid',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const overview = assertSuccess(await api('/api/admin/overview', { token: admin.token })).overview;
    assert.ok(overview.totalUsers >= 3);
    assert.ok(overview.totalEquipment >= 1);
    assert.ok(overview.totalBookings >= 1);
    assert.ok(overview.pendingEquipmentApprovals >= 1);
    assert.ok(overview.completedRentals >= 1);
    assert.ok(overview.totalRevenue >= 360);
    assert.equal(overview.monthlyBookings.length, 12);

    const equipment = assertSuccess(await api('/api/admin/equipment', { token: admin.token }));
    assert.equal(
      equipment.equipment.find((item) => item._id === equipmentId).owner.email,
      owner.email.toLowerCase(),
    );

    const bookings = assertSuccess(await api('/api/admin/bookings', { token: admin.token }));
    const booking = bookings.bookings.find((item) => item.equipmentId === equipmentId);
    assert.equal(booking.renter.email, renter.email.toLowerCase());
    assert.equal(booking.owner.email, owner.email.toLowerCase());
    assert.equal(booking.equipment.title, 'Admin listing');
  });

  it('allows admins to change roles and edit their profile without allowing privilege self-removal', async () => {
    const roleResult = assertSuccess(await api(`/api/admin/users/${renter.user._id}/role`, {
      method: 'PATCH',
      token: admin.token,
      body: { role: 'owner' },
    }));
    assert.equal(roleResult.user.role, 'owner');

    assertError(await api(`/api/admin/users/${admin.user._id}/role`, {
      method: 'PATCH',
      token: admin.token,
      body: { role: 'renter' },
    }), 400, 'own admin role');

    const profile = assertSuccess(await api('/api/auth/me', {
      method: 'PATCH',
      token: admin.token,
      body: { name: 'Updated Admin', email: 'updated-admin@example.test', role: 'renter' },
    }));
    assert.equal(profile.user.name, 'Updated Admin');
    assert.equal(profile.user.email, 'updated-admin@example.test');
    assert.equal(profile.user.role, 'admin');
    assert.ok(!('passwordHash' in profile.user));
  });

  after(async () => {
    await closeTestDb();
  });
});
