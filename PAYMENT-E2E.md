# Payment and ticket end-to-end test (Stripe test mode)

This test exercises checkout creation, webhook-confirmed payment, persistent ticket-email queueing, PDF ticket creation, and admin visibility. It does not use real money.

## Prerequisites

- Run the app locally with Node.js 20+ and a persistent writable data directory.
- Use Stripe **test-mode** API keys only. Never put secrets in this document or commit them.
- Configure a test SMTP inbox/provider, or use a mail catcher such as Mailpit. The payment can still be recorded without SMTP, but delivery cannot pass.
- Install and authenticate Stripe CLI for the same test account.

Set these in `.env`:

```dotenv
NODE_ENV=development
BASE_URL=http://localhost:3000
STRIPE_SECRET_KEY=sk_test_...
SMTP_HOST=...
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...
MAIL_FROM=Virtual Run Test <verified-sender@example.test>
```

Start the CMS in one terminal:

```sh
npm start
```

In another terminal, forward Stripe test webhooks. Copy the signing secret printed by Stripe CLI into `STRIPE_WEBHOOK_SECRET` in `.env`, then restart the CMS:

```sh
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Stripe CLI may need to be restarted after app restart; keep it forwarding during the test.

## Exercise checkout

1. Open `http://localhost:3000`, register with an inbox you can inspect, and choose a category.
2. Stripe Checkout opens in test mode. Use Stripe's official test card `4242 4242 4242 4242`, a future expiry, any CVC and a test postal code. Never enter real card data in test mode.
3. Complete checkout. The success page may initially say the payment is processing; the signed webhook, not the redirect, is authoritative.
4. Check terminal logs and Stripe CLI for a successful `checkout.session.completed` event. For asynchronous payment methods, verify the corresponding async success event.
5. Confirm the test inbox receives the PDF ticket and participant verification message. Open `/track/TICKET-CODE`, request an access link using the registration email, and verify that the one-time link works only once and expires after 20 minutes.
6. Sign into `/admin` and confirm registration shows `Lunas`, ticket delivery timestamp appears, and the mail queue reports `Terkirim`.
7. For retry testing, temporarily configure an invalid SMTP password before completing a second test checkout. Confirm the ticket job becomes retryable with an error/attempt count. Restore SMTP and wait for backoff, or use the admin resend action; confirm delivery and sent status.

## Negative checks

- Open a made-up checkout success URL: it must not mark any registration paid.
- Send a webhook with a bad signature: the endpoint must reject it.
- Repeat the same valid Stripe event: the registration remains paid and there is no duplicate ticket job (resending manually is an explicit action).
- Confirm cancelled/failed checkout does not issue a paid ticket.

## Deployment smoke test

With the app deployed and admin credentials provided securely in your shell environment:

```sh
BASE_URL=https://your-domain.example ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='...' npm run test:smoke
```

The smoke test checks the public page, active event, admin authentication, and read access to event, registration, activity and mail-queue APIs. It does not create registrations or charge payments.
