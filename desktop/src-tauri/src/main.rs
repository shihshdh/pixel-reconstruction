// Pixel Reconstruction 的 Windows 客户端。网站的静态文件打包在客户端里，从本地加载；
// 只有生成、修图、下载作品这些 API 请求走网络。外部链接交给系统浏览器打开。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

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

// ---- 本机显卡引擎：用自己电脑的 NVIDIA 显卡跑 SHARP，不占用云端 GPU ----
//
// 引擎是 backend/local_engine/engine.py（随安装包放在 engine/ 资源目录），用本机已经装好
// SHARP 的 Python 环境运行，只监听 127.0.0.1。PyTorch + 模型有 5GB 以上，不打包进客户端；
// 找不到这样的环境时页面继续使用云端。

/// 固定端口：作品库按后端地址记录作品，端口不变，重启客户端后本机作品仍能打开。
const ENGINE_PORT: u16 = 47821;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct EngineState {
    child: Option<Child>,
    python: Option<PathBuf>,
    installer: Option<Child>,
}

#[derive(serde::Serialize)]
struct EngineInfo {
    url: String,
    python: String,
}

/// 可以运行引擎的 Python：同一环境里要有 SHARP、PyTorch、FastAPI、uvicorn 和 multipart。
fn engine_python_in(env: &Path) -> Option<PathBuf> {
    let python = env.join("python.exe");
    let site = env.join("Lib").join("site-packages");
    let ok = python.is_file()
        && site.join("sharp").join("cli").join("predict.py").is_file()
        && ["torch", "fastapi", "uvicorn", "multipart"].iter().all(|m| site.join(m).is_dir());
    ok.then_some(python)
}

/// 一键安装的运行环境根目录（安装脚本装好后写入 engine-runtime.txt）。
fn runtime_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let pointer = app.path().app_local_data_dir().ok()?.join("engine").join("engine-runtime.txt");
    let root = PathBuf::from(std::fs::read_to_string(pointer).ok()?.trim());
    root.is_dir().then_some(root)
}

/// 按顺序查找：一键安装的环境 → 环境变量 PIXEL_ENGINE_PYTHON → 配置文件 engine-python.txt →
/// conda 登记的所有环境（~/.conda/environments.txt）→ 常见安装位置下的 envs → ~/sharp-env。
fn find_engine_python(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut envs: Vec<PathBuf> = Vec::new();
    if let Some(root) = runtime_root(app) {
        envs.push(root.join("python"));
    }
    // 测试一键安装流程用：只认一键安装的环境，忽略本机已有的 conda 等环境
    if std::env::var("PIXEL_ENGINE_ONLY_RUNTIME").is_ok_and(|v| v == "1") {
        return envs.iter().find_map(|env| engine_python_in(env));
    }
    // 允许填 python.exe 本身，也允许填环境目录
    let as_env = |value: &str| {
        let path = PathBuf::from(value.trim());
        if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) {
            path.parent().map(Path::to_path_buf).unwrap_or(path)
        } else {
            path
        }
    };
    if let Ok(value) = std::env::var("PIXEL_ENGINE_PYTHON") {
        envs.push(as_env(&value));
    }
    if let Ok(dir) = app.path().app_config_dir() {
        if let Ok(value) = std::fs::read_to_string(dir.join("engine-python.txt")) {
            envs.push(as_env(&value));
        }
    }
    let home = std::env::var("USERPROFILE").map(PathBuf::from).ok();
    if let Some(home) = &home {
        if let Ok(list) = std::fs::read_to_string(home.join(".conda").join("environments.txt")) {
            // 名字里带 sharp 的环境排在前面
            let mut listed: Vec<PathBuf> = list.lines().map(str::trim).filter(|l| !l.is_empty()).map(PathBuf::from).collect();
            listed.sort_by_key(|p| !p.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase().contains("sharp")));
            envs.extend(listed);
        }
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = &home {
        roots.extend(["anaconda3", "miniconda3", "miniforge3"].iter().map(|n| home.join(n)));
    }
    for base in [r"C:\ProgramData", r"D:\"] {
        roots.extend(["anaconda", "anaconda3", "miniconda3", "miniforge3"].iter().map(|n| Path::new(base).join(n)));
    }
    for root in roots {
        envs.push(root.join("envs").join("sharp"));
        if let Ok(entries) = std::fs::read_dir(root.join("envs")) {
            envs.extend(entries.flatten().map(|e| e.path()));
        }
        envs.push(root);
    }
    if let Some(home) = &home {
        envs.push(home.join("sharp-env"));
    }
    envs.iter().find_map(|env| engine_python_in(env))
}

/// NVIDIA 驱动会在 System32 放 nvcuda.dll（CUDA 驱动接口），没有它就不可能跑 CUDA。
fn has_nvidia_gpu() -> bool {
    let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    Path::new(&system).join("System32").join("nvcuda.dll").is_file()
}

/// 引擎文件：安装后在资源目录 engine/；开发构建直接用仓库里的源码。
fn engine_file(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    let bundled = app.path().resource_dir().ok().map(|d| d.join("engine").join(name));
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join(r"..\..\backend\local_engine").join(name);
    bundled.into_iter().chain(std::iter::once(source)).find(|p| p.exists())
}
fn engine_script(app: &tauri::AppHandle) -> Option<PathBuf> {
    engine_file(app, "engine.py")
}

fn log_tail(path: &Path) -> String {
    let text = std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(4)..].join("\n")
}

/// 启动（或确认已在运行）本机引擎，返回它的地址。可以重复调用。
/// 引擎监视客户端的进程号：客户端退出（包括被强制结束）时引擎随之退出。
#[tauri::command]
fn local_engine_start(app: tauri::AppHandle, state: tauri::State<'_, Mutex<EngineState>>) -> Result<EngineInfo, String> {
    let mut engine = state.lock().map_err(|_| "引擎状态不可用")?;
    let data = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("engine");
    let log = data.join("engine.log");
    let url = format!("http://127.0.0.1:{ENGINE_PORT}");
    if let Some(child) = engine.child.as_mut() {
        if let Ok(None) = child.try_wait() {
            let python = engine.python.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            return Ok(EngineInfo { url, python });
        }
        // 已经退出：把原因交给页面，下次调用再重新启动
        engine.child = None;
        let tail = log_tail(&log);
        return Err(if tail.is_empty() { "本机引擎已退出".into() } else { format!("本机引擎已退出：{tail}") });
    }
    // 没有 NVIDIA 驱动（核显、AMD 或没有独显）就不启动，页面直接用云端
    if !has_nvidia_gpu() {
        return Err("NO_GPU：这台电脑没有可用的 NVIDIA 显卡".into());
    }
    let python = find_engine_python(&app).ok_or("没有找到装有 SHARP 的 Python 环境")?;
    let script = engine_script(&app).ok_or("客户端缺少本机引擎文件，请重新安装")?;
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let output = std::fs::File::create(&log).map_err(|e| e.to_string())?;
    let mut command = Command::new(&python);
    command
        .arg("-u")
        .arg(&script)
        .args(["--port", &ENGINE_PORT.to_string(), "--parent-pid", &std::process::id().to_string(), "--data"])
        .arg(&data)
        .env("PYTHONIOENCODING", "utf-8")
        .envs(runtime_root(&app).map(|root| root.join("models").join("sharp_2572gikvuh.pt")).filter(|p| p.is_file()).map(|p| ("SHARP_CKPT", p)))
        .stdin(Stdio::null())
        .stdout(output.try_clone().map_err(|e| e.to_string())?)
        .stderr(output);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command.spawn().map_err(|e| format!("无法启动本机引擎：{e}"))?;
    engine.child = Some(child);
    engine.python = Some(python.clone());
    Ok(EngineInfo { url, python: python.to_string_lossy().into_owned() })
}

/// 全屏无边框：盖住整块屏幕（含任务栏），没有标题栏和窗口边框。on 为空时切换。
#[tauri::command]
fn set_fullscreen(window: tauri::WebviewWindow, on: Option<bool>) -> Result<bool, String> {
    let next = on.unwrap_or(!window.is_fullscreen().map_err(|e| e.to_string())?);
    window.set_fullscreen(next).map_err(|e| e.to_string())?;
    Ok(next)
}

/// 结束一个进程及其子进程（安装脚本会拉起 curl、pip）。
fn kill_tree(child: &mut Child) {
    let mut command = Command::new("taskkill");
    command.args(["/PID", &child.id().to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = command.status();
    let _ = child.kill();
    let _ = child.wait();
}

#[derive(serde::Serialize)]
struct InstallInfo {
    running: bool,
    status: Option<String>,
}

/// 本机引擎一键安装（backend/local_engine/install-engine.ps1）：
/// start 在后台开始（已在进行时不重复）；status 读进度；cancel 停止，已下载的部分保留，下次断点续传。
/// 安装位置：有 D 盘时优先 D:\Pixel Reconstruction\engine-runtime，其次本机应用数据目录，由脚本按剩余空间选择。
#[tauri::command]
fn local_engine_install(app: tauri::AppHandle, state: tauri::State<'_, Mutex<EngineState>>, action: String) -> Result<InstallInfo, String> {
    let mut engine = state.lock().map_err(|_| "引擎状态不可用")?;
    let data = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("engine");
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let status_path = data.join("install-status.json");
    let running = |engine: &mut EngineState| matches!(engine.installer.as_mut().map(|c| c.try_wait()), Some(Ok(None)));
    match action.as_str() {
        "start" if !running(&mut engine) => {
            if !has_nvidia_gpu() {
                return Err("NO_GPU：这台电脑没有可用的 NVIDIA 显卡".into());
            }
            let script = engine_file(&app, "install-engine.ps1").ok_or("客户端缺少安装脚本，请重新安装客户端")?;
            let vendor = engine_file(&app, "vendor").ok_or("客户端缺少安装文件，请重新安装客户端")?;
            let local = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("engine-runtime");
            let mut roots = Vec::new();
            if Path::new(r"D:\").is_dir() {
                roots.push(r"D:\Pixel Reconstruction\engine-runtime".to_string());
            }
            roots.push(local.to_string_lossy().into_owned());
            let _ = std::fs::remove_file(&status_path);
            let mut command = Command::new("powershell.exe");
            command
                .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&script)
                .arg("-Roots").arg(roots.join("|"))
                .arg("-Status").arg(&status_path)
                .arg("-Pointer").arg(data.join("engine-runtime.txt"))
                .arg("-Vendor").arg(&vendor)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(std::fs::File::create(data.join("install.log")).map(Stdio::from).unwrap_or(Stdio::null()));
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(CREATE_NO_WINDOW);
            }
            engine.installer = Some(command.spawn().map_err(|e| format!("无法启动安装：{e}"))?);
        }
        "cancel" => {
            if let Some(mut child) = engine.installer.take() {
                kill_tree(&mut child);
            }
        }
        "start" | "status" => {}
        _ => return Err("未知操作".into()),
    }
    let running = running(&mut engine);
    Ok(InstallInfo { running, status: std::fs::read_to_string(&status_path).ok() })
}

fn stop_engine(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Mutex<EngineState>>() {
        if let Ok(mut engine) = state.lock() {
            if let Some(mut child) = engine.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            // 安装中关掉客户端：停掉下载，下次启动断点续传
            if let Some(mut child) = engine.installer.take() {
                kill_tree(&mut child);
            }
        }
    }
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
        // 记住窗口位置、大小和最大化状态；不记“是否有标题栏”——否则会把旧版保存的
        // 带标题栏状态恢复回来，无边框设置被覆盖，窗口顶上又多出一条黑色系统标题栏
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::DECORATIONS)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(EngineState::default()))
        .invoke_handler(tauri::generate_handler![save_work_file, open_works_folder, local_engine_start, local_engine_install, set_fullscreen])
        .setup(|app| {
            let handle = app.handle().clone();
            let popup_handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Pixel Reconstruction")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 640.0)
                .center()
                .background_color(tauri::window::Color(246, 244, 239, 255))
                // 无边框：不要系统标题栏（深色模式下是一条黑边），导航栏兼作标题栏，
                // 拖动、双击最大化、窗口按钮都在页面里；保留系统阴影和 Windows 11 圆角
                .decorations(false)
                .shadow(true)
                // 让网页自己处理拖进来的照片（否则窗口层面会先截走文件拖放）
                .disable_drag_drop_handler()
                // 硬件加速：双显卡时用独显，驱动在黑名单里也不退回软件渲染，
                // 光栅化和视频帧走 GPU。前一段是 wry 的默认参数，覆盖时必须保留。
                .additional_browser_args(concat!(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
                    " --force_high_performance_gpu --ignore-gpu-blocklist",
                    " --enable-gpu-rasterization --enable-zero-copy"
                ))
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
            // 双保险：创建后再关一次系统标题栏
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(false);
                let _ = window.set_shadow(true);
                // 旧版带标题栏时保存的位置，换成无边框后可能有一截落在屏幕外：拉回屏幕中间
                if let (Ok(position), Ok(false)) = (window.outer_position(), window.is_maximized()) {
                    if position.x < 0 || position.y < 0 {
                        let _ = window.center();
                    }
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start Pixel Reconstruction")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                stop_engine(app);
            }
        });
}
