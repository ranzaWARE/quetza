const ldap = require('ldapjs');
const db   = require('./db');
const { Agent } = require('undici');

// ── LDAP ──────────────────────────────────────────────────────
// Escape dei valori nei filtri LDAP (RFC 4515). ldapjs 3 non esporta più
// escapeFilter: chiamarlo lanciava un TypeError dentro il callback di bind,
// quindi ogni login LDAP falliva (e l'eccezione non gestita poteva
// abbattere il processo).
function escapeLdapFilter(value) {
  return String(value).replace(/[\\*()\0]/g, c => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

async function ldapAuthenticate(username, password) {
  // Un bind con password vuota è un "unauthenticated bind": molti AD lo
  // accettano come successo. Va rifiutato prima di contattare il server.
  if (!username || !password) throw new Error('Credenziali non valide');
  const cfg = {
    url:          db.getSetting('ldap_url')         || process.env.LDAP_URL,
    bindDN:       db.getSetting('ldap_bind_dn')     || process.env.LDAP_BIND_DN,
    bindPassword: db.getSetting('ldap_bind_pass')   || process.env.LDAP_BIND_PASSWORD,
    searchBase:   db.getSetting('ldap_search_base') || process.env.LDAP_SEARCH_BASE,
    searchFilter: db.getSetting('ldap_search_filter')|| process.env.LDAP_SEARCH_FILTER || '(sAMAccountName={{username}})',
    rejectUnauthorized: (db.getSetting('ldap_tls_reject')||process.env.LDAP_TLS_REJECT_UNAUTHORIZED) !== 'false',
  };

  return new Promise((resolve, reject) => {
    const tlsOpts = { rejectUnauthorized: cfg.rejectUnauthorized };
    const adminClient = ldap.createClient({ url: cfg.url, tlsOptions: tlsOpts, timeout: 8000, connectTimeout: 8000 });
    adminClient.on('error', err => reject(new Error(`LDAP connection: ${err.message}`)));
    adminClient.bind(cfg.bindDN, cfg.bindPassword, err => {
      if (err) { adminClient.destroy(); return reject(new Error(`LDAP bind: ${err.message}`)); }
      const filter = cfg.searchFilter.replace('{{username}}', escapeLdapFilter(username));
      adminClient.search(cfg.searchBase, { filter, scope: 'sub', attributes: ['dn','sAMAccountName','displayName','mail','cn'] }, (err, res) => {
        if (err) { adminClient.destroy(); return reject(new Error(`LDAP search: ${err.message}`)); }
        let userEntry = null;
        res.on('searchEntry', e => { userEntry = e; });
        res.on('error', err => { adminClient.destroy(); reject(new Error(err.message)); });
        res.on('end', () => {
          adminClient.destroy();
          if (!userEntry) return reject(new Error('Utente non trovato'));
          const userDN = userEntry.dn.toString();
          const attrs  = userEntry.pojo?.attributes || [];
          const get    = name => attrs.find(a => a.type === name)?.values?.[0] || '';
          const userClient = ldap.createClient({ url: cfg.url, tlsOptions: tlsOpts, timeout: 8000, connectTimeout: 8000 });
          userClient.on('error', err => reject(new Error(err.message)));
          userClient.bind(userDN, password, err => {
            userClient.destroy();
            if (err) return reject(new Error('Password non valida'));
            const uname = get('sAMAccountName') || username;
            const displayName = get('displayName') || get('cn') || uname;
            let dbUser;
            try { dbUser = syncExternalUser(uname, displayName, 'ldap'); }
            catch (e) { return reject(e); }
            resolve({ username: uname, displayName, email: get('mail')||'', source:'ldap', is_admin: dbUser.is_admin||0 });
          });
        });
      });
    });
  });
}

// Utente arrivato da LDAP o SSO: lo si registra nel DB locale al primo
// accesso (serve per assegnargli is_admin). Senza password locale, quindi
// non può entrare dal tab "Locale".
// Due controlli che prima mancavano:
//  - un utente disattivato dall'admin non deve poter entrare da LDAP/SSO;
//  - uno username esterno uguale a un account di altra origine (es. "admin"
//    locale) non deve ereditarne i permessi.
function syncExternalUser(username, displayName, source) {
  let u = db.getUserByUsername(username);
  if (!u) {
    try { db.createUser(username, null, displayName || username, 0, source); } catch {}
    u = db.getUserByUsername(username);
  }
  if (!u) throw new Error('Impossibile registrare l\'utente');
  if (u.source !== source) {
    console.warn(`[auth] "${username}" da ${source} coincide con un account ${u.source}: accesso negato`);
    throw new Error('Account già esistente con un altro metodo di accesso');
  }
  if (!u.is_active) throw new Error('Account disattivato');
  db.touchLogin(username);
  return u;
}

// ── OIDC (provider generico: Keycloak, Entra ID, Authentik, ...) ─────
// Quetza fa solo da client OIDC: il provider è esterno e gli endpoint si
// ricavano dalla discovery (.well-known/openid-configuration), senza
// assumere i path di un prodotto specifico.
function getOidcConfig() {
  return {
    enabled:      db.getSetting('oidc_enabled') === 'true',
    issuer:       (db.getSetting('oidc_issuer') || '').replace(/\/+$/, ''),
    // URL dell'issuer raggiungibile DAL CONTAINER (es. nome/IP interno del
    // provider), opzionale: usato solo per le chiamate server-side
    // (discovery, token). L'issuer pubblico resta quello visto dal browser e
    // quello atteso nel claim "iss" dei token. Vuoto = issuer pubblico.
    internalUrl:  (db.getSetting('oidc_internal_url') || process.env.OIDC_INTERNAL_URL || '').replace(/\/+$/, ''),
    clientId:     db.getSetting('oidc_client_id')    || '',
    clientSecret: db.getSetting('oidc_client_secret')|| '',
    redirectUri:  db.getSetting('oidc_redirect_uri') || '',
    // Come per LDAP: un provider interno con certificato self-signed/CA
    // aziendale non è fidato di default da Node (che non eredita il trust
    // store del sistema operativo) — la fetch fallisce con
    // UNABLE_TO_GET_ISSUER_CERT_LOCALLY finché non si importa quella CA
    // (soluzione corretta: NODE_EXTRA_CA_CERTS) o si disattiva qui la
    // verifica come ultima spiaggia.
    tlsReject: (db.getSetting('oidc_tls_reject') || process.env.OIDC_TLS_REJECT_UNAUTHORIZED) !== 'false',
  };
}

function oidcFetchOptions(cfg) {
  // Scoped alle sole fetch verso il provider (non un NODE_TLS_REJECT_UNAUTHORIZED
  // globale, che disattiverebbe la verifica per QUALSIASI TLS del processo).
  return { dispatcher: cfg.tlsReject ? undefined : new Agent({ connect: { rejectUnauthorized: false } }) };
}

// Sposta un endpoint dall'URL pubblico a quello interno (o viceversa):
// stesso prefisso dell'issuer → si sostituisce il prefisso, altrimenti solo
// l'origin se coincide. Endpoint su host diversi restano invariati.
function rebase(url, from, to) {
  if (!url || !from || !to || from === to) return url;
  if (url.startsWith(from)) return to + url.slice(from.length);
  const u = new URL(url), f = new URL(from), t = new URL(to);
  return u.origin === f.origin ? t.origin + u.pathname + u.search : url;
}

let discoveryCache = null; // { key, at, doc }
const DISCOVERY_TTL = 5 * 60 * 1000;

// Discovery dall'URL interno (o dall'issuer). Ritorna gli endpoint già pronti:
// authorization per il browser (URL pubblico), token per il server (interno).
async function oidcDiscover(cfg, { fresh = false } = {}) {
  const base = cfg.internalUrl || cfg.issuer;
  const url  = `${base}/.well-known/openid-configuration`;
  const key  = `${cfg.issuer}|${base}`;
  if (!fresh && discoveryCache?.key === key && Date.now() - discoveryCache.at < DISCOVERY_TTL) return discoveryCache.doc;
  const res = await fetch(url, { ...oidcFetchOptions(cfg), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw Object.assign(new Error(`discovery HTTP ${res.status} da ${url}`), { url, status: res.status });
  const meta = await res.json();
  const doc = {
    url, status: res.status, issuer: meta.issuer,
    authorizationEndpoint: rebase(meta.authorization_endpoint, cfg.internalUrl, cfg.issuer),
    tokenEndpoint:         rebase(meta.token_endpoint, cfg.issuer, base),
  };
  if (!doc.authorizationEndpoint || !doc.tokenEndpoint) throw new Error(`discovery incompleta da ${url}`);
  discoveryCache = { key, at: Date.now(), doc };
  return doc;
}

// Il claim "iss" deve corrispondere all'issuer pubblico configurato. Si
// accetta anche l'URL interno per i provider che usano come iss l'host con
// cui sono stati contattati.
function isAcceptedIssuer(cfg, iss) {
  const norm = v => (v || '').replace(/\/+$/, '');
  return [cfg.issuer, cfg.internalUrl].filter(Boolean).includes(norm(iss));
}

// ── Local ─────────────────────────────────────────────────────
async function localAuthenticate(username, password) {
  if (!db.verifyPassword(username, password)) throw new Error('Credenziali non valide');
  db.touchLogin(username);
  const user = db.getUserByUsername(username);
  return {
    username: user.username, displayName: user.display_name, source: 'local',
    is_admin: user.is_admin, must_change_password: user.must_change_password ? 1 : 0,
  };
}

// Esiste un account locale con password utilizzabile?
function hasLocalCredentials(username) {
  const u = db.getUserByUsername(username);
  return !!(u && u.source === 'local' && u.password_hash && u.is_active);
}

// ── Main entry point ──────────────────────────────────────────
// method === 'local' → forza l'autenticazione locale (tab "Locale" del login).
// Con LDAP attivo si tenta prima LDAP, poi si ricade sull'account locale se
// ne esiste uno con password: senza questo fallback un LDAP irraggiungibile
// o mal configurato rendeva irraggiungibile anche l'admin locale.
async function authenticate(username, password, method) {
  const ldapEnabled = db.getSetting('ldap_enabled') === 'true' || process.env.LDAP_ENABLED === 'true';

  if (method === 'local' || !ldapEnabled) return localAuthenticate(username, password);

  try {
    return await ldapAuthenticate(username, password);
  } catch (err) {
    if (hasLocalCredentials(username)) {
      console.warn(`[auth] LDAP fallito per "${username}" (${err.message}) — fallback su account locale`);
      return localAuthenticate(username, password);
    }
    throw err;
  }
}

module.exports = { authenticate, escapeLdapFilter, syncExternalUser, getOidcConfig, oidcDiscover, oidcFetchOptions, isAcceptedIssuer, ldapAuthenticate, localAuthenticate, hasLocalCredentials };
