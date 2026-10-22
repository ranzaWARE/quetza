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

# CA aggiuntive facoltative (es. provider SSO con certificato interno):
# tutti i PEM in /app/ca concatenati e passati a Node, che altrimenti non
# fiderebbe certificati firmati da una CA aziendale.
if [ -z "$NODE_EXTRA_CA_CERTS" ] && ls /app/ca/*.crt /app/ca/*.pem >/dev/null 2>&1; then
  cat /app/ca/*.crt /app/ca/*.pem 2>/dev/null > /tmp/extra-ca.pem
  export NODE_EXTRA_CA_CERTS=/tmp/extra-ca.pem
  echo "CA extra caricate da /app/ca"
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