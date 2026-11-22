import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import {
  api,
  registerUser,
  insertBookingDirect,
  getTestDb,
  closeTestDb,
  assertError,
  assertSuccess,
} from './helpers.js';

let renter;
let otherRenter;

describe('Demo Payments API', () => {
  before(async () => {
    [renter, otherRenter] = await Promise.all([
      registerUser('renter', 'demoPaymentRenter'),
      registerUser('renter', 'demoPaymentOtherRenter'),
    ]);
  });

  it('requires authentication and prevents paying another renter’s booking', async () => {
    const booking = await insertBookingDirect({
      renterId: new ObjectId(renter.user.id ?? renter.user._id),
      bookingStatus: 'pending',
    });

    assertError(
      await api('/api/payments/checkout', {
        method: 'POST',
        body: { bookingId: booking._id.toString(), paymentMethod: 'demo_card', outcome: 'success' },
      }),
      401,
      'no token',
    );
    assertError(
      await api('/api/payments/checkout', {
        method: 'POST',
        token: otherRenter.token,
        body: { bookingId: booking._id.toString(), paymentMethod: 'demo_card', outcome: 'success' },
      }),
      403,
      'only the renter',
    );
  });

  it('validates payment method and simulated outcome', async () => {
    const booking = await insertBookingDirect({
      renterId: new ObjectId(renter.user.id ?? renter.user._id),
      bookingStatus: 'pending',
    });
    for (const body of [
      { bookingId: booking._id.toString(), paymentMethod: 'unsupported', outcome: 'success' },
      { bookingId: booking._id.toString(), paymentMethod: 'demo_card', outcome: 'unknown' },
    ]) {
      assertError(
        await api('/api/payments/checkout', { method: 'POST', token: renter.token, body }),
        400,
      );
    }
  });

  it('uses database pricing, records a successful payment, and rejects duplicates', async () => {
    const booking = await insertBookingDirect({
      renterId: new ObjectId(renter.user.id ?? renter.user._id),
      bookingStatus: 'pending',
      pricePerDay: 12.35,
      quantity: 2,
      totalDays: 3,
      totalAmount: 0.01,
    });
    const checkout = assertSuccess(
      await api('/api/payments/checkout', {
        method: 'POST',
        token: renter.token,
        body: {
          bookingId: booking._id.toString(),
          paymentMethod: 'demo_card',
          outcome: 'success',
          amount: 0.01,
          renterId: new ObjectId().toString(),
        },
      }),
      201,
    );

    assert.equal(
      checkout.transaction.amount,
      booking.pricePerDay * booking.quantity * booking.totalDays,
    );
    assert.equal(checkout.transaction.bookingId, booking._id.toString());
    assert.equal(checkout.transaction.renterId, renter.user.id ?? renter.user._id);
    assert.equal(checkout.transaction.paymentMethod, 'demo_card');
    assert.equal(checkout.transaction.status, 'success');
    assert.ok(checkout.transaction.transactionId);
    assert.ok(checkout.transaction.createdAt);
    assert.ok(checkout.transaction.updatedAt);

    const { db } = await getTestDb();
    const paidBooking = await db.collection('bookings').findOne({ _id: booking._id });
    assert.equal(paidBooking.paymentStatus, 'paid');
    assert.equal(paidBooking.paymentTransactionId, checkout.transaction.transactionId);

    assertError(
      await api('/api/payments/checkout', {
        method: 'POST',
        token: renter.token,
        body: {
          bookingId: booking._id.toString(),
          paymentMethod: 'bkash_demo',
          outcome: 'success',
        },
      }),
      409,
      'already been paid',
    );
    assert.equal(
      await db.collection('paymentTransactions').countDocuments({
        bookingId: booking._id,
        status: 'success',
      }),
      1,
    );

    const history = assertSuccess(await api('/api/payments/my', { token: renter.token }));
    assert.ok(history.payments.some(
      (payment) => payment.transactionId === checkout.transaction.transactionId,
    ));
  });

  it('records failed and cancelled attempts without marking bookings paid', async () => {
    const failedBooking = await insertBookingDirect({
      renterId: new ObjectId(renter.user.id ?? renter.user._id),
      bookingStatus: 'pending',
    });
    const cancelledBooking = await insertBookingDirect({
      renterId: new ObjectId(renter.user.id ?? renter.user._id),
      bookingStatus: 'pending',
    });

    for (const [booking, outcome, method] of [
      [failedBooking, 'failed', 'bkash_demo'],
      [cancelledBooking, 'cancelled', 'nagad_demo'],
    ]) {
      const result = assertSuccess(
        await api('/api/payments/checkout', {
          method: 'POST',
          token: renter.token,
          body: { bookingId: booking._id.toString(), paymentMethod: method, outcome },
        }),
        201,
      );
      assert.equal(result.transaction.status, outcome);
      assert.equal(result.transaction.paymentMethod, method);
    }

    const { db } = await getTestDb();
    for (const booking of [failedBooking, cancelledBooking]) {
      const storedBooking = await db.collection('bookings').findOne({ _id: booking._id });
      assert.equal(storedBooking.paymentStatus, 'unpaid');
    }
    assert.equal(
      await db.collection('paymentTransactions').countDocuments({
        bookingId: { $in: [failedBooking._id, cancelledBooking._id] },
      }),
      2,
    );
  });

  after(async () => {
    await closeTestDb();
  });
});
