#!/usr/bin/env bash
set -euo pipefail
: "${DB_FILE:=./cms.db}"
: "${UPLOAD_DIR:=./uploads}"
: "${BACKUP_DIR:=./backups}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_DEST="$(realpath -m "$BACKUP_DIR/cms-$STAMP.db")"
UPLOAD_DEST="$(realpath -m "$BACKUP_DIR/uploads-$STAMP.tar.gz")"
DB_FILE="$(realpath "$DB_FILE")" DB_DEST="$DB_DEST" node - <<'NODE'
const Database=require('better-sqlite3');
(async()=>{const db=new Database(process.env.DB_FILE,{readonly:true,fileMustExist:true});await db.backup(process.env.DB_DEST);db.close()})().catch(e=>{console.error(e);process.exit(1)});
NODE
if [ -d "$UPLOAD_DIR" ]; then tar -czf "$UPLOAD_DEST" -C "$UPLOAD_DIR" .; else echo "Upload directory not found: $UPLOAD_DIR" >&2; exit 1; fi
chmod 600 "$DB_DEST" "$UPLOAD_DEST"
echo "Backup created: $DB_DEST and $UPLOAD_DEST"
