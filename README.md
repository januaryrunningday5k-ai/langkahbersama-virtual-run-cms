# Virtual Run Event CMS

Reusable CMS for virtual running events with event management, Stripe Checkout, payment-webhook-confirmed tickets, activity submissions and Strava integration.

## Production deployment starter

This repository includes a Dockerfile and `compose.yaml` with persistent Docker volumes for SQLite and uploads. They are deployment scaffolding—not a deployed service. A domain, host, TLS certificate/reverse proxy, Stripe account, SMTP provider, and their secrets must be supplied by the operator. Do not commit `.env` or credentials.

1. Copy `.env.example` to `.env`; set a unique `SESSION_SECRET` (32+ random characters), strong admin password, public HTTPS `BASE_URL`, Stripe and SMTP credentials.
2. Start with `docker compose up --build -d`. The service binds to localhost; configure a TLS reverse proxy and firewall on the host. Review proxy trust and hosting-provider instructions.
3. Persist and back up `/data` and `/app/uploads`. For Docker, use the named volumes listed in `compose.yaml`. SQLite is intended for one app instance; use PostgreSQL/shared sessions/object storage for scaling.
4. Configure Stripe webhook at `https://YOUR-DOMAIN/api/stripe/webhook` and use test-mode credentials first. A successful browser redirect does not prove payment.

## Backups

`./scripts/backup.sh` creates a SQLite online backup and a compressed upload snapshot. Set `DB_FILE`, `UPLOAD_DIR`, and `BACKUP_DIR` to the actual persistent paths. Store encrypted copies off-host. To verify a backup without overwriting production, run:

```sh
DB_BACKUP=/path/to/cms-backup.db UPLOAD_BACKUP=/path/to/uploads-backup.tar.gz ./scripts/restore-test.sh
```

This checks SQLite integrity and required tables. It does not prove a full application recovery; perform a staging restore and check uploaded records/login before launch.

## Payment, email, refunds and reconciliation

Stripe Checkout/webhook and email ticket delivery depend on valid Stripe and SMTP secrets. Follow [PAYMENT-E2E.md](PAYMENT-E2E.md) to test in Stripe test mode. This runbook is a manual procedure; it is not evidence that a live transaction or SMTP verification has been completed.

**Important:** the current CMS does not yet include a complete in-app refund/reconciliation workflow. Do not promise automatic refunds. Refunds must be processed in Stripe Dashboard and recorded/reconciled by an authorized operator until a tested admin workflow is implemented. Keep a transaction ledger, verify the Stripe payment/refund IDs, amount, currency and registration code, and run periodic reports against Stripe. Do not manually mark payment as paid based on a browser redirect.

## Upload scanning

The app checks basic file signatures and upload size, but does not yet integrate malware-scanning software. Signature validation is not malware scanning. Before public uploads, deploy a scanner (for example, ClamAV) and ensure the server rejects/quarantines files when the scanner is unavailable. Also use private durable storage and retention limits.

## Professional public experience

The visitor landing page is responsive and reads the active event/categories from the CMS API. Check the event details, prices, dates, accessibility, contact/support information, consent text and privacy policy before publishing.

## Launch gate

Do not treat this repository as production-verified until an operator has completed and recorded: DNS/HTTPS check, Stripe test checkout and signed webhook, SMTP sender/domain verification and inbox delivery, upload malware scan pass/fail tests, database-and-file restore drill, refund/reconciliation procedure, and full staging walkthrough. This coding environment has no access to your domain, host, Stripe/SMTP secrets, so those external checks cannot be performed here.
