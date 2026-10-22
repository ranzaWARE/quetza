#!/bin/sh
# Rigenera le schermate della guida e la guida stessa.
# Servono: node con le dipendenze di backend/, Playwright con Chromium,
# python3 con Pillow e numpy, il font Inter Thin Italic (scrittura a mano).
#   sh docs/screenshots/make.sh
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=$(mktemp -d)
PORT=3300

python3 "$HERE/scrittura.py" "$WORK"
python3 "$HERE/whisper-finto.py" & WPID=$!
( cd "$ROOT/backend" && DB_PATH="$WORK/data/q.db" CERT_PATH=/nessuno KEY_PATH=/nessuno PORT=$PORT TRUST_PROXY=0 \
  SESSION_SECRET=schermate-della-guida-0123456789 WHISPER_URL=http://127.0.0.1:9876 \
  BACKUP_DIR="$WORK/app/backups" BACKUP_COPY_DIR="$WORK/app/backups-copy" \
  ORG_NAME="Azienda Esempio S.r.l." node server.js > "$WORK/server.log" 2>&1 ) & SPID=$!
trap 'kill $WPID $SPID 2>/dev/null; rm -rf "$WORK"' EXIT
sleep 2

WORK="$WORK" BASE="http://localhost:$PORT" node "$HERE/schermate.js"
python3 "$HERE/ritaglia.py" "$WORK"
python3 "$ROOT/docs/make-icon.py"
python3 "$ROOT/docs/make-guide.py"
