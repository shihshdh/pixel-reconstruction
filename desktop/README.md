# Pixel Reconstruction · Windows 客户端

用 [Tauri 2](https://tauri.app) 打包的桌面客户端。网站的静态文件（页面、首页 3D 场景、演示视频、助手模型）打包在安装包里，从本地加载；只有生成、修图、下载作品这些请求走网络。国内访问 Netlify 慢，这样启动和切页都不受影响。代价是网站更新后，客户端需要重新打包发布。

和在浏览器里使用相比：

- 启动约 0.6 秒出现界面，首页 3D 场景约 3 秒就绪；
- 独立窗口，没有地址栏和标签页，窗口大小与位置会被记住；
- 按硬件自动分档：独显电脑上预览超采样、导出 1920 宽视频；性能较低的电脑降低预览分辨率保证流畅，并按实际帧率动态升降。工作室里的“画质”可以手动指定。场景数据始终是全量点数；
- 优先使用独立显卡和显卡视频编码，导出视频比实时更快；
- 照片可以直接拖进窗口，上传时显示进度和速度；
- 重复打开时切回已有窗口，不会开出第二个；
- 作品另存为本地文件：安装时会在 D 盘建好 `D:\Pixel Reconstruction\作品`，每件作品一个文件夹，里面有原图、3D 场景（.splat/.ply）、`info.json` 和在工作室导出的视频。没有 D 盘时放在安装目录下的“作品”，再不行放在“文档”。卸载客户端不会删除这些文件；
- 外部链接（作者主页、许可证等）用系统默认浏览器打开。

渲染使用系统自带的 Microsoft Edge WebView2。Windows 11 和较新的 Windows 10 已内置；如果没有，安装程序会自动下载。

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
- 页面可以通过 `window.__PIXEL_DESKTOP__` 判断自己是否运行在客户端里。客户端只向页面开放两个本地命令：往作品文件夹写文件（文件名和类型都有白名单，不能写到别的目录）、打开作品文件夹。`info.json` 不包含任务 Token 或下载链接。
