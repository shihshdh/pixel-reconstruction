# Pixel Reconstruction · Windows 客户端

用 [Tauri 2](https://tauri.app) 打包的桌面客户端。网站的静态文件（页面、首页 3D 场景、演示视频、助手模型）打包在安装包里，从本地加载；只有生成、修图、下载作品这些请求走网络。国内访问 Netlify 慢，这样启动和切页都不受影响。代价是网站更新后，客户端需要重新打包发布。

和在浏览器里使用相比：

- 启动约 0.6 秒出现界面，首页 3D 场景约 3 秒就绪；
- 独立窗口，没有地址栏和标签页，窗口大小与位置会被记住；
- **本机显卡生成**：有 NVIDIA 显卡、并且装好了 SHARP 的 Python 环境时，照片直接在本机显卡上重建，不占用云端 GPU，也不上传照片（见下文“本机显卡引擎”）。没有 NVIDIA 显卡或显存不足 6GB 的电脑照常使用云端，界面里不出现本机选项；
- **画质五档**（导航栏“画质”，工作室里同步）：自动 / 极致 / 高 / 均衡 / 流畅。独显客户端默认“极致”：预览最高 2.5× 超采样、导出 2560 宽 60fps，界面背景换成实时光线追踪；核显自动落在“均衡”或“流畅”，也能手动切换任意一档。运行中按实际帧率升降渲染倍率，帧率目标按屏幕刷新率自动定（60Hz 屏 60fps，高刷屏 120fps）。场景数据始终是全量点数；
- **导出不等太久**：导出前先按目标分辨率试画几帧估算耗时，超过本档预算（极致/高 60 秒）自动降一档分辨率并提示；
- **光追界面**（极致档）：玻璃球（薄膜彩虹反射、折射、焦散）、白瓷、铬镜、磨砂蓝球与发光光球，解析软阴影和倒影，每像素 4× 超采样抗锯齿，帧率跟随刷新率（最高 120fps）。掉帧时依次关超采样、降到 30fps、降分辨率，最后停在静帧；进入工作室、显影期间、窗口隐藏时停止，把显卡让给场景和推理；
- **全屏无边框**：F11 或导航栏按钮切换，Esc 退出；
- 优先使用独立显卡和显卡视频编码，导出视频比实时更快；
- 照片可以直接拖进窗口，上传时显示进度和速度；
- 重复打开时切回已有窗口，不会开出第二个；
- 作品另存为本地文件：安装时会在 D 盘建好 `D:\Pixel Reconstruction\作品`，每件作品一个文件夹，里面有原图、3D 场景（.splat/.ply）、`info.json` 和在工作室导出的视频。没有 D 盘时放在安装目录下的“作品”，再不行放在“文档”。卸载客户端不会删除这些文件；
- 外部链接（作者主页、许可证等）用系统默认浏览器打开。

渲染使用系统自带的 Microsoft Edge WebView2。Windows 11 和较新的 Windows 10 已内置；如果没有，安装程序会自动下载。

## 本机显卡引擎

`backend/local_engine/engine.py`，随安装包放在资源目录 `engine/`。客户端启动时在后台拉起它（无窗口），只监听 `127.0.0.1:47821`，并只接受客户端页面的跨域请求。接口直接复用 Beam 网关（`backend/beam/gateway.py`）：任务 Token、签名下载链接、状态、文件、修图完全一致；区别只是生成任务进本机队列，由常驻显存的模型处理。

- 模型只在启动时载入一次（约 15–35 秒，含一次空白图预热），之后每张照片约 7 秒（RTX 5070 Ti 笔记本实测，Beam 冷启动一次约 46–55 秒）；预热期间提交的照片会排队；
- 本机处理超过 2 分钟（渲染视频 4 分钟）、出错或引擎无响应时，同一张照片自动改交云端；
- 修图仍调用豆包：本机作品用你在修图页填写的豆包 Key，或本机环境变量 `ARK_API_KEY`；
- 任务数据在 `%LOCALAPPDATA%\app.pixelreconstruction.desktop\engine`，日志 `engine.log`；
- 客户端退出（包括被强制结束）时引擎随之退出，不会留下占显存的进程。

PyTorch 和模型权重有 5GB 以上，不打包进安装包。客户端按顺序查找可用的 Python：环境变量 `PIXEL_ENGINE_PYTHON` → `%APPDATA%\app.pixelreconstruction.desktop\engine-python.txt`（写 python.exe 或环境目录）→ conda 登记的环境（名字带 sharp 的优先）→ 常见 Anaconda/Miniconda 位置 → `~\sharp-env`。环境里需要 `sharp`、`torch`（CUDA 版）、`fastapi`、`uvicorn`、`python-multipart`、`pillow`，安装见 `backend/本地GPU指南.md`。

## 构建

需要 Rust（stable，MSVC 工具链）和 Visual Studio C++ 生成工具。

```sh
cd desktop
npm install
npm run build
```

`npm run build` 会先构建网站（根目录 `npm run build`），把 `out/` 复制到 `desktop/dist/`（不含 `download/`），再打包。安装包输出到 `src-tauri/target/release/bundle/nsis/`，约 48MB。换图标时替换 `app-icon.png`（1024×1024），再运行 `npm run icons`。

## 发布

1. 版本号在 `src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 里各有一处，保持一致；
2. 把安装包复制为 `public/download/PixelReconstruction-Setup.exe`，随站点一起发布，网站导航栏的“Windows 客户端”指向这个文件；
3. 同一个安装包上传到 GitHub Releases。

`public/download/` 不进仓库，安装包以 GitHub Releases 为准。

## 说明

- 安装包没有代码签名，首次运行时 Windows SmartScreen 可能提示“Windows 已保护你的电脑”，点“更多信息 → 仍要运行”即可。去掉这个提示需要购买代码签名证书。
- 默认安装到当前用户目录，不需要管理员权限。
- 页面可以通过 `window.__PIXEL_DESKTOP__` 判断自己是否运行在客户端里。客户端只向页面开放四个本地命令：往作品文件夹写文件（文件名和类型都有白名单，不能写到别的目录）、打开作品文件夹、启动本机显卡引擎、切换全屏。`info.json` 不包含任务 Token 或下载链接。
