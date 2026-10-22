package it.ranzaware.quetza

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import java.io.OutputStream
import java.util.concurrent.Executors

/**
 * Salva in Download/Quetza i file che la pagina genera (PDF, export .zip).
 * La WebView non sa scaricare i blob: la pagina li manda a pezzi in base64
 * (vedi quetza-shim.js) e qui vengono riscritti su disco, in ordine, su un
 * thread separato.
 */
class Downloads(private val context: Context) {

    private class Pending(val name: String, val uri: Uri, val out: OutputStream)

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val open = HashMap<String, Pending>() // usata solo dal thread io

    fun begin(id: String, name: String, mime: String) = io.execute {
        try {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, safeName(name))
                put(MediaStore.Downloads.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Quetza")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return@execute
            val out = resolver.openOutputStream(uri) ?: run { resolver.delete(uri, null, null); return@execute }
            open[id] = Pending(safeName(name), uri, out)
        } catch (_: Exception) {
        }
    }

    fun chunk(id: String, base64: String) = io.execute {
        val p = open[id] ?: return@execute
        try {
            p.out.write(Base64.decode(base64, Base64.DEFAULT))
        } catch (_: Exception) {
            discard(id)
        }
    }

    fun end(id: String, mime: String, onDone: (name: String, uri: Uri, mime: String) -> Unit, onError: () -> Unit) =
        io.execute {
            val p = open.remove(id)
            if (p == null) { main.post(onError); return@execute }
            try {
                p.out.close()
                context.contentResolver.update(
                    p.uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null,
                )
                main.post { onDone(p.name, p.uri, mime) }
            } catch (_: Exception) {
                context.contentResolver.delete(p.uri, null, null)
                main.post(onError)
            }
        }

    fun abort(id: String) = io.execute { discard(id) }

    private fun discard(id: String) {
        val p = open.remove(id) ?: return
        runCatching { p.out.close() }
        runCatching { context.contentResolver.delete(p.uri, null, null) }
    }

    private fun safeName(name: String): String =
        name.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1f]"), "_").trim().ifBlank { "quetza" }.take(120)
}
