use std::fs;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
       );
       CREATE TABLE IF NOT EXISTS history (
         id       INTEGER PRIMARY KEY AUTOINCREMENT,
         created  INTEGER NOT NULL,
         provider TEXT NOT NULL DEFAULT '',
         model    TEXT NOT NULL DEFAULT '',
         file     TEXT NOT NULL,
         thumb    TEXT NOT NULL DEFAULT '',
         size     INTEGER NOT NULL,
         prompt   TEXT NOT NULL DEFAULT '',
         ws       INTEGER NOT NULL DEFAULT 1
       );
       CREATE TABLE IF NOT EXISTS templates (
         id       INTEGER PRIMARY KEY AUTOINCREMENT,
         created  INTEGER NOT NULL,
         provider TEXT NOT NULL DEFAULT '',
         model    TEXT NOT NULL DEFAULT '',
         prompt   TEXT NOT NULL DEFAULT '',
         file     TEXT NOT NULL,
         thumb    TEXT NOT NULL DEFAULT '',
         size     INTEGER NOT NULL,
         hash     TEXT NOT NULL DEFAULT ''
       );",
    )
    .map_err(|e| e.to_string())?;
  // 旧库补列：history 早期没有 prompt 字段，「从历史图存为模板」要带上
  // 当时的描述；补不上也不拦启动（列保持默认空串，功能降级为不带提示词）。
  let has_prompt: Result<i64, _> = conn
    .query_row("SELECT COUNT(*) FROM pragma_table_info('history') WHERE name = 'prompt'", [], |r| r.get(0));
  if matches!(has_prompt, Ok(0)) {
    let _ = conn.execute("ALTER TABLE history ADD COLUMN prompt TEXT NOT NULL DEFAULT ''", []);
  }
  // 旧库补列：工作区标记（哪个工作区生成的）。老记录归入工作区 1。
  let has_ws: Result<i64, _> = conn
    .query_row("SELECT COUNT(*) FROM pragma_table_info('history') WHERE name = 'ws'", [], |r| r.get(0));
  if matches!(has_ws, Ok(0)) {
    let _ = conn.execute("ALTER TABLE history ADD COLUMN ws INTEGER NOT NULL DEFAULT 1", []);
  }
  // 旧库补列：模板按图片字节哈希去重。老记录 hash 为空串，不会被误判成重复。
  let has_hash: Result<i64, _> = conn
    .query_row("SELECT COUNT(*) FROM pragma_table_info('templates') WHERE name = 'hash'", [], |r| r.get(0));
  if matches!(has_hash, Ok(0)) {
    let _ = conn.execute("ALTER TABLE templates ADD COLUMN hash TEXT NOT NULL DEFAULT ''", []);
  }
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

/// 错误日志：前端把生成失败、连通性测试结果等关键事件追加到应用数据目录的
/// ziran.log，方便事后排查「当时为什么没出图」。Key、请求头一律不入日志
/// （由前端脱敏，这里只管追加与轮转）；日志本身留在用户自己的机器上。
const LOG_FILE: &str = "ziran.log";
/// 单文件上限：512KB 足够存几千条事件，超过就轮转，防止无限生长
const LOG_MAX_BYTES: u64 = 512 * 1024;

#[tauri::command]
fn append_log(app: tauri::AppHandle, line: String) -> Result<(), String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  append_log_line(&dir, &line)
}

/// 在系统文本编辑器里打开错误日志（没有就先建一个空文件）。
#[tauri::command]
fn open_log_file(app: tauri::AppHandle) -> Result<(), String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let path = dir.join(LOG_FILE);
  if !path.exists() {
    fs::write(&path, "").map_err(|e| e.to_string())?;
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

/// 追加一行日志；超过上限就轮转成 ziran.log.1（只留一代，再超就覆盖），
/// 保证日志不会无限生长。拆成纯函数便于对轮转逻辑做单元测试。
fn append_log_line(dir: &std::path::Path, line: &str) -> Result<(), String> {
  fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  let path = dir.join(LOG_FILE);
  if let Ok(meta) = fs::metadata(&path) {
    if meta.len() > LOG_MAX_BYTES {
      let rotated = dir.join(format!("{LOG_FILE}.1"));
      let _ = fs::remove_file(&rotated);
      fs::rename(&path, &rotated).map_err(|e| e.to_string())?;
    }
  }
  use std::io::Write;
  let mut f = fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&path)
    .map_err(|e| e.to_string())?;
  writeln!(f, "{line}").map_err(|e| e.to_string())
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

/// 生成历史：每次成功的成图落一份到应用数据目录 history/，
/// 元数据（provider/model/文件名/缩略图名）进 gallery.db 的 history 表，
/// 上限 HISTORY_KEEP 张，超出时连行带文件一起裁掉最旧的。
/// 前端用 history_list/history_thumb 画切换条，history_image 取原图查看。
const HISTORY_KEEP: i64 = 50;

#[derive(Serialize)]
struct HistoryEntry {
  id: i64,
  created: i64,
  provider: String,
  model: String,
  #[serde(default)]
  prompt: String,
  size: i64,
  #[serde(default)]
  ws: i64,
}

fn history_ext(mime: &str) -> Result<&'static str, String> {
  match mime {
    "png" => Ok("png"),
    "jpeg" => Ok("jpg"),
    "webp" => Ok("webp"),
    "gif" => Ok("gif"),
    other => Err(format!("unsupported image type: {other}")),
  }
}

/// 96px JPEG 缩略图。个别格式解不开时返回 None（列表退化为直接用原图）。
fn make_thumb(bytes: &[u8]) -> Option<Vec<u8>> {
  let img = image::load_from_memory(bytes).ok()?;
  let rgb = img.thumbnail(96, 96).to_rgb8();
  let mut out = Vec::new();
  image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80)
    .encode_image(&rgb)
    .ok()?;
  Some(out)
}

fn clip_meta(s: &str) -> String {
  s.trim().chars().take(120).collect()
}

/// 解析 `data:image/<type>;base64,…` 成 (原始字节, 扩展名)。
/// 历史归档与「存为模板」共用同一套格式白名单，坏数据在这里统一报错。
fn decode_image_data_url(data_url: &str) -> Result<(Vec<u8>, &'static str), String> {
  let rest = data_url
    .strip_prefix("data:image/")
    .ok_or("not an image data url")?;
  let (mime, b64) = rest
    .split_once(";base64,")
    .ok_or("data url has no base64 payload")?;
  let ext = history_ext(mime)?;
  let bytes = base64_decode(b64)?;
  if bytes.is_empty() {
    return Err("image payload is empty".into());
  }
  Ok((bytes, ext))
}

/// 把一张成图写进库目录（history/ 或 templates/）：原图 + 96px 缩略图。
/// 返回 (文件名, 缩略图名, 字节数)；缩略图生成失败降级为空名（查看时
/// 退回原图，只慢不坏）。
fn write_vault_image(vault: &std::path::Path, data_url: &str) -> Result<(String, String, i64), String> {
  let (bytes, ext) = decode_image_data_url(data_url)?;
  write_vault_image_bytes(vault, &bytes, ext)
}

/// 同上，但调用方已解码好字节（模板去重要先算哈希，避免重复解码）。
fn write_vault_image_bytes(vault: &std::path::Path, bytes: &[u8], ext: &str) -> Result<(String, String, i64), String> {
  fs::create_dir_all(vault).map_err(|e| format!("写入库目录失败：{e}"))?;
  let now = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default();
  let name = format!("ziran-{}-{}.{ext}", now.as_secs(), now.subsec_nanos());
  fs::write(vault.join(&name), bytes).map_err(|e| format!("写入历史失败：{e}"))?;
  let thumb_name = make_thumb(bytes)
    .map(|t| {
      let tname = format!("{name}.thumb.jpg");
      match fs::write(vault.join(&tname), &t) {
        Ok(_) => tname,
        Err(_) => String::new(),
      }
    })
    .unwrap_or_default();
  Ok((name, thumb_name, bytes.len() as i64))
}

/// 归档图（历史/模板）按 id 取文件名：两个库共用同一条 SQL，
/// 只是表名与报错文案不同。thumb_only=true 时先取缩略图列，缺了退回原图。
fn vault_file_of(
  app: &tauri::AppHandle,
  table: &str,
  label: &str,
  id: i64,
  thumb_only: bool,
) -> Result<String, String> {
  let conn = db_open(app)?;
  let sql = if thumb_only {
    format!("SELECT CASE WHEN thumb = '' THEN file ELSE thumb END FROM {table} WHERE id = ?1")
  } else {
    format!("SELECT file FROM {table} WHERE id = ?1")
  };
  let name: String = conn
    .query_row(&sql, [id], |r| r.get(0))
    .map_err(|e| format!("{label} #{id} 不存在：{e}"))?;
  Ok(name)
}

fn read_vault_file(app: &tauri::AppHandle, vault: &str, name: &str) -> Result<(Vec<u8>, &'static str), String> {
  // 文件名由本程序生成（ziran-<secs>-<nanos>.<ext> / .thumb.jpg），
  // 只接受纯文件名，防止 path traversal。
  if name.contains('/') || name.contains('\\') || name.contains("..") {
    return Err("bad history file name".into());
  }
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  let bytes = fs::read(dir.join(vault).join(name)).map_err(|e| format!("读取历史文件失败：{e}"))?;
  let mime = match name.rsplit('.').next() {
    Some("png") => "image/png",
    Some("webp") => "image/webp",
    Some("gif") => "image/gif",
    _ => "image/jpeg",
  };
  Ok((bytes, mime))
}

fn prune_history(conn: &Connection, dir: &std::path::Path) {
  // 找到第 HISTORY_KEEP 条之后的行，逐行删文件再删行。失败静默——
  // 裁剪只是回收空间，不该打断保存。
  let cutoff: Option<i64> = conn
    .query_row(
      "SELECT id FROM history ORDER BY id DESC LIMIT 1 OFFSET ?1",
      [HISTORY_KEEP],
      |r| r.get(0),
    )
    .ok();
  let Some(cutoff) = cutoff else { return };
  let stale: Vec<(i64, String, String)> = conn
    .prepare("SELECT id, file, thumb FROM history WHERE id <= ?1")
    .and_then(|mut s| {
      s.query_map([cutoff], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
      })?
      .collect()
    })
    .unwrap_or_default();
  for (_, file, thumb) in stale {
    for name in [file, thumb] {
      if !name.is_empty() {
        let _ = fs::remove_file(dir.join(&name));
      }
    }
  }
  let _ = conn.execute("DELETE FROM history WHERE id <= ?1", [cutoff]);
}

#[tauri::command]
fn history_add(
  app: tauri::AppHandle,
  data_url: String,
  provider: String,
  model: String,
  prompt: Option<String>,
  ws: Option<i64>,
) -> Result<HistoryEntry, String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  let hdir = dir.join("history");
  let (name, thumb_name, size) = write_vault_image(&hdir, &data_url)?;
  let now = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default();
  let conn = db_open(&app)?;
  let ws = ws.unwrap_or(1);
  conn
    .execute(
      "INSERT INTO history (created, provider, model, prompt, file, thumb, size, ws) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
      rusqlite::params![
        now.as_secs() as i64,
        clip_meta(&provider),
        clip_meta(&model),
        clip_meta(prompt.as_deref().unwrap_or("")),
        name,
        thumb_name,
        size,
        ws
      ],
    )
    .map_err(|e| e.to_string())?;
  let id = conn.last_insert_rowid();
  prune_history(&conn, &hdir);
  Ok(HistoryEntry {
    id,
    created: now.as_secs() as i64,
    provider: clip_meta(&provider),
    model: clip_meta(&model),
    prompt: clip_meta(prompt.as_deref().unwrap_or("")),
    size,
    ws,
  })
}

#[tauri::command]
fn history_list(app: tauri::AppHandle) -> Result<Vec<HistoryEntry>, String> {
  let conn = db_open(&app)?;
  let mut stmt = conn
    .prepare("SELECT id, created, provider, model, prompt, size, ws FROM history ORDER BY id DESC LIMIT ?1")
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([HISTORY_KEEP], |r| {
      Ok(HistoryEntry {
        id: r.get(0)?,
        created: r.get(1)?,
        provider: r.get(2)?,
        model: r.get(3)?,
        prompt: r.get(4)?,
        size: r.get(5)?,
        ws: r.get(6)?,
      })
    })
    .map_err(|e| e.to_string())?;
  let entries = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
  Ok(entries)
}

#[tauri::command]
fn history_image(app: tauri::AppHandle, id: i64) -> Result<String, String> {
  let name = vault_file_of(&app, "history", "历史记录", id, false)?;
  let (bytes, mime) = read_vault_file(&app, "history", &name)?;
  Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

#[tauri::command]
fn history_thumb(app: tauri::AppHandle, id: i64) -> Result<String, String> {
  let name = vault_file_of(&app, "history", "历史记录", id, true)?;
  let (bytes, mime) = read_vault_file(&app, "history", &name)?;
  Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

#[tauri::command]
fn history_delete(app: tauri::AppHandle, id: i64) -> Result<(), String> {
  let conn = db_open(&app)?;
  let rows: Vec<(String, String)> = conn
    .prepare("SELECT file, thumb FROM history WHERE id = ?1")
    .and_then(|mut s| {
      s.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()
    })
    .map_err(|e| e.to_string())?;
  if rows.is_empty() {
    return Err(format!("历史记录 #{id} 不存在"));
  }
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  for (file, thumb) in rows {
    for name in [file, thumb] {
      if !name.is_empty() {
        let _ = fs::remove_file(dir.join("history").join(&name));
      }
    }
  }
  conn
    .execute("DELETE FROM history WHERE id = ?1", [id])
    .map_err(|e| e.to_string())?;
  Ok(())
}

/// 生成模板：用户把满意的成图「存为模板」，之后可以基于这张图再出图。
/// 与生成历史同一套存法（历史 templates/ 目录 + SQLite 元数据），差异是
/// 模板是用户显式收藏的，不自动裁剪；每条额外带生成时的提示词，
/// 载入参考槽位时一并回填。
#[derive(Serialize)]
struct TemplateEntry {
  id: i64,
  created: i64,
  provider: String,
  model: String,
  prompt: String,
  size: i64,
}

#[tauri::command]
fn template_add(
  app: tauri::AppHandle,
  data_url: String,
  provider: String,
  model: String,
  prompt: String,
) -> Result<TemplateEntry, String> {
  // 先解码算哈希查重：同一张图重复「存为模板」直接拒绝，不再写文件进库。
  // 字节级哈希（SHA-256）——同一张图无论从画板还是历史走哪条路径进来，
  // data URI 的 base64 编码一致，字节必然一致。
  let (bytes, ext) = decode_image_data_url(&data_url)?;
  let hash = format!("{:x}", Sha256::digest(&bytes));
  let conn = db_open(&app)?;
  if let Ok(id) = conn
    .query_row::<i64, _, _>("SELECT id FROM templates WHERE hash = ?1", [&hash], |r| r.get(0))
  {
    return Err(format!("这张图已在模板库（#{id}），不再重复添加"));
  }
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  let (name, thumb_name, size) = write_vault_image_bytes(&dir.join("templates"), &bytes, ext)?;
  let now = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default();
  conn
    .execute(
      "INSERT INTO templates (created, provider, model, prompt, file, thumb, size, hash) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
      rusqlite::params![
        now.as_secs() as i64,
        clip_meta(&provider),
        clip_meta(&model),
        clip_meta(&prompt),
        name,
        thumb_name,
        size,
        hash
      ],
    )
    .map_err(|e| e.to_string())?;
  Ok(TemplateEntry {
    id: conn.last_insert_rowid(),
    created: now.as_secs() as i64,
    provider: clip_meta(&provider),
    model: clip_meta(&model),
    prompt: clip_meta(&prompt),
    size,
  })
}

#[tauri::command]
fn template_list(app: tauri::AppHandle) -> Result<Vec<TemplateEntry>, String> {
  let conn = db_open(&app)?;
  let mut stmt = conn
    .prepare("SELECT id, created, provider, model, prompt, size FROM templates ORDER BY id DESC")
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], |r| {
      Ok(TemplateEntry {
        id: r.get(0)?,
        created: r.get(1)?,
        provider: r.get(2)?,
        model: r.get(3)?,
        prompt: r.get(4)?,
        size: r.get(5)?,
      })
    })
    .map_err(|e| e.to_string())?;
  Ok(rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?)
}

#[tauri::command]
fn template_image(app: tauri::AppHandle, id: i64) -> Result<String, String> {
  let name = vault_file_of(&app, "templates", "模板", id, false)?;
  let (bytes, mime) = read_vault_file(&app, "templates", &name)?;
  Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

#[tauri::command]
fn template_thumb(app: tauri::AppHandle, id: i64) -> Result<String, String> {
  let name = vault_file_of(&app, "templates", "模板", id, true)?;
  let (bytes, mime) = read_vault_file(&app, "templates", &name)?;
  Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

#[tauri::command]
fn template_delete(app: tauri::AppHandle, id: i64) -> Result<(), String> {
  let conn = db_open(&app)?;
  let rows: Vec<(String, String)> = conn
    .prepare("SELECT file, thumb FROM templates WHERE id = ?1")
    .and_then(|mut s| {
      s.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()
    })
    .map_err(|e| e.to_string())?;
  if rows.is_empty() {
    return Err(format!("模板 #{id} 不存在"));
  }
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  for (file, thumb) in rows {
    for name in [file, thumb] {
      if !name.is_empty() {
        let _ = fs::remove_file(dir.join("templates").join(&name));
      }
    }
  }
  conn
    .execute("DELETE FROM templates WHERE id = ?1", [id])
    .map_err(|e| e.to_string())?;
  Ok(())
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
  /// 手机端「取消」用：带上取消句柄 id 的请求可被 provider_fetch_cancel 中断。
  /// 缺省（桌面端/旧桩）完全不受影响。
  #[serde(default)]
  cancel_id: Option<String>,
}

#[derive(Serialize)]
struct ProviderResponse {
  status: u16,
  text: String,
}

/// 生成请求的取消句柄表：前端给每条要可取消的请求带 cancel_id，
/// 取消时按 id 取走信号端发送；还在等的请求经 select 立刻返回。
/// 已结束请求的句柄在 select 出口摘除，不泄漏。
#[derive(Default)]
struct FetchCancel(Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>);

/// 取消标记：请求被用户取消时返回它，前端据此显示「已取消」而不是报错。
const CANCELLED_MARKER: &str = "__cancelled__";

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
async fn provider_fetch(
  request: ProviderRequest,
  cancels: State<'_, Arc<FetchCancel>>,
) -> Result<ProviderResponse, String> {
  if !request.url.starts_with("https://") {
    return Err("only https urls are allowed".into());
  }
  let work = tauri::async_runtime::spawn_blocking(move || {
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
  });
  match request.cancel_id {
    // 可取消请求：登记句柄后在「请求完成」与「收到取消信号」之间择先。
    // 取消后底层 HTTP 线程会自己跑完（ureq 阻塞读没有中断点），但结果被丢弃。
    Some(id) => {
      let (tx, rx) = tokio::sync::oneshot::channel::<()>();
      cancels.0.lock().unwrap().insert(id.clone(), tx);
      let out = tokio::select! {
        res = work => res.map_err(|e| e.to_string()).and_then(|inner| inner),
        _ = rx => Err(CANCELLED_MARKER.into()),
      };
      cancels.0.lock().unwrap().remove(&id);
      out
    }
    None => work.await.map_err(|e| e.to_string())?,
  }
}

/// 手机端「取消」：按 id 触发取消信号。桌面端不带 cancel_id，不受影响。
#[tauri::command]
fn provider_fetch_cancel(cancels: State<'_, Arc<FetchCancel>>, id: String) {
  if let Some(tx) = cancels.0.lock().unwrap().remove(&id) {
    let _ = tx.send(());
  }
}

/// 手机端「存相册」：把成图写进用户在系统「创建文档」（SAF）里选的位置——
/// 选 Pictures 目录就能进相册。桌面端继续用 save_result_image 落盘。
#[tauri::command]
fn save_image_saf(app: tauri::AppHandle, uri: String, data_url: String) -> Result<(), String> {
  use std::io::Write;
  use tauri_plugin_fs::FsExt;
  let b64 = data_url.split(',').nth(1).ok_or("bad data url")?;
  let bytes = base64_decode(b64)?;
  let url: tauri_plugin_fs::FilePath = uri
    .parse()
    .map_err(|e| format!("bad content uri: {e}"))?;
  let mut opts = tauri_plugin_fs::OpenOptions::new();
  opts.write(true);
  let mut file = app
    .fs()
    .open(url, opts)
    .map_err(|e| format!("打开保存位置失败：{e}"))?;
  file.write_all(&bytes).map_err(|e| format!("写入失败：{e}"))?;
  file.flush().map_err(|e| format!("写入失败：{e}"))?;
  Ok(())
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
    // fs：手机端存相册用——open() 对 content:// URI 走 openOutputStream
    .plugin(tauri_plugin_fs::init())
    // gallery：手机端「保存到系统相册」，MediaStore 写 Pictures/Ziran
    .plugin(tauri_plugin_gallery::init())
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
      app.manage(Arc::new(FetchCancel::default()));
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
      append_log,
      open_log_file,
      open_config_dir,
      history_add,
      history_list,
      history_image,
      history_thumb,
      history_delete,
      template_add,
      template_list,
      template_image,
      template_thumb,
      template_delete,
      save_result_image,
      provider_fetch,
      provider_fetch_cancel,
      save_image_saf
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
  fn log_appends_and_rotates() {
    let dir = std::env::temp_dir().join(format!("ziran-log-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    append_log_line(&dir, "line-a").unwrap();
    append_log_line(&dir, "line-b").unwrap();
    assert_eq!(fs::read_to_string(dir.join(LOG_FILE)).unwrap(), "line-a\nline-b\n");
    // 超过上限后再写一条：旧文件轮转成 .1，新文件从零开始
    let big = "x".repeat((LOG_MAX_BYTES + 1) as usize);
    append_log_line(&dir, &big).unwrap();
    append_log_line(&dir, "after-rotate").unwrap();
    // 轮转搬走的是整个旧文件（含前面的行），新文件从零开始
    assert_eq!(
      fs::read_to_string(dir.join(format!("{LOG_FILE}.1"))).unwrap(),
      format!("line-a\nline-b\n{big}\n")
    );
    assert_eq!(fs::read_to_string(dir.join(LOG_FILE)).unwrap(), "after-rotate\n");
    // 再次超限轮转：旧的 .1 被覆盖，不堆积
    append_log_line(&dir, &big).unwrap();
    append_log_line(&dir, "second-rotate").unwrap();
    assert_eq!(
      fs::read_to_string(dir.join(format!("{LOG_FILE}.1"))).unwrap(),
      format!("after-rotate\n{big}\n")
    );
    assert_eq!(fs::read_to_string(dir.join(LOG_FILE)).unwrap(), "second-rotate\n");
    let _ = fs::remove_dir_all(&dir);
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

  /// 历史裁剪：只留最近 HISTORY_KEEP 条，最旧的行和文件一起删。
  #[test]
  fn history_prune_keeps_recent_and_deletes_files() {
    let tmp = std::env::temp_dir().join(format!("ziran-hist-test-{}", std::process::id()));
    fs::create_dir_all(&tmp).unwrap();
    let conn = Connection::open(tmp.join("gallery.db")).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn
      .execute_batch(
        "CREATE TABLE history (
           id       INTEGER PRIMARY KEY AUTOINCREMENT,
           created  INTEGER NOT NULL,
           provider TEXT NOT NULL DEFAULT '',
           model    TEXT NOT NULL DEFAULT '',
           file     TEXT NOT NULL,
           thumb    TEXT NOT NULL DEFAULT '',
           size     INTEGER NOT NULL);",
      )
      .unwrap();
    for i in 0..55 {
      let file = format!("ziran-{i}.png");
      fs::write(tmp.join(&file), b"x").unwrap();
      conn
        .execute(
          "INSERT INTO history (created, file, thumb, size) VALUES (?1,?2,'',1)",
          rusqlite::params![i, file],
        )
        .unwrap();
    }
    prune_history(&conn, &tmp);
    let (count, oldest, newest): (i64, i64, i64) = conn
      .query_row(
        "SELECT COUNT(*), MIN(id), MAX(id) FROM history",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
      )
      .unwrap();
    assert_eq!(count, HISTORY_KEEP);
    assert_eq!(oldest, 6); // id 从 1 起，id<=5（created 0..=4）被裁掉
    assert_eq!(newest, 55);
    for i in 0..5 {
      assert!(!tmp.join(format!("ziran-{i}.png")).exists(), "file {i} should be gone");
    }
    for i in 5..55 {
      assert!(tmp.join(format!("ziran-{i}.png")).exists(), "file {i} should survive");
    }
    let _ = fs::remove_dir_all(&tmp);
  }

  /// 缩略图：真 PNG 缩得出，垃圾字节返回 None（不炸）。
  #[test]
  fn make_thumb_handles_real_and_garbage() {
    let img = image::DynamicImage::new_rgb8(320, 200);
    let mut png = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
      .unwrap();
    let thumb = make_thumb(&png).expect("real png should thumb");
    assert!(thumb.len() > 0 && thumb.len() < png.len());
    assert!(make_thumb(b"not-an-image").is_none());
  }

  /// 历史归档与「存为模板」共用的落盘：data url 解码出字节与扩展名，
  /// 原图 + 缩略图都写入；坏 data url 要报错而不是落半截文件。
  #[test]
  fn vault_write_decodes_and_creates_thumb() {
    let img = image::DynamicImage::new_rgb8(120, 90);
    let mut png = Vec::new();
    img
      .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
      .unwrap();
    let data_url = format!("data:image/png;base64,{}", base64_encode(&png));
    let dir = std::env::temp_dir().join(format!("ziran-vault-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let (file, thumb, size) = write_vault_image(&dir, &data_url).unwrap();
    assert_eq!(size, png.len() as i64);
    assert!(file.ends_with(".png") && !file.contains('/'));
    assert!(dir.join(&file).exists());
    assert!(thumb.ends_with(".thumb.jpg"));
    assert!(dir.join(&thumb).exists());
    // 非 image 前缀 / 没有 base64 载荷 / 空载荷 → 拒绝
    assert!(decode_image_data_url("data:text/plain;base64,AA").is_err());
    assert!(decode_image_data_url("data:image/png;nope").is_err());
    assert!(decode_image_data_url("data:image/png;base64,").is_err());
    let _ = fs::remove_dir_all(&dir);
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
