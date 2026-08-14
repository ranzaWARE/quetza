// Fallback: connect-sqlite3 dipende dal modulo nativo sqlite3. Per i test
// basta lo store in memoria di express-session.
module.exports = function (session) { return session.MemoryStore; };
