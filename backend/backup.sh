#!/bin/sh
# Backup automatico DB Quetza — eseguito ogni notte da cron
BACKUP_DIR="${BACKUP_DIR:-/app/data/backups}"
DB_PATH="${DB_PATH:-/app/data/quetza.db}"
mkdir -p "$BACKUP_DIR"
DATE=$(date +%Y%m%d_%H%M%S)
cp "$DB_PATH" "$BACKUP_DIR/quetza_$DATE.db"
# Mantieni solo gli ultimi 30 backup
ls -t "$BACKUP_DIR"/quetza_*.db | tail -n +31 | xargs -r rm
echo "[backup] $DATE - OK"