#!/bin/sh
set -e

# SSL cert
if [ ! -f /app/certs/server.crt ]; then
  echo "Generating SSL certificate for IP: ${SERVER_IP:-127.0.0.1}"
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout /app/certs/server.key \
    -out    /app/certs/server.crt \
    -subj   "/CN=quetza/O=Graphimecc/C=IT" \
    -addext "subjectAltName=IP:${SERVER_IP:-127.0.0.1},DNS:localhost"
fi

# Backup automatico ogni notte alle 02:00
BACKUP_CRON="${BACKUP_CRON:-0 2 * * *}"
echo "$BACKUP_CRON /app/backup.sh >> /app/data/backup.log 2>&1" | crontab -
crond -b 2>/dev/null || true

if [ "$NODE_ENV" = "development" ]; then
  exec npx nodemon --watch . --ext js,json --ignore data/ --ignore certs/ --ignore node_modules/ server.js
else
  exec node server.js
fi