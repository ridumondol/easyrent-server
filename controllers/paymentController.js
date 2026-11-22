import { randomUUID } from 'node:crypto';
import { getDB } from '../config/db.js';
import { sendError, sendSuccess } from '../utils/response.js';
import { calculateRentalAmount, calculateTotalAmount } from '../utils/rental.js';
import { PENDING_HOLD_MINUTES } from '../utils/constants.js';
import { isPositiveInteger, isPositiveNumber, isValidObjectId, toObjectId } from '../utils/validation.js';
import { getStripeClient, getStripeCurrency } from '../services/stripeService.js';

const PAYMENT_METHODS = ['demo_card', 'bkash_demo', 'nagad_demo'];
const PAYMENT_OUTCOMES = ['success', 'failed', 'cancelled'];

function getBookingsCollection() {
  return getDB().collection('bookings');
}

function getTransactionsCollection() {
  return getDB().collection('paymentTransactions');
}

function calculateBookingAmount(booking) {
  if (
    !isPositiveNumber(booking.pricePerDay)
    || !isPositiveInteger(booking.quantity)
    || !isPositiveInteger(booking.totalDays)
  ) {
    return null;
  }

  const amount = booking.rentalType
    ? calculateRentalAmount(booking.pricePerDay, booking.quantity, booking.totalDays, booking.rentalType)
    : calculateTotalAmount(booking.pricePerDay, booking.quantity, booking.totalDays);
  const amountInCents = Math.round(amount * 100);
  return Number.isSafeInteger(amountInCents) && amountInCents > 0 ? amount : null;
}

function getPendingHoldCutoff(now) {
  return new Date(now.getTime() - PENDING_HOLD_MINUTES * 60 * 1000);
}

async function ensureSuccessfulPaymentIndex(transactions) {
  await transactions.createIndex(
    { bookingId: 1 },
    {
      name: 'one_successful_payment_per_booking',
      unique: true,
      partialFilterExpression: { status: 'success' },
    },
  );
}

function validateCheckoutInput(request, response) {
  const { bookingId, paymentMethod, outcome } = request.body ?? {};
  if (!isValidObjectId(bookingId)) {
    sendError(response, { statusCode: 400, message: 'A valid bookingId is required.' });
    return null;
  }
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    sendError(response, {
      statusCode: 400,
      message: `paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}.`,
    });
    return null;
  }
  if (!PAYMENT_OUTCOMES.includes(outcome)) {
    sendError(response, {
      statusCode: 400,
      message: `outcome must be one of: ${PAYMENT_OUTCOMES.join(', ')}.`,
    });
    return null;
  }
  return { bookingId, paymentMethod, outcome };
}

async function createDemoCheckout(request, response) {
  const input = validateCheckoutInput(request, response);
  if (!input) return undefined;

  try {
    const bookings = getBookingsCollection();
    const transactions = getTransactionsCollection();
    await ensureSuccessfulPaymentIndex(transactions);

    const bookingObjectId = toObjectId(input.bookingId);
    const booking = await bookings.findOne({ _id: bookingObjectId });
    if (!booking) return sendError(response, { statusCode: 404, message: 'Booking not found.' });
    if (String(booking.renterId) !== String(request.user.userId)) {
      return sendError(response, { statusCode: 403, message: 'Only the renter who owns this booking can pay for it.' });
    }
    if (booking.paymentStatus === 'paid') {
      return sendError(response, { statusCode: 409, message: 'This booking has already been paid.' });
    }
    if (booking.bookingStatus !== 'pending' || booking.paymentStatus !== 'unpaid') {
      return sendError(response, { statusCode: 400, message: 'Only pending, unpaid bookings can be paid.' });
    }

    const now = new Date();
    if (!(booking.createdAt instanceof Date) || booking.createdAt < getPendingHoldCutoff(now)) {
      return sendError(response, { statusCode: 400, message: 'The pending booking hold has expired.' });
    }
    const amount = calculateBookingAmount(booking);
    if (amount === null) {
      return sendError(response, { statusCode: 400, message: 'Booking pricing is invalid and cannot be paid.' });
    }

    const transaction = {
      transactionId: randomUUID(),
      bookingId: booking._id,
      renterId: request.user.userId,
      amount,
      paymentMethod: input.paymentMethod,
      status: input.outcome,
      createdAt: now,
      updatedAt: now,
    };

    if (input.outcome === 'success') {
      const paymentClaim = await bookings.updateOne(
        {
          _id: bookingObjectId,
          renterId: request.user.userId,
          bookingStatus: 'pending',
          paymentStatus: 'unpaid',
          createdAt: { $gte: getPendingHoldCutoff(now) },
        },
        {
          $set: {
            paymentStatus: 'paid',
            paymentTransactionId: transaction.transactionId,
            paidAt: now,
            updatedAt: now,
          },
        },
      );

      if (paymentClaim.modifiedCount !== 1) {
        const latestBooking = await bookings.findOne({ _id: bookingObjectId });
        if (latestBooking?.paymentStatus === 'paid') {
          return sendError(response, { statusCode: 409, message: 'This booking has already been paid.' });
        }
        return sendError(response, { statusCode: 409, message: 'The booking is no longer eligible for payment.' });
      }

      try {
        await transactions.insertOne(transaction);
      } catch (error) {
        await bookings.updateOne(
          {
            _id: bookingObjectId,
            renterId: request.user.userId,
            paymentStatus: 'paid',
            paymentTransactionId: transaction.transactionId,
          },
          {
            $set: { paymentStatus: 'unpaid', updatedAt: new Date() },
            $unset: { paymentTransactionId: '', paidAt: '' },
          },
        );
        throw error;
      }
    } else {
      await transactions.insertOne(transaction);
    }

    return sendSuccess(response, {
      statusCode: 201,
      message: input.outcome === 'success'
        ? 'Test payment completed successfully.'
        : `Test payment ${input.outcome}.`,
      data: { transaction },
    });
  } catch (error) {
    console.error('Test payment processing failed:', error);
    return sendError(response, { statusCode: 500, message: 'Unable to process the test payment.' });
  }
}

export async function createStripeCheckout(request, response) {
  const { bookingId } = request.body ?? {};
  if (!isValidObjectId(bookingId)) {
    return sendError(response, { statusCode: 400, message: 'A valid bookingId is required.' });
  }
  if (!process.env.CLIENT_URL) {
    return sendError(response, { statusCode: 503, message: 'CLIENT_URL is not configured for checkout redirects.' });
  }

  try {
    const stripe = getStripeClient();
    const bookings = getBookingsCollection();
    const payments = getDB().collection('payments');
    const bookingObjectId = toObjectId(bookingId);
    const booking = await bookings.findOne({ _id: bookingObjectId });
    if (!booking) return sendError(response, { statusCode: 404, message: 'Booking not found.' });
    if (String(booking.renterId) !== String(request.user.userId)) {
      return sendError(response, { statusCode: 403, message: 'Only the renter who owns this booking can pay for it.' });
    }
    if (booking.paymentStatus === 'paid') {
      return sendError(response, { statusCode: 409, message: 'This booking has already been paid.' });
    }
    if (booking.bookingStatus !== 'pending' || booking.paymentStatus !== 'unpaid') {
      return sendError(response, { statusCode: 400, message: 'Only pending, unpaid bookings can be paid.' });
    }

    const now = new Date();
    if (!(booking.createdAt instanceof Date) || booking.createdAt < getPendingHoldCutoff(now)) {
      return sendError(response, { statusCode: 400, message: 'The pending booking hold has expired.' });
    }
    const amount = calculateBookingAmount(booking);
    if (amount === null) {
      return sendError(response, { statusCode: 400, message: 'Booking pricing is invalid and cannot be paid.' });
    }

    const existingPayment = await payments.findOne({
      bookingId: bookingObjectId,
      renterId: request.user.userId,
      status: 'pending',
    });
    if (existingPayment?.stripeCheckoutSessionId) {
      const existingSession = await stripe.checkout.sessions.retrieve(existingPayment.stripeCheckoutSessionId);
      if (existingSession.status === 'open' && existingSession.url) {
        return sendSuccess(response, {
          message: 'Stripe Checkout session retrieved.',
          data: { checkoutUrl: existingSession.url, sessionId: existingSession.id },
        });
      }
      await payments.updateOne(
        { _id: existingPayment._id, status: 'pending' },
        { $set: { status: 'failed', updatedAt: now } },
      );
    }

    const equipment = await getDB().collection('equipment').findOne(
      { _id: booking.equipmentId },
      { projection: { title: 1 } },
    );
    if (!equipment) {
      return sendError(response, { statusCode: 404, message: 'Equipment for this booking no longer exists.' });
    }

    const currency = getStripeCurrency();
    const amountInMinorUnits = Math.round(amount * 100);
    if (!Number.isSafeInteger(amountInMinorUnits) || amountInMinorUnits < 1) {
      return sendError(response, { statusCode: 400, message: 'Booking amount is outside supported payment limits.' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency,
          unit_amount: amountInMinorUnits,
          product_data: { name: equipment.title },
        },
        quantity: 1,
      }],
      metadata: {
        bookingId: bookingObjectId.toString(),
        renterId: request.user.userId.toString(),
      },
      success_url: new URL('/payment/success?session_id={CHECKOUT_SESSION_ID}', process.env.CLIENT_URL).toString(),
      cancel_url: new URL('/customer/bookings?payment=cancelled', process.env.CLIENT_URL).toString(),
    });
    if (!session.url) throw new Error('Stripe did not return a Checkout URL.');

    const transaction = {
      transactionId: randomUUID(),
      bookingId: bookingObjectId,
      renterId: request.user.userId,
      stripeCheckoutSessionId: session.id,
      amount,
      currency,
      status: 'pending',
      sessionExpiresAt: session.expires_at ? new Date(session.expires_at * 1000) : undefined,
      createdAt: now,
      updatedAt: now,
    };
    await payments.insertOne(transaction);

    return sendSuccess(response, {
      statusCode: 201,
      message: 'Stripe Checkout session created.',
      data: { checkoutUrl: session.url, sessionId: session.id },
    });
  } catch (error) {
    if (!process.env.STRIPE_SECRET_KEY) {
      return sendError(response, { statusCode: 503, message: 'Stripe payments are not configured.' });
    }
    console.error('Stripe checkout creation failed:', error);
    return sendError(response, { statusCode: 502, message: 'Unable to create a Stripe Checkout session.' });
  }
}

export async function handleStripeWebhook(request, response) {
  const signature = request.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret || typeof signature !== 'string') {
    return sendError(response, { statusCode: 400, message: 'Stripe webhook signature is missing or not configured.' });
  }

  let event;
  try {
    event = getStripeClient().webhooks.constructEvent(request.body, signature, webhookSecret);
  } catch (error) {
    console.warn('Stripe webhook signature verification failed:', error.message);
    return sendError(response, { statusCode: 400, message: 'Invalid Stripe webhook signature.' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.payment_status !== 'paid' || !session.metadata?.bookingId) {
        return sendError(response, { statusCode: 400, message: 'Completed Checkout session has invalid payment metadata.' });
      }

      const payments = getDB().collection('payments');
      const payment = await payments.findOne({ stripeCheckoutSessionId: session.id });
      if (!payment || payment.status === 'failed') {
        return sendError(response, { statusCode: 404, message: 'Payment record for this Checkout session was not found.' });
      }
      if (
        session.metadata.bookingId !== payment.bookingId.toString()
        || session.metadata.renterId !== payment.renterId.toString()
        || session.amount_total !== Math.round(payment.amount * 100)
        || session.currency?.toLowerCase() !== payment.currency
      ) {
        return sendError(response, { statusCode: 400, message: 'Stripe Checkout session does not match the stored payment.' });
      }
      if (payment.status === 'success') {
        return sendSuccess(response, { message: 'Stripe event was already processed.', data: { received: true } });
      }

      const bookingUpdate = await getBookingsCollection().updateOne(
        {
          _id: payment.bookingId,
          renterId: payment.renterId,
          bookingStatus: 'pending',
          paymentStatus: 'unpaid',
        },
        {
          $set: {
            paymentStatus: 'paid',
            paymentTransactionId: payment.transactionId,
            paidAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );
      if (bookingUpdate.modifiedCount !== 1) {
        const alreadyApplied = await getBookingsCollection().findOne({
          _id: payment.bookingId,
          paymentStatus: 'paid',
          paymentTransactionId: payment.transactionId,
        });
        if (!alreadyApplied) {
          return sendError(response, { statusCode: 409, message: 'Booking is no longer eligible for this payment.' });
        }
      }

      await payments.updateOne(
        { _id: payment._id, status: 'pending' },
        {
          $set: {
            status: 'success',
            stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : '',
            updatedAt: new Date(),
          },
        },
      );
    } else if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      await getDB().collection('payments').updateOne(
        { stripeCheckoutSessionId: session.id, status: 'pending' },
        { $set: { status: 'failed', updatedAt: new Date() } },
      );
    }

    return sendSuccess(response, { message: 'Stripe event received.', data: { received: true } });
  } catch (error) {
    console.error('Stripe webhook processing failed:', error);
    return sendError(response, { statusCode: 500, message: 'Stripe webhook could not be processed.' });
  }
}

export async function verifyPayment(request, response) {
  const { bookingId } = request.params;
  if (!isValidObjectId(bookingId)) {
    return sendError(response, { statusCode: 400, message: 'Invalid booking ID.' });
  }

  try {
    const booking = await getBookingsCollection().findOne({ _id: toObjectId(bookingId) });
    if (!booking) return sendError(response, { statusCode: 404, message: 'Booking not found.' });
    if (String(booking.renterId) !== String(request.user.userId)) {
      return sendError(response, { statusCode: 403, message: 'You are not authorized to view this payment.' });
    }

    return sendSuccess(response, {
      message: 'Payment status retrieved successfully.',
      data: {
        bookingId: booking._id,
        bookingStatus: booking.bookingStatus,
        paymentStatus: booking.paymentStatus,
        paymentTransactionId: booking.paymentTransactionId ?? null,
      },
    });
  } catch (error) {
    console.error('verifyPayment error:', error);
    return sendError(response, { statusCode: 500, message: 'Failed to retrieve payment status.' });
  }
}

export async function getMyPayments(request, response) {
  try {
    const collection = process.env.NODE_ENV === 'test'
      ? getTransactionsCollection()
      : getDB().collection('payments');
    const payments = await collection
      .find({ renterId: request.user.userId })
      .sort({ createdAt: -1 })
      .toArray();

    return sendSuccess(response, {
      message: 'Payment history retrieved successfully.',
      data: { payments, count: payments.length },
    });
  } catch (error) {
    console.error('getMyPayments error:', error);
    return sendError(response, { statusCode: 500, message: 'Failed to retrieve payment history.' });
  }
}

export async function createCheckout(request, response) {
  if (process.env.NODE_ENV === 'test' && request.body?.outcome) {
    return createDemoCheckout(request, response);
  }
  return createStripeCheckout(request, response);
}
