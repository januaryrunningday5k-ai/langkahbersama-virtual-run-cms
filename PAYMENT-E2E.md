# Stripe test-mode and email verification runbook

This guide describes a manual staging test; it does not run transactions or verify your provider credentials automatically.

## Prepare

- Use Stripe test keys and a test webhook secret only.
- Configure a test SMTP inbox or mail-catcher, and verify your sender/domain with your provider.
- Start the app and confirm a future event is active.
- In a second terminal, forward webhooks with Stripe CLI: `stripe listen --forward-to localhost:3000/api/stripe/webhook`. Put the printed signing secret in `STRIPE_WEBHOOK_SECRET` and restart the app.

## Test flow

1. Register from the public page using an inbox you can inspect.
2. Complete Stripe Checkout using the official test card `4242 4242 4242 4242`, future expiry, any CVC and test postal code. Never enter real card data in test mode.
3. Verify Stripe CLI reports successful webhook delivery and the app records the paid state. A success-page redirect alone is not confirmation.
4. Confirm the test inbox receives the paid ticket PDF. Test participant email verification and that the link is single-use/expiring.
5. Upload allowed JPG/PNG/PDF and reject a renamed unsupported file. If malware scanning is configured, test clean and EICAR test files only in an isolated staging environment and verify detections are rejected/quarantined.
6. In Stripe test mode, process a refund through the provider dashboard, then compare Stripe records and CMS records/ledger. The current app has no automated refund reconciliation UI: document this as a manual test and do not claim automation.
7. Force SMTP failure in staging, restore valid settings, and verify retry behavior if the configured queue is active. Never perform this against live participants.

## Test record template

Record timestamp, environment, event/code (test data only), Stripe test session/payment/refund IDs, webhook event IDs and response, email delivery result, ticket result, upload scan result, backup/restore result, and operator. Do not include secrets or real participant personal data.

## Domain and HTTPS

An operator must configure DNS and hosting, obtain a valid TLS certificate, set `BASE_URL` to the HTTPS origin, verify redirects/cookies/webhook reachability, and run the flow above. This cannot be completed without domain/hosting access.
