#!/usr/bin/env bash
set -euo pipefail
: "${DB_BACKUP:?Set DB_BACKUP to a backup .db file}"
: "${UPLOAD_BACKUP:?Set UPLOAD_BACKUP to uploads .tar.gz}"
: "${RESTORE_DIR:=./restore-test}"
mkdir -p "$RESTORE_DIR/uploads"
cp "$DB_BACKUP" "$RESTORE_DIR/cms.db"
tar -xzf "$UPLOAD_BACKUP" -C "$RESTORE_DIR/uploads"
node - "$RESTORE_DIR/cms.db" <<'NODE'
const Database=require('better-sqlite3');
const db=new Database(process.argv[2],{readonly:true,fileMustExist:true});
const check=db.pragma('integrity_check',{simple:true});
if(check!=='ok'){console.error('SQLite integrity check failed:',check);process.exit(1)}
const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
for(const required of ['events','registrations','activities']) if(!tables.includes(required)){console.error('Missing table:',required);process.exit(1)}
console.log('Restore verification passed. Tables:',tables.join(', '));db.close();
NODE
printf 'Restore copy ready at %s. This verifies database integrity; validate uploaded-file records and application login before replacing production data.\n' "$RESTORE_DIR"
