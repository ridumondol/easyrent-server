import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTestDb,
  insertBookingDirect,
  insertEquipmentDirect,
  closeTestDb,
} from './helpers.js';
import { connectToDatabase, closeDatabase } from '../config/db.js';
import { runPendingBookingLifecycle } from '../services/bookingLifecycleService.js';
import { getDateAvailability } from '../utils/availability.js';

describe('Pending booking lifecycle', () => {
  before(async () => {
    await connectToDatabase();
  });

  after(async () => {
    await closeTestDb();
    await closeDatabase();
  });

  it('cancels expired unpaid bookings and releases their stock', async () => {
    const now = new Date();
    const equipmentId = await insertEquipmentDirect({ quantity: 1 });
    const booking = await insertBookingDirect({
      equipmentId,
      bookingStatus: 'pending',
      paymentStatus: 'unpaid',
      createdAt: new Date(now.getTime() - 31 * 60 * 1000),
    });

    const result = await runPendingBookingLifecycle(now, async () => {
      assert.fail('An unpaid booking must not be refunded.');
    });

    const { db } = await getTestDb();
    const storedBooking = await db.collection('bookings').findOne({ _id: booking._id });
    const equipment = await db.collection('equipment').findOne({ _id: equipmentId });
    const availability = await getDateAvailability({
      equipment,
      startDate: booking.startDate,
      endDate: booking.endDate,
    });

    assert.equal(result.expiredUnpaidCount, 1);
    assert.equal(storedBooking.bookingStatus, 'cancelled');
    assert.equal(storedBooking.cancellationReason, 'payment_hold_expired');
    assert.equal(availability.availableQuantity, 1);
  });

  it('keeps paid pending bookings reserved beyond the unpaid hold', async () => {
    const now = new Date();
    const equipmentId = await insertEquipmentDirect({ quantity: 1 });
    const booking = await insertBookingDirect({
      equipmentId,
      bookingStatus: 'pending',
      paymentStatus: 'paid',
      createdAt: new Date(now.getTime() - 31 * 60 * 1000),
      paidAt: new Date(now.getTime() - 23 * 60 * 60 * 1000),
    });
    const { db } = await getTestDb();
    const equipment = await db.collection('equipment').findOne({ _id: equipmentId });

    const availability = await getDateAvailability({
      equipment,
      startDate: booking.startDate,
      endDate: booking.endDate,
    });

    assert.equal(availability.availableQuantity, 0);
  });

  it('cancels and fully refunds paid bookings not accepted within 24 hours', async () => {
    const now = new Date();
    const booking = await insertBookingDirect({
      bookingStatus: 'pending',
      paymentStatus: 'paid',
      paidAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
      paymentTransactionId: 'auto-refund-test',
    });
    const { db } = await getTestDb();
    await db.collection('payments').insertOne({
      bookingId: booking._id,
      renterId: booking.renterId,
      transactionId: booking.paymentTransactionId,
      stripePaymentIntentId: 'pi_test_auto_refund',
      status: 'success',
    });

    let refundCall;
    const result = await runPendingBookingLifecycle(now, async (paymentIntentId, idempotencyKey) => {
      refundCall = { paymentIntentId, idempotencyKey };
      return { id: 're_test_auto_refund' };
    });

    const storedBooking = await db.collection('bookings').findOne({ _id: booking._id });
    const storedPayment = await db.collection('payments').findOne({ bookingId: booking._id });

    assert.equal(result.refundedCount, 1);
    assert.deepEqual(refundCall, {
      paymentIntentId: 'pi_test_auto_refund',
      idempotencyKey: `rentora-payment-refund-${booking.paymentTransactionId}`,
    });
    assert.equal(storedBooking.bookingStatus, 'cancelled');
    assert.equal(storedBooking.paymentStatus, 'refunded');
    assert.equal(storedBooking.refundStatus, 'succeeded');
    assert.equal(storedPayment.status, 'refunded');
    assert.equal(storedPayment.stripeRefundId, 're_test_auto_refund');
  });

  it('retries refunds after a transient Stripe refund failure', async () => {
    const now = new Date();
    const booking = await insertBookingDirect({
      bookingStatus: 'cancelled',
      paymentStatus: 'paid',
      refundStatus: 'pending',
      paymentTransactionId: 'auto-refund-retry-test',
    });
    const { db } = await getTestDb();
    await db.collection('payments').insertOne({
      bookingId: booking._id,
      renterId: booking.renterId,
      transactionId: booking.paymentTransactionId,
      stripePaymentIntentId: 'pi_test_refund_retry',
      status: 'success',
    });

    await runPendingBookingLifecycle(now, async () => {
      throw new Error('Temporary Stripe failure');
    });
    const failedBooking = await db.collection('bookings').findOne({ _id: booking._id });
    assert.equal(failedBooking.refundStatus, 'failed');
    assert.equal(failedBooking.paymentStatus, 'paid');

    const retry = await runPendingBookingLifecycle(
      new Date(now.getTime() + 6 * 60 * 1000),
      async () => ({ id: 're_test_retry_success' }),
    );
    const refundedBooking = await db.collection('bookings').findOne({ _id: booking._id });
    assert.equal(retry.refundedCount, 1);
    assert.equal(refundedBooking.paymentStatus, 'refunded');
    assert.equal(refundedBooking.refundStatus, 'succeeded');
  });

  it('marks demo payments refunded without calling Stripe', async () => {
    const now = new Date();
    const booking = await insertBookingDirect({
      bookingStatus: 'pending',
      paymentStatus: 'paid',
      paidAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
      paymentTransactionId: 'demo-auto-refund-test',
    });
    const { db } = await getTestDb();
    await db.collection('paymentTransactions').insertOne({
      bookingId: booking._id,
      renterId: booking.renterId,
      transactionId: booking.paymentTransactionId,
      paymentMethod: 'demo_card',
      status: 'success',
    });

    await runPendingBookingLifecycle(now, async () => {
      assert.fail('Demo refunds must not call Stripe.');
    });

    const refundedTransaction = await db.collection('paymentTransactions').findOne({
      bookingId: booking._id,
    });
    assert.equal(refundedTransaction.status, 'refunded');
  });
});
