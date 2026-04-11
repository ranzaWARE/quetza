#!/bin/sh
set -e

apk add --no-cache openssl

mkdir -p /etc/nginx/certs

if [ ! -f /etc/nginx/certs/quetza.crt ]; then
  echo "Generating self-signed SSL certificate..."
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout /etc/nginx/certs/quetza.key \
    -out    /etc/nginx/certs/quetza.crt \
    -subj   "/CN=quetza/O=Graphimecc/C=IT" \
    -addext "subjectAltName=IP:${SERVER_IP:-127.0.0.1},DNS:localhost"
  echo "Certificate generated."
fi

exec nginx -g 'daemon off;'