# Quetza 🦕
**Note scritte a mano con audio sincronizzato — Graphimecc Group**

---

## Deploy in 5 minuti

### 1. Copia i file sul server
```bash
scp -r quetza/ utente@IP-SERVER:/opt/quetza
ssh utente@IP-SERVER
cd /opt/quetza
```

### 2. Configura l'ambiente
```bash
cp .env.example .env
nano .env
```

Valori da impostare nel `.env`:
```env
SESSION_SECRET=metti_qui_una_stringa_casuale_lunga_almeno_32_caratteri

LDAP_ENABLED=true
LDAP_URL=ldap://192.168.1.10:389
LDAP_BIND_DN=CN=svc_quetza,OU=ServiceAccounts,DC=graphimecc,DC=local
LDAP_BIND_PASSWORD=password_del_service_account
LDAP_SEARCH_BASE=DC=graphimecc,DC=local
LDAP_SEARCH_FILTER=(sAMAccountName={{username}})
LDAP_TLS_REJECT_UNAUTHORIZED=false
```

### 3. Avvia
```bash
docker compose up -d
```

L'app è disponibile su `http://IP-SERVER:3000`

---

## Configurazione LDAP (Active Directory)

Crea un service account in AD con **sola lettura**:
- Nome: `svc_quetza`
- OU: `ServiceAccounts` (o dove preferisci)
- Nessun privilegio speciale — serve solo per cercare gli utenti

Poi imposta nel `.env` le credenziali di questo account.

---

## Reverse proxy con Nginx (consigliato per HTTPS)

```nginx
server {
    listen 80;
    server_name quetza.graphimecc.local;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name quetza.graphimecc.local;

    ssl_certificate     /etc/ssl/certs/graphimecc.crt;
    ssl_certificate_key /etc/ssl/private/graphimecc.key;

    # Aumenta il limite per l'upload audio
    client_max_body_size 250M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
    }
}
```

Dopo aver aggiunto HTTPS, nel `docker-compose.yml` imposta `secure: true` nella config delle sessioni (modifica `server.js` → `cookie.secure = true`).

---

## Backup

I dati (SQLite + audio) sono nel volume Docker `quetza_quetza_data`.

```bash
# Backup
docker run --rm \
  -v quetza_quetza_data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/quetza-$(date +%Y%m%d-%H%M).tar.gz /data

# Restore
docker run --rm \
  -v quetza_quetza_data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar xzf /backup/quetza-20250115-1000.tar.gz -C /
```

---

## Aggiornamento

```bash
cd /opt/quetza
docker compose pull   # se usi un'immagine da registry
docker compose up -d --build   # rebuild locale
```

---

## Funzionalità

| Feature | Dettaglio |
|---|---|
| ✍️ Scrittura a mano | Pointer Events API — qualsiasi pennino (Wacom, Surface, Samsung S Pen, Apple Pencil via browser) |
| 🖊️ Strumenti | Penna, evidenziatore giallo, gomma, rettangolo, ellisse, linea, freccia |
| 🎨 Colori & spessore | 6 colori + slider 1-24px |
| 📄 Fogli | A4 verticale con scroll infinito, separatori tratteggiati, numerazione pagine |
| 📏 Griglie | Righe / quadretti / puntini / nessuna — per nota |
| 🔍 Zoom | Bottoni +/−, fit, Ctrl+scroll, pinch su tablet |
| 🌙 Dark mode | Toggle in toolbar |
| 🎙️ Audio sync | Registrazione microfono durante la scrittura — ogni tratto ha il timestamp audio |
| ▶️ Riproduzione | Play/pausa, seek, auto-scroll e evidenziazione gialla dei tratti in sync |
| 📊 Timeline | Strip laterale con mappa dei tratti audio, cliccabile per seek |
| 🖼️ Incolla immagine | Ctrl+V per incollare screenshot/foto sulla nota |
| 📤 Export PDF | Con o senza griglia, diviso per pagine A4 |
| 💾 Salvataggio | Manuale (Ctrl+S) con thumbnail automatica |
| 👥 Multi-utente | Ogni utente vede solo le proprie note |
| 🔐 Auth | LDAP/Active Directory + fallback utenti locali |

---

## Stack

- **Runtime**: Node.js 20 (Alpine)
- **Framework**: Express 4
- **Database**: SQLite (better-sqlite3) — zero configurazione
- **Auth**: ldapjs
- **Audio storage**: BLOB in SQLite
- **Deploy**: Docker + Docker Compose

---

## Struttura

```
quetza/
├── docker-compose.yml
├── .env.example
└── backend/
    ├── Dockerfile
    ├── package.json
    ├── server.js       → Express + routes API
    ├── db.js           → SQLite (note, audio, sessioni)
    ├── auth.js         → LDAP + utenti locali
    └── public/
        ├── index.html  → App principale
        ├── login.html  → Login
        ├── css/app.css → Stili completi (light + dark)
        └── js/app.js   → Canvas engine, audio sync, zoom, forme
```
