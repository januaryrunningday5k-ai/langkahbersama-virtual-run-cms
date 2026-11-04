# Virtual Run Event CMS

Reusable CMS for virtual running events with an admin dashboard, Stripe Checkout, payment-webhook-confirmed tickets, email delivery retries, participant activity uploads and optional Strava sync.

## Run locally

Requires Node.js 20+. Copy `.env.example` to `.env`, change `SESSION_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`, then run `npm install && npm start`. Visit `/` for the event site and `/admin` for the CMS. The app creates an example event on first start; create and activate a future-dated event before opening registration.

## Hosting configuration

Configure all variables from `.env.example` in the hosting provider's secret/environment settings, not in Git. Use a persistent disk mounted at the parent directory of `DB_FILE`; the `uploads/` directory must also be on persistent private storage. This SQLite/local-file design is for a single server instance. Use PostgreSQL, shared session storage and private object storage before horizontal scaling. Enable HTTPS and configure the hosting platform's trusted proxy settings appropriately.

`BASE_URL` must be the public HTTPS origin. Set `NODE_ENV=production`, use a fresh unique session secret, and choose a strong admin password. Keep backups and test restores before an event.

## Stripe and automatic tickets

Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, then register `https://YOUR-DOMAIN/api/stripe/webhook` in Stripe for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `checkout.session.async_payment_failed`. Use Stripe test mode for staging first. The server confirms payment only from a valid signature-verified webhook, queues ticket email in SQLite, and retries temporary SMTP errors with exponential backoff (up to 12 attempts). Admins can inspect `/api/admin/ticket-jobs` after signing in and enqueue a resend from the participant list. Configure and verify SMTP deliverability: it is required both for participant email verification and ticket delivery.

A successful browser redirect alone is not payment confirmation. Reconcile transactions and implement your refund workflow with the payment provider before handling live sales.

## Participant access and activity moderation

Participants verify their registration email through a short-lived, single-use link before viewing activity data, uploading proof, or connecting/syncing Strava. Uploads are size-limited, checked against file signatures (JPEG, PNG, PDF), stored under random names with restrictive file permissions, and served only to admins. File signature checks do not replace malware scanning; add a malware scanning service and private object storage for public production use.

The admin Activity tab supports filtering/search and approve/reject moderation. Strava OAuth requires an application and callback URL `https://YOUR-DOMAIN/api/strava/callback`; Strava determines available scopes, quotas and review requirements.

## Admin features

- Create/edit and activate reusable events.
- Search and export up to 1,000 recent participants as CSV.
- Review activity submissions, approve/reject, and inspect uploaded evidence.
- Inspect payment state and ticket-mail queue status; enqueue paid-ticket resends.

## Before launch

- Run end-to-end staging tests for registration, Stripe webhook retries, email verification, ticket generation/delivery, upload validation, admin moderation and backup restoration.
- Configure privacy notice, consent, data-retention/deletion, refund/cancellation policy, monitoring and incident response.
- Add malware scanning and persistent private storage; consider PostgreSQL/Redis before multi-instance operation.
- Ensure event dates, prices, capacity, email sender and payment account are correct. Do not commit credentials or send them in chat.
