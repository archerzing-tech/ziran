//! 应用内插件：手机端把成图写进 Android 系统相册。
//!
//! 走 MediaStore（Android 10+ 的正规相册入口，minSdk 29 全覆盖），
//! 不需要存储权限；文件落到 Pictures/Ziran，相册/图库应用立即可见。
//! 桌面端不注册 Kotlin 侧，命令返回错误由前端走对话框路径兜底。

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};
#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.plugin.gallery";

/// 供 `.plugin(tauri_plugin_gallery::init())` 使用。
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("gallery")
        .invoke_handler(tauri::generate_handler!(commands::save_to_gallery))
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin(PLUGIN_IDENTIFIER, "GalleryPlugin")?;
                app.manage(handle);
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (app, api);
            }
            Ok(())
        })
        .build()
}

mod commands;
