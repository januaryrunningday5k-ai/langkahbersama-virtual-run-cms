#!/usr/bin/env bash
set -euo pipefail

# Run from the repository root on the host. Uses SQLite's online backup API
# so the database snapshot is consistent while the service is running.
: "${DB_FILE:=./cms.db}"
: "${UPLOAD_DIR:=./uploads}"
: "${BACKUP_DIR:=./backups}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_ABS="$(realpath "$DB_FILE")"
BACKUP_ABS="$(realpath -m "$BACKUP_DIR")"
DB_DEST="$BACKUP_ABS/cms-$STAMP.db"
UPLOAD_DEST="$BACKUP_ABS/uploads-$STAMP.tar.gz"

DB_FILE="$DB_ABS" DB_DEST="$DB_DEST" node - <<'NODE'
const Database = require('better-sqlite3');
(async () => {
  const db = new Database(process.env.DB_FILE, { readonly: true, fileMustExist: true });
  await db.backup(process.env.DB_DEST);
  db.close();
})().catch(err => { console.error(err); process.exit(1); });
NODE
if [ -d "$UPLOAD_DIR" ]; then tar -czf "$UPLOAD_DEST" -C "$UPLOAD_DIR" .; fi
chmod 600 "$DB_DEST" "$UPLOAD_DEST" 2>/dev/null || true
printf 'Backup complete:\n  %s\n  %s\n' "$DB_DEST" "$UPLOAD_DEST"
