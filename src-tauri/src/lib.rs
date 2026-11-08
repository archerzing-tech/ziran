use std::fs;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 单张图片的下载上限：图库素材都在几百 KB 量级，64MB 足够宽裕；
/// 超过它说明 URL 有问题，不值得把内存填满。
const MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;

fn base64_encode(data: &[u8]) -> String {
  let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
  for chunk in data.chunks(3) {
    let b0 = chunk[0] as u32;
    let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
    let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
    let n = (b0 << 16) | (b1 << 8) | b2;
    out.push(B64[(n >> 18) as usize & 63] as char);
    out.push(B64[(n >> 12) as usize & 63] as char);
    out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
    out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
  }
  out
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
  let mut table = [255u8; 256];
  for (i, &c) in B64.iter().enumerate() {
    table[c as usize] = i as u8;
  }
  let mut out = Vec::with_capacity(s.len() / 4 * 3);
  let mut buf = 0u32;
  let mut bits = 0u32;
  for &c in s.as_bytes() {
    if c == b'=' {
      break;
    }
    let v = table[c as usize];
    if v == 255 {
      return Err(format!("invalid base64 character: {}", c as char));
    }
    buf = (buf << 6) | v as u32;
    bits += 6;
    if bits >= 8 {
      bits -= 8;
      out.push((buf >> bits) as u8);
    }
  }
  Ok(out)
}

fn mime_of(url: &str) -> &'static str {
  let path = url.split(['?', '#']).next().unwrap_or("");
  match path.rsplit('.').next() {
    Some("png") => "image/png",
    Some("webp") => "image/webp",
    Some("gif") => "image/gif",
    _ => "image/jpeg",
  }
}

/// Open (and initialize) the local gallery database.
/// Every reference image lives here as a blob so browsing works offline.
fn db_open(app: &tauri::AppHandle) -> Result<Connection, String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let conn = Connection::open(dir.join("gallery.db")).map_err(|e| e.to_string())?;
  conn
    .pragma_update(None, "journal_mode", "WAL")
    .map_err(|e| e.to_string())?;
  // 并发写入（可见缩略图 + 后台预取同时落库）默认会立刻报
  // database is locked；给个等待窗口让写锁排队而不是失败。
  conn
    .busy_timeout(Duration::from_secs(5))
    .map_err(|e| e.to_string())?;
  conn
    .execute_batch(
      "CREATE TABLE IF NOT EXISTS images (
         url     TEXT PRIMARY KEY,
         kind    TEXT NOT NULL DEFAULT 'adhoc',
         mime    TEXT NOT NULL,
         bytes   BLOB NOT NULL,
         size    INTEGER NOT NULL,
         created INTEGER NOT NULL
       );",
    )
    .map_err(|e| e.to_string())?;
  Ok(conn)
}

/// 共享的 ureq Agent：keep-alive 连接池。图库缩略图全部打同一个源站，
/// 复用 TLS 连接省掉每张图一次握手的 1~2 秒；一次性的 ureq::get
/// 每张图都要重新建连，是首屏慢的主因之一。
static AGENT: OnceLock<ureq::Agent> = OnceLock::new();

fn agent() -> &'static ureq::Agent {
  AGENT.get_or_init(|| {
    ureq::AgentBuilder::new()
      .max_idle_connections_per_host(8)
      .timeout_connect(Duration::from_secs(10))
      .build()
  })
}

/// 下载闸门：可见缩略图与后台预取共用，同一时刻最多 6 个在途请求。
/// 几十张卡同时发起会互相挤带宽、每个都变慢；限流反而整体更快，
/// 也避免源站把高并发当成异常流量。
struct Gate {
  max: usize,
  held: Mutex<usize>,
  cv: Condvar,
}

static DL_GATE: Gate = Gate {
  max: 6,
  held: Mutex::new(0),
  cv: Condvar::new(),
};

struct GatePermit;

impl Drop for GatePermit {
  fn drop(&mut self) {
    let mut held = DL_GATE.held.lock().unwrap();
    *held -= 1;
    DL_GATE.cv.notify_one();
  }
}

fn dl_permit() -> GatePermit {
  let mut held = DL_GATE.held.lock().unwrap();
  while *held >= DL_GATE.max {
    held = DL_GATE.cv.wait(held).unwrap();
  }
  *held += 1;
  GatePermit
}

fn download(url: &str) -> Result<Vec<u8>, String> {
  let _permit = dl_permit();
  let res = agent()
    .get(url)
    .timeout(Duration::from_secs(30))
    .call()
    .map_err(|e| e.to_string())?;
  let mut buf = Vec::new();
  res
    .into_reader()
    .take(MAX_DOWNLOAD_BYTES)
    .read_to_end(&mut buf)
    .map_err(|e| e.to_string())?;
  Ok(buf)
}

/// Return (mime, bytes) for `url`, downloading into the DB on first use.
fn fetch_into_db(app: &tauri::AppHandle, url: &str, kind: &str) -> Result<(String, Vec<u8>), String> {
  let cached = {
    let conn = db_open(app)?;
    let mut stmt = conn
      .prepare("SELECT mime, bytes FROM images WHERE url = ?1")
      .map_err(|e| e.to_string())?;
    stmt
      .query_row(rusqlite::params![url], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
      })
      .ok()
  };
  if let Some(hit) = cached {
    return Ok(hit);
  }
  let bytes = download(url)?;
  let mime = mime_of(url).to_string();
  let conn = db_open(app)?;
  conn
    .execute(
      "INSERT OR REPLACE INTO images (url, kind, mime, bytes, size, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      rusqlite::params![
        url,
        kind,
        mime,
        bytes,
        bytes.len() as i64,
        SystemTime::now()
          .duration_since(UNIX_EPOCH)
          .unwrap_or_default()
          .as_secs() as i64
      ],
    )
    .map_err(|e| e.to_string())?;
  Ok((mime, bytes))
}

/// Serve a gallery image as a data URI: read from the local DB, download on miss.
#[tauri::command]
async fn image_data_uri(app: tauri::AppHandle, url: String, kind: Option<String>) -> Result<String, String> {
  // 上传的图片本来就是 data: URI：原样交还，让前端本地解析
  if url.starts_with("data:image/") {
    return Ok(url);
  }
  if !url.starts_with("https://") && !url.starts_with("http://") {
    return Err("invalid url".into());
  }
  tauri::async_runtime::spawn_blocking(move || {
    let (mime, bytes) = fetch_into_db(&app, &url, kind.as_deref().unwrap_or("adhoc"))?;
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
  })
  .await
  .map_err(|e| e.to_string())?
}

#[derive(Default)]
struct PrefetchState {
  total: AtomicU32,
  done: AtomicU32,
  failed: AtomicU32,
  active: AtomicBool,
}

#[derive(Serialize)]
struct PrefetchStatus {
  total: u32,
  done: u32,
  failed: u32,
  active: bool,
}

/// Bulk-download a gallery's thumbnails into the DB in the background.
/// Returns how many images actually needed fetching (0 = already all local).
#[tauri::command]
fn prefetch_start(
  app: tauri::AppHandle,
  state: State<'_, Arc<PrefetchState>>,
  urls: Vec<String>,
  kind: String,
) -> Result<u32, String> {
  // 原子地「未运行 → 运行」：check-then-set 会放并发的第二次点击进来，
  // 两批 worker 互相覆盖计数器
  if state
    .active
    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
    .is_err()
  {
    return Err("已有本地化任务在进行".into());
  }
  let valid: Vec<String> = urls
    .into_iter()
    .filter(|u| u.starts_with("https://") || u.starts_with("http://"))
    .collect();
  let have: std::collections::HashSet<String> = {
    let conn = db_open(&app)?;
    let mut stmt = conn.prepare("SELECT url FROM images").map_err(|e| e.to_string())?;
    let rows = stmt
      .query_map([], |r| r.get::<_, String>(0))
      .map_err(|e| e.to_string())?;
    rows.filter_map(Result::ok).collect()
  };
  let missing: Vec<String> = valid.into_iter().filter(|u| !have.contains(u)).collect();
  let total = missing.len() as u32;
  state.total.store(total, Ordering::SeqCst);
  state.done.store(0, Ordering::SeqCst);
  state.failed.store(0, Ordering::SeqCst);
  if total == 0 {
    state.active.store(false, Ordering::SeqCst);
    return Ok(0);
  }

  let st = Arc::clone(&*state);
  std::thread::spawn(move || {
    let workers = 6usize;
    let mut handles = Vec::new();
    for chunk in missing.chunks(missing.len().div_ceil(workers)) {
      let app = app.clone();
      let chunk = chunk.to_vec();
      let kind = kind.clone();
      let st = Arc::clone(&st);
      handles.push(std::thread::spawn(move || {
        for url in chunk {
          if fetch_into_db(&app, &url, &kind).is_ok() {
            st.done.fetch_add(1, Ordering::SeqCst);
          } else {
            st.failed.fetch_add(1, Ordering::SeqCst);
            st.done.fetch_add(1, Ordering::SeqCst);
          }
        }
      }));
    }
    for h in handles {
      let _ = h.join();
    }
    st.active.store(false, Ordering::SeqCst);
  });
  Ok(total)
}

#[tauri::command]
fn prefetch_status(state: State<'_, Arc<PrefetchState>>) -> PrefetchStatus {
  PrefetchStatus {
    total: state.total.load(Ordering::SeqCst),
    done: state.done.load(Ordering::SeqCst),
    failed: state.failed.load(Ordering::SeqCst),
    active: state.active.load(Ordering::SeqCst),
  }
}

/// 用户可编辑的配置文件白名单（放在应用数据目录，避免任意路径写入）
const CONFIG_FILES: &[&str] = &["providers.json"];

fn config_file_guard(name: &str) -> Result<(), String> {
  if !CONFIG_FILES.contains(&name) {
    return Err("unsupported config file".into());
  }
  Ok(())
}

/// 配置文件的完整路径（前端显示与打开用）
#[tauri::command]
fn config_file_path(app: tauri::AppHandle, name: String) -> Result<String, String> {
  config_file_guard(&name)?;
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  Ok(dir.join(&name).to_string_lossy().into_owned())
}

/// 读取配置文件；不存在返回 None（由前端决定是否写入默认内容）
#[tauri::command]
fn read_config_file(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
  config_file_guard(&name)?;
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  let path = dir.join(&name);
  if !path.exists() {
    return Ok(None);
  }
  fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_config_file(app: tauri::AppHandle, name: String, contents: String) -> Result<(), String> {
  config_file_guard(&name)?;
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  fs::write(dir.join(&name), contents).map_err(|e| e.to_string())
}

/// 用系统默认的纯文本编辑器打开配置文件。
/// 「在 Finder 里打开文件夹」的两个问题：窗口藏在应用后面（用户以为
/// 点了没反应），文件夹里未必有要编辑的文件；直接打开文件本身两个都解决。
#[tauri::command]
fn edit_config_file(app: tauri::AppHandle, name: String) -> Result<(), String> {
  config_file_guard(&name)?;
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  let path = dir.join(&name);
  if !path.exists() {
    return Err("config file does not exist".into());
  }
  #[cfg(target_os = "macos")]
  {
    std::process::Command::new("open").arg("-t").arg(&path).spawn().map_err(|e| e.to_string())?;
  }
  #[cfg(target_os = "windows")]
  {
    std::process::Command::new("notepad").arg(&path).spawn().map_err(|e| e.to_string())?;
  }
  #[cfg(target_os = "linux")]
  {
    std::process::Command::new("xdg-open").arg(&path).spawn().map_err(|e| e.to_string())?;
  }
  Ok(())
}

/// 把成图写进用户在系统保存对话框里选的路径。
/// webview 对 <a download> 的支持不可靠（WKWebView 经常把它当导航处理），
/// 所以落盘交给 Rust：前端解出 data: URI，这里校验扩展名白名单后写文件。
#[tauri::command]
fn save_result_image(path: String, data_url: String) -> Result<String, String> {
  let rest = data_url
    .strip_prefix("data:image/")
    .ok_or("not an image data url")?;
  let (mime, b64) = rest
    .split_once(";base64,")
    .ok_or("data url has no base64 payload")?;
  let ext = match mime {
    "png" => "png",
    "jpeg" => "jpg",
    "webp" => "webp",
    "gif" => "gif",
    other => return Err(format!("unsupported image type: {other}")),
  };
  if !path.to_lowercase().ends_with(&format!(".{ext}")) {
    return Err(format!("保存文件名需要以 .{ext} 结尾（图片实际是 {mime} 格式）"));
  }
  let bytes = base64_decode(b64)?;
  if bytes.is_empty() {
    return Err("image payload is empty".into());
  }
  fs::write(&path, &bytes).map_err(|e| format!("写入失败：{e}"))?;
  Ok(path)
}

/// 供应商 API 请求代理。webview 里的 fetch 过不了 CORS：有的服务
/// （如火山方舟）只在 OPTIONS 预检里回 access-control-allow-origin，
/// 实际响应不带，浏览器按规范把整个响应扔掉——表面就是一句
/// "Load failed"，连 API 的报错原文都看不到。原生侧没有 CORS，
/// 错误响应也能原样带回（status + body text）。
#[derive(Deserialize)]
struct ProviderFilePart {
  name: String,
  filename: String,
  mime: String,
  /// base64（不带 data: 前缀）
  data: String,
}

#[derive(Deserialize)]
struct ProviderRequest {
  url: String,
  #[serde(default)]
  headers: std::collections::HashMap<String, String>,
  /// JSON 字符串体（与 multipart 二选一）
  #[serde(default)]
  json_body: Option<String>,
  #[serde(default)]
  form_fields: Vec<(String, String)>,
  #[serde(default)]
  form_files: Vec<ProviderFilePart>,
}

#[derive(Serialize)]
struct ProviderResponse {
  status: u16,
  text: String,
}

fn build_multipart(
  fields: &[(String, String)],
  files: &[ProviderFilePart],
) -> Result<(String, Vec<u8>), String> {
  let boundary = format!(
    "ziranboundary{}",
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap_or_default()
      .as_nanos()
  );
  let mut body: Vec<u8> = Vec::new();
  for (k, v) in fields {
    body.extend_from_slice(
      format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n")
        .as_bytes(),
    );
  }
  for f in files {
    let bytes = base64_decode(&f.data)?;
    body.extend_from_slice(
      format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
        f.name, f.filename, f.mime
      )
      .as_bytes(),
    );
    body.extend_from_slice(&bytes);
    body.extend_from_slice(b"\r\n");
  }
  body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
  Ok((format!("multipart/form-data; boundary={boundary}"), body))
}

/// 发请求并读回响应体。非 2xx 不当作错误：把 status + body 原样带回，
/// API 的报错原文（"invalid api key" 之类）不能被吞成一句状态码。
fn send_and_read(req: ureq::Request, body: Vec<u8>) -> Result<ProviderResponse, String> {
  let res = match req.send_bytes(&body) {
    Ok(r) => r,
    Err(ureq::Error::Status(_, r)) => r,
    Err(e) => return Err(e.to_string()),
  };
  let status = res.status();
  let mut bytes = Vec::new();
  res
    .into_reader()
    .take(MAX_DOWNLOAD_BYTES)
    .read_to_end(&mut bytes)
    .map_err(|e| e.to_string())?;
  Ok(ProviderResponse {
    status,
    text: String::from_utf8_lossy(&bytes).into_owned(),
  })
}

#[tauri::command]
async fn provider_fetch(request: ProviderRequest) -> Result<ProviderResponse, String> {
  if !request.url.starts_with("https://") {
    return Err("only https urls are allowed".into());
  }
  tauri::async_runtime::spawn_blocking(move || {
    let has_multipart = !request.form_fields.is_empty() || !request.form_files.is_empty();
    let mut req = agent().post(&request.url);
    if has_multipart {
      let (content_type, body) = build_multipart(&request.form_fields, &request.form_files)?;
      req = req.set("Content-Type", &content_type);
      for (k, v) in &request.headers {
        req = req.set(k, v);
      }
      send_and_read(req, body)
    } else {
      for (k, v) in &request.headers {
        req = req.set(k, v);
      }
      send_and_read(req, request.json_body.unwrap_or_default().into_bytes())
    }
  })
  .await
  .map_err(|e| e.to_string())?
}

/// 在系统文件管理器里打开配置目录
#[tauri::command]
fn open_config_dir(app: tauri::AppHandle) -> Result<(), String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  #[cfg(target_os = "macos")]
  {
    std::process::Command::new("open")
      .arg(&dir)
      .spawn()
      .map_err(|e| e.to_string())?;
  }
  #[cfg(target_os = "windows")]
  {
    std::process::Command::new("explorer")
      .arg(&dir)
      .spawn()
      .map_err(|e| e.to_string())?;
  }
  #[cfg(target_os = "linux")]
  {
    std::process::Command::new("xdg-open")
      .arg(&dir)
      .spawn()
      .map_err(|e| e.to_string())?;
  }
  Ok(())
}

/// Open a URL in the default system browser (API key application pages).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
  if !url.starts_with("https://") && !url.starts_with("http://") {
    return Err("invalid url".into());
  }
  #[cfg(target_os = "macos")]
  {
    std::process::Command::new("open")
      .arg(&url)
      .spawn()
      .map_err(|e| e.to_string())?;
  }
  #[cfg(target_os = "windows")]
  {
    std::process::Command::new("cmd")
      .args(["/C", "start", "", &url])
      .spawn()
      .map_err(|e| e.to_string())?;
  }
  #[cfg(target_os = "linux")]
  {
    std::process::Command::new("xdg-open")
      .arg(&url)
      .spawn()
      .map_err(|e| e.to_string())?;
  }
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      // the old file-based cache is superseded by the SQLite store
      let _ = fs::remove_dir_all(app.path().app_cache_dir()?.join("gallery"));
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      app.manage(Arc::new(PrefetchState::default()));
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      image_data_uri,
      prefetch_start,
      prefetch_status,
      open_url,
      config_file_path,
      read_config_file,
      write_config_file,
      edit_config_file,
      open_config_dir,
      save_result_image,
      provider_fetch
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn base64_vectors() {
    assert_eq!(base64_encode(b""), "");
    assert_eq!(base64_encode(b"f"), "Zg==");
    assert_eq!(base64_encode(b"fo"), "Zm8=");
    assert_eq!(base64_encode(b"foo"), "Zm9v");
    assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
    assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
    assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
  }

  #[test]
  fn base64_roundtrip_and_reject() {
    let data: Vec<u8> = (0..=255u8).collect();
    let decoded = base64_decode(&base64_encode(&data)).unwrap();
    assert_eq!(decoded, data);
    // 带 padding 的独立解码也要正确
    assert_eq!(base64_decode("Zm9vYmFy").unwrap(), b"foobar");
    assert_eq!(base64_decode("Zg==").unwrap(), b"f");
    assert!(base64_decode("a!c=").is_err());
  }

  #[test]
  fn build_multipart_fields_and_files() {
    let fields = vec![("model".to_string(), "gpt-image-1".to_string())];
    let files = vec![ProviderFilePart {
      name: "image[]".into(),
      filename: "ref.png".into(),
      mime: "image/png".into(),
      // "hi" 的 base64
      data: "aGk=".into(),
    }];
    let (content_type, body) = build_multipart(&fields, &files).unwrap();
    assert!(content_type.starts_with("multipart/form-data; boundary=ziranboundary"));
    let boundary = content_type.rsplit('=').next().unwrap();
    let text = String::from_utf8(body).unwrap();
    assert!(text.contains(&format!("--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\ngpt-image-1\r\n")));
    assert!(text.contains("name=\"image[]\"; filename=\"ref.png\"\r\nContent-Type: image/png\r\n\r\nhi\r\n"));
    assert!(text.ends_with(&format!("--{boundary}--\r\n")));
    // 坏 base64 要报错而不是 panic
    assert!(build_multipart(&fields, &[ProviderFilePart {
      name: "image[]".into(),
      filename: "ref.png".into(),
      mime: "image/png".into(),
      data: "!!".into(),
    }])
    .is_err());
  }

  #[test]
  fn save_result_image_guard_rails() {
    let png = format!("data:image/png;base64,{}", base64_encode(b"png-bytes"));
    // 错扩展名 → 拒绝且不落盘
    let err = save_result_image("/tmp/x.jpg".into(), png.clone()).err().unwrap();
    assert!(err.contains(".png"));
    // 非 image/ 开头的 data url → 拒绝
    let err = save_result_image("/tmp/x.png".into(), "data:text/plain;base64,AA".into()).err().unwrap();
    assert!(err.contains("not an image"));
    // 类型白名单（svg 不在列）
    let err = save_result_image("/tmp/x.png".into(), "data:image/svg+xml;base64,AA".into()).err().unwrap();
    assert!(err.contains("unsupported"));
    // 真实落盘：系统临时目录
    let path = std::env::temp_dir().join("ziran-test-save.png");
    let ok = save_result_image(path.to_string_lossy().into_owned(), png).unwrap();
    assert_eq!(ok, path.to_string_lossy());
    assert_eq!(std::fs::read(&path).unwrap(), b"png-bytes");
    let _ = std::fs::remove_file(&path);
  }

  #[test]
  fn db_blob_roundtrip() {
    let conn = Connection::open_in_memory().unwrap();
    conn
      .execute_batch(
        "CREATE TABLE images (
           url TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'adhoc',
           mime TEXT NOT NULL, bytes BLOB NOT NULL,
           size INTEGER NOT NULL, created INTEGER NOT NULL);",
      )
      .unwrap();
    conn
      .execute(
        "INSERT OR REPLACE INTO images (url, kind, mime, bytes, size, created) VALUES (?1,?2,?3,?4,?5,?6)",
        rusqlite::params!["https://x/y.webp", "pose", "image/webp", vec![1u8, 2, 3], 3i64, 0i64],
      )
      .unwrap();
    let (mime, bytes): (String, Vec<u8>) = conn
      .query_row(
        "SELECT mime, bytes FROM images WHERE url = ?1",
        rusqlite::params!["https://x/y.webp"],
        |r| Ok((r.get(0)?, r.get(1)?)),
      )
      .unwrap();
    assert_eq!(mime, "image/webp");
    assert_eq!(bytes, vec![1, 2, 3]);
  }

  /// 真实网络对比：一次性连接 vs 连接池 + 闸门并发。
  /// 本地手跑：cargo test bench_thumb_download -- --ignored --nocapture
  #[test]
  #[ignore]
  fn bench_thumb_download() {
    let urls: Vec<String> = [
      "f71f980dde3", "f009cba9893", "f06fe4f6b36", "f15a069b8a3", "f29201630d2", "f3ef523a678",
    ]
    .iter()
    .map(|c| format!("https://ai-pose-gallery.anhao.app/thumbs/portrait/{c}.webp"))
    .collect();
    let t = std::time::Instant::now();
    let ok_serial = urls.iter().filter(|u| download(u).is_ok()).count();
    let serial = t.elapsed();
    let t = std::time::Instant::now();
    let handles: Vec<_> = urls
      .iter()
      .map(|u| {
        let u = u.clone();
        std::thread::spawn(move || download(&u).is_ok())
      })
      .collect();
    let ok_pooled = handles.into_iter().map(|h| h.join().unwrap()).filter(|ok| *ok).count();
    let pooled = t.elapsed();
    println!("serial  (one-shot ×6): {serial:?} ok={ok_serial}");
    println!("parallel (agent+gate): {pooled:?} ok={ok_pooled}");
  }
}
