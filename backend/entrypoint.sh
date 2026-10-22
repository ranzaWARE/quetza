#!/bin/sh
set -e

# Certificato HTTPS: se in /app/certs (cartella ./certs accanto al compose)
# ci sono già server.crt e server.key, ad esempio emessi dalla CA aziendale,
# si usano quelli. Altrimenti se ne genera uno self-signed al primo avvio.
mkdir -p /app/certs
if [ ! -f /app/certs/server.crt ] || [ ! -f /app/certs/server.key ]; then
  SAN="IP:${SERVER_IP:-127.0.0.1},DNS:localhost"
  [ -n "$SERVER_NAME" ] && SAN="DNS:${SERVER_NAME},${SAN}"
  echo "Genero un certificato self-signed per ${SAN}"
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout /app/certs/server.key \
    -out    /app/certs/server.crt \
    -subj   "/CN=${SERVER_NAME:-quetza}/O=Quetza" \
    -addext "subjectAltName=${SAN}" 2>/dev/null
fi

# CA aggiuntive facoltative (es. provider SSO con certificato interno):
# tutti i PEM in /app/ca concatenati e passati a Node, che altrimenti non
# fiderebbe certificati firmati da una CA aziendale.
if [ -z "$NODE_EXTRA_CA_CERTS" ] && ls /app/ca/*.crt /app/ca/*.pem >/dev/null 2>&1; then
  cat /app/ca/*.crt /app/ca/*.pem 2>/dev/null > /tmp/extra-ca.pem
  export NODE_EXTRA_CA_CERTS=/tmp/extra-ca.pem
  echo "CA extra caricate da /app/ca"
fi

# Backup automatico del DB (default ogni notte alle 02:00). crond non passa
# le variabili d'ambiente ai job: si scrivono nella riga del crontab.
BACKUP_CRON="${BACKUP_CRON:-0 2 * * *}"
BACKUP_DIR="${BACKUP_DIR:-/app/backups}"
mkdir -p "$BACKUP_DIR"
echo "$BACKUP_CRON DB_PATH=${DB_PATH:-/app/data/quetza.db} BACKUP_DIR=$BACKUP_DIR BACKUP_KEEP=${BACKUP_KEEP:-30} node /app/backup.js >> $BACKUP_DIR/backup.log 2>&1" | crontab -
crond -b 2>/dev/null || true

if [ "$NODE_ENV" = "development" ]; then
  exec npx nodemon --watch . --ext js,json --ignore data/ --ignore certs/ --ignore node_modules/ server.js
else
  exec node server.js
fi
