const ldap = require('ldapjs');
const db   = require('./db');

// ── LDAP ──────────────────────────────────────────────────────
async function ldapAuthenticate(username, password) {
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
      const filter = cfg.searchFilter.replace('{{username}}', ldap.escapeFilter(username));
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
            // Sincronizza utente nel DB locale (per potergli assegnare is_admin).
            // source='ldap' → nessun hash locale, non può fare login locale.
            const existing = db.getUserByUsername(uname);
            if (!existing) {
              try { db.createUser(uname, null, get('displayName')||get('cn')||uname, 0, 'ldap'); } catch {}
            }
            db.touchLogin(uname);
            const dbUser = db.getUserByUsername(uname);
            resolve({ username: uname, displayName: get('displayName')||get('cn')||uname, email: get('mail')||'', source:'ldap', is_admin: dbUser?.is_admin||0 });
          });
        });
      });
    });
  });
}

// ── Keycloak OIDC ─────────────────────────────────────────────
function getKeycloakConfig() {
  return {
    enabled:      db.getSetting('oidc_enabled') === 'true',
    issuer:       (db.getSetting('oidc_issuer') || '').replace(/\/+$/, ''),
    // URL del realm raggiungibile DAL CONTAINER (es. http://keycloak:8080/realms/x
    // o l'IP interno): usato solo per le chiamate server-side (discovery, token).
    // L'issuer pubblico resta quello del browser (redirect /auth) e quello
    // atteso nel claim "iss" dei token. Vuoto = si usa l'issuer pubblico.
    internalUrl:  (db.getSetting('oidc_internal_url') || process.env.OIDC_INTERNAL_URL || '').replace(/\/+$/, ''),
    clientId:     db.getSetting('oidc_client_id')    || '',
    clientSecret: db.getSetting('oidc_client_secret')|| '',
    redirectUri:  db.getSetting('oidc_redirect_uri') || '',
    // Come per LDAP: un Keycloak interno con certificato self-signed/CA
    // aziendale non è fidato di default da Node (che non eredita il trust
    // store del sistema operativo) — la fetch del token fallisce con
    // UNABLE_TO_GET_ISSUER_CERT_LOCALLY finché non si importa quella CA
    // (soluzione corretta: NODE_EXTRA_CA_CERTS) o si disattiva qui la
    // verifica come ultima spiaggia.
    tlsReject: (db.getSetting('oidc_tls_reject') || process.env.OIDC_TLS_REJECT_UNAUTHORIZED) !== 'false',
  };
}

// Base URL per le chiamate server→Keycloak.
function oidcServerBase(kc) {
  return kc.internalUrl || kc.issuer;
}

// Il claim "iss" deve corrispondere all'issuer pubblico (Keycloak con
// KC_HOSTNAME firma sempre con l'hostname pubblico, anche se lo si chiama
// dall'URL interno). Si accetta anche l'URL interno per i Keycloak senza
// hostname fisso, che usano come iss l'host con cui sono stati contattati.
function isAcceptedIssuer(kc, iss) {
  const norm = v => (v || '').replace(/\/+$/, '');
  return [kc.issuer, kc.internalUrl].filter(Boolean).includes(norm(iss));
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

module.exports = { authenticate, getKeycloakConfig, oidcServerBase, isAcceptedIssuer, ldapAuthenticate, localAuthenticate, hasLocalCredentials };
