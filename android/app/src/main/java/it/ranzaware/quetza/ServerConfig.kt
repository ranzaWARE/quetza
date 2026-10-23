package it.ranzaware.quetza

import android.content.Context
import android.content.RestrictionsManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.core.content.edit

/**
 * Impostazioni dell'app: server da proporre, certificati accettati e
 * modalità e-ink. La configurazione gestita (MDM) ha sempre la precedenza
 * su quella scelta dall'utente.
 */
class ServerConfig(context: Context) {

    private val prefs = context.getSharedPreferences("quetza", Context.MODE_PRIVATE)
    private val managed: Bundle =
        (context.getSystemService(Context.RESTRICTIONS_SERVICE) as RestrictionsManager).applicationRestrictions

    private val managedUrl: String?
        get() = managed.getString("server_url")?.let(::normalize)

    val isManaged: Boolean get() = managedUrl != null

    /**
     * Server da proporre per il collegamento: quello dell'MDM, oppure quello
     * scelto con la versione precedente dell'app (che apriva il sito). Il
     * collegamento vero e proprio lo fa e lo ricorda l'interfaccia.
     */
    val serverUrl: String?
        get() = managedUrl ?: prefs.getString("server_url", null)

    var einkMode: String
        get() = managed.getString("eink_mode")?.takeIf { it in EINK_MODES }
            ?: prefs.getString("eink_mode", "auto")!!
        set(value) = prefs.edit { putString("eink_mode", value) }

    val isEinkModeManaged: Boolean get() = managed.getString("eink_mode")?.let { it in EINK_MODES } == true

    val isEink: Boolean
        get() = when (einkMode) {
            "on" -> true
            "off" -> false
            else -> isEinkDevice()
        }

    // ── Certificati ────────────────────────────────────────────────

    private val managedFingerprints: Set<String>
        get() = managed.getString("cert_sha256").orEmpty()
            .split(',', ';', '\n', ' ')
            .map(::cleanFingerprint)
            .filter { it.length == 64 }
            .toSet()

    /** Con impronte imposte dall'MDM l'utente non può accettarne altre. */
    val certsLocked: Boolean get() = managedFingerprints.isNotEmpty()

    private val accepted: Set<String> get() = prefs.getStringSet("certs", emptySet())!!

    fun isTrusted(hostPort: String, fp: String): Boolean =
        fp in managedFingerprints || (!certsLocked && "$hostPort|$fp" in accepted)

    fun hadOtherCert(hostPort: String): Boolean = accepted.any { it.startsWith("$hostPort|") }

    fun trust(hostPort: String, fp: String) = prefs.edit {
        putStringSet("certs", accepted.filterNot { it.startsWith("$hostPort|") }.toSet() + "$hostPort|$fp")
    }

    fun forgetCerts() = prefs.edit { remove("certs") }

    companion object {
        val EINK_MODES = setOf("auto", "on", "off")

        /** Boox (Onyx) è la marca e-ink Android più diffusa; le altre si attivano a mano. */
        fun isEinkDevice(): Boolean =
            Build.MANUFACTURER.equals("onyx", ignoreCase = true) ||
                Build.BRAND.equals("onyx", ignoreCase = true) ||
                Build.BRAND.contains("boox", ignoreCase = true)

        /**
         * Accetta quello che l'utente scriverebbe nel browser ("192.168.1.20:8443",
         * "https://quetza.local/") e lo riduce all'origine: Quetza usa percorsi
         * assoluti, quindi deve stare alla radice del server.
         */
        fun normalize(input: String): String? {
            val s = input.trim()
            if (s.isEmpty()) return null
            val uri = Uri.parse(if ("://" in s) s else "https://$s")
            val scheme = uri.scheme?.lowercase()
            if (scheme != "https" && scheme != "http") return null
            if (uri.host.isNullOrBlank()) return null
            return originOf(uri) + "/"
        }

        fun originOf(uri: Uri): String {
            val scheme = uri.scheme!!.lowercase()
            val host = uri.host!!.lowercase().let { if (':' in it && !it.startsWith("[")) "[$it]" else it }
            val port = uri.port
            val defaultPort = if (scheme == "https") 443 else 80
            return if (port == -1 || port == defaultPort) "$scheme://$host" else "$scheme://$host:$port"
        }

        fun hostPort(url: String): String {
            val uri = Uri.parse(url)
            val port = if (uri.port != -1) uri.port else if (uri.scheme == "http") 80 else 443
            return "${uri.host}:$port"
        }

        fun cleanFingerprint(s: String): String = s.replace(":", "").trim().uppercase()
    }
}
