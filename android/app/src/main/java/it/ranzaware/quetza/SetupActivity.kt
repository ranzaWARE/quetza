package it.ranzaware.quetza

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.RadioGroup
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity

/**
 * Impostazioni dell'app (tieni premuta l'icona › Impostazioni): modalità
 * e-ink e certificati accettati. Il server si collega dall'app stessa.
 */
class SetupActivity : ComponentActivity() {

    private lateinit var config: ServerConfig

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)
        config = ServerConfig(this)

        val eink = findViewById<RadioGroup>(R.id.eink)
        val einkNote = findViewById<TextView>(R.id.eink_note)

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

        findViewById<Button>(R.id.connect).setOnClickListener { save(eink.checkedRadioButtonId) }
        findViewById<Button>(R.id.forget).setOnClickListener {
            config.forgetCerts()
            Toast.makeText(this, R.string.setup_forgotten, Toast.LENGTH_LONG).show()
        }
    }

    private fun save(einkChoice: Int) {
        if (!config.isEinkModeManaged) {
            config.einkMode = when (einkChoice) {
                R.id.eink_on -> "on"
                R.id.eink_off -> "off"
                else -> "auto"
            }
        }
        // Riparte da zero: la WebView deve rileggere script e tema.
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        )
        finish()
    }
}
