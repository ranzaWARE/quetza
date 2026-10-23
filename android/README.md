# Quetza per Android

App per telefoni, tablet e lettori e-ink (Boox). Dentro c'è la stessa interfaccia del server, e **funziona anche senza rete e senza nessun server**: le note, l'audio e il cestino stanno sul dispositivo. Se colleghi un server Quetza, tutto si sincronizza con il tuo account.

Rispetto alla PWA aperta in Chrome aggiunge:

- **Note sul dispositivo**, con o senza server (vedi sotto).
- **Certificati self-signed** gestiti senza passare dagli avvisi del browser (vedi sotto).
- **Registrazione che non si interrompe**: schermo sempre acceso mentre si registra, e il microfono resta attivo anche passando a un'altra app (notifica "Quetza sta registrando").
- **Download veri**: PDF ed export `.zip` finiscono in `Download/Quetza`, con i pulsanti Apri e Condividi.
- **Selettore file** che rispetta i tipi accettati (import `.zip`, immagini).
- **Ottimizzazioni e-ink** (vedi sotto).
- **Configurazione via MDM** del server da collegare.

Requisiti: Android 10 o successivo, WebView di sistema aggiornata.

## Installazione

Scarica l'APK dalla pagina [Releases](https://github.com/ranzaWARE/quetza/releases) (file `quetza.apk`) oppure dagli artifact dell'ultima build in *Actions › App Android*, e installalo sul dispositivo (va permessa l'installazione da origini sconosciute).

All'avvio si apre subito la libreria: non serve nessun account.

## Senza server

Le note stanno solo sul dispositivo: si scrive, si registra, si cerca, si esporta in PDF e in `.zip` anche in aereo. **Non c'è nessun backup**: se il dispositivo si perde, si rompe o l'app viene disinstallata, le note se ne vanno con lui. Per questo la libreria lo ricorda con una riga in alto (si può nascondere per una settimana). Due rimedi: **Esporta** ogni tanto (l'archivio si importa anche su un server Quetza), oppure collega un server.

Senza server non ci sono la trascrizione (la fa Whisper sul server) né la condivisione con i colleghi.

## Con un server

Pulsante in alto a destra (il telefonino) › indirizzo del server, es. `https://192.168.1.20:8443` › **Collega**. Si apre la pagina di accesso del server (account locale, LDAP o SSO, come nel browser), poi una conferma: **Collega e sincronizza**. Da lì:

- le note del dispositivo vanno sul server e quelle dell'account arrivano sul dispositivo; poi si sincronizza da solo all'avvio, ogni minuto, al ritorno della rete e pochi secondi dopo ogni modifica;
- senza rete si continua a lavorare normalmente: le modifiche partono appena il server torna raggiungibile;
- se la stessa nota è stata cambiata sia sul dispositivo sia altrove, nessuna versione va persa: quella del dispositivo diventa una nota a parte "(conflitto hh:mm)";
- una nota eliminata altrove finisce nel cestino anche qui (e viceversa); niente sparisce dal dispositivo senza passare dal cestino;
- trascrizione e condivisione funzionano come nel browser; le note dei colleghi si aprono quando il server è raggiungibile.

Il pulsante diventa una nuvola: lì ci sono lo stato (ultima sincronizzazione, note ancora da inviare), **Sincronizza ora** e **Scollega**. Scollegando si sceglie se tenere le note sul dispositivo o toglierle (per passare il dispositivo a un'altra persona).

Il dispositivo si collega con un token suo, non con la password. L'amministratore vede quanti dispositivi ha ogni utente e può scollegarli dal pannello (*Utenti › Scollega dispositivi*), per esempio se un tablet viene perso; anche disattivare l'utente ferma subito la sincronizzazione.

Chi aggiorna dalla versione precedente dell'app (che apriva il sito del server) trova il server già proposto al primo avvio: **Collega**, poi la conferma (il login solo se la sessione è scaduta), e le note dell'account tornano sul tablet.

## Certificato self-signed

Il certificato che Quetza genera da solo non è firmato da nessuna autorità riconosciuta. Due strade:

1. **Accettare l'impronta (più semplice).** Al primo collegamento l'app mostra intestatario, scadenza e impronta SHA-256 del certificato. Confrontala con quella del server:
   ```bash
   docker compose exec nginx openssl x509 -in /etc/nginx/certs/quetza.crt -noout -fingerprint -sha256
   ```
   e premi **Accetta e ricorda**. Se un giorno il server presenta un certificato diverso, l'app lo segnala con un avviso esplicito invece di accettarlo in silenzio.

2. **Installare la CA aziendale (consigliato se ce n'è una).** *Impostazioni › Sicurezza › Crittografia e credenziali › Installa un certificato › Certificato CA.* L'app si fida dei certificati utente, quindi non chiede più nulla.

Il certificato serve solo per collegare e sincronizzare: le note sul dispositivo si aprono comunque.

## Distribuzione con MDM

L'app espone una configurazione gestita (Intune, Workspace ONE, Google Endpoint…):

| Chiave | Valore |
|---|---|
| `server_url` | Server da collegare. Al primo avvio l'app lo propone già compilato (e non modificabile) e lo ripropone finché l'utente non lo collega. |
| `cert_sha256` | Una o più impronte SHA-256 ammesse, separate da virgola (con o senza `:`). Se presenti, l'utente non può accettare altri certificati. |
| `eink_mode` | `auto` (predefinito), `on`, `off`. |

## Tablet e-ink (Boox)

Sui dispositivi Onyx Boox la modalità e-ink si attiva da sola (si può forzare o spegnere da *tieni premuta l'icona › Impostazioni*):

- al primo avvio il tema di Quetza parte da **e-ink** (bianco e nero, niente ombre); resta poi quello scelto dall'utente;
- animazioni e transizioni sono disattivate, così il pannello non lampeggia e non lascia scie;
- niente bagliore di fine scorrimento, barre che sfumano e animazioni tra le finestre;
- lo schermo non va in standby mentre si registra.

La penna Boox funziona come su un tablet normale, pressione inclusa; il tasto della penna o la punta gomma attivano la gomma.

Impostazioni consigliate sul Boox, per l'app Quetza (*E-Ink Center* o tenendo premuta l'icona › *Ottimizza*):

- **Modalità di aggiornamento: Bilanciata** per scrivere; **Veloce/Ultra veloce** solo se si scorre molto. Le modalità più rapide rendono il tratto più reattivo ma lasciano più ghosting.
- **Refresh completo automatico**: ogni 10–20 aggiornamenti, per pulire le scie.
- **DPI / scala**: lasciare quella di sistema; Quetza non usa lo zoom testo di Android.
- Disattivare la **gestione dei colori scuri** (inversione) per Quetza: la pagina è già pensata per il bianco e nero.

## Build

Serve JDK 17 e l'Android SDK (Android Studio va benissimo).

```bash
cd android
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
```

La build copia l'interfaccia da `backend/public` dentro l'APK (task `copyWebUi`, in `assets/web`): l'app viene servita da `https://appassets.androidplatform.net` e imposta `window.__quetzaClient`, che fa servire le chiamate `/api/…` da `js/local-api.js` con le note in IndexedDB; `js/local-sync.js` sincronizza con il server collegato. Ogni modifica dell'interfaccia richiede quindi un nuovo APK. Una futura app client (desktop, iOS) funziona allo stesso modo: interfaccia inclusa, `window.__quetzaClient` impostato, la sua origine aggiunta a `CLIENT_ORIGINS` sul server.

Per provare la modalità dell'app in un browser: apri l'interfaccia servita da un qualunque server di file statici con `?locale=1` (`?locale=0` per uscire).

GitHub Actions costruisce l'APK a ogni modifica sotto `android/` o `backend/public/` e, per i tag `android-v*` (es. `android-v1.0.0`), lo pubblica in una release.

### Firma

Un APK debug firmato su macchine diverse non si aggiorna sopra l'altro. Per aggiornamenti senza disinstallare serve un keystore fisso:

```bash
keytool -genkeypair -v -keystore quetza.jks -alias quetza -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 quetza.jks   # → segreto QUETZA_KEYSTORE_BASE64
```

Segreti del repository (*Settings › Secrets and variables › Actions*): `QUETZA_KEYSTORE_BASE64`, `QUETZA_KEYSTORE_PASSWORD`, `QUETZA_KEY_ALIAS`, `QUETZA_KEY_PASSWORD`. Con questi la CI produce anche `quetza.apk` firmato in release. Conserva il keystore: perderlo significa non poter più aggiornare l'app installata.
