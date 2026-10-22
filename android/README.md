# Quetza per Android

App client per telefoni, tablet e lettori e-ink (Boox). È un guscio nativo in Kotlin attorno alla stessa interfaccia web del server: ogni aggiornamento di Quetza arriva subito anche sull'app, senza ripubblicarla.

Rispetto alla PWA aperta in Chrome aggiunge:

- **Indirizzo del server** chiesto al primo avvio, oppure distribuito via MDM.
- **Certificati self-signed** gestiti senza passare dagli avvisi del browser (vedi sotto).
- **Registrazione che non si interrompe**: schermo sempre acceso mentre si registra, e il microfono resta attivo anche passando a un'altra app (notifica "Quetza sta registrando").
- **Download veri**: PDF ed export `.zip` finiscono in `Download/Quetza`, con i pulsanti Apri e Condividi.
- **Selettore file** che rispetta i tipi accettati (import `.zip`, immagini).
- **Ottimizzazioni e-ink** (vedi sotto).

Requisiti: Android 10 o successivo, WebView di sistema aggiornata.

## Installazione

Scarica l'APK dalla pagina [Releases](https://github.com/ranzaWARE/quetza/releases) (file `quetza.apk`) oppure dagli artifact dell'ultima build in *Actions › App Android*, e installalo sul dispositivo (va permessa l'installazione da origini sconosciute).

Al primo avvio scrivi l'indirizzo che usi nel browser, ad esempio `https://192.168.1.20:8443`. Per cambiarlo: tieni premuta l'icona › **Cambia server**, oppure dal pulsante nella schermata "Server non raggiungibile".

## Certificato self-signed

Il certificato che Quetza genera da solo non è firmato da nessuna autorità riconosciuta. Due strade:

1. **Accettare l'impronta (più semplice).** Al primo collegamento l'app mostra intestatario, scadenza e impronta SHA-256 del certificato. Confrontala con quella del server:
   ```bash
   docker compose exec nginx openssl x509 -in /etc/nginx/certs/quetza.crt -noout -fingerprint -sha256
   ```
   e premi **Accetta e ricorda**. Se un giorno il server presenta un certificato diverso, l'app lo segnala con un avviso esplicito invece di accettarlo in silenzio.

2. **Installare la CA aziendale (consigliato se ce n'è una).** *Impostazioni › Sicurezza › Crittografia e credenziali › Installa un certificato › Certificato CA.* L'app si fida dei certificati utente, quindi non chiede più nulla. È anche l'unico modo perché funzioni il **service worker**, cioè l'apertura dell'app quando il server non è raggiungibile: Chromium non registra service worker su siti con errori di certificato, anche se accettati.

Le modifiche non ancora salvate restano comunque nel dispositivo (IndexedDB) in entrambi i casi.

## Distribuzione con MDM

L'app espone una configurazione gestita (Intune, Workspace ONE, Google Endpoint…):

| Chiave | Valore |
|---|---|
| `server_url` | Indirizzo del server. Se presente, l'utente non lo può cambiare. |
| `cert_sha256` | Una o più impronte SHA-256 ammesse, separate da virgola (con o senza `:`). Se presenti, l'utente non può accettare altri certificati. |
| `eink_mode` | `auto` (predefinito), `on`, `off`. |

## Tablet e-ink (Boox)

Sui dispositivi Onyx Boox la modalità e-ink si attiva da sola (si può forzare o spegnere nella schermata del server):

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

GitHub Actions costruisce l'APK a ogni modifica sotto `android/` e, per i tag `android-v*` (es. `android-v1.0.0`), lo pubblica in una release.

### Firma

Un APK debug firmato su macchine diverse non si aggiorna sopra l'altro. Per aggiornamenti senza disinstallare serve un keystore fisso:

```bash
keytool -genkeypair -v -keystore quetza.jks -alias quetza -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 quetza.jks   # → segreto QUETZA_KEYSTORE_BASE64
```

Segreti del repository (*Settings › Secrets and variables › Actions*): `QUETZA_KEYSTORE_BASE64`, `QUETZA_KEYSTORE_PASSWORD`, `QUETZA_KEY_ALIAS`, `QUETZA_KEY_PASSWORD`. Con questi la CI produce anche `quetza.apk` firmato in release. Conserva il keystore: perderlo significa non poter più aggiornare l'app installata.
