package it.ranzaware.quetza

import android.app.Activity
import android.app.AlertDialog
import android.net.http.SslError
import android.webkit.SslErrorHandler
import java.security.MessageDigest
import java.text.DateFormat
import javax.security.auth.x500.X500Principal

/**
 * Certificati self-signed: alla prima connessione mostra l'impronta e, se
 * l'utente la accetta, la ricorda per quel server (trust on first use).
 * Se poi il server presenta un certificato diverso lo segnala invece di
 * passare in silenzio.
 *
 * Un certificato emesso da una CA installata sul dispositivo non arriva mai
 * qui: lo accetta già la WebView grazie a network_security_config.
 */
class CertTrust(
    private val activity: Activity,
    private val config: ServerConfig,
    private val onRejected: (String) -> Unit,
) {
    // Una pagina fa molte richieste in parallelo: un solo dialogo per server.
    private val pending = HashMap<String, MutableList<SslErrorHandler>>()

    fun handle(error: SslError, handler: SslErrorHandler) {
        val cert = error.certificate.x509Certificate
        if (cert == null) {
            handler.cancel()
            onRejected(activity.getString(R.string.cert_rejected))
            return
        }
        val fp = MessageDigest.getInstance("SHA-256").digest(cert.encoded)
            .joinToString("") { "%02X".format(it) }
        val hostPort = ServerConfig.hostPort(error.url)

        if (config.isTrusted(hostPort, fp)) {
            handler.proceed()
            return
        }
        if (config.certsLocked) {
            handler.cancel()
            onRejected(activity.getString(R.string.cert_locked, hostPort))
            return
        }
        pending[hostPort]?.let { it += handler; return }
        pending[hostPort] = mutableListOf(handler)
        if (activity.isFinishing) { resolve(hostPort, false); return }

        val changed = config.hadOtherCert(hostPort)
        val date = DateFormat.getDateInstance(DateFormat.LONG)
        val body = activity.getString(
            R.string.cert_body,
            hostPort,
            commonName(cert.subjectX500Principal),
            commonName(cert.issuerX500Principal),
            date.format(cert.notAfter),
            fp.chunked(2).joinToString(":"),
        )
        AlertDialog.Builder(activity)
            .setTitle(if (changed) R.string.cert_title_changed else R.string.cert_title_new)
            .setMessage(if (changed) activity.getString(R.string.cert_changed_warning) + body else body)
            .setCancelable(false)
            .setPositiveButton(R.string.cert_accept) { _, _ ->
                config.trust(hostPort, fp)
                resolve(hostPort, true)
            }
            .setNegativeButton(R.string.cert_cancel) { _, _ -> resolve(hostPort, false) }
            .show()
    }

    private fun resolve(hostPort: String, ok: Boolean) {
        pending.remove(hostPort)?.forEach { if (ok) it.proceed() else it.cancel() }
        if (!ok) onRejected(activity.getString(R.string.cert_rejected))
    }

    private fun commonName(p: X500Principal): String {
        val name = p.getName(X500Principal.RFC2253)
        return Regex("(?:^|,)CN=([^,]+)").find(name)?.groupValues?.get(1) ?: name
    }
}
