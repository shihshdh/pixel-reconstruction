

照片 → Apple SHARP 高斯泼溅 → 3D 场景 + 云端渲染的运镜视频。

整条链路长这样：

```
你的浏览器                Modal 云端 (A10G GPU)
┌──────────┐  POST /generate   ┌──────────────────────┐
│ Next.js  │ ────────────────► │ sharp predict → .ply │
│ 前端     │  轮询 /status     │ sharp render  → .mp4 │
│          │ ◄──────────────── │ 存进云端硬盘(Volume) │
│ 3D查看器 │  GET /file/...    └──────────────────────┘
└──────────┘ ◄──── .ply / .mp4 直接拉回来
```

前端不碰 GPU，GPU 不管页面，中间就三个 HTTP 接口。没有数据库、没有对象存储、
没有要配的第三方 token——只有 Modal 一个

---

## 本地硬件

本地开发可以完全不花钱：见 `backend/本地GPU指南.md`。下面的五步是云端（Modal）路线，两条路前端通用。

---

## 第 1 步 · 装基础工具

需要两样东西：**Node.js**（跑前端）和 **Python**（用来操作 Modal）。

1. Node.js：去 https://nodejs.org 下载 **LTS 版**，一路下一步安装。
2. Python：去 https://www.python.org/downloads/ 下载 3.11 或 3.12。
   安装第一屏**务必勾选 "Add python.exe to PATH"**，不然后面命令找不到。

装完后，打开一个**新的** PowerShell 窗口（旧窗口读不到新 PATH），验证：

```powershell
node -v        # 出现 v20.x 或 v22.x
python --version   # 出现 Python 3.11.x / 3.12.x
```

✅ 两条命令都能打印版本号，第 1 步完成。

---

## 第 2 步 · 注册并登录 Modal

Modal 是 serverless GPU 平台：有请求才开机计费，没人用就是 0 成本，
注册自带每月免费额度（目前每月 30 美元，够你生成几百上千张）。

> 国内访问 modal.com 需要先开代理（Clash 打开系统代理）。

```powershell
pip install modal
modal setup
```

`modal setup` 会弹浏览器让你登录/注册（用 GitHub 账号最快），
授权后回到终端，看到 `Token verified` 之类的成功提示即可。

**如果报错 `modal : 无法将"modal"项识别为 cmdlet…`**：
这是 Python 的 Scripts 目录没在 PATH 里。临时解法（每开一个新终端要重跑）：

```powershell
$env:Path += ";$env:APPDATA\Python\Python312\Scripts"
```

一劳永逸的解法：

```powershell
[Environment]::SetEnvironmentVariable(
  "Path",
  $env:Path + ";$env:APPDATA\Python\Python312\Scripts",
  "User")
```

（路径里的 `Python312` 按你实际装的版本改；执行完**重开终端**。）

✅ `modal --help` 能打印帮助信息，第 2 步完成。

---

## 第 3 步 · 部署 GPU 后端（动手 1 分钟，等待 10~20 分钟）

在项目根目录（能看到 `backend` 和 `app` 两个文件夹的那层）执行：

```powershell
modal deploy backend/sharp_inference.py
```

第一次部署会**构建镜像**：装 CUDA 环境、克隆 Apple 的 ml-sharp、
预下载 1.4GB 模型权重。终端会一直滚日志，10~20 分钟属于正常，去喝杯水。
（以后再 deploy 都是秒级，镜像有缓存。）

结束时终端会打印类似这样的一行：

```
└── 🔨 Created web function api =>
    https://xxxxx--sharp-web-api.modal.run
```

**把这个 URL 复制下来**，下一步要用。

✅ 看到 `modal.run` 结尾的 URL，第 3 步完成。
（也可以登录 modal.com 控制台，在 Apps 里看到 `sharp-web`。)

---

## 第 4 步 · 本地跑前端

1. 把 `.env.local.example` 复制一份，改名为 `.env.local`，
   填入刚才的 URL（结尾不要带 `/`）：

   ```
   NEXT_PUBLIC_MODAL_API=https://xxxxx--sharp-web-api.modal.run
   ```

2. 装依赖。国内直连 npm 很慢，先切镜像：

   ```powershell
   npm config set registry https://registry.npmmirror.com
   npm install
   ```

3. 启动：

   ```powershell
   npm run dev
   ```

浏览器打开 http://localhost:3000 ，把一张照片拖进"片门"。

**关于第一次生成**：刚部署完的第一张图最慢——GPU 冷启动 + 渲染内核
若需现场编译，可能要 2~3 分钟，页面上有提示。之后容器保温 5 分钟，
连续生成大约 20~40 秒一张（推理本身不到 1 秒，时间主要花在
渲染运镜视频和传输上）。

✅ 能看到 3D 场景转起来、运镜视频能播放，第 4 步完成。核心功能已经全通了。

---

## 第 5 步 · 上线到公网

前端是纯静态调用，部署到 Vercel 免费档就够。最快的方式：

```powershell
npm i -g vercel
vercel
```

跟着提示登录（GitHub 账号）、一路回车接受默认值。部署完成后：

1. 去 vercel.com 打开这个项目 → **Settings → Environment Variables**，
   添加 `NEXT_PUBLIC_MODAL_API` = 你的 Modal URL。
2. 重新部署一次让环境变量生效：`vercel --prod`。

注意：`*.vercel.app` 域名在国内裸连不稳定，自己用挂代理没问题；
想让朋友直接打开，可以在 Vercel 绑一个自己的域名。

---

## 常见报错

| 现象 | 原因与解法 |
| --- | --- |
| `modal` 命令不存在 | Python Scripts 不在 PATH，见第 2 步 |
| `modal deploy` 卡很久 | 第一次构建镜像就是要 10~20 分钟，看日志在滚就别动它 |
| 页面提示"还没配置后端地址" | `.env.local` 没建或没填，改完要重启 `npm run dev` |
| 第一张图等了 3 分钟 | 冷启动 + 内核编译，仅首次；不放心可去 Modal 控制台看实时日志 |
| `npm install` 龟速/失败 | 先执行第 4 步里的切镜像命令 |
| 状态返回 error | 把页面上的报错全文发给 Claude，里面带着 GPU 端日志尾巴 |
| .ply 加载很慢 | 文件可能上百兆，正常；查看器是边下边渲染的 |

