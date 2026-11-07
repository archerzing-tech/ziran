use std::fs;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;
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

fn download(url: &str) -> Result<Vec<u8>, String> {
  let res = ureq::get(url)
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
    let workers = 4usize;
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
      open_url
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
}
