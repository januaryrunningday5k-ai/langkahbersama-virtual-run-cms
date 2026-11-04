# Virtual Run Event CMS

Reusable virtual-run CMS with admin event management, Stripe checkout, paid-ticket PDF/email delivery, participant activity uploads and optional Strava sync.

## Setup

Requires Node.js 20+, persistent storage for SQLite/uploads, Stripe and SMTP configuration for paid production use. Copy `.env.example` to `.env`, set a unique 32+ character `SESSION_SECRET`, `ADMIN_EMAIL`, and strong `ADMIN_PASSWORD`, then run `npm install && npm start`. Visit `/` and `/admin`.

## Ticket email retry queue

Verified Stripe webhooks enqueue a durable SQLite email job. The worker retries delivery with exponential backoff (up to 12 attempts); administrators can enqueue a resend using `/api/admin/tickets/CODE/resend` after sign-in. Jobs and failure details are available from `/api/admin/ticket-jobs`. Configure SMTP to send mail. The webhook remains idempotent and never trusts a browser redirect for payment confirmation.

## Participant access

A ticket code alone does not grant access to participant details or activity submission. Participants enter the ticket code and registration email at `/track/CODE`; the server emails a one-time, 20-minute verification link. The token is stored as a SHA-256 hash, is single-use, and establishes an HTTP-only session. The tracking API, upload endpoint, Strava connect and sync endpoints require this participant session. The participant can end the session with the logout button. Configure SMTP for verification messages.

## Upload security

Uploads are held in memory while size-limited, then accepted only when their file signature matches JPEG, PNG, or PDF. Server-generated random filenames and restrictive file permissions are used; files are not served publicly and admin access is required to view them. This is format validation, not malware scanning. For a public production system, also use private durable object storage, malware scanning, retention limits, and backups.

## Stripe

Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `BASE_URL`. Configure a Stripe webhook at `/api/stripe/webhook` for checkout completion and async payment success/failure. Test in Stripe test mode first. Real credentials must only be configured as deployment secrets, never committed to git.

## Strava

Set `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`, and register `${BASE_URL}/api/strava/callback` as the OAuth callback in Strava. API scopes/quotas and approval rules are set by Strava. Participants must verify their email before connecting or syncing.

## Important production notes

- Use HTTPS and a persistent disk. SQLite and local uploads are for a single-instance deployment; use PostgreSQL/shared sessions/object storage before scaling horizontally.
- Back up and test restoration of the database and uploaded files. Set privacy, consent, data-retention, and deletion policies.
- Payment reconciliation, refunds, malware scanning, monitoring, and end-to-end staging tests are still required before accepting real entrants.
- The example seeded event dates are illustrative; create and activate a future event in `/admin` before registration.
