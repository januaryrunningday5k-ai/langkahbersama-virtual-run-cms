# Virtual Run Event CMS

Reusable CMS for virtual running events with an admin dashboard, Stripe Checkout, payment-webhook-confirmed tickets, email retries, activity uploads and optional Strava sync.

## Local setup

Requires Node.js 20+. Copy `.env.example` to `.env`, replace all placeholder credentials, then run `npm install && npm start`. Visit `/` for the event site and `/admin` for the CMS. The app creates an illustrative event on first start; create and activate a future-dated event before opening registration.

## Production deployment configuration

The repository includes a production `Dockerfile` and `compose.yaml`. Configure secrets in the host environment or an untracked `.env`; do not commit secrets. Set `BASE_URL` to your public HTTPS origin, a unique `SESSION_SECRET` (at least 32 characters), a strong admin password, Stripe live credentials/webhook, SMTP, and optional Strava credentials. `compose.yaml` persists SQLite in `/data` and uploads in a separate volume. It binds the service to localhost by default; put a TLS reverse proxy in front of it. Review proxy trust and firewall settings for your hosting environment before deployment.

Start:

```sh
cp .env.example .env
# Edit .env and replace every example value
mkdir -p backups
chmod +x scripts/backup.sh
 docker compose up --build -d
```

Back up the live database and uploaded evidence using the online SQLite backup API:

```sh
DB_FILE=/path/to/cms.db UPLOAD_DIR=/path/to/uploads BACKUP_DIR=./backups ./scripts/backup.sh
```

For the Docker Compose deployment, inspect the named volume mount path with `docker volume inspect`, or run a one-off backup container. Store backups encrypted and off-host; test restoration before an event. SQLite/local volumes target one application instance, not horizontal scaling.

## Stripe payment and automated tickets

Configure `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Register `https://YOUR-DOMAIN/api/stripe/webhook` in Stripe for checkout completion and async success/failure events. Payment is confirmed only by a valid signature-verified webhook. Paid tickets enter a persistent email queue with exponential retry; SMTP must be configured for delivery.

See [PAYMENT-E2E.md](PAYMENT-E2E.md) for Stripe test-mode checkout, CLI webhook forwarding, ticket email and failure/retry testing. Never use real card details during staging. The success redirect alone is not proof of payment.

## Admin monitoring

The admin dashboard includes payment state and ticket-mail status, attempt count, next retry time and last delivery error. Admins can manually enqueue a resend for paid tickets. Activity moderation supports search/filter, evidence viewing, and approve/reject.

For authenticated operational data, the admin API exposes `/api/admin/ticket-jobs`; use it only after admin login. No credentials should be sent in chat or stored in Git.

## Participant access, uploads and Strava

Participants verify their registered email with a short-lived, single-use link before viewing activity data, uploading proof, or connecting/syncing Strava. Uploads are size-limited, signature-checked (JPEG, PNG, PDF), stored under random names with restrictive permissions, and served only to admins. File signatures are not malware scanning; add a scanning service and private object storage for public production use.

For Strava, set `STRAVA_CLIENT_ID`/`STRAVA_CLIENT_SECRET` and register `https://YOUR-DOMAIN/api/strava/callback`. Check Strava's current scope, quota and review requirements.

## Deployment verification

Run a non-payment smoke test after deployment:

```sh
BASE_URL=https://your-domain.example ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='your-secret' npm run test:smoke
```

It checks public page, active event and authenticated admin read APIs. Complete the Stripe test-mode flow in `PAYMENT-E2E.md` before enabling live checkout.

Before launch, configure HTTPS, SMTP sender verification, durable storage, encrypted off-host backups, privacy/consent/retention policies, refunds/reconciliation, malware scanning, monitoring and incident response. Run a backup restore drill. Keep deployment credentials in provider secrets.
