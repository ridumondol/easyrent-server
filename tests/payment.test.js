import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import Stripe from 'stripe';
import {
  api,
  registerUser,
  insertBookingDirect,
  insertEquipmentDirect,
  getTestDb,
  closeTestDb,
  assertError,
  assertSuccess,
} from './helpers.js';
import { connectToDatabase, closeDatabase } from '../config/db.js';
import { createCheckout, createStripeCheckout, handleStripeWebhook, verifyPayment } from '../controllers/paymentController.js';

let renter;
let otherRenter;
let owner;

async function callSignedWebhook(event, secret, refundStripePayment) {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  const response = {
    statusCode: 200,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  await handleStripeWebhook(
    {
      headers: { 'stripe-signature': signature },
      body: Buffer.from(payload),
    },
    response,
    refundStripePayment,
  );
  return response;
}

describe('Demo Payments API', () => {
  before(async () => {
    await connectToDatabase();
    [renter, otherRenter, owner] = await Promise.all([
      registerUser('renter', 'demoPaymentRenter'),
      registerUser('renter', 'demoPaymentOtherRenter'),
      registerUser('owner', 'demoPaymentOwner'),
    ]);
  });

  it('requires authentication and prevents paying another renterâ€™s booking', async () => {
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

  it('accepts a late Stripe payment only when inventory remains', async () => {
    const originalWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const webhookSecret = 'whsec_booking_inventory_test';
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;

    try {
      const { db } = await getTestDb();
      const equipmentId = await insertEquipmentDirect({ quantity: 1 });
      await insertBookingDirect({
        equipmentId,
        bookingStatus: 'confirmed',
        quantity: 1,
      });
      const lateBooking = await insertBookingDirect({
        equipmentId,
        renterId: new ObjectId(renter.user.id ?? renter.user._id),
        bookingStatus: 'cancelled',
        paymentStatus: 'unpaid',
        cancellationReason: 'payment_hold_expired',
        createdAt: new Date(Date.now() - 31 * 60 * 1000),
      });
      const payment = {
        transactionId: `late_payment_${lateBooking._id}`,
        bookingId: lateBooking._id,
        renterId: new ObjectId(renter.user.id ?? renter.user._id),
        stripeCheckoutSessionId: `cs_test_late_${lateBooking._id}`,
        amount: 300,
        currency: 'bdt',
        checkoutReservation: true,
        status: 'failed',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await db.collection('payments').insertOne(payment);

      let refundArgs;
      const response = await callSignedWebhook({
        id: `evt_late_${lateBooking._id}`,
        object: 'event',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: payment.stripeCheckoutSessionId,
            mode: 'payment',
            status: 'complete',
            payment_status: 'paid',
            livemode: false,
            metadata: {
              bookingId: lateBooking._id.toString(),
              renterId: payment.renterId.toString(),
                transactionId: payment.transactionId,
            },
            amount_total: 30000,
            currency: 'bdt',
            payment_intent: `pi_test_late_${lateBooking._id}`,
          },
        },
      }, webhookSecret, async (paymentIntentId, idempotencyKey) => {
        refundArgs = { paymentIntentId, idempotencyKey };
        return { id: 're_test_late_refund' };
      });

      const storedBooking = await db.collection('bookings').findOne({ _id: lateBooking._id });
      const storedPayment = await db.collection('payments').findOne({
        bookingId: lateBooking._id,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(storedBooking.bookingStatus, 'cancelled');
      assert.equal(storedBooking.paymentStatus, 'refunded');
      assert.equal(storedPayment.status, 'refunded');
      assert.deepEqual(refundArgs, {
        paymentIntentId: `pi_test_late_${lateBooking._id}`,
        idempotencyKey: `rentora-payment-refund-${payment.transactionId}`,
      });

      const availableEquipmentId = await insertEquipmentDirect({ quantity: 1 });
      const availableLateBooking = await insertBookingDirect({
        equipmentId: availableEquipmentId,
        renterId: new ObjectId(renter.user.id ?? renter.user._id),
        bookingStatus: 'cancelled',
        paymentStatus: 'unpaid',
        cancellationReason: 'payment_hold_expired',
        createdAt: new Date(Date.now() - 31 * 60 * 1000),
      });
      const availablePayment = {
        ...payment,
        _id: new ObjectId(),
        transactionId: `late_available_${availableLateBooking._id}`,
        bookingId: availableLateBooking._id,
        stripeCheckoutSessionId: `cs_test_available_${availableLateBooking._id}`,
      };
      await db.collection('payments').insertOne(availablePayment);
      const availableResponse = await callSignedWebhook({
        id: `evt_available_${availableLateBooking._id}`,
        object: 'event',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: availablePayment.stripeCheckoutSessionId,
            mode: 'payment',
            status: 'complete',
            payment_status: 'paid',
            livemode: false,
            metadata: {
              bookingId: availableLateBooking._id.toString(),
              renterId: availablePayment.renterId.toString(),
              transactionId: availablePayment.transactionId,
            },
            amount_total: 30000,
            currency: 'bdt',
            payment_intent: `pi_test_available_${availableLateBooking._id}`,
          },
        },
      }, webhookSecret, async () => {
        assert.fail('A late payment with available stock must not be refunded.');
      });
      const availableStoredBooking = await db.collection('bookings').findOne({
        _id: availableLateBooking._id,
      });
      assert.equal(availableResponse.statusCode, 200);
      assert.equal(availableStoredBooking.bookingStatus, 'pending');
      assert.equal(availableStoredBooking.paymentStatus, 'paid');
    } finally {
      if (originalWebhookSecret === undefined) {
        delete process.env.STRIPE_WEBHOOK_SECRET;
      } else {
        process.env.STRIPE_WEBHOOK_SECRET = originalWebhookSecret;
      }
    }
  });

  it('routes bookingId-only checkout requests to Stripe', async () => {
    const booking = await insertBookingDirect({
      renterId: new ObjectId(renter.user.id ?? renter.user._id),
      bookingStatus: 'pending',
    });
    const originalClientUrl = process.env.CLIENT_URL;
    delete process.env.CLIENT_URL;

    try {
      assertError(
        await api('/api/payments/checkout', {
          method: 'POST',
          token: renter.token,
          body: { bookingId: booking._id.toString() },
        }),
        503,
        'CLIENT_URL',
      );
    } finally {
      if (originalClientUrl === undefined) {
        delete process.env.CLIENT_URL;
      } else {
        process.env.CLIENT_URL = originalClientUrl;
      }
    }
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

  it('creates one Stripe Checkout session using trusted booking pricing and reuses it on retry', async () => {
    const equipmentId = await insertEquipmentDirect({ quantity: 3, title: 'Test equipment' });
    const booking = await insertBookingDirect({
      equipmentId,
      renterId: new ObjectId(renter.user.id ?? renter.user._id),
      bookingStatus: 'pending',
      paymentStatus: 'unpaid',
      pricePerDay: 12.35,
      quantity: 2,
      totalDays: 3,
      totalAmount: 0.01,
    });
    const renterId = new ObjectId(renter.user.id ?? renter.user._id);
    const originalKey = process.env.STRIPE_SECRET_KEY;
    const originalClientUrl = process.env.CLIENT_URL;
    process.env.STRIPE_SECRET_KEY = 'sk_test_1234567890abcdefghijkl';
    process.env.CLIENT_URL = 'https://rentora.example';

    let createCount = 0;
    let createParams;
    let createOptions;
    const stripeStub = {
      checkout: {
        sessions: {
          async create(params, options) {
            createCount += 1;
            createParams = params;
            createOptions = options;
            return {
              id: `cs_test_${booking._id}`,
              url: 'https://checkout.stripe.test/session',
              status: 'open',
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            };
          },
          async retrieve() {
            return {
              id: `cs_test_${booking._id}`,
              url: 'https://checkout.stripe.test/session',
              status: 'open',
            };
          },
        },
      },
    };

    function makeResponse() {
      return {
        statusCode: 200,
        body: null,
        status(statusCode) { this.statusCode = statusCode; return this; },
        json(body) { this.body = body; return this; },
      };
    }

    try {
      const request = {
        body: { bookingId: booking._id.toString(), amount: 0.01 },
        user: { userId: renterId },
      };
      const firstResponse = makeResponse();
      await createStripeCheckout(request, firstResponse, { stripeClient: stripeStub });
      assert.equal(firstResponse.statusCode, 201);
      assert.equal(firstResponse.body.data.checkoutUrl, 'https://checkout.stripe.test/session');
      assert.equal(createParams.line_items[0].price_data.unit_amount, 3705);
      assert.equal(createParams.line_items[0].quantity, 2);
      assert.equal(createParams.mode, 'payment');
      assert.equal(createParams.metadata.bookingId, booking._id.toString());
      assert.equal(createParams.payment_intent_data.metadata.transactionId, createOptions.idempotencyKey);
      assert.match(createParams.success_url, /booking_id=.*session_id=/);
      assert.match(createParams.cancel_url, /payment\/cancelled\?booking_id=/);
      const { db } = await getTestDb();
      assert.equal(
        (await db.collection('payments').findOne({ bookingId: booking._id })).stripeCheckoutSessionId,
        `cs_test_${booking._id}`,
      );

      const retryResponse = makeResponse();
      await createStripeCheckout(request, retryResponse, { stripeClient: stripeStub });
      assert.equal(retryResponse.statusCode, 200);
      assert.equal(retryResponse.body.data.sessionId, `cs_test_${booking._id}`);
      assert.equal(createCount, 1);

      let retrievedSessionId;
      const verificationResponse = makeResponse();
      const storedPayment = await db.collection('payments').findOne({ bookingId: booking._id });
      await verifyPayment({
        params: { bookingId: booking._id.toString() },
        query: { session_id: `cs_test_${booking._id}` },
        user: { userId: renterId },
      }, verificationResponse, {
        stripeClient: {
          checkout: { sessions: { async retrieve(sessionId) {
            retrievedSessionId = sessionId;
            return {
              id: sessionId,
              mode: 'payment',
              status: 'complete',
              payment_status: 'paid',
              livemode: false,
              amount_total: 7410,
              currency: 'bdt',
              metadata: {
                bookingId: booking._id.toString(),
                renterId: renterId.toString(),
                transactionId: storedPayment.transactionId,
              },
              payment_intent: `pi_test_${booking._id}`,
            };
          } } },
        },
      });
      assert.equal(verificationResponse.statusCode, 200);
      assert.equal(retrievedSessionId, `cs_test_${booking._id}`);
      assert.equal(verificationResponse.body.data.stripePaymentStatus, 'paid');
      assert.equal(verificationResponse.body.data.paymentStatus, 'paid');
      assert.equal((await db.collection('payments').findOne({ _id: storedPayment._id })).status, 'success');
    } finally {
      if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = originalKey;
      if (originalClientUrl === undefined) delete process.env.CLIENT_URL;
      else process.env.CLIENT_URL = originalClientUrl;
    }
  });

  it('lets confirmed unpaid bookings pay and reconciles a completed Stripe session on retry', async () => {
    const renterId = new ObjectId(renter.user.id ?? renter.user._id);
    const ownerId = new ObjectId(owner.user.id ?? owner.user._id);
    const equipmentId = await insertEquipmentDirect({ ownerId, quantity: 2 });
    const booking = await insertBookingDirect({
      equipmentId,
      renterId,
      ownerId,
      bookingStatus: 'confirmed',
      paymentStatus: 'unpaid',
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const originalKey = process.env.STRIPE_SECRET_KEY;
    const originalClientUrl = process.env.CLIENT_URL;
    process.env.STRIPE_SECRET_KEY = 'sk_test_1234567890abcdefghijkl';
    process.env.CLIENT_URL = 'https://rentora.example';

    let sessionPaid = false;
    let createCount = 0;
    let transactionId;
    const sessionId = `cs_test_confirmed_${booking._id}`;
    const stripeClient = {
      checkout: {
        sessions: {
          async create() {
            createCount += 1;
            return {
              id: sessionId,
              url: 'https://checkout.stripe.test/session',
              status: 'open',
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            };
          },
          async retrieve(id) {
            return {
              id,
              mode: 'payment',
              status: sessionPaid ? 'complete' : 'open',
              payment_status: sessionPaid ? 'paid' : 'unpaid',
              livemode: false,
              amount_total: 30000,
              currency: 'bdt',
              metadata: {
                bookingId: booking._id.toString(),
                renterId: renterId.toString(),
                transactionId,
              },
              payment_intent: `pi_test_confirmed_${booking._id}`,
              url: 'https://checkout.stripe.test/session',
            };
          },
        },
      },
    };
    const makeResponse = () => ({
      statusCode: 200,
      body: null,
      status(statusCode) { this.statusCode = statusCode; return this; },
      json(body) { this.body = body; return this; },
    });

    try {
      const request = {
        body: { bookingId: booking._id.toString() },
        user: { userId: renterId },
      };
      const checkoutResponse = makeResponse();
      await createStripeCheckout(request, checkoutResponse, { stripeClient });
      assert.equal(checkoutResponse.statusCode, 201);
      assert.equal(checkoutResponse.body.data.checkoutUrl, 'https://checkout.stripe.test/session');

      const { db } = await getTestDb();
      transactionId = (await db.collection('payments').findOne({ bookingId: booking._id })).transactionId;
      sessionPaid = true;
      const retryResponse = makeResponse();
      await createStripeCheckout(request, retryResponse, { stripeClient });
      assert.equal(retryResponse.statusCode, 200);
      assert.equal(retryResponse.body.data.paymentStatus, 'paid');
      assert.equal(createCount, 1);

      const storedBooking = await db.collection('bookings').findOne({ _id: booking._id });
      assert.equal(storedBooking.bookingStatus, 'confirmed');
      assert.equal(storedBooking.paymentStatus, 'paid');
      assert.equal(
        (await db.collection('payments').findOne({ bookingId: booking._id })).status,
        'success',
      );
    } finally {
      if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = originalKey;
      if (originalClientUrl === undefined) delete process.env.CLIENT_URL;
      else process.env.CLIENT_URL = originalClientUrl;
    }
  });

  it('settles a Stripe payment during verification and safely supports repeats', async () => {
    const { db } = await getTestDb();
    const renterId = new ObjectId(renter.user.id ?? renter.user._id);
    const ownerId = new ObjectId(owner.user.id ?? owner.user._id);
    const equipmentId = await insertEquipmentDirect({ ownerId, quantity: 2 });
    const booking = await insertBookingDirect({
      equipmentId,
      renterId,
      ownerId,
      bookingStatus: 'pending',
      paymentStatus: 'unpaid',
    });
    const payment = {
      transactionId: `verify_${booking._id}`,
      bookingId: booking._id,
      renterId,
      stripeCheckoutSessionId: `cs_test_verify_${booking._id}`,
      amount: 300,
      currency: 'bdt',
      checkoutReservation: true,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { insertedId: paymentId } = await db.collection('payments').insertOne(payment);
    const originalKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_1234567890abcdefghijkl';

    const response = () => ({
      statusCode: 200,
      body: null,
      status(statusCode) { this.statusCode = statusCode; return this; },
      json(body) { this.body = body; return this; },
    });
    const stripeClient = {
      checkout: {
        sessions: {
          async retrieve(id) {
            return {
              id,
              mode: 'payment',
              status: 'complete',
              payment_status: 'paid',
              livemode: false,
              amount_total: 30000,
              currency: 'bdt',
              metadata: {
                bookingId: booking._id.toString(),
                renterId: renterId.toString(),
                transactionId: payment.transactionId,
              },
              payment_intent: `pi_test_verify_${booking._id}`,
            };
          },
        },
      },
    };

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const verification = response();
        await verifyPayment({
          params: { bookingId: booking._id.toString() },
          query: { session_id: payment.stripeCheckoutSessionId },
          user: { userId: renterId },
        }, verification, { stripeClient });
        assert.equal(verification.statusCode, 200);
        assert.equal(verification.body.data.paymentStatus, 'paid');
        assert.equal(verification.body.data.bookingStatus, 'pending');
      }

      assert.equal((await db.collection('payments').findOne({ _id: paymentId })).status, 'success');
      assert.equal(await db.collection('payments').countDocuments({
        bookingId: booking._id,
        status: 'success',
      }), 1);
      assertSuccess(await api(`/api/bookings/${booking._id}/status`, {
        method: 'PATCH',
        token: owner.token,
        body: { bookingStatus: 'confirmed' },
      }));
      assert.equal(
        (await db.collection('bookings').findOne({ _id: booking._id })).bookingStatus,
        'confirmed',
      );
    } finally {
      if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = originalKey;
    }
  });

  it('rejects a completed webhook with a mismatched booking reference without marking paid', async () => {
    const { db } = await getTestDb();
    const webhookSecret = 'whsec_booking_mismatch_test';
    const originalSecret = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    const renterId = new ObjectId(renter.user.id ?? renter.user._id);
    const booking = await insertBookingDirect({
      renterId,
      bookingStatus: 'pending',
      paymentStatus: 'unpaid',
    });
    const payment = {
      transactionId: `mismatch_${booking._id}`,
      bookingId: booking._id,
      renterId,
      stripeCheckoutSessionId: `cs_test_mismatch_${booking._id}`,
      amount: 300,
      currency: 'bdt',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.collection('payments').insertOne(payment);

    try {
      const result = await callSignedWebhook({
        id: `evt_mismatch_${booking._id}`,
        object: 'event',
        type: 'checkout.session.completed',
        data: { object: {
          id: payment.stripeCheckoutSessionId,
          mode: 'payment',
          status: 'complete',
          payment_status: 'paid',
          livemode: false,
          metadata: {
            bookingId: new ObjectId().toString(),
            renterId: renterId.toString(),
            transactionId: payment.transactionId,
          },
          amount_total: 30000,
          currency: 'bdt',
          payment_intent: `pi_test_mismatch_${booking._id}`,
        } },
      }, webhookSecret);

      assert.equal(result.statusCode, 400);
      assert.equal((await db.collection('bookings').findOne({ _id: booking._id })).paymentStatus, 'unpaid');
      assert.equal((await db.collection('payments').findOne({
        stripeCheckoutSessionId: payment.stripeCheckoutSessionId,
      })).status, 'pending');
    } finally {
      if (originalSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = originalSecret;
    }
  });

  it('keeps incomplete and expired Stripe sessions unpaid during verification', async () => {
    const { db } = await getTestDb();
    const originalKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_1234567890abcdefghijkl';
    const cases = [
      { sessionStatus: 'open', paymentStatus: 'unpaid', storedStatus: 'pending' },
      { sessionStatus: 'complete', paymentStatus: 'unpaid', storedStatus: 'pending' },
      { sessionStatus: 'expired', paymentStatus: 'unpaid', storedStatus: 'cancelled' },
    ];

    try {
      for (const [index, item] of cases.entries()) {
        const renterId = new ObjectId(renter.user.id ?? renter.user._id);
        const booking = await insertBookingDirect({
          renterId,
          bookingStatus: 'pending',
          paymentStatus: 'unpaid',
        });
        const payment = {
          transactionId: `incomplete_${index}_${booking._id}`,
          bookingId: booking._id,
          renterId,
          stripeCheckoutSessionId: `cs_test_incomplete_${index}_${booking._id}`,
          amount: 300,
          currency: 'bdt',
          status: 'pending',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await db.collection('payments').insertOne(payment);
        const result = {
          statusCode: 200,
          body: null,
          status(statusCode) { this.statusCode = statusCode; return this; },
          json(body) { this.body = body; return this; },
        };

        await verifyPayment({
          params: { bookingId: booking._id.toString() },
          query: { session_id: payment.stripeCheckoutSessionId },
          user: { userId: renterId },
        }, result, {
          stripeClient: {
            checkout: { sessions: { async retrieve(id) {
              return {
                id,
                mode: 'payment',
                status: item.sessionStatus,
                payment_status: item.paymentStatus,
                livemode: false,
              };
            } } },
          },
        });

        assert.equal(result.statusCode, 200);
        assert.equal(result.body.data.paymentStatus, 'unpaid');
        assert.equal((await db.collection('payments').findOne({
          stripeCheckoutSessionId: payment.stripeCheckoutSessionId,
        })).status, item.storedStatus);
      }
    } finally {
      if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = originalKey;
    }
  });

  it('forces Stripe Checkout in production even when demo fields are submitted', async () => {
    const equipmentId = await insertEquipmentDirect({ quantity: 1, title: 'Production checkout test equipment' });
    const booking = await insertBookingDirect({
equipmentId,
renterId: new ObjectId(renter.user.id ?? renter.user._id),
      bookingStatus: 'pending',
      paymentStatus: 'unpaid',
    });
    const originals = {
      nodeEnv: process.env.NODE_ENV,
      demo: process.env.ENABLE_DEMO_PAYMENTS,
      key: process.env.STRIPE_SECRET_KEY,
      clientUrl: process.env.CLIENT_URL,
    };
    process.env.NODE_ENV = 'production';
    process.env.ENABLE_DEMO_PAYMENTS = 'true';
    process.env.STRIPE_SECRET_KEY = 'sk_test_1234567890abcdefghijkl';
    process.env.CLIENT_URL = 'https://rentora.example';
    let stripeCalled = false;
    const response = {
      statusCode: 200,
      body: null,
      status(statusCode) { this.statusCode = statusCode; return this; },
      json(body) { this.body = body; return this; },
    };
    try {
      await createCheckout({
        body: { bookingId: booking._id.toString(), paymentMethod: 'demo_card', outcome: 'success' },
        user: { userId: renter.user.id ?? renter.user._id },
      }, response, {
        stripeClient: {
          checkout: { sessions: { async create() {
            stripeCalled = true;
            return { id: `cs_test_prod_${booking._id}`, url: 'https://checkout.stripe.test/session' };
          } } },
        },
      });
      assert.equal(response.statusCode, 201);
      assert.equal(stripeCalled, true);
      const { db } = await getTestDb();
      assert.equal((await db.collection('bookings').findOne({ _id: booking._id })).paymentStatus, 'unpaid');
    } finally {
      if (originals.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originals.nodeEnv;
      if (originals.demo === undefined) delete process.env.ENABLE_DEMO_PAYMENTS;
      else process.env.ENABLE_DEMO_PAYMENTS = originals.demo;
      if (originals.key === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = originals.key;
      if (originals.clientUrl === undefined) delete process.env.CLIENT_URL;
      else process.env.CLIENT_URL = originals.clientUrl;
    }
  });

  it('verifies Stripe signatures and processes payment and failure events', async () => {
    const { db } = await getTestDb();
    const payments = db.collection('payments');
    const bookings = db.collection('bookings');
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const renterId = new ObjectId(renter.user.id ?? renter.user._id);
    const equipmentId = await insertEquipmentDirect({ quantity: 1 });
    const paidBooking = await insertBookingDirect({
      equipmentId,
      renterId,
      bookingStatus: 'pending',
      paymentStatus: 'unpaid',
      createdAt: new Date(Date.now() - 31 * 60 * 1000),
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
          mode: 'payment',
          status: 'complete',
          payment_status: 'paid',
          livemode: false,
          metadata: {
            bookingId: paidBooking._id.toString(),
            renterId: renterId.toString(),
            transactionId: paidPayment.transactionId,
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

    async function deliverEvent(event) {
      const payload = JSON.stringify(event);
      const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
      return api('/api/payments/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': signature },
        body: event,
      });
    }

    const expiredBooking = await insertBookingDirect({ renterId, bookingStatus: 'pending' });
    const expiredSessionId = `cs_test_expired_${expiredBooking._id}`;
    await payments.insertOne({
      transactionId: `expired_${expiredBooking._id}`,
      bookingId: expiredBooking._id,
      renterId,
      stripeCheckoutSessionId: expiredSessionId,
      amount: 300,
      currency: 'bdt',
      checkoutReservation: true,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    assert.equal((await deliverEvent({
      id: `evt_expired_${expiredBooking._id}`,
      object: 'event',
      type: 'checkout.session.expired',
      data: { object: { id: expiredSessionId } },
    })).status, 200);
    assert.equal((await payments.findOne({ stripeCheckoutSessionId: expiredSessionId })).status, 'cancelled');
    assert.equal((await bookings.findOne({ _id: expiredBooking._id })).paymentStatus, 'unpaid');

    const intentFailureBooking = await insertBookingDirect({ renterId, bookingStatus: 'pending' });
    const intentFailureTransactionId = `intent_failed_${intentFailureBooking._id}`;
    const intentFailureId = `pi_test_failed_${intentFailureBooking._id}`;
    await payments.insertOne({
      transactionId: intentFailureTransactionId,
      bookingId: intentFailureBooking._id,
      renterId,
      amount: 300,
      currency: 'bdt',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    assert.equal((await deliverEvent({
      id: `evt_pi_failed_${intentFailureBooking._id}`,
      object: 'event',
      type: 'payment_intent.payment_failed',
      data: { object: { id: intentFailureId, metadata: { transactionId: intentFailureTransactionId } } },
    })).status, 200);
    assert.equal((await payments.findOne({ transactionId: intentFailureTransactionId })).status, 'failed');
    assert.equal((await bookings.findOne({ _id: intentFailureBooking._id })).paymentStatus, 'unpaid');

    const refundedBooking = await insertBookingDirect({
      renterId,
      bookingStatus: 'confirmed',
      paymentStatus: 'paid',
      paymentTransactionId: `refund_${Date.now()}`,
    });
    const refundTransactionId = refundedBooking.paymentTransactionId;
    const refundPaymentIntentId = `pi_test_refund_${refundedBooking._id}`;
    await payments.insertOne({
      transactionId: refundTransactionId,
      bookingId: refundedBooking._id,
      renterId,
      stripePaymentIntentId: refundPaymentIntentId,
      amount: 300,
      currency: 'bdt',
      status: 'success',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const refundEvent = {
      id: `evt_refunded_${refundedBooking._id}`,
      object: 'event',
      type: 'charge.refunded',
      data: { object: {
        payment_intent: refundPaymentIntentId,
        amount: 30000,
        amount_refunded: 30000,
        refunds: { data: [{ id: `re_test_${refundedBooking._id}` }] },
      } },
    };
    assert.equal((await deliverEvent(refundEvent)).status, 200);
    assert.equal((await payments.findOne({ transactionId: refundTransactionId })).status, 'refunded');
    assert.equal((await bookings.findOne({ _id: refundedBooking._id })).paymentStatus, 'refunded');
    assert.equal((await deliverEvent(refundEvent)).status, 200);
    assert.equal(await payments.countDocuments({ bookingId: refundedBooking._id, status: 'refunded' }), 1);

    const partiallyRefundedBooking = await insertBookingDirect({
      renterId,
      bookingStatus: 'confirmed',
      paymentStatus: 'paid',
      paymentTransactionId: `partial_refund_${Date.now()}`,
    });
    const partialIntentId = `pi_test_partial_refund_${partiallyRefundedBooking._id}`;
    await payments.insertOne({
      transactionId: partiallyRefundedBooking.paymentTransactionId,
      bookingId: partiallyRefundedBooking._id,
      renterId,
      stripePaymentIntentId: partialIntentId,
      amount: 300,
      currency: 'bdt',
      status: 'success',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    assert.equal((await deliverEvent({
      id: `evt_partial_refund_${partiallyRefundedBooking._id}`,
      object: 'event',
      type: 'charge.refunded',
      data: { object: { payment_intent: partialIntentId, amount: 30000, amount_refunded: 5000 } },
    })).status, 200);
    assert.equal((await payments.findOne({ stripePaymentIntentId: partialIntentId })).status, 'success');
    assert.equal((await bookings.findOne({ _id: partiallyRefundedBooking._id })).paymentStatus, 'paid');

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
    assert.match(liveMode.body.message, /mode/i);
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

  it('allows confirmed bookings to complete a demo payment after the pending hold expires', async () => {
    const booking = await insertBookingDirect({
      renterId: new ObjectId(renter.user.id ?? renter.user._id),
      bookingStatus: 'confirmed',
      paymentStatus: 'unpaid',
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const checkout = assertSuccess(
      await api('/api/payments/checkout', {
        method: 'POST',
        token: renter.token,
        body: {
          bookingId: booking._id.toString(),
          paymentMethod: 'demo_card',
          outcome: 'success',
        },
      }),
      201,
    );

    const { db } = await getTestDb();
    const storedBooking = await db.collection('bookings').findOne({ _id: booking._id });
    assert.equal(checkout.transaction.status, 'success');
    assert.equal(storedBooking.bookingStatus, 'confirmed');
    assert.equal(storedBooking.paymentStatus, 'paid');
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
    await closeDatabase();
  });
});
