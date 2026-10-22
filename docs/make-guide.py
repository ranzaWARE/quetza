#!/usr/bin/env python3
"""Genera backend/public/guida.html: la guida di Quetza in un file unico, con
le schermate incorporate. L'app la serve su /guida.html (pulsante «?»).
Le schermate stanno in docs/img (rigenerabili con docs/screenshots/make.sh).
Uso: python3 docs/make-guide.py"""
import base64, html, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
IMG = os.path.join(HERE, "img")
OUT = os.path.join(ROOT, "backend", "public", "guida.html")
VERSION = json.load(open(os.path.join(ROOT, "backend", "package.json")))["version"]

E = html.escape


def data_uri(name, mime):
    with open(os.path.join(IMG, name), "rb") as f:
        return f"data:{mime};base64," + base64.b64encode(f.read()).decode()


ICON = data_uri("icon.png", "image/png")


def fig(name, caption, width=None, alt=None):
    w = f' style="max-width:{width}px"' if width else ""
    return (f'<figure><img src="{data_uri(name + ".webp", "image/webp")}" alt="{E(alt or caption)}"'
            f' loading="lazy"{w}><figcaption>{caption}</figcaption></figure>')


def kbd(*keys):
    return " ".join(f"<kbd>{E(k)}</kbd>" for k in keys)


SHORTCUTS = [
    (("P",), "Penna"), (("H",), "Evidenziatore"), (("E",), "Gomma"), (("S",), "Lasso (seleziona e sposta)"),
    (("R",), "Rettangolo"), (("O",), "Ellisse"), (("L",), "Linea"), (("A",), "Freccia"), (("T",), "Testo"),
    (("Ctrl", "Z"), "Annulla"), (("Ctrl", "Y"), "Ripeti"), (("Ctrl", "S"), "Salva subito"),
    (("Ctrl", "V"), "Incolla un'immagine"), (("Ctrl", "+"), "Zoom avanti"), (("Ctrl", "−"), "Zoom indietro"),
    (("Ctrl", "0"), "Adatta alla larghezza"), (("PagSu",), "Pagina precedente"), (("PagGiù",), "Pagina successiva"),
    (("Spazio",), "Play / pausa dell'audio"), (("Canc",), "Elimina la selezione"), (("Esc",), "Annulla la selezione"),
]
shortcut_rows = "".join(f"<tr><td>{kbd(*k)}</td><td>{E(v)}</td></tr>" for k, v in SHORTCUTS)

TOOLS = [
    ("Penna", "Scrittura a mano. Su tablet usa la pressione della penna."),
    ("Evidenziatore", "Tratto largo e trasparente, per sottolineare."),
    ("Gomma", "Cancella i tratti che tocca. Ha uno spessore suo."),
    ("Lasso", "Circonda tratti e testi per spostarli, ridimensionarli o eliminarli."),
    ("Rettangolo, ellisse, linea, freccia", "Forme pulite: trascina dal punto di partenza a quello di arrivo."),
    ("Riconoscimento forme", "Se attivo, un rettangolo o un cerchio disegnati a mano diventano forme pulite."),
    ("Colori e spessore", "Tre colori rapidi, la tavolozza completa e lo spessore del tratto."),
    ("Griglia", "Righe, puntini, quadretti o foglio bianco. Compare anche nel PDF, se vuoi."),
    ("Testo", "Clicca sul foglio e scrivi da tastiera: il testo digitato si trova con la ricerca."),
    ("Immagini", "Incolla un'immagine (Ctrl+V o il pulsante), poi spostala o ridimensionala."),
    ("Pagine", "Il «+» in basso aggiunge un foglio A4; le frecce ai lati cambiano pagina."),
]
tool_rows = "".join(f"<tr><td><strong>{E(a)}</strong></td><td>{E(b)}</td></tr>" for a, b in TOOLS)

ENV = [
    ("SESSION_SECRET", "Obbligatorio. Segreto delle sessioni (lo genera <code>installa.sh</code>). Cambiarlo disconnette tutti."),
    ("SERVER_IP, SERVER_NAME", "IP e nome DNS del server: entrano nel certificato self-signed."),
    ("ORG_NAME", "Nome dell'organizzazione nella pagina di accesso. Il logo va in <code>./logo/</code>."),
    ("QUETZA_HTTPS_PORT, QUETZA_HTTP_PORT", "Porte sul server (8443 e 8080). La HTTP fa solo il redirect."),
    ("PUBLIC_URL", "Indirizzo completo con cui gli utenti aprono Quetza, se diverso da https://host:porta."),
    ("ALLOW_HTTP", "true = l'app anche in HTTP, in chiaro. Sconsigliato."),
    ("TRUST_PROXY", "1 se davanti c'è nginx (profilo <code>nginx</code>), altrimenti 0."),
    ("DNS_SERVER", "DNS interno per i container, se LDAP o SSO si raggiungono per nome e Docker non li risolve."),
    ("BACKUP_PATH, BACKUP_CRON, BACKUP_KEEP", "Dove, quando e quante copie del DB tenere (./backups, 02:00, 30)."),
    ("IMPORT_MAX_MB", "Dimensione massima di un archivio importato (serve altrettanta RAM)."),
    ("WHISPER_MODEL, LANGUAGE", "Modello e lingua della trascrizione (small, it)."),
    ("WHISPER_MEMORY, WHISPER_TIMEOUT_MIN", "RAM massima del container di trascrizione e tempo massimo per un audio."),
    ("HF_TOKEN", "Token Hugging Face per distinguere chi parla."),
    ("LDAP_*", "Configurazione LDAP / Active Directory (anche da Amministrazione, che ha la precedenza)."),
    ("OIDC_INTERNAL_URL", "URL del provider SSO raggiungibile dal container, se diverso da quello pubblico."),
]
env_rows = "".join(f"<tr><td><code>{E(a)}</code></td><td>{b}</td></tr>" for a, b in ENV)

MODELS = [
    ("tiny", "~1 GB", "molto veloce", "solo per prove"),
    ("base", "~1 GB", "veloce", "audio pulito, una persona"),
    ("small", "~2 GB", "buona", "consigliato per riunioni"),
    ("medium", "~5 GB", "lenta su CPU", "audio difficile, accenti"),
    ("large-v3", "~10 GB", "molto lenta su CPU", "solo con molta RAM"),
]
model_rows = "".join(f"<tr><td><code>{a}</code></td><td>{b}</td><td>{c}</td><td>{d}</td></tr>" for a, b, c, d in MODELS)

page = f"""<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guida Quetza</title>
<link rel="icon" href="{ICON}">
<style>
:root {{
  --bg: #f4f5f7; --paper: #ffffff; --ink: #111827; --muted: #5f6673; --line: #dde0e5;
  --accent: #f5a000; --on-accent: #111827; --link: #a35f00; --soft: #fff5e0; --chip: #fdeccc;
  --warn: #fff4e5; --warn-ink: #7a4300; --code: #f1f2f4;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    --bg: #0f1115; --paper: #181b21; --ink: #e8eaee; --muted: #a0a6b0; --line: #2c313a;
    --accent: #f5a000; --on-accent: #111827; --link: #ffbf47; --soft: #2a2216; --chip: #3a2c12;
    --warn: #33260f; --warn-ink: #ffd58a; --code: #222630;
  }}
}}
:root[data-theme="dark"] {{
  --bg: #0f1115; --paper: #181b21; --ink: #e8eaee; --muted: #a0a6b0; --line: #2c313a;
  --accent: #f5a000; --on-accent: #111827; --link: #ffbf47; --soft: #2a2216; --chip: #3a2c12;
  --warn: #33260f; --warn-ink: #ffd58a; --code: #222630;
}}
* {{ box-sizing: border-box; }}
body {{ margin: 0; background: var(--bg); color: var(--ink);
  font: 16px/1.6 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }}
header {{ background: var(--paper); border-bottom: 1px solid var(--line); }}
.wrap {{ max-width: 900px; margin: 0 auto; padding: 0 20px; }}
.hero {{ display: flex; gap: 22px; align-items: center; padding: 36px 0 26px; }}
.hero img {{ width: 96px; height: 96px; flex: none; image-rendering: pixelated; }}
h1 {{ font-size: 34px; line-height: 1.15; margin: 0 0 6px; letter-spacing: -.02em; }}
.lead {{ margin: 0; color: var(--muted); font-size: 17px; }}
.lead.small {{ font-size: 14px; margin-top: 4px; font-style: italic; }}
nav {{ display: flex; flex-wrap: wrap; gap: 8px; padding-bottom: 18px; }}
nav a {{ font-size: 14px; color: var(--ink); text-decoration: none; background: var(--chip);
  padding: 5px 12px; border-radius: 999px; }}
nav a:hover {{ background: var(--accent); color: var(--on-accent); }}
nav .sep {{ flex-basis: 100%; height: 0; }}
main {{ padding: 10px 0 60px; }}
section {{ background: var(--paper); border: 1px solid var(--line); border-radius: 16px;
  padding: 26px 28px; margin: 22px 0; }}
section.it {{ border-top: 4px solid var(--accent); }}
h2 {{ font-size: 24px; margin: 0 0 12px; letter-spacing: -.01em; }}
h3 {{ font-size: 18px; margin: 26px 0 8px; }}
p {{ margin: 0 0 12px; }}
ol.steps {{ counter-reset: s; list-style: none; padding: 0; margin: 0; }}
ol.steps > li {{ counter-increment: s; position: relative; padding-left: 44px; margin: 0 0 20px; }}
ol.steps > li::before {{ content: counter(s); position: absolute; left: 0; top: 0; width: 30px; height: 30px;
  border-radius: 50%; background: var(--accent); color: var(--on-accent); font-weight: 700;
  display: grid; place-items: center; font-size: 15px; }}
figure {{ margin: 14px 0 6px; }}
figure img {{ width: 100%; height: auto; display: block; border-radius: 10px; border: 1px solid var(--line);
  box-shadow: 0 8px 22px rgba(0,0,0,.10); }}
figcaption {{ font-size: 13.5px; color: var(--muted); margin-top: 8px; }}
.note {{ background: var(--soft); border-radius: 10px; padding: 12px 16px; margin: 12px 0; font-size: 15px; }}
.warn {{ background: var(--warn); color: var(--warn-ink); border-radius: 10px; padding: 12px 16px; margin: 12px 0; font-size: 15px; }}
.cols {{ display: grid; grid-template-columns: 1fr 1fr; gap: 22px; align-items: start; }}
table {{ width: 100%; border-collapse: collapse; font-size: 15px; margin: 8px 0 4px; }}
td, th {{ text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }}
th {{ font-size: 13px; color: var(--muted); font-weight: 600; }}
code {{ font: 13.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--code);
  padding: 2px 6px; border-radius: 5px; overflow-wrap: anywhere; }}
pre {{ background: var(--code); border-radius: 10px; padding: 12px 14px; overflow-x: auto; font-size: 13.5px; margin: 8px 0 14px; }}
pre code {{ background: none; padding: 0; }}
kbd {{ font: 12.5px ui-monospace, Menlo, Consolas, monospace; background: var(--paper); border: 1px solid var(--line);
  border-bottom-width: 2px; border-radius: 6px; padding: 1px 7px; }}
details {{ border-bottom: 1px solid var(--line); padding: 10px 0; }}
summary {{ cursor: pointer; font-weight: 600; }}
details p, details pre {{ margin: 8px 0 4px; }}
a {{ color: var(--link); }}
footer {{ color: var(--muted); font-size: 13px; text-align: center; padding: 0 0 40px; }}
@media (max-width: 680px) {{
  .hero {{ flex-direction: column; align-items: flex-start; }} h1 {{ font-size: 28px; }}
  section {{ padding: 20px 16px; }} ol.steps > li {{ padding-left: 40px; }}
  .cols {{ grid-template-columns: 1fr; }}
}}
@media print {{ nav {{ display: none; }} section {{ break-inside: avoid; border: none; }} }}
</style>
</head>
<body>
<header><div class="wrap">
  <div class="hero">
    <img src="{ICON}" alt="">
    <div>
      <h1>Quetza</h1>
      <p class="lead">Appunti a mano con l’audio della riunione, sul server della tua organizzazione. Guida per la versione {E(VERSION)}.</p>
      <p class="lead small">Il nome viene dal Quetzalcoatlus, lo pterosauro più grande mai esistito.</p>
    </div>
  </div>
  <nav>
    <a href="#accesso">Accedere</a><a href="#note">Le note</a><a href="#scrivere">Scrivere e disegnare</a>
    <a href="#registrare">Registrare</a><a href="#riascoltare">Riascoltare</a><a href="#trascrizione">Trascrizione</a>
    <a href="#condividere">Condividere ed esportare</a><a href="#tablet">Tablet e telefono</a><a href="#tasti">Scorciatoie</a>
    <a href="#problemi">Problemi</a><span class="sep"></span>
    <a href="#admin">Amministrazione</a><a href="#installare">Installare</a><a href="#configurare">Configurare</a>
    <a href="#backup">Backup e aggiornamenti</a><a href="#it">Per l’IT</a>
  </nav>
</div></header>

<main class="wrap">

<section>
  <h2>In breve</h2>
  <p>Quetza è un quaderno nel browser. Scrivi su fogli A4 con la penna di un tablet (o con il mouse) e intanto registri la riunione.
  Ogni tratto ricorda l’istante in cui l’hai scritto: quando riascolti, Quetza evidenzia quello che stavi scrivendo in quel momento.
  A fine registrazione l’audio viene trascritto in automatico, distinguendo chi parla, e la trascrizione diventa cercabile.</p>
  <p>Tutto resta sul server dell’organizzazione: niente cloud, niente servizi esterni.</p>
  {fig("libreria", "Le tue note: anteprima del foglio, titolo, data e il segno «audio» se c’è una registrazione.")}
</section>

<section id="accesso">
  <h2>Accedere</h2>
  <div class="cols">
    <div>
      <ol class="steps">
        <li><strong>Apri l’indirizzo</strong> che ti ha dato l’IT, ad esempio <code>https://quetza.azienda.local:8443</code>.
          Se il browser avvisa che la connessione non è privata, vedi <a href="#problemi">Problemi</a>.</li>
        <li><strong>Scegli come entrare</strong>: <em>Locale</em> (utente creato in Quetza), <em>SSO</em> (l’accesso unico aziendale)
          o <em>LDAP</em> (nome utente e password di Windows). Le schede compaiono solo se l’IT le ha attivate.</li>
        <li><strong>Al primo accesso con una password provvisoria</strong> Quetza chiede di cambiarla: almeno 8 caratteri.</li>
      </ol>
    </div>
    <div>{fig("login", "La pagina di accesso.", 420)}</div>
  </div>
  <div class="note">Con SSO o LDAP la password è quella aziendale: si cambia dove la cambi di solito, non in Quetza.</div>
</section>

<section id="note">
  <h2>Le note</h2>
  <ol class="steps">
    <li><strong>Nuova nota</strong> apre un foglio vuoto. <strong>Nota vocale</strong> parte direttamente con la registrazione:
      il foglio lo apri dopo, se ti serve.</li>
    <li><strong>Il titolo</strong> si cambia in alto al centro, dentro la nota.</li>
    <li><strong>Il salvataggio è automatico</strong>, pochi secondi dopo l’ultimo tratto. Il pulsante arancione (o <kbd>Ctrl</kbd> <kbd>S</kbd>) salva subito.
      Se la rete cade compare una striscia rossa: non chiudere la pagina, Quetza riprova da solo.</li>
    <li><strong>Duplica ed elimina</strong> stanno nel menu «…» di ogni nota.</li>
  </ol>
  <h3>Cercare</h3>
  <p>La ricerca trova le parole nel titolo, nel testo digitato con lo strumento Testo e nella trascrizione dell’audio.
  La scrittura a mano non viene letta: per ritrovare una nota scritta a penna conta il titolo, oppure quello che è stato detto.</p>
  {fig("ricerca", "«preventivi» non è nel titolo, ma è stato detto in riunione: la nota si trova dalla trascrizione.", 700)}
</section>

<section id="scrivere">
  <h2>Scrivere e disegnare</h2>
  <p>La barra in alto ha due righe: sopra le azioni sulla nota (audio, tema, condividi, PDF, trascrizione, salva, indietro), sotto gli strumenti.</p>
  {fig("forme", "Forme, frecce e scrittura a mano sullo stesso foglio.", 480)}
  <table><tr><th>Strumento</th><th>A cosa serve</th></tr>{tool_rows}</table>
  <p>Per spostarti nel foglio: rotella del mouse premuta, tasto destro, oppure <kbd>Spazio</kbd> + trascinamento.
  Su tablet un dito sposta il foglio e due dita lo ingrandiscono: il dito non scrive, così il palmo appoggiato non lascia segni.</p>
</section>

<section id="registrare">
  <h2>Registrare la riunione</h2>
  <ol class="steps">
    <li><strong>Apri la barra audio</strong> con il microfono in alto (nelle note vocali è già aperta).</li>
    <li><strong>Premi il pulsante rosso</strong>. La prima volta il browser chiede il permesso per il microfono: <strong>Consenti</strong>.</li>
    <li><strong>Scrivi come al solito.</strong> Ogni tratto viene legato al momento della registrazione.
      Con <em>pausa</em> fermi e riprendi senza chiudere la sessione.</li>
    <li><strong>Premi di nuovo il rosso</strong> per fermare: l’audio viene salvato e parte la trascrizione.</li>
  </ol>
  {fig("registrazione", "Registrazione in corso: il tempo scorre nella barra in basso mentre scrivi.")}
  <div class="warn">Il browser permette il microfono solo su HTTPS. Se il pulsante rosso non fa nulla, controlla che l’indirizzo inizi con <code>https://</code>.</div>
  <p>Puoi registrare più volte sulla stessa nota: le sessioni si accodano e vengono trascritte insieme.</p>
</section>

<section id="riascoltare">
  <h2>Riascoltare</h2>
  <p>Premi play, oppure clicca un punto della forma d’onda per saltare lì. I tratti scritti in quel momento si illuminano di giallo;
  i puntini bianchi sulla forma d’onda mostrano dove hai scritto qualcosa.</p>
  {fig("riascolto", "A metà registrazione si illumina la riga che stavi scrivendo in quel momento.")}
</section>

<section id="trascrizione">
  <h2>Trascrizione</h2>
  <p>Parte da sola quando fermi la registrazione e lavora sul server: puoi continuare a scrivere o chiudere la nota.
  Il pulsante <strong>AI</strong> apre il pannello con il testo, diviso per persona se l’IT ha attivato il riconoscimento di chi parla.
  Clicca un orario o una frase per riascoltare quel punto; <strong>Copia</strong> porta tutto negli appunti.</p>
  {fig("trascrizione", "Trascrizione con tre persone: ognuna ha il suo colore.")}
  <div class="note">La durata dipende dal server e dal modello scelto: su CPU, per una riunione di un’ora possono servire decine di minuti.
  Più registrazioni insieme vengono elaborate una alla volta.</div>
</section>

<section id="condividere">
  <h2>Condividere ed esportare</h2>
  <div class="cols">
    <div>
      <h3 style="margin-top:0">Link di sola lettura</h3>
      <p>Il pulsante <strong>condividi</strong> crea un link che chiunque nella rete può aprire senza account: vede tutte le pagine e può ascoltare l’audio.
      Puoi farlo scadere dopo 1, 7 o 30 giorni e revocarlo quando vuoi (cestino). Eliminando la nota, i suoi link smettono di funzionare.</p>
      <h3>PDF</h3>
      <p>Il pulsante <strong>scarica</strong> crea un PDF con tutte le pagine, con o senza righe.</p>
      <h3>Archivio delle tue note</h3>
      <p><strong>Esporta</strong> (nella pagina delle note) scarica uno ZIP con tutte le tue note e gli audio; <strong>Importa</strong> lo ricarica.
      Utile per spostarle o tenerne una copia personale.</p>
    </div>
    <div>{fig("condividi", "Link creato: copialo o mandalo per email.", 380)}</div>
  </div>
</section>

<section id="tablet">
  <h2>Tablet, telefono e tema</h2>
  <p>Quetza funziona nel browser di computer, tablet e telefono. Si scrive con la penna (Apple Pencil, S Pen, penne Windows), che usa anche la pressione; il dito serve solo a scorrere e ingrandire.
  Su un telefono senza penna restano comode le note vocali, la lettura e la condivisione.
  Si può <strong>installare come app</strong>: in Chrome/Edge dal menu <em>Installa app</em>, su iPad e iPhone da Safari con <em>Condividi → Aggiungi alla schermata Home</em>.</p>
  <p>Il pulsante con il sole cambia tema: <strong>chiaro</strong>, <strong>scuro</strong> ed <strong>e-ink</strong> (alto contrasto, per tablet a inchiostro elettronico).
  Nel tema scuro l’inchiostro nero diventa bianco, e torna nero nel PDF.</p>
  {fig("editor-scuro", "La stessa nota nel tema scuro.")}
</section>

<section id="tasti">
  <h2>Scorciatoie da tastiera</h2>
  <table><tr><th>Tasti</th><th>Azione</th></tr>{shortcut_rows}</table>
</section>

<section id="problemi">
  <h2>Problemi frequenti</h2>
  <details><summary>Il browser dice «La connessione non è privata»</summary>
    <p>Il server usa un certificato creato da sé (self-signed). La soluzione giusta è che l’IT installi un certificato della CA aziendale
    (vedi <a href="#configurare">Configurare</a>). Nel frattempo si può proseguire con <em>Avanzate → Procedi</em>: su alcuni browser però
    il microfono e l’installazione come app restano bloccati.</p></details>
  <details><summary>Il pulsante di registrazione non fa nulla</summary>
    <p>Serve HTTPS e il permesso del microfono. Controlla l’indirizzo (<code>https://</code>) e, nelle impostazioni del sito
    (il lucchetto vicino all’indirizzo), che il microfono sia consentito.</p></details>
  <details><summary>La trascrizione non arriva</summary>
    <p>Al primo avvio il server scarica il modello e può metterci qualche minuto. Poi riprova con il pulsante AI. Se continua,
    l’IT trova lo stato in Amministrazione → Whisper → Test connessione.</p></details>
  <details><summary>La trascrizione non distingue chi parla</summary>
    <p>Il riconoscimento dei parlanti richiede un token Hugging Face configurato dall’IT. Senza, il testo arriva comunque, tutto di seguito.</p></details>
  <details><summary>Ho dimenticato la password</summary>
    <p>Con SSO o LDAP vale la password aziendale. Per un account locale, un amministratore imposta una password provvisoria
    (Amministrazione → Utenti → Reset pw) e al primo accesso ne sceglierai una nuova.</p></details>
  <details><summary>Il link condiviso dice «Link non valido o scaduto»</summary>
    <p>Il link è scaduto, è stato revocato o la nota è stata eliminata. Creane uno nuovo dalla nota.</p></details>
  <details><summary>«Accesso negato» con SSO o LDAP, ma la password è giusta</summary>
    <p>L’account può essere disattivato in Quetza, oppure esiste già un utente locale con lo stesso nome: Quetza non li unisce, per sicurezza.
    Chiedi all’amministratore.</p></details>
</section>

<section id="admin" class="it">
  <h2>Amministrazione</h2>
  <p>Gli amministratori vedono l’ingranaggio in alto: apre <code>/admin</code>, con le statistiche e cinque schede.</p>
  <h3>Utenti</h3>
  {fig("admin", "Utenti: ruolo, stato, origine (locale, ldap, oidc) e ultimo accesso.")}
  <p><strong>+ Nuovo utente</strong> crea un account locale. Gli utenti LDAP e SSO si creano da soli al primo accesso, come utenti normali:
  rendili amministratori da qui. <strong>Disattiva</strong> blocca subito l’accesso, anche alle sessioni già aperte. Non si può togliere l’ultimo amministratore.</p>
  <h3>SSO / OIDC</h3>
  <p>Quetza fa solo da client: funziona con il provider che l’organizzazione ha già (Keycloak, Microsoft Entra ID, Authentik, Google Workspace…)
  e non ne installa nessuno. Sul provider registra un client «confidential» con il flusso <em>authorization code</em> e come redirect URI
  <code>https://&lt;indirizzo di Quetza&gt;/auth/callback</code>. Poi compila qui Issuer, Client ID, Client Secret e Redirect URI e premi <strong>Test connessione</strong>.</p>
  {fig("admin-sso", "SSO / OIDC. L’URL interno serve solo se il server non raggiunge il provider con l’indirizzo pubblico.")}
  <div class="note">L’accesso usa PKCE e nonce e controlla issuer e destinatario del token. Se il provider ha un certificato della CA aziendale,
  metti il file della CA nella cartella <code>ca/</code> accanto a <code>docker-compose.yml</code>, invece di togliere la verifica TLS.</div>
  <h3>LDAP / Active Directory</h3>
  <p>Serve un account di servizio di sola lettura (Bind DN) per cercare l’utente; poi Quetza verifica la password dell’utente stesso.
  Il filtro <code>(sAMAccountName={{{{username}}}})</code> usa il nome utente Windows. Gli account locali restano utilizzabili dalla scheda «Locale»,
  così un AD irraggiungibile non chiude fuori l’amministratore.</p>
  {fig("admin-ldap", "LDAP / AD. Con <code>ldaps://</code> e la CA aziendale in <code>ca/</code> la verifica TLS può restare attiva.")}
  <h3>Whisper</h3>
  <p>Modello di trascrizione, cambiabile senza riavviare, e token Hugging Face per riconoscere chi parla
  (va accettata la licenza di <code>pyannote/speaker-diarization-3.1</code> su huggingface.co).</p>
  <table><tr><th>Modello</th><th>RAM</th><th>Velocità su CPU</th><th>Quando</th></tr>{model_rows}</table>
  {fig("admin-whisper", "Whisper: modello, token e test del servizio.")}
  <h3>Backup &amp; Migrazione</h3>
  <p>Esporta e importa tutte le note di tutti gli utenti in uno ZIP, per spostare Quetza su un altro server.
  L’import aggiunge e aggiorna, non cancella. Gli account locali importati nascono senza password: impostala da Utenti → Reset pw.</p>
  {fig("admin-backup", "Backup &amp; Migrazione. Per i backup quotidiani vedi la sezione successiva.")}
</section>

<section id="installare" class="it">
  <h2>Installare</h2>
  <p>Serve un server Linux con Docker e il plugin Compose, raggiungibile dagli utenti nella LAN. Indicativamente 2 CPU e 4 GB di RAM
  con il modello <code>small</code>; di più per i modelli grandi. Al primo avvio serve Internet per scaricare le immagini e il modello di trascrizione.</p>
  <ol class="steps">
    <li><strong>Scarica il progetto</strong> sul server:
      <pre><code>git clone https://github.com/ranzaWARE/quetza.git
cd quetza</code></pre></li>
    <li><strong>Avvia l’installazione</strong>. Lo script crea il file <code>.env</code> con un segreto casuale, chiede IP e nome del server, costruisce e avvia i container:
      <pre><code>./installa.sh</code></pre></li>
    <li><strong>Apri l’indirizzo</strong> che lo script stampa alla fine ed entra con <code>admin</code> / <code>admin</code>: Quetza chiede subito una nuova password.</li>
    <li><strong>Configura</strong> utenti, SSO o LDAP e trascrizione da <a href="#admin">Amministrazione</a>.</li>
  </ol>
  <p>Senza lo script: <code>cp .env.example .env</code>, compila almeno <code>SESSION_SECRET</code> (<code>openssl rand -hex 32</code>) e <code>SERVER_IP</code>,
  poi <code>docker compose up -d --build</code>.</p>
</section>

<section id="configurare" class="it">
  <h2>Configurare</h2>
  <p>Tutta la configurazione sta nel file <code>.env</code>, commentato riga per riga. Dopo una modifica: <code>docker compose up -d</code>.</p>
  <table><tr><th>Variabile</th><th>Cosa fa</th></tr>{env_rows}</table>
  <h3>Cartelle accanto a docker-compose.yml</h3>
  <table>
    <tr><td><code>certs/</code></td><td>Certificato HTTPS: <code>server.crt</code> e <code>server.key</code>. Mettici quelli emessi dalla CA aziendale (catena completa nel .crt);
      se mancano, al primo avvio se ne genera uno self-signed valido 10 anni.</td></tr>
    <tr><td><code>backups/</code></td><td>Backup notturni del database (cambia posto con <code>BACKUP_PATH</code>).</td></tr>
    <tr><td><code>ca/</code></td><td>CA aziendali (<code>*.crt</code> o <code>*.pem</code>) di cui fidarsi per LDAPS e SSO.</td></tr>
    <tr><td><code>logo/</code></td><td>Logo dell’organizzazione per l’intestazione: <code>logo.svg</code>, <code>.png</code>, <code>.webp</code> o <code>.jpg</code>.</td></tr>
  </table>
  <p>Dopo aver sostituito il certificato: <code>docker compose restart quetza</code>.</p>
</section>

<section id="backup" class="it">
  <h2>Backup e aggiornamenti</h2>
  <h3>Backup</h3>
  <p>Ogni notte Quetza copia il database (note, audio, trascrizioni, utenti, impostazioni) in <code>backups/</code>, tenendo le ultime 30 copie.
  La copia è coerente anche mentre l’app lavora. <strong>Copia quella cartella fuori dal server</strong> (NAS, backup aziendale):
  un backup sullo stesso disco non protegge da un guasto del disco.</p>
  <pre><code>docker exec quetza node /app/backup.js     # backup subito</code></pre>
  <h3>Ripristino</h3>
  <pre><code>docker compose stop quetza
docker run --rm -v quetza_quetza_data:/data -v "$PWD/backups":/b alpine \\
  sh -c 'rm -f /data/quetza.db-wal /data/quetza.db-shm &amp;&amp; cp /b/quetza_AAAAMMGG_HHMMSS.db /data/quetza.db'
docker compose start quetza</code></pre>
  <p>Il nome del volume dipende dalla cartella del progetto: controllalo con <code>docker volume ls</code>.</p>
  <h3>Aggiornare</h3>
  <pre><code>cd quetza
git pull
./installa.sh        # tiene il .env, ricostruisce e riavvia</code></pre>
  <p>Prima di aggiornare conviene un backup al volo (comando sopra).</p>
</section>

<section id="it" class="it">
  <h2>Per l’IT</h2>
  <table>
    <tr><th>Cosa</th><th>Dove</th></tr>
    <tr><td>Container</td><td><code>quetza</code> (Node.js, porte 3000→HTTP e 3443→HTTPS) e <code>quetza-whisper</code> (Python, nessuna porta esposta)</td></tr>
    <tr><td>Dati</td><td>volume <code>quetza_data</code>: <code>quetza.db</code> (SQLite, audio compresi) e <code>sessions.db</code></td></tr>
    <tr><td>Modelli di trascrizione</td><td>volume <code>whisper_models</code></td></tr>
    <tr><td>Log</td><td><code>docker compose logs -f quetza</code> (accessi SSO/LDAP con prefisso <code>[oidc]</code> e <code>[auth]</code>), <code>backups/backup.log</code></td></tr>
    <tr><td>Stato</td><td><code>GET /healthz</code>, usato dall’healthcheck di Docker</td></tr>
    <tr><td>Reverse proxy</td><td>facoltativo: <code>docker compose --profile nginx up -d</code> (porte 80/443) e <code>TRUST_PROXY=1</code></td></tr>
    <tr><td>Rete in uscita</td><td>solo al primo avvio e agli aggiornamenti: immagini Docker, pacchetti, modelli da huggingface.co. Verso SSO e LDAP se configurati.</td></tr>
  </table>
  <h3>Sicurezza</h3>
  <p>Password locali con scrypt e salt per utente; cookie di sessione <code>HttpOnly</code>, <code>SameSite=Lax</code> e <code>Secure</code> su HTTPS;
  limite di tentativi sul login; la porta HTTP fa solo il redirect verso HTTPS. Gli utenti SSO/LDAP non ereditano mai un account locale con lo stesso nome.
  I link condivisi sono pubblici per chi ha il link: usa la scadenza per le note riservate.</p>
</section>

</main>
<footer>Quetza {E(VERSION)} · ranzaWARE</footer>
</body>
</html>
"""

open(OUT, "w", encoding="utf-8").write(page)
print(OUT, f"{os.path.getsize(OUT) // 1024} KB")
