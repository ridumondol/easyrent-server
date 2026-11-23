import { getDB } from '../config/db.js';
import { PENDING_HOLD_MINUTES } from '../utils/constants.js';
import { refundStripePaymentIntent } from './stripeService.js';

const OWNER_CONFIRMATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const REFUND_RETRY_DELAY_MS = 5 * 60 * 1000;

function getPaymentCollections() {
  const db = getDB();
  return process.env.NODE_ENV === 'test'
    ? [db.collection('payments'), db.collection('paymentTransactions')]
    : [db.collection('payments')];
}

export async function refundPaymentRecord(
  payment,
  collection,
  now = new Date(),
  refundStripePayment = refundStripePaymentIntent,
) {
  if (payment.status === 'refunded') return payment;

  let refund;
  if (payment.stripePaymentIntentId) {
    refund = await refundStripePayment(
      payment.stripePaymentIntentId,
      `rentora-booking-refund-${payment.bookingId}`,
    );
  } else if (!payment.paymentMethod) {
    throw new Error(`Payment ${payment.transactionId} has no refundable payment reference.`);
  }

  const update = await collection.updateOne(
    { _id: payment._id, status: payment.status },
    {
      $set: {
        status: 'refunded',
        refundedAt: now,
        updatedAt: now,
        ...(refund?.id ? { stripeRefundId: refund.id } : {}),
      },
    },
  );
  if (update.modifiedCount !== 1) {
    const latest = await collection.findOne({ _id: payment._id });
    if (latest?.status !== 'refunded') {
      throw new Error(`Payment ${payment.transactionId} changed while its refund was being recorded.`);
    }
    return latest;
  }

  return { ...payment, status: 'refunded', refundedAt: now, ...(refund?.id ? { stripeRefundId: refund.id } : {}) };
}

async function findCapturedPayment(bookingId) {
  for (const collection of getPaymentCollections()) {
    const payment = await collection.findOne({
      bookingId,
      status: { $in: ['success', 'refunded'] },
    });
    if (payment) return { payment, collection };
  }
  return null;
}

async function processPendingRefunds(now, refundStripePayment) {
  const bookings = getDB().collection('bookings');
  const retryCutoff = new Date(now.getTime() - REFUND_RETRY_DELAY_MS);
  const pendingRefunds = await bookings.find({
    bookingStatus: 'cancelled',
    paymentStatus: 'paid',
    $or: [
      { refundStatus: { $in: ['pending', 'failed'] } },
      { refundStatus: 'processing', updatedAt: { $lte: retryCutoff } },
    ],
  }).toArray();

  let refundedCount = 0;
  for (const booking of pendingRefunds) {
    const claim = await bookings.updateOne(
      {
        _id: booking._id,
        bookingStatus: 'cancelled',
        paymentStatus: 'paid',
        refundStatus: booking.refundStatus,
        ...(booking.refundStatus === 'processing'
          ? { updatedAt: { $lte: retryCutoff } }
          : {}),
      },
      { $set: { refundStatus: 'processing', updatedAt: now } },
    );
    if (claim.modifiedCount !== 1) continue;

    try {
      const record = await findCapturedPayment(booking._id);
      if (!record) {
        throw new Error(`No successful payment record found for booking ${booking._id}.`);
      }

      await refundPaymentRecord(record.payment, record.collection, now, refundStripePayment);
      await bookings.updateOne(
        {
          _id: booking._id,
          bookingStatus: 'cancelled',
          paymentStatus: 'paid',
          refundStatus: 'processing',
        },
        {
          $set: {
            paymentStatus: 'refunded',
            refundStatus: 'succeeded',
            refundedAt: now,
            updatedAt: now,
          },
        },
      );
      refundedCount += 1;
    } catch (error) {
      await bookings.updateOne(
        {
          _id: booking._id,
          bookingStatus: 'cancelled',
          paymentStatus: 'paid',
          refundStatus: 'processing',
        },
        { $set: { refundStatus: 'failed', updatedAt: now } },
      );
      console.error(`Automatic refund failed for booking ${booking._id}:`, error.message);
    }
  }

  return refundedCount;
}

export async function runPendingBookingLifecycle(
  now = new Date(),
  refundStripePayment = refundStripePaymentIntent,
) {
  const bookings = getDB().collection('bookings');
  const unpaidCutoff = new Date(now.getTime() - PENDING_HOLD_MINUTES * 60 * 1000);
  const confirmationCutoff = new Date(now.getTime() - OWNER_CONFIRMATION_TIMEOUT_MS);

  const expiredUnpaid = await bookings.updateMany(
    {
      bookingStatus: 'pending',
      paymentStatus: 'unpaid',
      createdAt: { $lte: unpaidCutoff },
    },
    {
      $set: {
        bookingStatus: 'cancelled',
        cancellationReason: 'payment_hold_expired',
        updatedAt: now,
      },
    },
  );

  await bookings.updateMany(
    {
      bookingStatus: 'pending',
      paymentStatus: 'paid',
      paidAt: { $lte: confirmationCutoff },
      refundStatus: { $exists: false },
    },
    {
      $set: {
        bookingStatus: 'cancelled',
        cancellationReason: 'owner_confirmation_timeout',
        refundStatus: 'pending',
        updatedAt: now,
      },
    },
  );

  const refundedCount = await processPendingRefunds(now, refundStripePayment);
  return { expiredUnpaidCount: expiredUnpaid.modifiedCount, refundedCount };
}
