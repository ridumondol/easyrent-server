import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getStripeClient,
  isStripeSecretKeyConfigured,
  isStripeWebhookSecretConfigured,
} from '../services/stripeService.js';

describe('Stripe environment configuration validation', () => {
  it('initializes the installed Stripe SDK with Checkout session methods', () => {
    const originalKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_1234567890abcdefghijkl';

    try {
      const stripe = getStripeClient();
      assert.equal(typeof stripe.checkout.sessions.create, 'function');
      assert.equal(typeof stripe.checkout.sessions.retrieve, 'function');
    } finally {
      if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = originalKey;
    }
  });

  it('accepts a Stripe test secret and rejects other key types and placeholders', () => {
    assert.equal(isStripeSecretKeyConfigured('sk_test_1234567890abcdef'), true);
    for (const key of [
      '',
      'pk_test_1234567890abcdef',
      'rk_test_1234567890abcdef',
      'rkcs_test_1234567890abcdef',
      'sk_live_1234567890abcdef',
      'sk_test_short',
      'sk_test_your_test_secret_key',
      'sk_test_replace_this_value',
      ' sk_test_1234567890abcdef',
    ]) {
      assert.equal(isStripeSecretKeyConfigured(key), false, `expected rejection for ${key}`);
    }
  });

  it('accepts correctly shaped webhook signing secrets and rejects placeholders', () => {
    assert.equal(isStripeWebhookSecretConfigured('whsec_1234567890abcdef'), true);
    for (const secret of [
      '',
      'sk_test_1234567890abcdef',
      'whsec_short',
      'whsec_your_webhook_secret',
      'whsec_replace_with_value',
      'whsec_invalid.secret!chars',
    ]) {
      assert.equal(isStripeWebhookSecretConfigured(secret), false, `expected rejection for ${secret}`);
    }
  });
});
