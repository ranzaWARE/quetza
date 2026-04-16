#!/bin/sh
set -e
if [ ! -f /app/certs/server.crt ]; then
  echo "Generating SSL certificate for IP: ${SERVER_IP:-127.0.0.1}"
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout /app/certs/server.key \
    -out    /app/certs/server.crt \
    -subj   "/CN=quetza/O=Graphimecc/C=IT" \
    -addext "subjectAltName=IP:${SERVER_IP:-127.0.0.1},DNS:localhost"
fi
exec node server.js
