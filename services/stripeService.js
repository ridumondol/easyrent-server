import Stripe from 'stripe';

let stripeClient;

export function isStripeSecretKeyConfigured(secretKey = process.env.STRIPE_SECRET_KEY) {
  return typeof secretKey === 'string'
    && /^sk_(test|live)_[A-Za-z0-9]{16,}$/.test(secretKey)
    && !/(your|replace|placeholder|example|dummy|changeme)/i.test(secretKey);
}

export function getStripeSecretKeyMode(secretKey = process.env.STRIPE_SECRET_KEY) {
  if (!isStripeSecretKeyConfigured(secretKey)) return null;
  return secretKey.startsWith('sk_live_') ? 'live' : 'test';
}

export function isStripeWebhookSecretConfigured(secret = process.env.STRIPE_WEBHOOK_SECRET) {
  return typeof secret === 'string'
    && /^whsec_[A-Za-z0-9_-]{16,}$/.test(secret)
    && !/(your|replace|placeholder|example|dummy|changeme)/i.test(secret);
}

export function getStripeClient() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!isStripeSecretKeyConfigured(secretKey)) {
    throw new Error('STRIPE_SECRET_KEY must be a configured Stripe test secret key.');
  }
  if (!stripeClient) stripeClient = new Stripe(secretKey);
  return stripeClient;
}

export function constructStripeWebhookEvent(payload, signature, secret) {
  return Stripe.webhooks.constructEvent(payload, signature, secret);
}

export function refundStripePaymentIntent(paymentIntentId, idempotencyKey) {
  return getStripeClient().refunds.create(
    { payment_intent: paymentIntentId },
    { idempotencyKey },
  );
}

export function getStripeCurrency() {
  return (process.env.STRIPE_CURRENCY || 'bdt').toLowerCase();
}
