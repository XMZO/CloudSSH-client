import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// 发布签名：gen/android/keystore.properties（不提交，格式见 README）。
// 缺省时 release 也用 debug 证书签名，方便个人直接安装。
val keystoreProps = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

// 安装包里的动态库与 dex 压缩存放（默认）：安装包约小一半，代价是安装时系统要解压出一份，占用空间多几 MB。
// 想要安装后占用最小（不压缩、系统直接映射）时用 node scripts/mobile.mjs build --uncompressed
// （即环境变量 CLOUDSSH_COMPRESS_APK=false，或 Gradle 属性 -Pcloudssh.compressApk=false）
val compressApk = ((findProperty("cloudssh.compressApk") as String?) ?: System.getenv("CLOUDSSH_COMPRESS_APK"))?.toBoolean() ?: true

android {
    compileSdk = 37
    namespace = "com.xmzo.cloudssh"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.xmzo.cloudssh"
        // Android 10+：写入“下载”走 MediaStore，无需存储权限
        minSdk = 29
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    androidResources {
        // 只保留中文与英文资源（依赖库自带的几十种语言翻译不打进包）
        localeFilters += listOf("zh", "en")
    }
    packaging {
        jniLibs {
            useLegacyPackaging = compressApk
        }
        dex {
            useLegacyPackaging = compressApk
        }
        resources {
            // Kotlin 反射元数据、依赖库许可证文本与调试探针运行时用不到
            excludes += setOf(
                "kotlin/**",
                "DebugProbesKt.bin",
                "META-INF/*.version",
                "META-INF/*.kotlin_module",
                "META-INF/**/LICENSE*",
                "META-INF/*LICENSE*",
                "META-INF/*NOTICE*",
                "META-INF/com.android.tools/**",
                "kotlin-tooling-metadata.json",
            )
        }
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
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            optimization {
               enable = true
            }
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // 用浏览器登录 GitHub（Custom Tab，支持 passkey）
    implementation("androidx.browser:browser:1.8.0")
}

// Tauri 的安卓库声明了 Material 组件，但它和本项目都没有任何代码或资源用到（主题用 AppCompat），
// 整个排除掉，省下它的大量资源与样式
configurations.configureEach {
    exclude(group = "com.google.android.material", module = "material")
}

apply(from = file("tauri.build.gradle.kts"))
