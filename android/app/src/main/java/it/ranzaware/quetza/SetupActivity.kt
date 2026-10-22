package it.ranzaware.quetza

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.RadioGroup
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity

/** Primo avvio (o "Cambia server"): indirizzo del server e modalità e-ink. */
class SetupActivity : ComponentActivity() {

    private lateinit var config: ServerConfig

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)
        config = ServerConfig(this)

        val url = findViewById<EditText>(R.id.url)
        val eink = findViewById<RadioGroup>(R.id.eink)
        val einkNote = findViewById<TextView>(R.id.eink_note)

        url.setText(config.serverUrl?.removeSuffix("/").orEmpty())
        if (config.isManaged) {
            url.isEnabled = false
            findViewById<View>(R.id.managed).visibility = View.VISIBLE
        }

        eink.check(
            when (config.einkMode) {
                "on" -> R.id.eink_on
                "off" -> R.id.eink_off
                else -> R.id.eink_auto
            },
        )
        if (config.isEinkModeManaged) for (i in 0 until eink.childCount) eink.getChildAt(i).isEnabled = false
        einkNote.setText(
            if (ServerConfig.isEinkDevice()) R.string.setup_eink_detected else R.string.setup_eink_not_detected,
        )

        val connect = { save(url.text.toString(), eink.checkedRadioButtonId) }
        findViewById<Button>(R.id.connect).setOnClickListener { connect() }
        url.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_GO) { connect(); true } else false
        }
        findViewById<Button>(R.id.forget).setOnClickListener {
            config.forgetCerts()
            Toast.makeText(this, R.string.setup_forgotten, Toast.LENGTH_LONG).show()
        }
    }

    private fun save(input: String, einkChoice: Int) {
        if (!config.isManaged) {
            val normalized = ServerConfig.normalize(input)
            if (normalized == null) {
                findViewById<EditText>(R.id.url).error = getString(R.string.setup_invalid)
                return
            }
            config.serverUrl = normalized
        }
        if (!config.isEinkModeManaged) {
            config.einkMode = when (einkChoice) {
                R.id.eink_on -> "on"
                R.id.eink_off -> "off"
                else -> "auto"
            }
        }
        // Riparte da zero: la WebView deve rileggere origine, script e tema.
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        )
        finish()
    }
}
