#!/bin/sh
# Installa o aggiorna Quetza con Docker Compose.
#   ./installa.sh        prima installazione: crea .env e avvia
#   ./installa.sh        di nuovo, dopo un git pull: ricostruisce e riavvia
#   ./installa.sh -y     senza domande (usa l'IP rilevato)
# Il file .env esistente non viene mai sovrascritto.
set -e
cd "$(dirname "$0")"

ASK=1
[ "$1" = "-y" ] && ASK=0

ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Requisiti ──────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "Docker non trovato: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "Manca il plugin Docker Compose (comando 'docker compose')."
docker info >/dev/null 2>&1 || die "Docker non risponde: è avviato? Serve essere root o nel gruppo docker."
ok "Docker e Compose presenti"

# ── .env ───────────────────────────────────────────────────────────────────
set_var() {  # set_var NOME valore  → sostituisce la riga NOME= nel .env
  tmp=$(mktemp)
  awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' .env > "$tmp" && cat "$tmp" > .env && rm -f "$tmp"
}

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env

  if command -v openssl >/dev/null 2>&1; then SECRET=$(openssl rand -hex 32)
  else SECRET=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n'); fi
  set_var SESSION_SECRET "$SECRET"

  IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
  [ -n "$IP" ] || IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -n "$IP" ] || IP=127.0.0.1
  if [ $ASK = 1 ]; then
    printf '  IP del server nella LAN [%s]: ' "$IP"; read -r R; [ -n "$R" ] && IP=$R
    printf '  Nome DNS del server, se ne ha uno (es. quetza.azienda.local) []: '; read -r NAME
    [ -n "$NAME" ] && set_var SERVER_NAME "$NAME"
  fi
  set_var SERVER_IP "$IP"
  ok "Creato .env (segreto generato, IP $IP). Le altre opzioni sono commentate lì dentro."
else
  ok "Uso il .env esistente"
  grep -q '^SESSION_SECRET=..*' .env || die "SESSION_SECRET vuoto nel .env: generane uno con 'openssl rand -hex 32'."
fi

mkdir -p certs ca logo
BP=$(sed -n 's/^BACKUP_PATH=//p' .env); mkdir -p "${BP:-./backups}"

# ── Avvio ──────────────────────────────────────────────────────────────────
info "Costruisco e avvio i container (la prima volta servono alcuni minuti)…"
docker compose up -d --build

PORT=$(sed -n 's/^QUETZA_HTTPS_PORT=//p' .env); PORT=${PORT:-8443}
HOST=$(sed -n 's/^SERVER_NAME=//p' .env); [ -n "$HOST" ] || HOST=$(sed -n 's/^SERVER_IP=//p' .env)
URL=$(sed -n 's/^PUBLIC_URL=//p' .env); [ -n "$URL" ] || URL="https://$HOST:$PORT"

info "Attendo che Quetza risponda…"
i=0
until docker exec quetza wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; do
  i=$((i+1)); [ $i -gt 60 ] && die "Quetza non risponde dopo 2 minuti: guarda 'docker compose logs quetza'."
  sleep 2
done

ok "Quetza è attivo"
echo
echo "  Apri:            $URL"
echo "  Primo accesso:   utente admin, password admin (va cambiata subito)"
echo "  Guida:           $URL/guida.html"
echo
info "La trascrizione parte quando il container quetza-whisper ha scaricato il"
info "modello (qualche minuto al primo avvio): Amministrazione → Whisper → Test."
