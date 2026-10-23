import javax.inject.Inject
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Firma della release: il keystore arriva dall'ambiente (GitHub Actions o
// macchina di chi pubblica), mai dal repository. Senza, si costruisce solo
// la debug.
val keystorePath: String? = System.getenv("QUETZA_KEYSTORE")

android {
    namespace = "it.ranzaware.quetza"
    compileSdk = 35

    defaultConfig {
        applicationId = "it.ranzaware.quetza"
        minSdk = 29
        targetSdk = 35
        versionCode = (System.getenv("QUETZA_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("QUETZA_VERSION_NAME") ?: "1.0.0"
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("QUETZA_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("QUETZA_KEY_ALIAS")
                keyPassword = System.getenv("QUETZA_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keystorePath != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// L'interfaccia è quella del server (backend/public), copiata nell'APK:
// l'app funziona senza rete e senza server, con le note sul dispositivo.
// Le pagine che servono solo sul server restano fuori.
abstract class CopyWebUi : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val source: DirectoryProperty

    @get:OutputDirectory
    abstract val output: DirectoryProperty

    @get:Inject
    abstract val fs: FileSystemOperations

    @TaskAction
    fun copy() {
        fs.sync {
            from(source)
            into(output.dir("web"))
            exclude("admin.html", "login.html", "collega.html", "share.html", "sw.js")
        }
    }
}

val copyWebUi = tasks.register<CopyWebUi>("copyWebUi") {
    source.set(rootProject.layout.projectDirectory.dir("../backend/public"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyWebUi, CopyWebUi::output)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.webkit:webkit:1.13.0")
}
