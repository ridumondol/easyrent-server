import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import Stripe from 'stripe';
import {
  api,
  registerUser,
  insertBookingDirect,
  getTestDb,
  closeTestDb,
  assertError,
  assertSuccess,
} from './helpers.js';
import { isStripeWebhookSecretConfigured } from '../services/stripeService.js';

let renter;
let otherRenter;
let owner;
const hasStripeWebhookConfiguration = isStripeWebhookSecretConfigured();

describe('Demo Payments API', () => {
  before(async () => {
    [renter, otherRenter, owner] = await Promise.all([
      registerUser('renter', 'demoPaymentRenter'),
      registerUser('renter', 'demoPaymentOtherRenter'),
      registerUser('owner', 'demoPaymentOwner'),
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
    assert.equal(
      (await api('/api/payments/checkout', {
        method: 'POST',
        token: owner.token,
        body: { bookingId: booking._id.toString() },
      })).status,
      403,
    );
  });

  it('rejects webhook requests without a Stripe signature', async () => {
    const result = await api('/api/payments/webhook', {
      method: 'POST',
      body: { type: 'checkout.session.completed' },
    });

    assert.equal(result.status, 400);
    assert.match(result.body.message, /signature/i);
  });

  it('allows only one pending Stripe checkout reservation per booking', async () => {
    const { db } = await getTestDb();
    const bookingId = new ObjectId();
    const now = new Date();
    const reservation = {
      transactionId: `reservation_${bookingId}`,
      bookingId,
      renterId: new ObjectId(renter.user.id ?? renter.user._id),
      amount: 100,
      currency: 'bdt',
      checkoutReservation: true,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    await db.collection('payments').insertOne(reservation);
    await assert.rejects(
      db.collection('payments').insertOne({
        ...reservation,
        transactionId: `duplicate_${bookingId}`,
      }),
      (error) => error.code === 11000,
    );
  });

  it('verifies Stripe signatures and processes payment and failure events', {
    skip: !hasStripeWebhookConfiguration,
  }, async () => {
    const { db } = await getTestDb();
    const payments = db.collection('payments');
    const bookings = db.collection('bookings');
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const renterId = new ObjectId(renter.user.id ?? renter.user._id);
    const paidBooking = await insertBookingDirect({
      renterId,
      bookingStatus: 'pending',
      paymentStatus: 'unpaid',
    });
    const paidPayment = {
      transactionId: `webhook_${paidBooking._id}`,
      bookingId: paidBooking._id,
      renterId,
      stripeCheckoutSessionId: `cs_test_${paidBooking._id}`,
      amount: 300,
      currency: 'bdt',
      checkoutReservation: true,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const paidPaymentResult = await payments.insertOne(paidPayment);

    const completedEvent = {
      id: `evt_test_${paidBooking._id}`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: paidPayment.stripeCheckoutSessionId,
          payment_status: 'paid',
          metadata: {
            bookingId: paidBooking._id.toString(),
            renterId: renterId.toString(),
          },
          amount_total: 30000,
          currency: 'bdt',
          payment_intent: `pi_test_${paidBooking._id}`,
        },
      },
    };
    const completedPayload = JSON.stringify(completedEvent);
    const completedSignature = Stripe.webhooks.generateTestHeaderString({
      payload: completedPayload,
      secret: webhookSecret,
    });
    const completed = await api('/api/payments/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': completedSignature },
      body: completedEvent,
    });
    assert.equal(completed.status, 200);
    assert.equal(
      (await bookings.findOne({ _id: paidBooking._id })).paymentStatus,
      'paid',
    );
    assert.equal(
      (await payments.findOne({ _id: paidPaymentResult.insertedId })).status,
      'success',
    );

    const replay = await api('/api/payments/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': completedSignature },
      body: completedEvent,
    });
    assert.equal(replay.status, 200);
    assert.equal(await payments.countDocuments({
      bookingId: paidBooking._id,
      status: 'success',
    }), 1);

    const failedBooking = await insertBookingDirect({
      renterId,
      bookingStatus: 'pending',
      paymentStatus: 'unpaid',
    });
    const failedSessionId = `cs_test_${failedBooking._id}`;
    await payments.insertOne({
      transactionId: `async_failed_${failedBooking._id}`,
      bookingId: failedBooking._id,
      renterId,
      stripeCheckoutSessionId: failedSessionId,
      amount: 300,
      currency: 'bdt',
      checkoutReservation: true,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const failedEvent = {
      id: `evt_failed_${failedBooking._id}`,
      object: 'event',
      type: 'checkout.session.async_payment_failed',
      data: { object: { id: failedSessionId } },
    };
    const failedPayload = JSON.stringify(failedEvent);
    const failedSignature = Stripe.webhooks.generateTestHeaderString({
      payload: failedPayload,
      secret: webhookSecret,
    });
    const failed = await api('/api/payments/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': failedSignature },
      body: failedEvent,
    });
    assert.equal(failed.status, 200);
    assert.equal(
      (await payments.findOne({ stripeCheckoutSessionId: failedSessionId })).status,
      'failed',
    );
    assert.equal(
      (await bookings.findOne({ _id: failedBooking._id })).paymentStatus,
      'unpaid',
    );

    const liveModeBooking = await insertBookingDirect({
      renterId,
      bookingStatus: 'pending',
      paymentStatus: 'unpaid',
    });
    const liveModeSessionId = `cs_test_live_mode_${liveModeBooking._id}`;
    await payments.insertOne({
      transactionId: `live_mode_${liveModeBooking._id}`,
      bookingId: liveModeBooking._id,
      renterId,
      stripeCheckoutSessionId: liveModeSessionId,
      amount: 300,
      currency: 'bdt',
      checkoutReservation: true,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const liveModeEvent = {
      id: `evt_live_mode_${liveModeBooking._id}`,
      object: 'event',
      type: 'checkout.session.expired',
      livemode: true,
      data: { object: { id: liveModeSessionId } },
    };
    const liveModePayload = JSON.stringify(liveModeEvent);
    const liveModeSignature = Stripe.webhooks.generateTestHeaderString({
      payload: liveModePayload,
      secret: webhookSecret,
    });
    const liveMode = await api('/api/payments/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': liveModeSignature },
      body: liveModeEvent,
    });
    assert.equal(liveMode.status, 400);
    assert.match(liveMode.body.message, /live-mode/i);
    assert.equal(
      (await payments.findOne({ stripeCheckoutSessionId: liveModeSessionId })).status,
      'pending',
    );

    const tampered = await api('/api/payments/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=invalid' },
      body: failedEvent,
    });
    assert.equal(tampered.status, 400);
    assert.match(tampered.body.message, /signature/i);
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
