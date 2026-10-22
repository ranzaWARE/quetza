package it.ranzaware.quetza

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

class MainActivity : ComponentActivity() {

    private lateinit var config: ServerConfig
    private lateinit var certs: CertTrust
    private lateinit var web: WebView
    private lateinit var overlay: View
    private lateinit var overlayText: TextView
    private lateinit var downloads: Downloads

    private lateinit var serverUrl: String
    private lateinit var shim: String
    private var shimAtDocumentStart = false
    private var mainFrameFailed = false
    private var recording = false

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingMic: PermissionRequest? = null

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val data = r.data
        val uris = when {
            r.resultCode != RESULT_OK || data == null -> null
            data.clipData != null -> Array(data.clipData!!.itemCount) { data.clipData!!.getItemAt(it).uri }
            data.data != null -> arrayOf(data.data!!)
            else -> null
        }
        fileCallback?.onReceiveValue(uris)
        fileCallback = null
    }

    private val askMic = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val req = pendingMic ?: return@registerForActivityResult
        pendingMic = null
        if (hasMic()) {
            req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        } else {
            req.deny()
            toast(getString(R.string.mic_denied))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        config = ServerConfig(this)
        serverUrl = config.serverUrl ?: run {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        val eink = config.isEink

        // Barre di sistema chiare su fondo chiaro, come il tema della PWA.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
        )
        setContentView(R.layout.activity_main)
        val root = findViewById<View>(R.id.root)
        web = findViewById(R.id.web)
        overlay = findViewById(R.id.overlay)
        overlayText = findViewById(R.id.overlay_text)
        downloads = Downloads(this)
        certs = CertTrust(this, config) { showOverlay(it) }

        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime(),
            )
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }

        findViewById<Button>(R.id.retry).setOnClickListener {
            hideOverlay()
            if (web.url == null) web.loadUrl(serverUrl) else web.reload()
        }
        findViewById<Button>(R.id.change_server).setOnClickListener {
            startActivity(Intent(this, SetupActivity::class.java))
        }

        if (eink) applyEinkTweaks(root)
        setupWebView(eink)

        onBackPressedDispatcher.addCallback(this) {
            when {
                web.canGoBack() -> web.goBack()
                // Uscire distruggerebbe la WebView e fermerebbe la registrazione.
                recording -> moveTaskToBack(true)
                else -> { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        }

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(serverUrl)
    }

    @SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
    private fun setupWebView(eink: Boolean) {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            // Lo zoom lo gestisce Quetza sul foglio: il pinch della WebView
            // ingrandirebbe anche la barra degli strumenti.
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = true
            userAgentString = "$userAgentString QuetzaAndroid/${BuildConfig.VERSION_NAME}"
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(web.settings, false)
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(web, true)
        }

        shim = "window.__quetzaEink=$eink;\n" + assets.open("quetza-shim.js").bufferedReader().use { it.readText() }
        val origins = setOf(config.origin)
        // Il ponte esiste solo per le pagine del server Quetza, non per il
        // provider SSO o qualunque altro sito aperto nella WebView.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "QuetzaAndroid", origins) { _, message, _, _, _ ->
                onBridgeMessage(message.data)
            }
        }
        shimAtDocumentStart = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (shimAtDocumentStart) WebViewCompat.addDocumentStartJavaScript(web, shim, origins)

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                return when (uri.scheme?.lowercase()) {
                    "http", "https", "about", "blob", "data" -> false
                    "mailto", "tel", "sms", "geo" -> { openExternal(Intent(Intent.ACTION_VIEW, uri)); true }
                    else -> true
                }
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                mainFrameFailed = false
                if (!shimAtDocumentStart && isOwnOrigin(url)) view.evaluateJavascript(shim, null)
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!mainFrameFailed) hideOverlay()
                CookieManager.getInstance().flush()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                mainFrameFailed = true
                showOverlay("$serverUrl\n${error.description}")
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                certs.handle(error, handler)
            }

            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                recreate()
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val wantsMic = PermissionRequest.RESOURCE_AUDIO_CAPTURE in request.resources
                if (!wantsMic || !isOwnOrigin(request.origin.toString())) { request.deny(); return }
                if (hasMic()) { request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)); return }
                pendingMic?.deny()
                pendingMic = request
                val perms = mutableListOf(Manifest.permission.RECORD_AUDIO)
                if (Build.VERSION.SDK_INT >= 33) perms += Manifest.permission.POST_NOTIFICATIONS
                askMic.launch(perms.toTypedArray())
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                try {
                    pickFiles.launch(fileIntent(params))
                } catch (_: ActivityNotFoundException) {
                    fileCallback = null
                    callback.onReceiveValue(null)
                }
                return true
            }
        }
    }

    /**
     * L'intent di default della WebView usa il primo "accept" così com'è: con
     * accept=".zip" chiederebbe il tipo MIME ".zip" e non mostrerebbe nulla.
     */
    private fun fileIntent(params: WebChromeClient.FileChooserParams): Intent {
        val mimes = params.acceptTypes.orEmpty()
            .flatMap { it.split(',') }
            .map { it.trim().lowercase() }
            .filter { it.isNotEmpty() }
            .mapNotNull { if (it.startsWith(".")) MimeTypeMap.getSingleton().getMimeTypeFromExtension(it.drop(1)) else it }
            .distinct()
        return Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimes.singleOrNull() ?: "*/*"
            if (mimes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, mimes.toTypedArray())
            if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
        }
    }

    private fun onBridgeMessage(json: String?) {
        val msg = runCatching { JSONObject(json ?: return) }.getOrNull() ?: return
        val id = msg.optString("id")
        when (msg.optString("t")) {
            "dl-begin" -> downloads.begin(id, msg.optString("name"), msg.optString("mime"))
            "dl-chunk" -> downloads.chunk(id, msg.optString("data"))
            "dl-end" -> downloads.end(id, msg.optString("mime"), ::onFileSaved) { toast(getString(R.string.file_error)) }
            "dl-fail" -> { downloads.abort(id); toast(getString(R.string.file_error)) }
            "dl-error" -> toast(getString(R.string.file_error))
            "rec" -> setRecording(msg.optBoolean("on"))
        }
    }

    private fun onFileSaved(name: String, uri: Uri, mime: String) {
        if (isFinishing) return
        val type = mime.ifBlank { contentResolver.getType(uri) ?: "application/octet-stream" }
        AlertDialog.Builder(this)
            .setMessage(getString(R.string.file_saved, name))
            .setPositiveButton(R.string.file_open) { _, _ ->
                openExternal(Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
            }
            .setNeutralButton(R.string.file_share) { _, _ ->
                val send = Intent(Intent.ACTION_SEND).setType(type)
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                openExternal(Intent.createChooser(send, name))
            }
            .setNegativeButton(android.R.string.ok, null)
            .show()
    }

    private fun setRecording(on: Boolean) {
        if (on == recording) return
        recording = on
        // Lo schermo che si spegne a metà riunione (sugli e-ink capita presto)
        // non deve interrompere niente.
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val service = Intent(this, RecordingService::class.java)
        if (on && hasMic()) {
            runCatching { ContextCompat.startForegroundService(this, service) }
        } else {
            stopService(service)
        }
    }

    private fun applyEinkTweaks(root: View) {
        // Ogni effetto animato su un pannello e-ink è una serie di refresh
        // parziali che lasciano scie: via bagliore di overscroll, barre di
        // scorrimento che sfumano e animazioni delle finestre.
        web.overScrollMode = View.OVER_SCROLL_NEVER
        web.isScrollbarFadingEnabled = false
        window.setWindowAnimations(0)
        root.setBackgroundColor(Color.WHITE)
        overlay.setBackgroundColor(Color.WHITE)
        window.decorView.setBackgroundColor(Color.WHITE)
    }

    private fun isOwnOrigin(url: String): Boolean =
        runCatching { ServerConfig.originOf(Uri.parse(url)) == config.origin }.getOrDefault(false)

    private fun hasMic() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun openExternal(intent: Intent) {
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            toast(getString(R.string.no_app))
        }
    }

    private fun showOverlay(text: String) {
        overlayText.text = text
        overlay.visibility = View.VISIBLE
    }

    private fun hideOverlay() {
        overlay.visibility = View.GONE
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::web.isInitialized) web.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        if (::web.isInitialized) {
            stopService(Intent(this, RecordingService::class.java))
            web.destroy()
        }
        super.onDestroy()
    }
}
