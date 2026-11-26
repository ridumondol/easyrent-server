import { randomUUID } from 'node:crypto';
import { getDB } from '../config/db.js';
import { sendError, sendSuccess } from '../utils/response.js';
import { calculateRentalAmount, calculateTotalAmount } from '../utils/rental.js';
import { BOOKING_STATUS, PENDING_HOLD_MINUTES } from '../utils/constants.js';
import { getDateAvailability } from '../utils/availability.js';
import { isPositiveInteger, isPositiveNumber, isValidObjectId, toObjectId } from '../utils/validation.js';
import { refundPaymentRecord } from '../services/bookingLifecycleService.js';
import {
  constructStripeWebhookEvent,
  getStripeClient,
  getStripeCurrency,
  getStripeSecretKeyMode,
  isStripeSecretKeyConfigured,
  isStripeWebhookSecretConfigured,
  refundStripePaymentIntent,
} from '../services/stripeService.js';

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

function calculateBookingUnitAmount(booking) {
  if (!isPositiveNumber(booking.pricePerDay) || !isPositiveInteger(booking.totalDays)) return null;
  const amount = booking.rentalType
    ? calculateRentalAmount(booking.pricePerDay, 1, booking.totalDays, booking.rentalType)
    : calculateTotalAmount(booking.pricePerDay, 1, booking.totalDays);
  const amountInCents = Math.round(amount * 100);
  return Number.isSafeInteger(amountInCents) && amountInCents > 0 ? amount : null;
}

function getPendingHoldCutoff(now) {
  return new Date(now.getTime() - PENDING_HOLD_MINUTES * 60 * 1000);
}

function isEligibleForCheckout(booking) {
  return booking.paymentStatus === 'unpaid'
    && (
      booking.bookingStatus === BOOKING_STATUS.PENDING
      || booking.bookingStatus === BOOKING_STATUS.CONFIRMED
      || booking.bookingStatus === BOOKING_STATUS.COMPLETED
    );
}

function hasExpiredPendingHold(booking, now) {
  return booking.bookingStatus === BOOKING_STATUS.PENDING
    && (!(booking.createdAt instanceof Date) || booking.createdAt < getPendingHoldCutoff(now));
}

function getPaymentIntentId(paymentIntent) {
  if (typeof paymentIntent === 'string') return paymentIntent;
  return typeof paymentIntent?.id === 'string' ? paymentIntent.id : '';
}

async function refundCapturedStripePayment({
  payment,
  booking,
  payments,
  paymentIntentId,
  reason,
  now,
  refundStripePayment,
}) {
  await payments.updateOne(
    { _id: payment._id, status: { $in: ['pending', 'failed', 'cancelled', 'success'] } },
    {
      $set: {
        status: 'success',
        stripePaymentIntentId: paymentIntentId,
        updatedAt: now,
      },
    },
  );
  const capturedPayment = {
    ...payment,
    status: 'success',
    stripePaymentIntentId: paymentIntentId,
  };
  const bookings = getBookingsCollection();
  const bookingAlreadyPaidForAnotherPayment =
    booking?.paymentStatus === 'paid'
    && booking.paymentTransactionId
    && booking.paymentTransactionId !== payment.transactionId;

  if (booking && !bookingAlreadyPaidForAnotherPayment) {
    await bookings.updateOne(
      { _id: booking._id, bookingStatus: { $ne: BOOKING_STATUS.COMPLETED } },
      {
        $set: {
          bookingStatus: BOOKING_STATUS.CANCELLED,
          paymentStatus: 'paid',
          paymentTransactionId: payment.transactionId,
          paidAt: booking.paidAt ?? now,
          cancellationReason: reason,
          refundStatus: 'pending',
          updatedAt: now,
        },
      },
    );
  }

  await refundPaymentRecord(capturedPayment, payments, now, refundStripePayment);
  if (booking) {
    await bookings.updateOne(
      {
        _id: booking._id,
        paymentStatus: 'paid',
        paymentTransactionId: payment.transactionId,
      },
      {
        $set: {
          paymentStatus: 'refunded',
          refundStatus: 'succeeded',
          refundedAt: now,
          cancellationReason: reason,
          updatedAt: now,
        },
      },
    );
  }
}

async function claimStripePayment(bookings, initialBooking, payment, now) {
  let booking = initialBooking;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (
      booking.paymentStatus === 'paid'
      && booking.paymentTransactionId === payment.transactionId
    ) {
      return booking;
    }

    const wasExpiredHold =
      booking.bookingStatus === BOOKING_STATUS.CANCELLED
      && booking.paymentStatus === 'unpaid'
      && booking.cancellationReason === 'payment_hold_expired';
    const canAcceptPayment =
      (booking.bookingStatus === BOOKING_STATUS.PENDING && booking.paymentStatus === 'unpaid')
      || wasExpiredHold
      || (booking.bookingStatus === BOOKING_STATUS.CONFIRMED && booking.paymentStatus === 'unpaid')
      || (booking.bookingStatus === BOOKING_STATUS.COMPLETED && booking.paymentStatus === 'unpaid');
    if (!canAcceptPayment) return null;

    const update = await bookings.updateOne(
      {
        _id: booking._id,
        renterId: payment.renterId,
        bookingStatus: booking.bookingStatus,
        paymentStatus: 'unpaid',
        ...(wasExpiredHold ? { cancellationReason: 'payment_hold_expired' } : {}),
      },
      {
        $set: {
          ...(wasExpiredHold ? { bookingStatus: BOOKING_STATUS.PENDING } : {}),
          paymentStatus: 'paid',
          paymentTransactionId: payment.transactionId,
          paidAt: now,
          updatedAt: now,
        },
        ...(wasExpiredHold ? { $unset: { cancellationReason: '' } } : {}),
      },
    );
    if (update.modifiedCount === 1) {
      return bookings.findOne({ _id: booking._id });
    }

    booking = await bookings.findOne({ _id: booking._id, renterId: payment.renterId });
    if (!booking) return null;
  }
  return null;
}

function getStripeSessionValidationError(session, payment) {
  if (session.id !== payment.stripeCheckoutSessionId) return 'Stripe Checkout session does not match the stored payment.';
  if (session.mode !== 'payment') return 'Stripe Checkout session is not a one-time payment.';
  if (session.status !== 'complete' || session.payment_status !== 'paid') {
    return 'Stripe has not confirmed a completed payment.';
  }
  if (typeof session.livemode !== 'boolean') return 'Stripe Checkout session mode could not be verified.';
  const configuredMode = getStripeSecretKeyMode();
  if ((configuredMode && (session.livemode ? 'live' : 'test') !== configuredMode)
    || (process.env.NODE_ENV === 'production' && !configuredMode)) {
    return 'Stripe Checkout session mode does not match the server configuration.';
  }
  if (
    session.metadata?.bookingId !== payment.bookingId.toString()
    || session.metadata?.renterId !== payment.renterId.toString()
    || session.metadata?.transactionId !== payment.transactionId
    || !Number.isSafeInteger(session.amount_total)
    || session.amount_total !== Math.round(payment.amount * 100)
    || session.currency?.toLowerCase() !== payment.currency
  ) {
    return 'Stripe Checkout session does not match the stored payment.';
  }
  return null;
}

async function settleSuccessfulStripePayment(
  session,
  refundStripePayment = refundStripePaymentIntent,
) {
  const payments = getDB().collection('payments');
  const payment = await payments.findOne({ stripeCheckoutSessionId: session.id });
  if (!payment) return { error: 'Payment record for this Checkout session was not found.', statusCode: 404 };

  const validationError = getStripeSessionValidationError(session, payment);
  if (validationError) return { error: validationError, statusCode: 400 };
  if (payment.status === 'refunded') return { paymentStatus: 'refunded' };

  const bookings = getBookingsCollection();
  const booking = await bookings.findOne({
    _id: payment.bookingId,
    renterId: payment.renterId,
  });
  const paymentIntentId = getPaymentIntentId(session.payment_intent);
  const now = new Date();

  if (!booking) {
    await refundCapturedStripePayment({
      payment,
      payments,
      paymentIntentId,
      reason: 'booking_not_found',
      now,
      refundStripePayment,
    });
    return { paymentStatus: 'refunded' };
  }

  const calculatedAmount = calculateBookingAmount(booking);
  if (
    calculatedAmount === null
    || Math.round(calculatedAmount * 100) !== Math.round(payment.amount * 100)
  ) {
    await refundCapturedStripePayment({
      payment,
      booking,
      payments,
      paymentIntentId,
      reason: 'booking_amount_mismatch',
      now,
      refundStripePayment,
    });
    return { paymentStatus: 'refunded' };
  }

  if (
    payment.status === 'success'
    && booking.paymentStatus === 'paid'
    && booking.paymentTransactionId === payment.transactionId
    && booking.refundStatus !== 'pending'
    && booking.refundStatus !== 'failed'
  ) {
    return { paymentStatus: booking.paymentStatus };
  }

  if (
    booking.paymentStatus === 'paid'
    && booking.paymentTransactionId === payment.transactionId
    && (booking.refundStatus === 'pending' || booking.refundStatus === 'failed')
  ) {
    await refundCapturedStripePayment({
      payment,
      booking,
      payments,
      paymentIntentId,
      reason: booking.cancellationReason || 'payment_refund_pending',
      now,
      refundStripePayment,
    });
    return { paymentStatus: 'refunded' };
  }

  const paidBooking = await claimStripePayment(bookings, booking, payment, now);
  if (!paidBooking) {
    await refundCapturedStripePayment({
      payment,
      booking,
      payments,
      paymentIntentId,
      reason: 'booking_no_longer_eligible',
      now,
      refundStripePayment,
    });
    return { paymentStatus: 'refunded' };
  }

  const equipment = await getDB().collection('equipment').findOne({
    _id: paidBooking.equipmentId,
  });
  const availability = equipment
    ? await getDateAvailability({
        equipment,
        startDate: paidBooking.startDate,
        endDate: paidBooking.endDate,
        excludeBookingId: paidBooking._id,
      })
    : null;

  await payments.updateOne(
    { _id: payment._id, status: { $in: ['pending', 'failed', 'cancelled', 'success'] } },
    {
      $set: {
        status: 'success',
        stripePaymentIntentId: paymentIntentId,
        updatedAt: now,
      },
    },
  );

  const needsAvailabilityCheck = paidBooking.bookingStatus !== BOOKING_STATUS.COMPLETED;
  if (needsAvailabilityCheck && (!availability || paidBooking.quantity > availability.availableQuantity)) {
    await refundCapturedStripePayment({
      payment: { ...payment, status: 'success', stripePaymentIntentId: paymentIntentId },
      booking: paidBooking,
      payments,
      paymentIntentId,
      reason: 'late_payment_inventory_unavailable',
      now,
      refundStripePayment,
    });
    return { paymentStatus: 'refunded' };
  }

  const settledBooking = await bookings.findOne({ _id: paidBooking._id });
  return { paymentStatus: settledBooking?.paymentStatus ?? 'unpaid' };
}

async function ensureSuccessfulPaymentIndex(transactions) {
  await transactions.createIndex(
    { bookingId: 1 },
    {
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
    // Keep the existing test collection for automated tests; real app demo
    // transactions belong in the same collection used by payment history.
    const transactions = process.env.NODE_ENV === 'test'
      ? getTransactionsCollection()
      : getDB().collection('payments');
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
    if (!isEligibleForCheckout(booking)) {
      return sendError(response, { statusCode: 400, message: 'Only pending or confirmed, unpaid bookings can be paid.' });
    }

    const now = new Date();
    if (hasExpiredPendingHold(booking, now)) {
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
      currency: 'bdt',
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
          bookingStatus: booking.bookingStatus,
          paymentStatus: 'unpaid',
          ...(booking.bookingStatus === BOOKING_STATUS.PENDING
            ? { createdAt: { $gte: getPendingHoldCutoff(now) } }
            : {}),
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

export async function createStripeCheckout(request, response, dependencies = {}) {
  const { bookingId } = request.body ?? {};
  if (!isValidObjectId(bookingId)) {
    return sendError(response, { statusCode: 400, message: 'A valid bookingId is required.' });
  }
  if (!process.env.CLIENT_URL) {
    return sendError(response, { statusCode: 503, message: 'CLIENT_URL is not configured for checkout redirects.' });
  }
  if (!isStripeSecretKeyConfigured()) {
    return sendError(response, {
      statusCode: 503,
      message: 'Stripe payments are unavailable. Configure a valid Stripe test secret key (sk_test_...) in the server environment.',
    });
  }

  try {
    const stripe = dependencies?.stripeClient ?? getStripeClient();
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
    if (!isEligibleForCheckout(booking)) {
      return sendError(response, { statusCode: 400, message: 'Only pending or confirmed, unpaid bookings can be paid.' });
    }

    const now = new Date();
    if (hasExpiredPendingHold(booking, now)) {
      return sendError(response, { statusCode: 400, message: 'The pending booking hold has expired.' });
    }
    const amount = calculateBookingAmount(booking);
    const unitAmount = calculateBookingUnitAmount(booking);
    if (amount === null || unitAmount === null || Math.round(unitAmount * booking.quantity * 100) !== Math.round(amount * 100)) {
      return sendError(response, { statusCode: 400, message: 'Booking pricing is invalid and cannot be paid.' });
    }

    let existingPayment = await payments.findOne({
      bookingId: bookingObjectId,
      renterId: request.user.userId,
      status: 'pending',
    });
    if (existingPayment?.stripeCheckoutSessionId) {
      const existingSession = await stripe.checkout.sessions.retrieve(existingPayment.stripeCheckoutSessionId);
      if (existingSession.status === 'open' && existingSession.url) {
        if (!existingPayment.checkoutReservation) {
          await payments.updateOne(
            { _id: existingPayment._id, status: 'pending' },
            { $set: { checkoutReservation: true, updatedAt: now } },
          );
        }
        return sendSuccess(response, {
          message: 'Stripe Checkout session retrieved.',
          data: { checkoutUrl: existingSession.url, sessionId: existingSession.id },
        });
      }
      if (existingSession.status === 'complete') {
        if (existingSession.payment_status === 'paid') {
          const settlement = await settleSuccessfulStripePayment(existingSession);
          if (settlement.error) {
            return sendError(response, {
              statusCode: settlement.statusCode,
              message: settlement.error,
            });
          }
          if (settlement.paymentStatus === 'paid') {
            return sendSuccess(response, {
              message: 'Payment confirmed successfully.',
              data: { bookingId: booking._id, paymentStatus: 'paid' },
            });
          }
          if (settlement.paymentStatus === 'refunded') {
            return sendError(response, {
              statusCode: 409,
              message: 'The payment was refunded because the booking could not be completed.',
            });
          }
        }
        return sendError(response, {
          statusCode: 409,
          message: 'This payment is processing. Check your payment history before trying again.',
        });
      }
      if (existingSession.status === 'expired') {
        await payments.updateOne(
          { _id: existingPayment._id, status: 'pending' },
          { $set: { status: 'cancelled', updatedAt: now } },
        );
        existingPayment = null;
      } else {
        return sendError(response, {
          statusCode: 409,
          message: 'An existing payment session could not be verified. Please try again later.',
        });
      }
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

    let reservation = existingPayment;
    if (reservation) {
      try {
        await payments.updateOne(
          { _id: reservation._id, status: 'pending' },
          { $set: { checkoutReservation: true, updatedAt: now } },
        );
      } catch (error) {
        if (error?.code !== 11000) throw error;
        reservation = await payments.findOne({
          bookingId: bookingObjectId,
          renterId: request.user.userId,
          status: 'pending',
          checkoutReservation: true,
        });
      }
    } else {
      const newReservation = {
        transactionId: randomUUID(),
        bookingId: bookingObjectId,
        renterId: request.user.userId,
        amount,
        currency,
        productName: equipment.title,
        checkoutReservation: true,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };
      try {
        const result = await payments.insertOne(newReservation);
        reservation = { ...newReservation, _id: result.insertedId };
      } catch (error) {
        if (error?.code !== 11000) throw error;
        reservation = await payments.findOne({
          bookingId: bookingObjectId,
          renterId: request.user.userId,
          status: 'pending',
          checkoutReservation: true,
        });
      }
    }

    if (!reservation) {
      return sendError(response, {
        statusCode: 409,
        message: 'A checkout session is already being created for this booking.',
      });
    }

    const successUrl = new URL(`/payment/success?booking_id=${bookingObjectId}&session_id={CHECKOUT_SESSION_ID}`, process.env.CLIENT_URL).toString();
    const cancelUrl = new URL(`/payment/cancelled?booking_id=${bookingObjectId}`, process.env.CLIENT_URL).toString();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: reservation.currency,
          unit_amount: Math.round(unitAmount * 100),
          product_data: { name: reservation.productName || equipment.title },
        },
        quantity: booking.quantity,
      }],
      metadata: {
        bookingId: bookingObjectId.toString(),
        renterId: request.user.userId.toString(),
        transactionId: reservation.transactionId,
      },
      payment_intent_data: {
        metadata: {
          bookingId: bookingObjectId.toString(),
          renterId: request.user.userId.toString(),
          transactionId: reservation.transactionId,
        },
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    }, { idempotencyKey: reservation.transactionId });
    if (!session.url) throw new Error('Stripe did not return a Checkout URL.');

    await payments.updateOne(
      { _id: reservation._id, status: 'pending' },
      {
        $set: {
          stripeCheckoutSessionId: session.id,
          updatedAt: new Date(),
          ...(session.expires_at
            ? { sessionExpiresAt: new Date(session.expires_at * 1000) }
            : {}),
        },
      },
    );

    return sendSuccess(response, {
      statusCode: 201,
      message: 'Stripe Checkout session created.',
      data: { checkoutUrl: session.url, sessionId: session.id },
    });
  } catch (error) {
    console.error('Stripe checkout creation failed:', error?.message ?? error);
    return sendError(response, { statusCode: 502, message: 'Unable to create a Stripe Checkout session.' });
  }
}

export async function handleStripeWebhook(
  request,
  response,
  refundStripePayment = refundStripePaymentIntent,
) {
  const signature = request.headers['stripe-signature'];
  if (typeof signature !== 'string') {
    return sendError(response, { statusCode: 400, message: 'Stripe webhook signature is missing.' });
  }
  if (!isStripeWebhookSecretConfigured()) {
    return sendError(response, { statusCode: 503, message: 'Stripe webhook signing is not configured.' });
  }

  let event;
  try {
    event = constructStripeWebhookEvent(request.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    console.warn('Stripe webhook signature verification failed.');
    return sendError(response, { statusCode: 400, message: 'Invalid Stripe webhook signature.' });
  }

  const configuredMode = getStripeSecretKeyMode();
  if (
    (configuredMode && (event.livemode ? 'live' : 'test') !== configuredMode)
    || (process.env.NODE_ENV === 'production' && !configuredMode)
  ) {
    console.warn('Rejected a Stripe webhook event that does not match the configured Stripe mode.');
    return sendError(response, { statusCode: 400, message: 'Stripe event mode does not match the server configuration.' });
  }

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      if (session.payment_status !== 'paid') {
        return sendSuccess(response, {
          message: 'Stripe payment is still processing.',
          data: { received: true },
        });
      }
      const settlement = await settleSuccessfulStripePayment(session, refundStripePayment);
      if (settlement.error) {
        return sendError(response, {
          statusCode: settlement.statusCode,
          message: settlement.error,
        });
      }
    } else if (
      event.type === 'checkout.session.expired'
      || event.type === 'checkout.session.async_payment_failed'
    ) {
      const session = event.data.object;
      await getDB().collection('payments').updateOne(
        { stripeCheckoutSessionId: session.id, status: 'pending' },
        { $set: { status: event.type === 'checkout.session.expired' ? 'cancelled' : 'failed', updatedAt: new Date() } },
      );
    } else if (event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object;
      await getDB().collection('payments').updateOne(
        {
          $or: [
            { stripePaymentIntentId: paymentIntent.id },
            ...(typeof paymentIntent.metadata?.transactionId === 'string'
              ? [{ transactionId: paymentIntent.metadata.transactionId }]
              : []),
          ],
          status: 'pending',
        },
        { $set: { status: 'failed', stripePaymentIntentId: paymentIntent.id, updatedAt: new Date() } },
      );
    } else if (event.type === 'charge.refunded') {
      const charge = event.data.object;
      const paymentIntentId = getPaymentIntentId(charge.payment_intent);
      if (paymentIntentId) {
        const payments = getDB().collection('payments');
        const payment = await payments.findOne({ stripePaymentIntentId: paymentIntentId });
        if (payment && charge.amount_refunded >= charge.amount) {
          const refundId = charge.refunds?.data?.[0]?.id;
          if (payment.status !== 'refunded') {
            await payments.updateOne(
              { _id: payment._id, status: { $ne: 'refunded' } },
              {
                $set: {
                  status: 'refunded',
                  refundedAt: new Date(),
                  updatedAt: new Date(),
                  ...(refundId ? { stripeRefundId: refundId } : {}),
                },
              },
            );
          }
          await getBookingsCollection().updateOne(
            {
              _id: payment.bookingId,
              renterId: payment.renterId,
              paymentTransactionId: payment.transactionId,
              paymentStatus: 'paid',
            },
            { $set: { paymentStatus: 'refunded', refundStatus: 'succeeded', refundedAt: new Date(), updatedAt: new Date() } },
          );
        }
      }
    }

    return sendSuccess(response, { message: 'Stripe event received.', data: { received: true } });
  } catch (error) {
    console.error('Stripe webhook processing failed:', error?.message ?? error);
    return sendError(response, { statusCode: 500, message: 'Stripe webhook could not be processed.' });
  }
}

export async function verifyPayment(request, response, dependencies = {}) {
  const { bookingId } = request.params;
  if (!isValidObjectId(bookingId)) {
    return sendError(response, { statusCode: 400, message: 'Invalid booking ID.' });
  }

  try {
    const booking = await getBookingsCollection().findOne({ _id: toObjectId(bookingId) });
    if (!booking) return sendError(response, { statusCode: 404, message: 'Booking not found.' });
    const isRenter = String(booking.renterId) === String(request.user.userId);
    const isOwner = String(booking.ownerId) === String(request.user.userId);
    const isAdmin = request.user.role === 'admin';
    if (!isRenter && !isOwner && !isAdmin) {
      return sendError(response, { statusCode: 403, message: 'You are not authorized to view this payment.' });
    }

    const requestedSessionId = request.query.session_id;
    const paymentFilter = {
      bookingId: booking._id,
      ...(isRenter ? { renterId: request.user.userId } : {}),
    };
    if (typeof requestedSessionId === 'string' && requestedSessionId) {
      paymentFilter.stripeCheckoutSessionId = requestedSessionId;
    }
    const payment = await getDB().collection('payments').findOne(paymentFilter, {
      sort: { createdAt: -1 },
    });
    if (typeof requestedSessionId === 'string' && requestedSessionId && !payment) {
      return sendError(response, { statusCode: 404, message: 'Checkout session was not found for this booking.' });
    }
    let stripeSession = null;
    if (payment?.stripeCheckoutSessionId) {
      if (
        typeof requestedSessionId === 'string'
        && requestedSessionId !== payment.stripeCheckoutSessionId
      ) {
        return sendError(response, { statusCode: 404, message: 'Checkout session was not found for this booking.' });
      }
      if (!isStripeSecretKeyConfigured()) {
        return sendError(response, { statusCode: 503, message: 'Stripe payment verification is unavailable.' });
      }
      stripeSession = await (dependencies?.stripeClient ?? getStripeClient()).checkout.sessions.retrieve(payment.stripeCheckoutSessionId);
      if (stripeSession.id !== payment.stripeCheckoutSessionId) {
        return sendError(response, { statusCode: 502, message: 'Stripe returned a different Checkout session.' });
      }
      if (stripeSession.status === 'expired') {
        await getDB().collection('payments').updateOne(
          { _id: payment._id, status: 'pending' },
          { $set: { status: 'cancelled', updatedAt: new Date() } },
        );
      } else if (stripeSession.status === 'complete' && stripeSession.payment_status === 'paid') {
        const settlement = await settleSuccessfulStripePayment(stripeSession);
        if (settlement.error) {
          return sendError(response, {
            statusCode: settlement.statusCode,
            message: settlement.error,
          });
        }
      }
    }

    const latestBooking = await getBookingsCollection().findOne({ _id: booking._id });
    return sendSuccess(response, {
      message: 'Payment status retrieved successfully.',
      data: {
        bookingId: booking._id,
        bookingStatus: latestBooking?.bookingStatus ?? booking.bookingStatus,
        paymentStatus: latestBooking?.paymentStatus ?? booking.paymentStatus,
        paymentTransactionId: latestBooking?.paymentTransactionId ?? null,
        stripeSessionStatus: stripeSession?.status ?? null,
        stripePaymentStatus: stripeSession?.payment_status ?? null,
      },
    });
  } catch (error) {
    console.error('verifyPayment error:', error?.message ?? error);
    return sendError(response, { statusCode: 502, message: 'Unable to verify payment with Stripe.' });
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

export async function createCheckout(request, response, dependencies = {}) {
  const { paymentMethod, outcome } = request.body ?? {};
  if (paymentMethod !== undefined || outcome !== undefined) {
    if (process.env.NODE_ENV !== 'production' && process.env.ENABLE_DEMO_PAYMENTS === 'true') {
      return createDemoCheckout(request, response);
    }
    if (process.env.NODE_ENV !== 'production') {
      return sendError(response, { statusCode: 403, message: 'Demo payments are disabled. Use Stripe Checkout.' });
    }
  }
  return createStripeCheckout(request, response, dependencies);
}

export async function reconcileBookingPayment(bookingId) {
  try {
    const payments = getDB().collection('payments');
    const payment = await payments.findOne({
      bookingId: toObjectId(bookingId),
      status: 'pending',
    });
    if (!payment?.stripeCheckoutSessionId) return null;
    if (!isStripeSecretKeyConfigured()) return null;
    const stripe = getStripeClient();
    if (!stripe) return null;
    const session = await stripe.checkout.sessions.retrieve(payment.stripeCheckoutSessionId);
    if (session.status === 'complete' && session.payment_status === 'paid') {
      return await settleSuccessfulStripePayment(session);
    }
  } catch (err) {
    console.error('reconcileBookingPayment error:', err?.message ?? err);
  }
  return null;
}
