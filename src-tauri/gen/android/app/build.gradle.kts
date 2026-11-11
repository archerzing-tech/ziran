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

android {
    compileSdk = 37
    namespace = "com.ziran.app"

    // Kotlin DSL 按脚本顺序执行：签名配置必须先于 buildTypes 里
    // 的 getByName("release") 引用出现，否则 not found。
    signingConfigs {
        create("release") {
            // 自签名：keystore / 密码 / 别名来自环境变量，不进仓库。
            // 本地开发设同样的三个变量即可复用同一把签名。
            val ksPath = System.getenv("TAURI_ANDROID_KEYSTORE_PATH") ?: ""
            val ksPass = System.getenv("TAURI_ANDROID_KEYSTORE_PASSWORD") ?: ""
            val ksAlias = System.getenv("TAURI_ANDROID_KEY_ALIAS") ?: ""
            if (ksPath.isNotBlank() && ksPass.isNotBlank() && ksAlias.isNotBlank()) {
                storeFile = file(ksPath)
                storePassword = ksPass
                keyAlias = ksAlias
                keyPassword = ksPass
            }
        }
    }

    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.ziran.app"
        // Android 10（API 29）起：用户要求支持的最低版本
        minSdk = 29
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
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
            // 构建机上注入了 keystore 三变量就走自签名；没有则保持默认
            // （本地 debug 构建不受影响）
            val ksPath = System.getenv("TAURI_ANDROID_KEYSTORE_PATH") ?: ""
            if (ksPath.isNotBlank() && file(ksPath).exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
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
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
