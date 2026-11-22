import Stripe from 'stripe';

let stripeClient;

export function getStripeClient() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured.');
  }
  if (!stripeClient) stripeClient = new Stripe(secretKey);
  return stripeClient;
}

export function getStripeCurrency() {
  return (process.env.STRIPE_CURRENCY || 'bdt').toLowerCase();
}
