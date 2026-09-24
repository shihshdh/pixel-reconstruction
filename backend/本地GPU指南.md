# 入画 · 本地 GPU 指南（RTX 5070）

用自己的显卡跑 SHARP，开发调试零成本，出图速度还比云端快
（没有冷启动，单张照片从上传到出运镜视频约 10 秒）。

先把定位说清楚：**本地适合自己玩和开发，对外网站还是用 Modal。**
原因很实在——对外服务你的电脑得一直开机、家宽上行带宽撑不起别人
下载上百兆的 .ply、把自己机器暴露公网也不安全。最舒服的用法：

```
平时开发    .env.local → http://localhost:8000   （本地 5070，免费）
正式上线    .env.local → https://xxx.modal.run    （Modal，给别人用）
```

前端代码零改动，换地址重启 `npm run dev` 即可。

---

## 开始前必读：你这张卡的特殊之处

RTX 5070 是 Blackwell 架构（计算能力 sm_120），**太新了**，
有两个硬性要求，网上老教程基本都会在这里翻车：

1. PyTorch 必须装 **CUDA 12.8 版本**（torch 2.7 以上的 cu128 轮子）。
   装成 cu121 / cu124 会报 `no kernel image is available for execution`。
2. 编译 gsplat（运镜渲染内核）时要告诉它架构号：`TORCH_CUDA_ARCH_LIST="12.0"`。

## 推荐路线：WSL2（Windows 里跑个 Linux）

为什么不直接 Windows 原生跑？因为 `sharp render` 依赖的 gsplat
需要现场编译 CUDA 代码，Windows 上要装 Visual Studio 编译器，
坑非常多；WSL2 里是标准 Linux 工具链，顺滑得多。显卡驱动不用
在 WSL 里另装，Windows 的 NVIDIA 驱动自带 WSL 支持。

### 1. 装 WSL2 + Ubuntu（管理员 PowerShell）

```powershell
wsl --install -d Ubuntu-24.04
```

装完重启，首次进入会让你设置 Linux 用户名密码。以后在开始菜单
打开 "Ubuntu" 就进入 Linux 终端，下面的命令都在里面执行。

> 网络提示：WSL 里 git clone GitHub 可能很慢。Clash 开启"允许局域网
> 连接"和 TUN 模式，WSL 一般就能直接走代理。

### 2. 装基础工具 + CUDA 编译器（一次性）

```bash
sudo apt update && sudo apt install -y build-essential ffmpeg python3.12-venv git wget

# NVIDIA 官方源装 CUDA Toolkit 12.8（提供编译 gsplat 用的 nvcc）
wget https://developer.download.nvidia.com/compute/cuda/repos/wsl-ubuntu/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i cuda-keyring_1.1-1_all.deb
sudo apt update && sudo apt install -y cuda-toolkit-12-8

echo 'export PATH=/usr/local/cuda-12.8/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
nvcc --version   # 看到 release 12.8 即成功
nvidia-smi       # 能看到 RTX 5070 即驱动直通正常
```

### 3. 装 SHARP（注意顺序，别乱）

```bash
python3 -m venv ~/sharp-env && source ~/sharp-env/bin/activate

# ① 先装 cu128 的 torch（5070 的命门）
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128

# ② 编译安装 gsplat（运镜渲染内核，编译几分钟）
pip install ninja
TORCH_CUDA_ARCH_LIST="12.0" pip install gsplat --no-build-isolation

# ③ 装 Apple ml-sharp 本体
git clone --depth 1 https://github.com/apple/ml-sharp ~/ml-sharp
pip install ~/ml-sharp

# ④ 防止第③步把 torch 降级回 CPU/旧 CUDA 版，验证一下：
python -c "import torch; print(torch.__version__, torch.cuda.get_device_name(0))"
# 期望输出类似：2.7.x+cu128 NVIDIA GeForce RTX 5070
# 如果版本号不带 cu128，重跑一次①的命令覆盖回来即可
```

### 4. 命令行先跑通一张

```bash
mkdir -p ~/test/in && cp /mnt/c/Users/你的用户名/Pictures/某张照片.jpg ~/test/in/
sharp predict -i ~/test/in -o ~/test/out --render
```

第一次会自动下载 1.4GB 权重并编译渲染内核，之后秒级。
`~/test/out` 里出现 `.ply` 和 `.mp4` 就是全链路打通了。
（WSL 里访问 Windows 文件就是 `/mnt/c/...`，反过来 Windows
资源管理器地址栏输 `\\wsl$` 能看到 Linux 文件。）

### 5. 起本地服务，接上前端

```bash
pip install fastapi uvicorn pillow pillow-heif
cd /mnt/c/你的项目路径/sharp-web        # 进到项目目录
python backend/local_server.py
```

然后在 Windows 这边把 `.env.local` 改成：

```
NEXT_PUBLIC_MODAL_API=http://localhost:8000
```

重启 `npm run dev`，现在每张照片都是你的 5070 在显影，免费且飞快。
（WSL2 的端口 Windows 侧直接用 localhost 就能访问，不用配转发。）

---

## 不想折腾 WSL？原生 Windows 的退路

在你现有的 conda 环境思路下也能跑**推理部分**：

```powershell
conda create -n sharp python=3.11 && conda activate sharp
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
git clone --depth 1 https://github.com/apple/ml-sharp
pip install ./ml-sharp
sharp predict -i 输入文件夹 -o 输出文件夹
```

代价是 `--render`（服务端运镜 mp4）大概率装不上——gsplat 在
Windows 要配 VS Build Tools 编译，失败率高。但其实问题不大：
网页里的实时运镜（环绕/缓推/横移/变焦）是浏览器渲染的，照样全有，
只是少了"云端渲染好的 mp4 下载"。本地服务照常启动，前端会自动
适配没有视频的情况（把页面上"同时渲染运镜视频"的勾去掉即可）。

---

## 真想用自己的电脑对外开放？

一行命令的内网穿透（Cloudflare Tunnel，免费、不要公网 IP）：

```bash
cloudflared tunnel --url http://localhost:8000
```

会给你一个 `https://随机词.trycloudflare.com` 的临时公网地址，
填进 Vercel 的环境变量里，网站就指向你家的 5070 了。
三个代价想清楚：电脑得常开、上行带宽决定别人的加载速度、
接口没有鉴权谁都能调（被刷了烧的是你的电费和显卡）。
临时给朋友演示一晚上没问题，长期挂着不如 Modal。

## 速度与成本对比

| | 本地 5070 | Modal A10G |
| --- | --- | --- |
| 单张耗时（暖机后） | 约 5~10 秒 | 约 20~40 秒（含传输） |
| 冷启动 | 无 | 约 1 分钟 |
| 成本 | 电费 | 免费额度内 0 元 |
| 适合 | 自己玩、开发调试 | 对外网站 |
