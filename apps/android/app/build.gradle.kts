import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 发布签名：apps/android/keystore.properties（不提交），格式见 README。
// 缺省时 release 也用 debug 证书签名，方便个人直接安装。
val keystoreProps = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.xmzo.cloudssh"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.xmzo.cloudssh"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // 默认实例地址：必须是 GitHub OAuth App 登记回调的域名（与桌面端 DEFAULT_WORKER_URL 一致）
        buildConfigField("String", "DEFAULT_WORKER_URL", "\"https://bash.al\"")
        // 只保留中文与英文资源（依赖库自带的几十种语言翻译不打进包）
        resourceConfigurations += listOf("zh", "en")
    }

    signingConfigs {
        if (keystoreProps.getProperty("storeFile") != null) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources {
            // Kotlin 反射元数据与调试探针运行时用不到
            excludes += setOf(
                "kotlin/**",
                "DebugProbesKt.bin",
                "META-INF/*.version",
                "META-INF/*.kotlin_module",
                "META-INF/com.android.tools/**",
                "kotlin-tooling-metadata.json",
            )
        }
    }

    // 不在 APK 里附带依赖清单（Play 商店才需要）
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
}

// 只依赖 androidx.webkit（多 Profile、document-start 注入、WebMessageListener）；
// Activity / insets 全部用框架 API，不引入 androidx.activity / lifecycle，release 包更小
dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    testImplementation("junit:junit:4.13.2")
}
