# Virtual Run Event CMS

A reusable, multi-event CMS for virtual running events. It includes a public registration page, admin event/participant dashboard, Stripe Checkout with webhook-confirmed payment, automatic PDF ticket email, activity proof uploads, and optional Strava linking/activity sync.

## Requirements

- Node.js 20+
- A persistent disk for SQLite and uploaded proofs in production
- Stripe account/webhook endpoint for online payments
- SMTP credentials for ticket email
- Strava API application (optional)

## Run locally

```sh
cp .env.example .env
npm install
npm start
```

Open http://localhost:3000. On first run, the CMS creates the database and seeds an example event. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` before starting; the password must be at least 12 characters. Visit `/admin` for the event dashboard.

Without Stripe configuration, online checkout is disabled (no fake payment success). In production, use HTTPS and a permanent disk.

## Stripe setup

1. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
2. Add a Stripe webhook pointing to `https://YOUR-DOMAIN/api/stripe/webhook` and subscribe to `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
3. Set `BASE_URL` to the public HTTPS origin. The server marks an order paid only after a verified webhook, then creates the PDF ticket and emails it.
4. Test with Stripe test-mode credentials before accepting real payments.

Never mark a registration paid based only on the browser redirect. Configure webhook retries and monitor server logs.

## Strava setup

Create a Strava API application and set its OAuth callback to `https://YOUR-DOMAIN/api/strava/callback`. Configure `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, and `BASE_URL`. After registering, the participant can link Strava at `/api/strava/connect/CODE` and sync activities from `/track/CODE`. Strava scopes, API limits, and review requirements are controlled by Strava; verify current requirements before launch.

## CMS and event lifecycle

- `/admin`: create and edit event details, activate a public event, search participants, export the latest 1,000 registrations to CSV, resend tickets, and review activity proofs.
- `/`: public event landing/registration.
- `/track/CODE`: upload a JPG/PNG/PDF activity proof or link/sync Strava.
- Ticket PDF is generated and emailed only after verified payment.
- Each event has a slug, dates, distances/prices, description, and active flag. Only one event can be active for public registration at a time.

## Important security and operational limitations

This repository is a starter application, not yet ready to accept real participant data or payments without further hardening and testing. In particular:

- Participant tracking currently uses a registration code in the URL as the access credential. Anyone who obtains that URL can see the tracking page and submit activity. Before launch, replace this with an expiring, single-purpose email verification link or OTP, add revocation, and rate-limit verification/upload endpoints.
- Upload filtering currently relies on the client-supplied MIME type. Before public use, validate file signatures, store files in private durable storage, and scan for malware; serve proof files only through authenticated admin routes.
- Ticket email failures are logged, not placed in a durable retry queue. Add retry/backoff and admin delivery status monitoring before a real event.
- Add backup/restore drills, payment reconciliation/refunds, privacy/retention policy, admin audit log, and production monitoring.
- SQLite/local upload storage requires a persistent disk and a single app instance. For horizontal scaling, migrate to managed PostgreSQL, shared session storage, and private object storage.
- Configure HTTPS, a unique strong `SESSION_SECRET`, strong admin password, SMTP deliverability, Stripe live webhook, privacy/legal copy, and test the full paid-registration flow in staging.

Do not put credentials in the repository or send secrets in chat. Configure them as environment variables in the hosting provider.
