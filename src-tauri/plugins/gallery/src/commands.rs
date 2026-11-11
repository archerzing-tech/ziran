#[cfg(target_os = "android")]
use tauri::Manager;
#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;
use tauri::Runtime;

/// 前端调用：`invoke('plugin:gallery|save_to_gallery', { dataUrl, name? })`
/// `dataUrl` 必须是 base64 的 data URI；成功后图片出现在系统相册
/// Pictures/Ziran 目录下。
#[tauri::command]
pub(crate) async fn save_to_gallery<R: Runtime>(
    app: tauri::AppHandle<R>,
    data_url: String,
    name: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let Some(handle) = app.try_state::<PluginHandle<R>>() else {
            return Err("相册插件未就绪（Kotlin 侧注册失败）".into());
        };
        let args = serde_json::json!({ "dataUrl": data_url, "name": name });
        handle
            .run_mobile_plugin::<serde_json::Value>("saveToGallery", args)
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, data_url, name);
        Err("系统相册保存只在手机端可用".into())
    }
}
