# Quetza

Note manoscritte self-hosted con audio sincronizzato e trascrizione automatica.

Si scrive a penna su un foglio A4 mentre si registra: ogni tratto viene marcato
con l'istante audio in cui è stato disegnato, così riascoltando la registrazione
si vede evidenziato quello che si stava scrivendo in quel momento. A fine
registrazione l'audio viene trascritto in automatico, con riconoscimento dei
parlanti se configurato.

Pensato per l'uso interno in LAN: nessun servizio esterno, nessun CDN, dati e
modelli restano sul server.

## Componenti

| Cartella   | Cosa contiene                                                       |
|------------|---------------------------------------------------------------------|
| `backend/` | API Express + SQLite, autenticazione, file statici, HTTPS            |
| `whisper/` | Microservizio Python (faster-whisper + pyannote) per la trascrizione |
| `nginx/`   | Reverse proxy opzionale per terminare il TLS a monte                 |

## Avvio

```bash
cp .env.example .env
# compila almeno SESSION_SECRET (openssl rand -hex 32) e SERVER_IP
docker compose up -d
```

L'app risponde su `https://<SERVER_IP>:8443` (il certificato self-signed viene
generato al primo avvio). La `8080` reindirizza su HTTPS.

Con nginx davanti, al posto delle porte 8080/8443:

```bash
docker compose --profile nginx up -d   # espone 80/443
```

**Primo accesso:** utente `admin`, password `admin`. Viene richiesto subito di
cambiarla: finché non è cambiata l'app non è utilizzabile.

### Senza Docker

```bash
cd backend && npm install && npm start
```

Senza certificati in `/app/certs` parte in HTTP puro sulla porta 3000. Attenzione:
la registrazione audio richiede HTTPS oppure `localhost` (vincolo del browser sul
permesso microfono).

## Trascrizione

Il servizio Whisper gira in un container separato, senza porte esposte
all'esterno. Alla fine di ogni registrazione Quetza gli invia l'audio e salva la
trascrizione, che diventa anche cercabile dalla ricerca full-text.

Il modello (`tiny` … `large-v3`) si sceglie da **Amministrazione → Whisper** e ha
effetto senza riavviare il container.

La diarizzazione ("chi ha detto cosa") richiede un token Hugging Face con la
licenza di `pyannote/speaker-diarization-3.1` accettata. Senza token la
trascrizione funziona lo stesso, ma senza distinguere i parlanti.

## Autenticazione

Tre metodi, combinabili:

- **Locale** — utenti nel DB, password con hash scrypt e salt per utente.
- **LDAP / Active Directory** — configurabile dal pannello admin o da `.env`.
- **OIDC / Keycloak** — configurabile dal pannello admin.

Gli account locali restano sempre utilizzabili come fallback: se l'AD non
risponde, l'amministratore può comunque entrare dal tab "Locale".

## Backup

Il container esegue un backup del DB ogni notte alle 02:00 in
`/app/data/backups`, conservando gli ultimi 30. Dal pannello admin si possono
anche esportare/importare tutte le note come archivio ZIP.

Il volume da salvare è `quetza_data`.

## Scorciatoie

| Tasto | Azione | | Tasto | Azione |
|---|---|---|---|---|
| `P` | Penna | | `Ctrl+Z` / `Ctrl+Y` | Annulla / Ripeti |
| `H` | Evidenziatore | | `Ctrl+S` | Salva |
| `E` | Gomma | | `Ctrl` `+` / `-` / `0` | Zoom avanti / indietro / adatta |
| `S` | Lasso | | `PagSu` / `PagGiù` | Pagina precedente / successiva |
| `R` `O` `L` `A` | Rettangolo, ellisse, linea, freccia | | `Spazio` | Play / pausa audio |
| `T` | Testo | | `Esc` | Annulla selezione |

Pan: rotella premuta, tasto destro, o barra spaziatrice + trascinamento.

## Test

```bash
cd backend && npm install && npm test        # 87 test: DB, API HTTP, canvas/PDF
cd whisper && python3 test_server.py         # 19 test: trascrizione (serve solo flask)
```

Le suite Node coprono hashing e migrazione password, gating del cambio password,
statistiche, round-trip export/import multipagina, condivisione, e la generazione
PDF pagina per pagina. Il test Whisper usa un `ffmpeg` e modelli finti, quindi
non richiede di scaricare i modelli veri.

## Licenza

MIT — vedi [LICENSE](LICENSE).
