const ldap = require('ldapjs');

const LDAP_ENABLED = process.env.LDAP_ENABLED === 'true';

// ── Local users fallback (usare solo per testing) ────────────
// In produzione usare LDAP. Aggiungere utenti qui solo in emergenza.
const LOCAL_USERS = [
  { username: 'admin', password: 'admin', displayName: 'Administrator' },
];

async function ldapAuthenticate(username, password) {
  return new Promise((resolve, reject) => {
    const tlsOpts = { rejectUnauthorized: process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== 'false' };

    const adminClient = ldap.createClient({
      url: process.env.LDAP_URL,
      tlsOptions: tlsOpts,
      timeout: 8000,
      connectTimeout: 8000
    });

    adminClient.on('error', err => reject(new Error(`LDAP connection: ${err.message}`)));

    adminClient.bind(process.env.LDAP_BIND_DN, process.env.LDAP_BIND_PASSWORD, err => {
      if (err) {
        adminClient.destroy();
        return reject(new Error(`LDAP service bind: ${err.message}`));
      }

      const filter = (process.env.LDAP_SEARCH_FILTER || '(sAMAccountName={{username}})')
        .replace('{{username}}', ldap.escapeFilter(username));

      adminClient.search(process.env.LDAP_SEARCH_BASE, {
        filter,
        scope: 'sub',
        attributes: ['dn', 'sAMAccountName', 'displayName', 'mail', 'cn']
      }, (err, res) => {
        if (err) { adminClient.destroy(); return reject(new Error(`LDAP search: ${err.message}`)); }

        let userEntry = null;
        res.on('searchEntry', entry => { userEntry = entry; });
        res.on('error', err => { adminClient.destroy(); reject(new Error(`LDAP search error: ${err.message}`)); });
        res.on('end', () => {
          adminClient.destroy();
          if (!userEntry) return reject(new Error('Utente non trovato'));

          const userDN = userEntry.dn.toString();
          const attrs = userEntry.pojo?.attributes || [];
          const get = name => attrs.find(a => a.type === name)?.values?.[0] || '';

          const userClient = ldap.createClient({
            url: process.env.LDAP_URL,
            tlsOptions: tlsOpts,
            timeout: 8000,
            connectTimeout: 8000
          });
          userClient.on('error', err => reject(new Error(`LDAP user bind: ${err.message}`)));
          userClient.bind(userDN, password, err => {
            userClient.destroy();
            if (err) return reject(new Error('Password non valida'));
            resolve({
              username: get('sAMAccountName') || username,
              displayName: get('displayName') || get('cn') || username,
              email: get('mail') || '',
              source: 'ldap'
            });
          });
        });
      });
    });
  });
}

async function localAuthenticate(username, password) {
  const user = LOCAL_USERS.find(u => u.username === username && u.password === password);
  if (!user) throw new Error('Credenziali non valide');
  return { username: user.username, displayName: user.displayName, source: 'local' };
}

async function authenticate(username, password) {
  if (LDAP_ENABLED) return ldapAuthenticate(username, password);
  return localAuthenticate(username, password);
}

module.exports = { authenticate };
