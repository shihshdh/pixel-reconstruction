# Pixel Reconstruction · 本机显卡引擎一键安装（Windows 客户端在后台调用）
#
# 装一套独立的运行环境，不碰系统里已有的 Python：
#   <根目录>\python   Python 3.12 嵌入版 + PyTorch(CUDA) + SHARP 依赖
#   <根目录>\models   SHARP 模型权重（从 Apple 官方 CDN 下载）
#   <根目录>\downloads 下载缓存（断点续传用，装好后删除大文件）
#
# 考虑国内直连：每个大文件先对几个源各取 2MB 测速，选最快的；下载用系统自带 curl.exe 断点续传，
# 速度长时间过低会换下一个源；PyTorch 与模型权重都校验 SHA-256。PyPI 依赖依次尝试清华、腾讯、中科大、官方源。
# 中途关掉客户端或断网不要紧：下次启动会从断点继续。
#
# 进度以 JSON 写入 -Status 文件（原子替换），客户端轮询显示。
param(
  [Parameter(Mandatory = $true)][string]$Roots,     # 候选安装位置，用 | 分隔，按顺序选第一个空间足够的
  [Parameter(Mandatory = $true)][string]$Status,    # 进度文件
  [Parameter(Mandatory = $true)][string]$Pointer,   # 装好后把根目录写到这里，客户端据此找到环境
  [Parameter(Mandatory = $true)][string]$Vendor     # 随客户端打包的文件：pip 安装包、SHARP 源码、依赖清单
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# 国内镜像与 Apple CDN 直连更快：即使系统设置了代理也绕过（curl 与 pip 都认 NO_PROXY）
$direct = 'npmmirror.com,.edu.cn,mirrors.cloud.tencent.com,hf-mirror.com,.cdn-apple.com'
$env:NO_PROXY = if ($env:NO_PROXY) { "$env:NO_PROXY,$direct" } else { $direct }

$PythonVersion = '3.12.10'
$PythonZip = @{ Size = 11133606; Sha = '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3' }
$TorchVersion = '2.9.0'
$VisionVersion = '0.24.0'
$Checkpoint = @{
  Name = 'sharp_2572gikvuh.pt'; Size = 2809738232
  Sha = '94211a75198c47f61fca7d739ba08a215418d8d398d48fddf023baccc24f073d'
  Urls = @('https://ml-site.cdn-apple.com/models/sharp/sharp_2572gikvuh.pt',
           'https://hf-mirror.com/apple/Sharp/resolve/main/sharp_2572gikvuh.pt')
}
# 官方 PyTorch 索引公布的哈希
$Wheels = @{
  cu128 = @{ torch = 'c97dc47a1f64745d439dd9471a96d216b728d528011029b4f9ae780e985529e0'; vision = '1aa36ac00106e1381c38348611a1ec0eebe942570ebaf0490f026b061dfc212c' }
  cu126 = @{ torch = '321de9e00dfb066fac4e182c62b6f0a10eb7943924daecb261a7490f98ce3641'; vision = '60727fcbcdc4c87213d177c159a76cbc7b6484c97278f3617e53ba8433056d81' }
}
$PypiMirrors = @('https://pypi.tuna.tsinghua.edu.cn/simple', 'https://mirrors.cloud.tencent.com/pypi/simple',
                 'https://mirrors.ustc.edu.cn/pypi/simple', 'https://pypi.org/simple')
$Steps = 7
$state = [ordered]@{ state = 'running'; step = 0; steps = $Steps; label = '正在准备'; detail = ''; received = 0; total = 0; speed = 0; root = ''; flavor = ''; error = '' }

function Save-Status {
  $state.updated = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  $json = $state | ConvertTo-Json -Compress
  $temporary = "$Status.tmp"
  [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding $false))
  Move-Item -Force $temporary $Status
}
function Set-Step([int]$step, [string]$label, [string]$detail = '') {
  $state.step = $step; $state.label = $label; $state.detail = $detail
  $state.received = 0; $state.total = 0; $state.speed = 0
  Save-Status
}
function Fail([string]$message) { throw [Exception]::new($message) }

$curl = Join-Path $env:SystemRoot 'System32\curl.exe'
if (-not (Test-Path $curl)) { $curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source }

# 对每个源取 2MB 测速，返回按速度从快到慢排好的地址（连不上的排最后，仍保留作兜底）
function Sort-BySpeed([string[]]$urls) {
  $scored = foreach ($url in $urls) {
    $speed = 0
    try {
      $out = & $curl -s -L -f -r 0-2097151 -o NUL -m 10 --connect-timeout 5 -w '%{speed_download}' $url 2>$null
      if ($LASTEXITCODE -eq 0) { $speed = [double]$out }
    } catch {}
    [pscustomobject]@{ Url = $url; Speed = $speed }
  }
  ($scored | Sort-Object -Property Speed -Descending).Url
}

# 断点续传下载 + SHA-256 校验。慢于 80KB/s 持续 60 秒就换下一个源。
function Get-Download([string]$label, [string[]]$urls, [string]$destination, [long]$size, [string]$sha) {
  if ((Test-Path $destination) -and (Get-Item $destination).Length -eq $size) { return }
  $part = "$destination.part"
  $state.detail = '正在测速选择下载源'; Save-Status
  $ordered = Sort-BySpeed $urls
  foreach ($url in $ordered) {
    $host_ = ([Uri]$url).Host
    $have = if (Test-Path $part) { (Get-Item $part).Length } else { 0 }
    if ($have -gt $size) { Remove-Item $part -Force; $have = 0 }
    if ($have -lt $size) {
      $arguments = "-L -f -s -C - --retry 8 --retry-delay 3 --retry-all-errors --connect-timeout 15 -o `"$part`" `"$url`""
      $process = Start-Process -FilePath $curl -ArgumentList $arguments -PassThru -WindowStyle Hidden
      $lastBytes = $have; $lastTime = Get-Date; $slowSince = $null; $speed = 0
      while (-not $process.HasExited) {
        Start-Sleep -Milliseconds 700
        $now = Get-Date
        $bytes = if (Test-Path $part) { (Get-Item $part).Length } else { 0 }
        $seconds = ($now - $lastTime).TotalSeconds
        if ($seconds -ge 1.5) {
          $instant = ($bytes - $lastBytes) / $seconds
          $speed = if ($speed -eq 0) { $instant } else { $speed * 0.6 + $instant * 0.4 }
          $lastBytes = $bytes; $lastTime = $now
          if ($speed -lt 80KB) { if (-not $slowSince) { $slowSince = $now } } else { $slowSince = $null }
          if ($slowSince -and ($now - $slowSince).TotalSeconds -gt 60 -and $ordered.Count -gt 1) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue; break
          }
        }
        $state.label = $label; $state.detail = "来源 $host_"
        $state.received = $bytes; $state.total = $size; $state.speed = [long]$speed
        Save-Status
      }
      $process.WaitForExit()
    }
    if ((Test-Path $part) -and (Get-Item $part).Length -eq $size) {
      $state.detail = '正在校验文件完整性'; $state.speed = 0; Save-Status
      $hash = (Get-FileHash -Algorithm SHA256 $part).Hash.ToLower()
      if ($hash -eq $sha) { Move-Item -Force $part $destination; return }
      Remove-Item $part -Force   # 内容不对：丢掉重下，换下一个源
    }
  }
  Fail "$label 下载失败：所有下载源都不可用，请检查网络后重试。"
}

# 运行一个命令，输出写日志；不把 stderr 当成错误（pip 会在 stderr 打印进度）
function Invoke-Logged([string]$file, [string]$arguments, [string]$log) {
  $process = Start-Process -FilePath $file -ArgumentList $arguments -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput "$log.out" -RedirectStandardError "$log.err"
  # PowerShell 5.1：不先取一次句柄，进程退出后 ExitCode 会是空值（成功也会被当成失败）
  $null = $process.Handle
  while (-not $process.HasExited) {
    Start-Sleep -Milliseconds 800
    $line = Get-Content "$log.out" -Tail 1 -ErrorAction SilentlyContinue
    if ($line -match '^(Collecting|Downloading|Installing|Successfully)') {
      $text = ($line -replace '\s+', ' ').Trim()
      $state.detail = $text.Substring(0, [Math]::Min(90, $text.Length)); Save-Status
    }
  }
  $process.WaitForExit()
  return $process.ExitCode
}

try {
  Save-Status
  # ---- 1. 显卡与驱动 ----
  Set-Step 1 '正在检查显卡'
  $smi = Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'
  if (-not (Test-Path $smi)) { Fail '没有找到 NVIDIA 显卡驱动，本机引擎需要 NVIDIA 独立显卡。' }
  $query = (& $smi --query-gpu=name,memory.total --format=csv,noheader,nounits | Select-Object -First 1) -split ','
  $gpuName = $query[0].Trim(); $memoryMb = [int]$query[1].Trim()
  if ($memoryMb -lt 6000) { Fail "$gpuName 只有 $([Math]::Round($memoryMb / 1024, 1))GB 显存，本机引擎至少需要 6GB，将继续使用云端。" }
  # 新驱动显示为 CUDA UMD Version，旧驱动为 CUDA Version
  $header = (& $smi) -join "`n"
  $cuda = if ($header -match 'CUDA (?:UMD )?Version:\s*(\d+)\.(\d+)') { [int]$Matches[1] * 100 + [int]$Matches[2] } else { 0 }
  if ($cuda -ge 1208) { $flavor = 'cu128' }
  elseif ($cuda -ge 1206 -and $gpuName -notmatch 'RTX 50') { $flavor = 'cu126' }
  else { Fail "显卡驱动版本过旧（支持 CUDA $([Math]::Floor($cuda / 100)).$($cuda % 100)），请到 NVIDIA 官网更新驱动后重试。" }
  $state.flavor = $flavor

  # 安装位置：候选里第一个剩余空间足够的（全新安装约需 14GB，装好后占用约 9GB）
  $root = $null
  foreach ($candidate in ($Roots -split '\|')) {
    $drive = [IO.Path]::GetPathRoot($candidate)
    if (-not (Test-Path $drive)) { continue }
    $free = (New-Object IO.DriveInfo $drive).AvailableFreeSpace
    $existing = Test-Path (Join-Path $candidate 'downloads')
    if ($existing -or $free -gt 14GB) { $root = $candidate; break }
  }
  if (-not $root) { Fail '磁盘空间不足：本机引擎需要约 14GB 可用空间。' }
  $state.root = $root
  $downloads = Join-Path $root 'downloads'; $pythonDir = Join-Path $root 'python'; $models = Join-Path $root 'models'
  New-Item -ItemType Directory -Force $downloads, $models | Out-Null
  if (-not $curl) { Fail '系统缺少 curl.exe（Windows 10 1803 以上自带），请更新 Windows 后重试。' }

  # ---- 2. Python 嵌入版 ----
  Set-Step 2 '正在准备 Python 运行环境'
  $python = Join-Path $pythonDir 'python.exe'
  if (-not (Test-Path $python)) {
    $zip = Join-Path $downloads "python-$PythonVersion-embed-amd64.zip"
    $urls = @("https://registry.npmmirror.com/-/binary/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip",
              "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip")
    Get-Download '正在下载 Python 运行环境' $urls $zip $PythonZip.Size $PythonZip.Sha
    $state.detail = '正在解压'; Save-Status
    Expand-Archive -Force $zip $pythonDir
  }
  # 嵌入版默认不加载 site-packages：打开它
  $pth = Get-ChildItem $pythonDir -Filter 'python*._pth' | Select-Object -First 1
  $zipName = (Get-ChildItem $pythonDir -Filter 'python3*.zip' | Select-Object -First 1).Name
  [IO.File]::WriteAllText($pth.FullName, "$zipName`r`n.`r`nLib\site-packages`r`nimport site`r`n")
  if (-not (Test-Path (Join-Path $pythonDir 'Lib\site-packages\pip'))) {
    # wheel 就是 zip，pip 是纯 Python：直接解压进 site-packages 即完成安装（pip 不允许用 wheel 自举修改自身）
    $pipWheel = (Get-ChildItem $Vendor -Filter 'pip-*.whl' | Select-Object -First 1).FullName
    $pipZip = Join-Path $downloads 'pip.zip'
    Copy-Item -Force $pipWheel $pipZip
    Expand-Archive -Force $pipZip (Join-Path $pythonDir 'Lib\site-packages')
    Remove-Item -Force $pipZip
  }

  # ---- 3/4. PyTorch（CUDA 版） ----
  $torchFile = "torch-$TorchVersion+$flavor-cp312-cp312-win_amd64.whl"
  $visionFile = "torchvision-$VisionVersion+$flavor-cp312-cp312-win_amd64.whl"
  $torchInstalled = Test-Path (Join-Path $pythonDir "Lib\site-packages\torch-$TorchVersion+$flavor.dist-info")
  $torchPath = Join-Path $downloads $torchFile; $visionPath = Join-Path $downloads $visionFile
  function Torch-Urls([string]$file) {
    $encoded = $file -replace '\+', '%2B'
    @("https://mirror.nju.edu.cn/pytorch/whl/$flavor/$encoded",
      "https://mirror.sjtu.edu.cn/pytorch-wheels/$flavor/$file",
      "https://download.pytorch.org/whl/$flavor/$encoded")
  }
  if (-not $torchInstalled) {
    Set-Step 3 '正在下载 PyTorch（CUDA 版）'
    $sizes = @{}
    foreach ($file in @($torchFile, $visionFile)) {
      # 取文件大小：任一源的 Content-Length
      foreach ($url in (Torch-Urls $file)) {
        $head = & $curl -sIL -m 20 $url 2>$null
        $length = ($head | Select-String -Pattern '^content-length:\s*(\d+)' | Select-Object -Last 1)
        if ($length) { $sizes[$file] = [long]$length.Matches[0].Groups[1].Value; break }
      }
      if (-not $sizes[$file]) { Fail 'PyTorch 下载源都无法连接，请检查网络后重试。' }
    }
    Get-Download '正在下载 PyTorch（CUDA 版）' (Torch-Urls $torchFile) $torchPath $sizes[$torchFile] $Wheels[$flavor].torch
    Get-Download '正在下载 TorchVision' (Torch-Urls $visionFile) $visionPath $sizes[$visionFile] $Wheels[$flavor].vision
  }

  # ---- 5. 其余依赖 ----
  Set-Step 4 '正在安装 PyTorch 与依赖'
  $requirements = Join-Path $Vendor 'requirements-engine.txt'
  $wheelArgs = if ($torchInstalled) { '' } else { "`"$torchPath`" `"$visionPath`"" }
  $installed = $false; $attempt = 0
  foreach ($mirror in $PypiMirrors) {
    $attempt++
    $state.detail = "依赖源 $(([Uri]$mirror).Host)"; Save-Status
    $arguments = "-m pip install --no-warn-script-location --disable-pip-version-check --only-binary=:all: --timeout 30 --retries 3 -i $mirror $wheelArgs -r `"$requirements`""
    $code = Invoke-Logged $python $arguments (Join-Path $downloads "pip-install-$attempt")
    if ($code -eq 0) { $installed = $true; break }
  }
  if (-not $installed) { Fail '依赖安装失败：所有 PyPI 镜像都不可用，请检查网络后重试。' }

  # ---- 6. SHARP 本体（随客户端打包，Apple 许可允许再分发） ----
  Set-Step 5 '正在安装 SHARP'
  $site = Join-Path $pythonDir 'Lib\site-packages'
  Remove-Item -Recurse -Force (Join-Path $site 'sharp') -ErrorAction SilentlyContinue
  Copy-Item -Recurse -Force (Join-Path $Vendor 'ml-sharp\sharp') (Join-Path $site 'sharp')
  Copy-Item -Force (Join-Path $Vendor 'ml-sharp\LICENSE*') $models

  # ---- 7. 模型权重 ----
  Set-Step 6 '正在下载模型权重'
  Get-Download '正在下载模型权重' $Checkpoint.Urls (Join-Path $models $Checkpoint.Name) $Checkpoint.Size $Checkpoint.Sha

  # ---- 8. 验证 ----
  Set-Step 7 '正在验证显卡环境'
  $check = Join-Path $downloads 'verify.py'
  [IO.File]::WriteAllText($check, "import torch, fastapi, uvicorn, multipart, PIL, numpy`nimport sharp.cli.predict`nassert torch.cuda.is_available(), 'CUDA 不可用'`nprint(torch.__version__, torch.cuda.get_device_name(0))`n")
  $code = Invoke-Logged $python "`"$check`"" (Join-Path $downloads 'verify')
  if ($code -ne 0) {
    $reason = (Get-Content "$(Join-Path $downloads 'verify').err" -Tail 1 -ErrorAction SilentlyContinue)
    Fail "环境验证失败：$reason"
  }
  # 装好后删掉大文件缓存，只留环境和权重
  Remove-Item -Force $torchPath, $visionPath -ErrorAction SilentlyContinue
  [IO.File]::WriteAllText($Pointer, $root, (New-Object Text.UTF8Encoding $false))
  $state.state = 'done'; $state.label = '本机引擎已安装'; $state.detail = $gpuName; Save-Status
} catch {
  $state.state = 'error'; $state.error = $_.Exception.Message; Save-Status
  exit 1
}
