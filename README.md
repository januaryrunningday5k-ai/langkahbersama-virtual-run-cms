# Virtual Run Event CMS

A reusable, multi-event CMS for virtual running events. It includes a public registration page, admin event/participant dashboard, Stripe Checkout with webhook-confirmed payment, automatic PDF ticket email, activity proof uploads, and optional Strava OAuth/activity sync.

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

Without Stripe configuration, online checkout is disabled (no fake payment success). You can inspect registration and content management locally. In production, use HTTPS and a permanent disk.

## Stripe setup

1. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
2. Add a Stripe webhook pointing to `https://YOUR-DOMAIN/api/stripe/webhook` and subscribe to `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
3. Set `BASE_URL` to the public HTTPS origin. The server marks an order paid only after a verified webhook, then creates the PDF ticket and emails it.
4. Test with Stripe test-mode credentials before accepting real payments.

Never mark a registration paid based only on the browser redirect. Configure webhook retries and monitor server logs.

## Strava setup (optional)

Create an API application in Strava and set its authorization callback URL to `https://YOUR-DOMAIN/api/strava/callback`. Configure `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, and `BASE_URL`. After registering, the participant can use the unique registration code to link Strava at `/api/strava/connect/CODE`. The app requests read access to activities and offers a sync button on the activity page. Strava API availability, quotas, scopes, and review requirements are controlled by Strava; verify current requirements before launch.

## CMS and event lifecycle

- `/admin`: sign in, create/edit events, activate the public event, and review registrations/activity proofs.
- `/`: public event landing/registration.
- `/track/CODE`: upload a JPG/PNG/PDF activity proof or link/sync Strava.
- Ticket PDF is generated and emailed only after verified payment.
- Each event has a slug, dates, distances/prices, description, and active flag. Only one event can be active for public registration at a time.

## Production checklist

- Use a managed database or persistent SQLite volume; local ephemeral filesystems lose data on redeploy. For multiple app instances, migrate SQLite and sessions to PostgreSQL/Redis.
- Configure HTTPS, secure session secret, backups, SMTP deliverability, Stripe live webhook, privacy/retention policy, and operational monitoring.
- Set a strong unique `SESSION_SECRET` and strong admin password. Keep `.env`, Stripe secrets, SMTP password, and Strava secret private.
- Uploads are stored on local disk and restricted by size/type. Use durable private object storage and malware scanning for a public production deployment.
- Add payment reconciliation, refund handling, consent/legal copy, rate-limit tuning, and accessibility/content review for your event.

## Environment variables

See `.env.example`. The application intentionally does not include real credentials or claim a payment has completed without a verified provider webhook.
