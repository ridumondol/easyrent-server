import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import {
  api,
  registerUser,
  createEquipment,
  insertEquipmentDirect,
  insertBookingDirect,
  getTestDb,
  closeTestDb,
  dateString,
  bookingPayload,
  assertError,
  assertSuccess,
} from './helpers.js';

const dateAt = (offset) => new Date(`${dateString(offset)}T00:00:00.000Z`);

describe('Booking & Rental Management System', () => {
  let renterA;
  let renterB;
  let ownerA;
  let ownerB;

  before(async () => {
    [renterA, renterB, ownerA, ownerB] = await Promise.all([
      registerUser('renter', 'renterA'),
      registerUser('renter', 'renterB'),
      registerUser('owner', 'ownerA'),
      registerUser('owner', 'ownerB'),
    ]);
  });

  after(async () => {
    await closeTestDb();
  });

  // ── Authentication & creation validation ──────────────────────────────
  describe('Create booking — authentication & validation', () => {
    it('rejects a booking without a token (401)', async () => {
      const response = await api('/api/bookings', {
        method: 'POST',
        body: bookingPayload(new ObjectId().toString()),
      });
      assertError(response, 401, 'no token');
    });

    it('rejects a malformed equipment ID (400)', async () => {
      const response = await api('/api/bookings', {
        method: 'POST',
        token: renterA.token,
        body: bookingPayload('not-a-valid-object-id'),
      });
      assertError(response, 400, 'invalid equipment id');
    });

    it('rejects a well-formed but nonexistent equipment ID (404)', async () => {
      const response = await api('/api/bookings', {
        method: 'POST',
        token: renterA.token,
        body: bookingPayload(new ObjectId().toString()),
      });
      assertError(response, 404, 'equipment not found');
    });

    it('rejects unapproved equipment (400)', async () => {
      const equipmentId = await createEquipment(
        ownerA.token,
        { title: 'Unapproved Drill' },
        { approve: false },
      );
      const response = await api('/api/bookings', {
        method: 'POST',
        token: renterA.token,
        body: bookingPayload(equipmentId),
      });
      assertError(response, 400, 'not approved');
    });

    it('rejects equipment flagged unavailable (400)', async () => {
      const equipmentId = await insertEquipmentDirect({ availability: false });
      const response = await api('/api/bookings', {
        method: 'POST',
        token: renterA.token,
        body: bookingPayload(equipmentId.toString()),
      });
      assertError(response, 400, 'unavailable');
    });

    it('rejects missing dates (400)', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const payload = bookingPayload(equipmentId);
      delete payload.startDate;
      const response = await api('/api/bookings', {
        method: 'POST',
        token: renterA.token,
        body: payload,
      });
      assertError(response, 400, 'startDate and endDate are required');
    });

    it('rejects invalid date strings (400)', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const response = await api('/api/bookings', {
        method: 'POST',
        token: renterA.token,
        body: bookingPayload(equipmentId, { startDate: 'not-a-date' }),
      });
      assertError(response, 400, 'invalid start date');
    });

    it('rejects an impossible calendar date (400)', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const response = await api('/api/bookings', {
        method: 'POST',
        token: renterA.token,
        body: bookingPayload(equipmentId, { startDate: '2030-02-30' }),
      });
      assertError(response, 400, 'invalid start date');
    });

    it('rejects a past start date (400)', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const response = await api('/api/bookings', {
        method: 'POST',
        token: renterA.token,
        body: bookingPayload(equipmentId, { startDate: dateString(-1) }),
      });
      assertError(response, 400, 'past');
    });

    it('rejects an end date before the start date (400)', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const response = await api('/api/bookings', {
        method: 'POST',
        token: renterA.token,
        body: bookingPayload(equipmentId, {
          startDate: dateString(6),
          endDate: dateString(4),
        }),
      });
      assertError(response, 400, 'after start date');
    });

    it('rejects an end date equal to the start date (400)', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const response = await api('/api/bookings', {
        method: 'POST',
        token: renterA.token,
        body: bookingPayload(equipmentId, { endDate: dateString(5) }),
      });
      assertError(response, 400, 'after start date');
    });

    it('rejects invalid quantity values (400)', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      for (const quantity of [0, -2, 1.5, '2', null]) {
        const response = await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId, { quantity }),
        });
        assertError(response, 400, 'positive integer');
      }
    });

    it('rejects a quantity greater than total equipment stock (400)', async () => {
      const equipmentId = await createEquipment(ownerA.token, { quantity: 2 });
      const response = await api('/api/bookings', {
        method: 'POST',
        token: renterA.token,
        body: bookingPayload(equipmentId, { quantity: 5 }),
      });
      assertError(response, 400, 'exceeds');
    });

    it('rejects missing contact details (400)', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const payload = bookingPayload(equipmentId);
      delete payload.phone;
      delete payload.address;
      const response = await api('/api/bookings', {
        method: 'POST',
        token: renterA.token,
        body: payload,
      });
      assertError(response, 400, 'phone');
    });

    it('prevents a renter from booking their own equipment (403)', async () => {
      const equipmentId = await insertEquipmentDirect({
        ownerId: new ObjectId(renterA.user._id),
      });
      const response = await api('/api/bookings', {
        method: 'POST',
        token: renterA.token,
        body: bookingPayload(equipmentId.toString()),
      });
      assertError(response, 403, 'own equipment');
    });

    it('rejects an owner attempting to create a booking (403)', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const response = await api('/api/bookings', {
        method: 'POST',
        token: ownerB.token,
        body: bookingPayload(equipmentId),
      });
      assertError(response, 403, 'insufficient permissions');
    });
  });

  // ── Successful creation & server-side calculation ─────────────────────
  describe('Create booking — success & calculation', () => {
    it('creates a pending, unpaid booking with complete information (201)', async () => {
      const equipmentId = await createEquipment(ownerA.token, { pricePerDay: 95 });
      const data = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId),
        }),
        201,
      );

      const booking = data.booking;
      assert.ok(booking._id);
      assert.equal(booking.equipmentId, equipmentId);
      assert.equal(booking.renterId, renterA.user._id);
      assert.equal(booking.ownerId, ownerA.user._id);
      assert.equal(booking.quantity, 1);
      assert.equal(booking.bookingStatus, 'pending');
      assert.equal(booking.paymentStatus, 'unpaid');
      for (const field of [
        'startDate', 'endDate', 'pricePerDay', 'totalDays', 'totalAmount',
        'phone', 'address', 'notes', 'createdAt', 'updatedAt',
      ]) {
        assert.ok(field in booking, `missing field: ${field}`);
      }
    });

    it('calculates days and amount from database price, ignoring frontend values', async () => {
      const equipmentId = await createEquipment(ownerA.token, {
        pricePerDay: 137.5,
        quantity: 4,
      });
      const data = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId, {
            startDate: dateString(10),
            endDate: dateString(14),
            quantity: 2,
            pricePerDay: 1,
            totalDays: 1,
            totalAmount: 1,
          }),
        }),
        201,
      );

      const booking = data.booking;
      assert.equal(booking.totalDays, 4);
      assert.equal(booking.pricePerDay, 137.5);
      assert.equal(booking.totalAmount, 137.5 * 2 * 4);
    });

    it('persists the booking into the bookings collection', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const data = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterB.token,
          body: bookingPayload(equipmentId),
        }),
        201,
      );
      const { db } = await getTestDb();
      const stored = await db.collection('bookings').findOne({
        _id: new ObjectId(data.booking._id),
      });
      assert.ok(stored);
      assert.equal(stored.bookingStatus, 'pending');
      assert.equal(stored.paymentStatus, 'unpaid');
    });
  });

  // ── Availability, overlap & quantity ──────────────────────────────────
  describe('Availability & overlap handling', () => {
    it('blocks overlapping dates when a confirmed booking exists (409)', async () => {
      const equipmentId = await createEquipment(ownerA.token, { quantity: 1 });
      const first = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId),
        }),
        201,
      ).booking;
      assertSuccess(
        await api('/api/payments/checkout', {
          method: 'POST',
          token: renterA.token,
          body: {
            bookingId: first._id,
            paymentMethod: 'demo_card',
            outcome: 'success',
          },
        }),
        201,
      );

      assertSuccess(
        await api(`/api/bookings/${first._id}/status`, {
          method: 'PATCH',
          token: ownerA.token,
          body: { bookingStatus: 'confirmed' },
        }),
      );

      const conflict = await api('/api/bookings', {
        method: 'POST',
        token: renterB.token,
        body: bookingPayload(equipmentId, {
          startDate: dateString(6),
          endDate: dateString(9),
        }),
      });
      assertError(conflict, 409, 'not available');
    });

    it('treats back-to-back date ranges as non-overlapping', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      await insertBookingDirect({
        equipmentId: new ObjectId(equipmentId),
        ownerId: new ObjectId(ownerA.user._id),
        startDate: dateAt(5),
        endDate: dateAt(8),
        bookingStatus: 'confirmed',
        quantity: 1,
      });

      const data = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterB.token,
          body: bookingPayload(equipmentId, {
            startDate: dateString(8),
            endDate: dateString(10),
          }),
        }),
        201,
      );
      assert.equal(data.booking.totalDays, 2);
    });

    it('allows booking completely different date ranges', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      await insertBookingDirect({
        equipmentId: new ObjectId(equipmentId),
        ownerId: new ObjectId(ownerA.user._id),
        startDate: dateAt(5),
        endDate: dateAt(8),
        bookingStatus: 'confirmed',
      });

      const data = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterB.token,
          body: bookingPayload(equipmentId, {
            startDate: dateString(20),
            endDate: dateString(23),
          }),
        }),
        201,
      );
      assert.ok(data.booking._id);
    });

    it('counts fresh pending bookings toward availability', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId, { quantity: 3 }),
        }),
        201,
      );

      const response = await api('/api/bookings', {
        method: 'POST',
        token: renterB.token,
        body: bookingPayload(equipmentId, { quantity: 1 }),
      });
      assertError(response, 409, 'not available');
    });

    it('does not let stale pending bookings block equipment indefinitely', async () => {
      const equipmentId = await createEquipment(ownerA.token, { quantity: 2 });
      await insertBookingDirect({
        equipmentId: new ObjectId(equipmentId),
        ownerId: new ObjectId(ownerA.user._id),
        startDate: dateAt(5),
        endDate: dateAt(8),
        bookingStatus: 'pending',
        quantity: 2,
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      });

      const data = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId, { quantity: 2 }),
        }),
        201,
      );
      assert.equal(data.booking.quantity, 2);
    });

    it('ignores cancelled bookings when checking availability', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const first = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId),
        }),
        201,
      ).booking;
      assertSuccess(
        await api(`/api/bookings/${first._id}/cancel`, {
          method: 'PATCH',
          token: renterA.token,
        }),
      );

      const data = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterB.token,
          body: bookingPayload(equipmentId),
        }),
        201,
      );
      assert.ok(data.booking._id);
    });

    it('enforces quantity-based availability and prevents overbooking', async () => {
      const equipmentId = await createEquipment(ownerA.token, { quantity: 3 });
      await insertBookingDirect({
        equipmentId: new ObjectId(equipmentId),
        ownerId: new ObjectId(ownerA.user._id),
        startDate: dateAt(5),
        endDate: dateAt(8),
        bookingStatus: 'confirmed',
        quantity: 2,
      });

      const tooMany = await api('/api/bookings', {
        method: 'POST',
        token: renterA.token,
        body: bookingPayload(equipmentId, { quantity: 2 }),
      });
      assertError(tooMany, 409, 'not available');

      const fits = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterB.token,
          body: bookingPayload(equipmentId, { quantity: 1 }),
        }),
        201,
      );
      assert.equal(fits.booking.quantity, 1);
    });

    it('exposes correct availability through the public availability endpoint', async () => {
      const equipmentId = await createEquipment(ownerA.token, {
        pricePerDay: 40,
        quantity: 4,
      });
      await insertBookingDirect({
        equipmentId: new ObjectId(equipmentId),
        ownerId: new ObjectId(ownerA.user._id),
        startDate: dateAt(5),
        endDate: dateAt(8),
        bookingStatus: 'confirmed',
        quantity: 1,
      });

      const data = assertSuccess(
        await api(
          `/api/bookings/availability?equipmentId=${equipmentId}` +
            `&startDate=${dateString(5)}&endDate=${dateString(8)}&quantity=2`,
        ),
      );
      assert.equal(data.stock, 4);
      assert.equal(data.blockedQuantity, 1);
      assert.equal(data.availableQuantity, 3);
      assert.equal(data.isAvailable, true);
      assert.equal(data.totalDays, 3);
      assert.equal(data.estimatedTotal, 40 * 2 * 3);
    });

    it('reports insufficient availability when requested quantity exceeds stock', async () => {
      const equipmentId = await createEquipment(ownerA.token, { quantity: 3 });
      await insertBookingDirect({
        equipmentId: new ObjectId(equipmentId),
        ownerId: new ObjectId(ownerA.user._id),
        startDate: dateAt(5),
        endDate: dateAt(8),
        bookingStatus: 'confirmed',
        quantity: 2,
      });

      const data = assertSuccess(
        await api(
          `/api/bookings/availability?equipmentId=${equipmentId}` +
            `&startDate=${dateString(5)}&endDate=${dateString(8)}&quantity=2`,
        ),
      );
      assert.equal(data.availableQuantity, 1);
      assert.equal(data.isAvailable, false);
    });
  });

  // ── Renter access control ─────────────────────────────────────────────
  describe('Renter booking APIs', () => {
    it('GET /my requires authentication (401)', async () => {
      assertError(await api('/api/bookings/my'), 401, 'no token');
    });

    it('GET /my returns only the renter’s own bookings', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const mine = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId),
        }),
        201,
      ).booking;
      await api('/api/bookings', {
        method: 'POST',
        token: renterB.token,
        body: bookingPayload(equipmentId, {
          startDate: dateString(25),
          endDate: dateString(28),
        }),
      });

      const data = assertSuccess(await api('/api/bookings/my', { token: renterA.token }));
      assert.ok(Array.isArray(data.bookings));
      assert.ok(data.bookings.some((booking) => booking._id === mine._id));
      assert.ok(
        data.bookings.every((booking) => booking.renterId === renterA.user._id),
      );
    });

    it('GET /my supports a status filter', async () => {
      const data = assertSuccess(
        await api('/api/bookings/my?bookingStatus=pending', { token: renterA.token }),
      );
      assert.ok(
        data.bookings.every((booking) => booking.bookingStatus === 'pending'),
      );
    });

    it('GET /my paginates results and validates page parameters', async () => {
      const equipmentId = await createEquipment(ownerA.token, { title: 'Booking Pagination Equipment' });
      for (let index = 0; index < 2; index += 1) {
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId, {
            startDate: dateString(60 + index * 5),
            endDate: dateString(63 + index * 5),
          }),
        });
      }

      const firstPage = assertSuccess(
        await api('/api/bookings/my?page=1&limit=1', { token: renterA.token }),
      );
      const secondPage = assertSuccess(
        await api('/api/bookings/my?page=2&limit=1', { token: renterA.token }),
      );
      assert.equal(firstPage.bookings.length, 1);
      assert.equal(firstPage.pagination.itemsPerPage, 1);
      assert.equal(firstPage.pagination.totalItems, firstPage.count);
      assert.ok(firstPage.pagination.totalPages >= 2);
      assert.notEqual(firstPage.bookings[0]._id, secondPage.bookings[0]._id);
      assertError(
        await api('/api/bookings/my?page=invalid', { token: renterA.token }),
        400,
        'page must be positive',
      );
    });

    it('rejects an invalid booking ID on GET /:id (400)', async () => {
      assertError(
        await api('/api/bookings/bad-id', { token: renterA.token }),
        400,
        'invalid booking id',
      );
    });

    it('returns 404 for a nonexistent booking ID', async () => {
      assertError(
        await api(`/api/bookings/${new ObjectId().toString()}`, { token: renterA.token }),
        404,
        'booking not found',
      );
    });

    it('lets a renter read their own booking (200)', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const booking = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId),
        }),
        201,
      ).booking;

      const data = assertSuccess(
        await api(`/api/bookings/${booking._id}`, { token: renterA.token }),
      );
      assert.equal(data.booking._id, booking._id);
    });

    it('prevents a renter from reading another renter’s booking (403)', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const booking = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId),
        }),
        201,
      ).booking;

      assertError(
        await api(`/api/bookings/${booking._id}`, { token: renterB.token }),
        403,
        'not authorized',
      );
    });

    it('prevents a renter from cancelling another renter’s booking (403)', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const booking = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId),
        }),
        201,
      ).booking;

      assertError(
        await api(`/api/bookings/${booking._id}/cancel`, {
          method: 'PATCH',
          token: renterB.token,
        }),
        403,
        'not authorized',
      );
    });
  });

  // ── Cancellation ──────────────────────────────────────────────────────
  describe('Booking cancellation', () => {
    it('lets a renter cancel their own pending booking', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const booking = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId),
        }),
        201,
      ).booking;

      const data = assertSuccess(
        await api(`/api/bookings/${booking._id}/cancel`, {
          method: 'PATCH',
          token: renterA.token,
        }),
      );
      assert.equal(data.booking.bookingStatus, 'cancelled');
      assert.ok(data.booking.updatedAt);
    });

    it('rejects cancelling an already cancelled booking (400)', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const booking = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId),
        }),
        201,
      ).booking;
      await api(`/api/bookings/${booking._id}/cancel`, {
        method: 'PATCH',
        token: renterA.token,
      });

      assertError(
        await api(`/api/bookings/${booking._id}/cancel`, {
          method: 'PATCH',
          token: renterA.token,
        }),
        400,
        'cannot be cancelled',
      );
    });

    it('queues a full refund when a paid booking is cancelled', async () => {
      const paymentTransactionId = `cancel_paid_${new ObjectId()}`;
      const seeded = await insertBookingDirect({
        renterId: new ObjectId(renterA.user._id),
        ownerId: new ObjectId(ownerA.user._id),
        bookingStatus: 'confirmed',
        paymentStatus: 'paid',
        paymentTransactionId,
      });
      const { db } = await getTestDb();
      await db.collection('paymentTransactions').insertOne({
        bookingId: seeded._id,
        renterId: seeded.renterId,
        transactionId: paymentTransactionId,
        paymentMethod: 'demo_card',
        status: 'success',
      });

      const data = assertSuccess(
        await api(`/api/bookings/${seeded._id}/cancel`, {
          method: 'PATCH',
          token: renterA.token,
        }),
      );
      assert.equal(data.booking.bookingStatus, 'cancelled');
      assert.equal(data.booking.paymentStatus, 'paid');
      assert.equal(data.booking.refundStatus, 'pending');
      const refundedTransaction = await db.collection('paymentTransactions').findOne({
        bookingId: seeded._id,
      });
      assert.equal(refundedTransaction.status, 'success');
    });
  });

  // ── Owner access & status management ──────────────────────────────────
  describe('Owner booking APIs', () => {
    it('GET /owner requires authentication (401)', async () => {
      assertError(await api('/api/bookings/owner'), 401, 'no token');
    });

    it('prevents a renter from accessing owner endpoints (403)', async () => {
      assertError(
        await api('/api/bookings/owner', { token: renterA.token }),
        403,
        'insufficient permissions',
      );
    });

    it('GET /owner returns only bookings for the owner’s equipment', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const mine = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId),
        }),
        201,
      ).booking;
      await insertBookingDirect({
        ownerId: new ObjectId(ownerB.user._id),
        renterId: new ObjectId(renterB.user._id),
      });

      const data = assertSuccess(
        await api('/api/bookings/owner', { token: ownerA.token }),
      );
      assert.ok(data.bookings.some((booking) => booking._id === mine._id));
      assert.ok(
        data.bookings.every((booking) => booking.ownerId === ownerA.user._id),
      );
    });

    it('lets an owner view a booking for their own equipment (200)', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const booking = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId),
        }),
        201,
      ).booking;

      const data = assertSuccess(
        await api(`/api/bookings/${booking._id}`, { token: ownerA.token }),
      );
      assert.equal(data.booking._id, booking._id);
    });

    it('prevents an owner from viewing an unrelated booking (403)', async () => {
      const seeded = await insertBookingDirect();
      assertError(
        await api(`/api/bookings/${seeded._id}`, { token: ownerA.token }),
        403,
        'not authorized',
      );
    });

    it('allows an owner to confirm a paid pending booking', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const booking = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId),
        }),
        201,
      ).booking;
      assertSuccess(
        await api('/api/payments/checkout', {
          method: 'POST',
          token: renterA.token,
          body: {
            bookingId: booking._id,
            paymentMethod: 'demo_card',
            outcome: 'success',
          },
        }),
        201,
      );

      const data = assertSuccess(
        await api(`/api/bookings/${booking._id}/status`, {
          method: 'PATCH',
          token: ownerA.token,
          body: { bookingStatus: 'confirmed' },
        }),
      );
      assert.equal(data.booking.bookingStatus, 'confirmed');
      assert.equal(data.booking.paymentStatus, 'paid');
    });

    it('allows an owner to confirm an unpaid pending booking', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const booking = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId),
        }),
        201,
      ).booking;

      const data = assertSuccess(
        await api(`/api/bookings/${booking._id}/status`, {
          method: 'PATCH',
          token: ownerA.token,
          body: { bookingStatus: 'confirmed' },
        }),
        200,
      );
      assert.equal(data.booking.bookingStatus, 'confirmed');
      assert.equal(data.booking.paymentStatus, 'unpaid');
    });

    it('allows an owner to reject a pending booking', async () => {
      const equipmentId = await createEquipment(ownerA.token);
      const booking = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId),
        }),
        201,
      ).booking;

      const data = assertSuccess(
        await api(`/api/bookings/${booking._id}/status`, {
          method: 'PATCH',
          token: ownerA.token,
          body: { bookingStatus: 'cancelled' },
        }),
      );
      assert.equal(data.booking.bookingStatus, 'cancelled');
    });

    it('prevents an owner from confirming another owner’s booking (403)', async () => {
      const equipmentId = await createEquipment(ownerB.token);
      const booking = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId),
        }),
        201,
      ).booking;

      assertError(
        await api(`/api/bookings/${booking._id}/status`, {
          method: 'PATCH',
          token: ownerA.token,
          body: { bookingStatus: 'confirmed' },
        }),
        403,
        'not authorized',
      );
    });

    it('rejects an invalid booking status value (400)', async () => {
      const seeded = await insertBookingDirect({
        ownerId: new ObjectId(ownerA.user._id),
        bookingStatus: 'pending',
      });
      assertError(
        await api(`/api/bookings/${seeded._id}/status`, {
          method: 'PATCH',
          token: ownerA.token,
          body: { bookingStatus: 'unknown' },
        }),
        400,
        'bookingStatus must be one of',
      );
    });

    it('rejects an invalid status transition (400)', async () => {
      const seeded = await insertBookingDirect({
        ownerId: new ObjectId(ownerA.user._id),
        bookingStatus: 'cancelled',
      });
      assertError(
        await api(`/api/bookings/${seeded._id}/status`, {
          method: 'PATCH',
          token: ownerA.token,
          body: { bookingStatus: 'confirmed' },
        }),
        400,
        'cannot change',
      );
    });

    it('allows an owner to mark a confirmed booking as completed', async () => {
      const seeded = await insertBookingDirect({
        ownerId: new ObjectId(ownerA.user._id),
        bookingStatus: 'confirmed',
      });
      const data = assertSuccess(
        await api(`/api/bookings/${seeded._id}/status`, {
          method: 'PATCH',
          token: ownerA.token,
          body: { bookingStatus: 'completed' },
        }),
      );
      assert.equal(data.booking.bookingStatus, 'completed');
    });

    it('allows an owner to mark a completed booking as paid without changing its status', async () => {
      const seeded = await insertBookingDirect({
        renterId: new ObjectId(renterA.user._id),
        ownerId: new ObjectId(ownerA.user._id),
        bookingStatus: 'completed',
      });

      const data = assertSuccess(
        await api(`/api/bookings/${seeded._id}/status`, {
          method: 'PATCH',
          token: ownerA.token,
          body: { paymentStatus: 'paid' },
        }),
      );

      assert.equal(data.booking.bookingStatus, 'completed');
      assert.equal(data.booking.paymentStatus, 'paid');
    });

    it('ignores a repeated completed status when marking payment as paid', async () => {
      const seeded = await insertBookingDirect({
        renterId: new ObjectId(renterA.user._id),
        ownerId: new ObjectId(ownerA.user._id),
        bookingStatus: 'completed',
      });

      const data = assertSuccess(
        await api(`/api/bookings/${seeded._id}/status`, {
          method: 'PATCH',
          token: ownerA.token,
          body: { bookingStatus: 'completed', paymentStatus: 'paid' },
        }),
      );

      assert.equal(data.booking.bookingStatus, 'completed');
      assert.equal(data.booking.paymentStatus, 'paid');
    });

    it('treats completed bookings as terminal (400)', async () => {
      const seeded = await insertBookingDirect({
        renterId: new ObjectId(renterA.user._id),
        ownerId: new ObjectId(ownerA.user._id),
        bookingStatus: 'completed',
      });
      assertError(
        await api(`/api/bookings/${seeded._id}/status`, {
          method: 'PATCH',
          token: ownerA.token,
          body: { bookingStatus: 'confirmed' },
        }),
        400,
        'cannot change',
      );
      assertError(
        await api(`/api/bookings/${seeded._id}/cancel`, {
          method: 'PATCH',
          token: renterA.token,
        }),
        400,
        'cannot be cancelled',
      );
    });

    it('re-checks availability before confirming a pending booking (409)', async () => {
      const equipmentId = await createEquipment(ownerA.token, { quantity: 2 });
      const pending = assertSuccess(
        await api('/api/bookings', {
          method: 'POST',
          token: renterA.token,
          body: bookingPayload(equipmentId, { quantity: 2 }),
        }),
        201,
      ).booking;
      assertSuccess(
        await api('/api/payments/checkout', {
          method: 'POST',
          token: renterA.token,
          body: {
            bookingId: pending._id,
            paymentMethod: 'demo_card',
            outcome: 'success',
          },
        }),
        201,
      );

      // Another party takes all stock while the booking is still pending.
      await insertBookingDirect({
        equipmentId: new ObjectId(equipmentId),
        ownerId: new ObjectId(ownerA.user._id),
        startDate: dateAt(5),
        endDate: dateAt(8),
        quantity: 2,
        bookingStatus: 'confirmed',
      });

      assertError(
        await api(`/api/bookings/${pending._id}/status`, {
          method: 'PATCH',
          token: ownerA.token,
          body: { bookingStatus: 'confirmed' },
        }),
        409,
        'not enough equipment quantity',
      );
    });
  });

  after(async () => {
    await closeTestDb();
  });
});
