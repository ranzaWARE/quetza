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
            // Sincronizza utente nel DB locale (per potergli assegnare is_admin)
            const existing = db.getUserByUsername(uname);
            if (!existing) {
              try { db.createUser(uname, null, get('displayName')||get('cn')||uname, 0); } catch {}
              // Aggiorna source a ldap
              db.updateUser(uname, {});
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
    issuer:       db.getSetting('oidc_issuer')       || '',
    clientId:     db.getSetting('oidc_client_id')    || '',
    clientSecret: db.getSetting('oidc_client_secret')|| '',
    redirectUri:  db.getSetting('oidc_redirect_uri') || '',
  };
}

// ── Local ─────────────────────────────────────────────────────
async function localAuthenticate(username, password) {
  if (!db.verifyPassword(username, password)) throw new Error('Credenziali non valide');
  db.touchLogin(username);
  const user = db.getUserByUsername(username);
  return { username: user.username, displayName: user.display_name, source: 'local', is_admin: user.is_admin };
}

// ── Main entry point ──────────────────────────────────────────
async function authenticate(username, password) {
  const ldapEnabled = db.getSetting('ldap_enabled') === 'true' || process.env.LDAP_ENABLED === 'true';
  if (ldapEnabled) return ldapAuthenticate(username, password);
  return localAuthenticate(username, password);
}

module.exports = { authenticate, getKeycloakConfig, ldapAuthenticate, localAuthenticate };