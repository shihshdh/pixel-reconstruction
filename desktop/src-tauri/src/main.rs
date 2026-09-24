// Pixel Reconstruction 的 Windows 客户端：一个装着线上站点的原生窗口。
// 站点更新后客户端自动是最新版；外部链接交给系统浏览器打开。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use tauri::{ipc::InvokeBody, webview::NewWindowResponse, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const SITE_HOST: &str = "pixel-reconstruction.netlify.app";

/// 留在窗口里的地址：本地启动页、站点本身、页面内生成的 blob/data。
fn stays_inside(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "blob" | "data" => true,
        "http" | "https" => matches!(url.host_str(), Some(h) if h == SITE_HOST || h == "tauri.localhost"),
        _ => false,
    }
}

// ---- 作品本地保存：站点只能往“作品”文件夹里写文件，别处一概不行 ----

/// D 盘固定的作品文件夹，安装程序会预先建好（见 installer-hooks.nsh）。
const D_DRIVE_WORKS: &str = r"D:\Pixel Reconstruction\作品";

/// 作品保存位置，按顺序选第一个可写的：
/// 1. D:\Pixel Reconstruction\作品（有 D 盘时）；
/// 2. 安装目录下的“作品”；
/// 3. “文档\Pixel Reconstruction 作品”。
/// 卸载程序只删它自己装的文件，这些文件夹都会保留。
fn works_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if std::path::Path::new(r"D:\").is_dir() {
        candidates.push(PathBuf::from(D_DRIVE_WORKS));
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|d| d.join("作品"))) {
        candidates.push(dir);
    }
    for dir in candidates {
        if std::fs::create_dir_all(&dir).is_ok() && writable(&dir) {
            return Ok(dir);
        }
    }
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    let dir = docs.join("Pixel Reconstruction 作品");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn writable(dir: &PathBuf) -> bool {
    let probe = dir.join(".write-test");
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(probe);
    ok
}

/// 只接受简单的名字：字母、数字、点、横线、下划线，不能以点开头，防止路径穿越。
fn safe_name(value: &str, max: usize) -> Option<&str> {
    let ok = !value.is_empty()
        && value.len() <= max
        && !value.starts_with('.')
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    ok.then_some(value)
}

fn header<'a>(request: &'a tauri::ipc::Request<'_>, name: &str) -> Result<&'a str, String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("缺少 {name}"))
}

/// 把一件作品的一个文件写到 作品/<作品文件夹>/<文件名>。
/// 大文件由网页分块发送（每块不超过 8MB）：offset 为 0 的块新建临时文件，之后按顺序追加，
/// 最后一块写完再改名，中断时不会留下半个正式文件。
#[tauri::command]
fn save_work_file(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    use std::io::Write;
    let folder = safe_name(header(&request, "x-work-folder")?, 80).ok_or("作品文件夹名不合法")?;
    let name = safe_name(header(&request, "x-file-name")?, 120).ok_or("文件名不合法")?;
    let allowed = [".jpg", ".jpeg", ".png", ".webp", ".ply", ".splat", ".mp4", ".json"];
    if !allowed.iter().any(|ext| name.to_ascii_lowercase().ends_with(ext)) {
        return Err("不支持的文件类型".into());
    }
    let offset: u64 = header(&request, "x-chunk-offset").unwrap_or("0").parse().map_err(|_| "分块位置不合法")?;
    let last = header(&request, "x-chunk-final").unwrap_or("1") == "1";
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("文件内容缺失".into());
    };
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("单块过大".into());
    }
    let dir = works_root(&app)?.join(folder);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(name);
    let temp = dir.join(format!(".{name}.part"));
    let mut file = if offset == 0 {
        std::fs::File::create(&temp).map_err(|e| e.to_string())?
    } else {
        // 追加前核对已写长度，乱序或重复的块直接拒绝
        let written = std::fs::metadata(&temp).map_err(|_| "缺少前面的分块")?.len();
        if written != offset {
            return Err("分块顺序不一致".into());
        }
        std::fs::OpenOptions::new().append(true).open(&temp).map_err(|e| e.to_string())?
    };
    file.write_all(bytes).map_err(|e| e.to_string())?;
    drop(file);
    if last {
        std::fs::rename(&temp, &target).map_err(|e| e.to_string())?;
    }
    Ok(target.to_string_lossy().into_owned())
}

/// 在资源管理器里打开作品文件夹（可指定某件作品的子文件夹）。
#[tauri::command]
fn open_works_folder(app: tauri::AppHandle, folder: Option<String>) -> Result<String, String> {
    let mut dir = works_root(&app)?;
    if let Some(sub) = folder.as_deref().and_then(|f| safe_name(f, 80)) {
        if dir.join(sub).is_dir() {
            dir = dir.join(sub);
        }
    }
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 重复打开时把已有窗口带到前面，而不是再开一个
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![save_work_file, open_works_folder])
        .setup(|app| {
            let handle = app.handle().clone();
            let popup_handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Pixel Reconstruction")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 640.0)
                .center()
                .background_color(tauri::window::Color(246, 244, 239, 255))
                // 让站点知道自己运行在客户端里（比如隐藏“下载客户端”入口）
                .initialization_script(concat!(
                    "window.__PIXEL_DESKTOP__ = { version: '",
                    env!("CARGO_PKG_VERSION"),
                    "' };"
                ))
                .on_navigation(move |url| {
                    if stays_inside(url) {
                        return true;
                    }
                    let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                    false
                })
                .on_new_window(move |url, _features| {
                    if stays_inside(&url) {
                        return NewWindowResponse::Allow;
                    }
                    let _ = popup_handle.opener().open_url(url.as_str(), None::<&str>);
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Pixel Reconstruction");
}
