import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAllowedOrigins } from '../config/cors.js';
import {
  isStripeSecretKeyConfigured,
  isStripeWebhookSecretConfigured,
} from '../services/stripeService.js';

describe('CORS origin configuration', () => {
  it('includes client and additional origins independently', () => {
    const origins = getAllowedOrigins(
      'https://rentora.example',
      'https://preview.rentora.example, http://localhost:4000',
    );

    assert.equal(origins.has('https://rentora.example'), true);
    assert.equal(origins.has('https://preview.rentora.example'), true);
    assert.equal(origins.has('http://localhost:4000'), true);
    assert.equal(origins.has('http://localhost:3000'), true);
  });

  describe('Stripe secret key configuration', () => {
    it('rejects live-mode, public, empty, and placeholder values', () => {
      assert.equal(isStripeSecretKeyConfigured('sk_live_'), false);
      assert.equal(isStripeSecretKeyConfigured('pk_test_'), false);
      assert.equal(isStripeSecretKeyConfigured(''), false);
      assert.equal(isStripeSecretKeyConfigured('your_stripe_test_secret_key'), false);
      if (process.env.STRIPE_SECRET_KEY) {
        assert.equal(
          isStripeSecretKeyConfigured(process.env.STRIPE_SECRET_KEY),
          /^sk_test_\S+$/.test(process.env.STRIPE_SECRET_KEY)
            && !/(your_|replace_with|placeholder)/i.test(process.env.STRIPE_SECRET_KEY),
        );
      }
    });

    it('requires a configured Stripe webhook signing secret', () => {
      assert.equal(isStripeWebhookSecretConfigured('your_stripe_webhook_secret'), false);
      assert.equal(isStripeWebhookSecretConfigured(''), false);
      if (process.env.STRIPE_WEBHOOK_SECRET) {
        assert.equal(
          isStripeWebhookSecretConfigured(process.env.STRIPE_WEBHOOK_SECRET),
          /^whsec_\S+$/.test(process.env.STRIPE_WEBHOOK_SECRET)
            && !/(your_|replace_with|placeholder)/i.test(process.env.STRIPE_WEBHOOK_SECRET),
        );
      }
    });
  });

  it('ignores empty origin configuration values', () => {
    const origins = getAllowedOrigins('', '');

    assert.equal(origins.has(''), false);
    assert.equal(origins.has('http://localhost:3000'), true);
  });
});
