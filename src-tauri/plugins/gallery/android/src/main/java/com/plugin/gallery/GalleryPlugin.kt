package com.plugin.gallery

import android.app.Activity
import android.content.ContentValues
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@InvokeArg
class SaveArgs {
  lateinit var dataUrl: String
  var name: String? = null
}

/** 把 base64 图片插入 MediaStore：系统相册 Pictures/Ziran，无需存储权限。 */
@TauriPlugin
class GalleryPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun saveToGallery(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SaveArgs::class.java)
      val b64 = args.dataUrl.substringAfter("base64,", "")
      if (b64.isEmpty()) {
        invoke.reject("图片不是 base64 数据")
        return
      }
      val bytes = Base64.decode(b64, Base64.DEFAULT)
      val mime = Regex("^data:([^;]+);").find(args.dataUrl)?.groupValues?.get(1) ?: "image/jpeg"
      val ext = when (mime) {
        "image/png" -> "png"
        "image/webp" -> "webp"
        "image/gif" -> "gif"
        else -> "jpg"
      }
      val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
      val name = args.name?.takeIf { it.isNotBlank() } ?: "ziran-$stamp.$ext"

      val values = ContentValues().apply {
        put(MediaStore.Images.Media.DISPLAY_NAME, name)
        put(MediaStore.Images.Media.MIME_TYPE, mime)
        put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Ziran")
        put(MediaStore.Images.Media.IS_PENDING, 1)
      }
      val resolver = activity.contentResolver
      val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
      if (uri == null) {
        invoke.reject("系统相册拒绝写入")
        return
      }
      resolver.openOutputStream(uri)?.use { it.write(bytes) }
        ?: run {
          invoke.reject("相册写入流打开失败")
          return
        }
      values.clear()
      values.put(MediaStore.Images.Media.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("保存到相册失败：${e.message}")
    }
  }
}
