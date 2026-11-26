<#
.SYNOPSIS
clis 统一 Windows 一键安装脚本

.DESCRIPTION
自动探测系统 bun 或 node (>= 22.18.0)；若缺失，则默认下载安装隔离私有 Bun 运行时，
并完成校验解包、运行时依赖安装、命令入口封装及孤立安装自更新兼容。

.EXAMPLE
irm https://raw.githubusercontent.com/iyowei/clis/main/install.ps1 | iex
$env:CLIS_TOOL="codd"; irm https://raw.githubusercontent.com/iyowei/clis/main/install.ps1 | iex
#>
[CmdletBinding()]
param(
  [string]$Tool = $env:CLIS_TOOL,
  [string]$Version = '',
  [string]$InstallerUrl = '',
  [string]$BunUrl = '',
  [string]$Registry = '',
  [string]$FromTarball = '',
  [string]$DataDir = '',
  [string]$BinDir = '',
  [switch]$NoPath,
  [switch]$Uninstall,
  [switch]$Yes,
  [Alias('h')]
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

function Write-Help {
  @'
clis 统一一键安装脚本 (Windows PowerShell)

用法:
  .\install.ps1 [选项]
  $env:CLIS_TOOL="codd"; irm https://raw.githubusercontent.com/iyowei/clis/main/install.ps1 | iex

支持工具:
  codd         @iyowei/codd-cli      全栈开发环境自动编排器 (Podman / K8s / Helm / MongoDB)
  create-clis  create-clis           在 iyowei/clis 仓内生成标准化 TypeScript + Bun CLI 包
  sweep        @iyowei/sweep-cli     通用多技术栈磁盘清理与缓存治理器
  fan          @iyowei/fan-cli       仅支持 macOS (Windows 将直接提示不支持并中止)

选项:
  -Tool <name>                要安装的 CLI 工具名 (或设环境变量 CLIS_TOOL)
  -Version <ver>              指定目标 CLI 的版本或标签 (默认: latest)
  -InstallerUrl <url>         自定义主安装脚本本身的完整下载地址 (包入口脚本拉取主脚本时使用)
  -BunUrl <url>               自定义私有 Bun 运行时下载地址 (.zip 完整直链 / Release 目录 / {file} 模板)
  -Registry <url>             自定义 npm 软件源地址, 用于下载目标 CLI 及依赖 (默认: https://registry.npmjs.org)
  -FromTarball <path|url>     跳过 npm 源, 直接从本地 .tgz 文件或下载直链安装目标 CLI 压缩包 (如 npm pack 产物)
  -NoPath                     跳过写入用户环境变量 PATH
  -Uninstall                  卸载指定工具 (所有工具清空后同步回收私有 Bun)
  -Yes                        非交互自动确认
  -Help                       显示帮助

环境变量 (<TOOL> 可为 CODD / CREATE_CLIS / SWEEP / FAN, 亦兼容 CLIS_* / NPM_CONFIG_REGISTRY):
  <TOOL>_INSTALLER_URL / <TOOL>_BUN_URL / <TOOL>_REGISTRY / NPM_CONFIG_REGISTRY /
  <TOOL>_VERSION / <TOOL>_INSTALL_HOME / <TOOL>_BIN_DIR / <TOOL>_NO_MODIFY_PATH
'@ | Write-Output
}

function Fail-Install {
  param([string]$Message)
  [Console]::Error.WriteLine("错误: $Message")
  exit 1
}

function Assert-HttpUrl {
  param([string]$FlagName, [string]$UrlValue)
  if ([string]::IsNullOrWhiteSpace($UrlValue)) {
    return
  }
  if ($UrlValue -notmatch '^https?://' -or $UrlValue -match '[\s"'']') {
    Fail-Install "非法的 $FlagName 地址 (仅支持无空白与引号的 http/https URL): $UrlValue"
  }
}

function Resolve-ToolSpec {
  param([string]$RawTool)
  switch ($RawTool) {
    { $_ -in @('fan', 'fan-cli', '@iyowei/fan-cli') } {
      return @{
        Key = 'fan'
        EnvPrefix = 'FAN'
        PackageName = '@iyowei/fan-cli'
        BinName = 'fan'
        EntryFile = 'fan.mjs'
        DistFile = 'cli.js'
        OnlyOs = 'darwin'
      }
    }
    { $_ -in @('codd', 'codd-cli', '@iyowei/codd-cli') } {
      return @{
        Key = 'codd'
        EnvPrefix = 'CODD'
        PackageName = '@iyowei/codd-cli'
        BinName = 'codd'
        EntryFile = 'codd.mjs'
        DistFile = 'cli.js'
        OnlyOs = 'all'
      }
    }
    'create-clis' {
      return @{
        Key = 'create-clis'
        EnvPrefix = 'CREATE_CLIS'
        PackageName = 'create-clis'
        BinName = 'create-clis'
        EntryFile = 'create-clis.mjs'
        DistFile = 'create-clis.js'
        OnlyOs = 'all'
      }
    }
    { $_ -in @('sweep', 'sweep-cli', '@iyowei/sweep-cli') } {
      return @{
        Key = 'sweep'
        EnvPrefix = 'SWEEP'
        PackageName = '@iyowei/sweep-cli'
        BinName = 'sweep'
        EntryFile = 'sweep.mjs'
        DistFile = 'cli.js'
        OnlyOs = 'all'
      }
    }
    default {
      Fail-Install "不支持的工具: $RawTool (可选: codd, create-clis, sweep, fan)"
    }
  }
}

function Get-ToolEnv {
  param([string]$EnvPrefix, [string]$Suffix)
  $toolVal = [Environment]::GetEnvironmentVariable("${EnvPrefix}_${Suffix}")
  if (-not [string]::IsNullOrWhiteSpace($toolVal)) {
    return $toolVal.Trim()
  }
  $clisVal = [Environment]::GetEnvironmentVariable("CLIS_${Suffix}")
  if (-not [string]::IsNullOrWhiteSpace($clisVal)) {
    return $clisVal.Trim()
  }
  if ($Suffix -eq 'REGISTRY' -and -not [string]::IsNullOrWhiteSpace($env:NPM_CONFIG_REGISTRY)) {
    return $env:NPM_CONFIG_REGISTRY.Trim()
  }
  return ''
}

function Prompt-ToolIfNeeded {
  param([string]$CurrentTool, [string]$ScriptUrl, [switch]$AutoYes)
  if (-not [string]::IsNullOrWhiteSpace($CurrentTool)) {
    return $CurrentTool.Trim()
  }
  $nonInteractive = (-not [string]::IsNullOrWhiteSpace($env:CI)) -or (-not [string]::IsNullOrWhiteSpace($env:CLIS_NON_INTERACTIVE)) -or $AutoYes
  if (-not $nonInteractive) {
    try {
      if ($Host.UI -and $Host.UI.RawUI) {
        Write-Host ''
        Write-Host '请选择要安装的 CLI 工具:'
        Write-Host '  1) codd         (全栈开发环境编排器)'
        Write-Host '  2) create-clis  (monorepo 包脚手架生成)'
        Write-Host '  3) sweep        (多技术栈磁盘清理器)'
        Write-Host '  4) fan          (仅 macOS 可用)'
        $choice = Read-Host '输入序号 [1-4]'
        switch ($choice.Trim()) {
          '1' { return 'codd' }
          'codd' { return 'codd' }
          '2' { return 'create-clis' }
          'create-clis' { return 'create-clis' }
          '3' { return 'sweep' }
          'sweep' { return 'sweep' }
          '4' { return 'fan' }
          'fan' { return 'fan' }
          default { Fail-Install "无效选择: $choice" }
        }
      }
    } catch {
      # 无交互终端直接落到底部清晰指引
    }
  }
  Fail-Install "未指定工具名称。请先设置 CLIS_TOOL 或传 -Tool，例如:`n  `$env:CLIS_TOOL=`"codd`"; irm $ScriptUrl | iex"
}

function Get-AbsPathDirs {
  $raw = [Environment]::GetEnvironmentVariable('PATH')
  if ([string]::IsNullOrWhiteSpace($raw)) {
    $raw = [Environment]::GetEnvironmentVariable('Path')
  }
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return @()
  }
  $dirs = @()
  foreach ($part in ($raw -split ';')) {
    $clean = $part.Trim().Trim('"')
    if ([string]::IsNullOrWhiteSpace($clean)) { continue }
    if ($clean -match '^[A-Za-z]:[/\\]|^\\\\[^\\]+\\[^\\]+') {
      $dirs += $clean
    }
  }
  return $dirs
}

function Test-NodeSupported {
  param([string]$NodeExe)
  try {
    & $NodeExe -e "var p=process.versions.node.split('.');var a=parseInt(p[0],10),b=parseInt(p[1],10);process.exit((a>22||(a===22&&b>=18))?0:1)" *> $null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Detect-ExistingRuntime {
  param([string]$RuntimeDir, [string]$ExplicitBunUrl)
  $dirs = Get-AbsPathDirs
  $hostBun = ''
  $hostNode = ''
  $hostNpm = ''
  $skippedNode = ''

  foreach ($dir in $dirs) {
    if (-not $hostBun) {
      foreach ($ext in @('.exe', '.com')) {
        $cand = Join-Path $dir "bun$ext"
        if (Test-Path -LiteralPath $cand -PathType Leaf) {
          try {
            & $cand --version *> $null
            if ($LASTEXITCODE -eq 0) { $hostBun = $cand; break }
          } catch {}
        }
      }
    }
    if (-not $hostNode) {
      foreach ($ext in @('.exe', '.com')) {
        $cand = Join-Path $dir "node$ext"
        if (Test-Path -LiteralPath $cand -PathType Leaf) {
          if (Test-NodeSupported -NodeExe $cand) {
            $hostNode = $cand
            break
          } elseif (-not $skippedNode) {
            $nver = (& $cand -v 2>$null | Select-Object -First 1)
            $skippedNode = "$cand ($nver)"
          }
        }
      }
    }
    if (-not $hostNpm) {
      foreach ($ext in @('.exe', '.com', '.cmd', '.bat')) {
        $cand = Join-Path $dir "npm$ext"
        if (Test-Path -LiteralPath $cand -PathType Leaf) {
          $hostNpm = $cand
          break
        }
      }
    }
  }

  $privateBun = ''
  $privCand = Join-Path $RuntimeDir 'bun.exe'
  if (Test-Path -LiteralPath $privCand -PathType Leaf) {
    try {
      & $privCand --version *> $null
      if ($LASTEXITCODE -eq 0) { $privateBun = $privCand }
    } catch {}
  }

  $active = ''
  $kind = ''
  if ($hostBun) {
    $active = $hostBun; $kind = 'system-bun'
    $ver = (& $hostBun --version 2>$null | Select-Object -First 1)
    Write-Output "✓ 检测到系统 Bun: $hostBun ($ver)"
  } elseif ($hostNode) {
    $active = $hostNode; $kind = 'system-node'
    $ver = (& $hostNode --version 2>$null | Select-Object -First 1)
    Write-Output "✓ 检测到系统 Node: $hostNode ($ver)"
  } else {
    if ($skippedNode) {
      Write-Output "ℹ 检测到系统 Node 低于最低要求 (>= 22.18.0), 已跳过: $skippedNode"
    }
    if ($privateBun) {
      $active = $privateBun; $kind = 'private-bun'
      $ver = (& $privateBun --version 2>$null | Select-Object -First 1)
      Write-Output "✓ 检测到已安装的私有隔离 Bun: $privateBun ($ver)"
    }
  }

  if ($active -and $ExplicitBunUrl) {
    [Console]::Error.WriteLine("警告: 已检测到可用运行时 ($active), 跳过私有 Bun 下载, 未使用 -BunUrl ($ExplicitBunUrl)")
  }

  return @{
    HostBun = $hostBun
    HostNode = $hostNode
    HostNpm = $hostNpm
    PrivateBun = $privateBun
    ActiveRuntime = $active
    ActiveKind = $kind
  }
}

function Select-BunWindowsZip {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ([System.Environment]::Is64BitOperatingSystem -and $env:PROCESSOR_ARCHITEW6432) {
    $arch = $env:PROCESSOR_ARCHITEW6432
  }
  if ($arch -match 'ARM64|aarch64') {
    return 'bun-windows-aarch64.zip'
  }
  $hasAvx2 = $true
  try {
    $sig = '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);'
    $type = Add-Type -MemberDefinition $sig -Name 'ClisKernel32Avx2Probe' -Namespace 'ClisInstall' -PassThru -ErrorAction Stop
    # 40 = PF_AVX2_INSTRUCTIONS_AVAILABLE
    $hasAvx2 = [bool]$type::IsProcessorFeaturePresent(40)
  } catch {
    $hasAvx2 = $true
  }
  if ($hasAvx2) {
    return 'bun-windows-x64.zip'
  }
  return 'bun-windows-x64-baseline.zip'
}

function Resolve-BunUrlsFromSpec {
  param([string]$SpecUrl, [string]$DefaultZip)
  if ($SpecUrl.Contains('{file}')) {
    return @{
      ZipName = $DefaultZip
      ZipUrl = $SpecUrl.Replace('{file}', $DefaultZip)
      SumUrl = $SpecUrl.Replace('{file}', 'SHASUMS256.txt')
    }
  }
  $noFrag = ($SpecUrl -split '#', 2)[0]
  $noQuery = ($noFrag -split '\?', 2)[0]
  if ($noQuery -match '\.zip$') {
    $zipName = ($noQuery -split '/')[-1]
    if ($zipName -notmatch '^[A-Za-z0-9._-]+$' -or $zipName -in @('.', '..')) {
      Fail-Install "非法的 Bun 压缩包文件名: $zipName"
    }
    $slashIdx = $noQuery.LastIndexOf('/')
    $parentBase = if ($slashIdx -gt 0) { $noQuery.Substring(0, $slashIdx) } else { $noQuery }
    return @{
      ZipName = $zipName
      ZipUrl = $SpecUrl
      SumUrl = "$parentBase/SHASUMS256.txt"
    }
  }
  $base = $SpecUrl.TrimEnd('/')
  return @{
    ZipName = $DefaultZip
    ZipUrl = "$base/$DefaultZip"
    SumUrl = "$base/SHASUMS256.txt"
  }
}

function Find-ShaSumEntry {
  param([string]$SumText, [string]$ZipName)
  foreach ($line in ($SumText -split "`r?`n")) {
    if ($line -match '^\s*([0-9a-fA-F]{64})\s+(\./)?(.+?)\s*$') {
      if ($Matches[3] -eq $ZipName) {
        return $Matches[1].ToLowerInvariant()
      }
    }
  }
  return ''
}

function Install-PrivateBun {
  param([string]$RuntimeDir, [string]$TmpRoot, [string]$CustomBunUrl, [string]$BunVer, [string]$EnvPrefix)
  $zipName = Select-BunWindowsZip
  $bunUrlVal = if ($CustomBunUrl) { $CustomBunUrl.Trim() } else { '' }

  $dlDir = Join-Path $TmpRoot 'bun-dl'
  New-Item -ItemType Directory -Path $dlDir -Force | Out-Null
  $sumPath = Join-Path $dlDir 'SHASUMS256.txt'
  Write-Output "→ 正在下载私有隔离 Bun 运行时 ($zipName)..."

  if ($bunUrlVal) {
    $pair = Resolve-BunUrlsFromSpec -SpecUrl $bunUrlVal -DefaultZip $zipName
    $zipName = $pair.ZipName
    $zipUrl = $pair.ZipUrl
    $sumUrl = $pair.SumUrl
  } else {
    $base = if (-not [string]::IsNullOrWhiteSpace($BunVer)) {
      $cleanV = $BunVer.TrimStart('v')
      "https://github.com/oven-sh/bun/releases/download/bun-v$cleanV"
    } else {
      'https://github.com/oven-sh/bun/releases/latest/download'
    }
    $zipUrl = "$base/$zipName"
    $sumUrl = "$base/SHASUMS256.txt"
  }

  try {
    Write-Output "→ 正在下载私有隔离 Bun 校验清单 ($sumUrl)..."
    Invoke-WebRequest -Uri $sumUrl -OutFile $sumPath -TimeoutSec 30 -UseBasicParsing
    $sumText = Get-Content -LiteralPath $sumPath -Raw -Encoding UTF8
    $expectedSha = Find-ShaSumEntry -SumText $sumText -ZipName $zipName
  } catch {
    if (-not $bunUrlVal) {
      [Console]::Error.WriteLine("警告: 若无法直连 github.com，可传 -BunUrl <url> 或设 ${EnvPrefix}_BUN_URL 自定义完整下载地址")
    }
    Fail-Install "下载 Bun 校验清单 SHASUMS256.txt 失败 ($sumUrl): $($_.Exception.Message)"
  }
  if (-not $expectedSha) {
    Fail-Install "SHASUMS256.txt 中未找到 $zipName 的 SHA-256 摘要"
  }

  $zipPath = Join-Path $dlDir $zipName
  try {
    Write-Output "→ 正在下载私有隔离 Bun ($zipName): $zipUrl..."
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -TimeoutSec 180 -UseBasicParsing
  } catch {
    Fail-Install "下载 $zipName 失败 ($zipUrl): $($_.Exception.Message)"
  }

  $actualSha = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha -ne $expectedSha) {
    Fail-Install "私有 Bun 下载包 SHA-256 校验失败 (期望: $expectedSha, 实际: $actualSha)"
  }

  Write-Output '✓ Bun SHA-256 校验通过, 正在解压...'
  $unpackDir = Join-Path $dlDir 'unpacked'
  Expand-Archive -LiteralPath $zipPath -DestinationPath $unpackDir -Force
  $reparseHit = Get-ChildItem -LiteralPath $unpackDir -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint } |
    Select-Object -First 1
  if ($reparseHit) {
    Remove-Item -LiteralPath $unpackDir -Recurse -Force -ErrorAction SilentlyContinue
    Fail-Install 'Bun 压缩包包含不安全的重解析点/符号链接, 已拒绝安装'
  }
  $bunFound = Get-ChildItem -Path $unpackDir -Filter 'bun.exe' -Recurse -File | Select-Object -First 1
  if (-not $bunFound) {
    Fail-Install "解压 $zipName 后未找到 bun.exe"
  }

  New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
  $destExe = Join-Path $RuntimeDir 'bun.exe'
  $randId = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $tmpExe = Join-Path $RuntimeDir "bun.tmp.$randId.exe"
  Copy-Item -LiteralPath $bunFound.FullName -Destination $tmpExe -Force
  Move-Item -LiteralPath $tmpExe -Destination $destExe -Force

  & $destExe --version *> $null
  if ($LASTEXITCODE -ne 0) {
    Fail-Install "新安装的私有 Bun 无法正常启动: $destExe"
  }
  $ver = (& $destExe --version 2>$null | Select-Object -First 1)
  Write-Output "✓ 私有隔离 Bun 已就绪 (未修改系统全局 PATH): $destExe ($ver)"
  return $destExe
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Text)
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Write-ExtractScript {
  param([string]$ScriptPath)
  $js = @'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const MAX_TGZ_BYTES = 64 * 1024 * 1024;
const MAX_TAR_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 20000;

const [tgzPath, destDir, integrity, shasum, expectedPkg, entryFile, distFile] = process.argv.slice(2);
const st = fs.statSync(tgzPath);
if (st.size > MAX_TGZ_BYTES) {
  console.error("Tarball exceeds 64 MiB safety limit (" + st.size + " bytes)");
  process.exit(3);
}
const bytes = fs.readFileSync(tgzPath);

if (integrity || shasum) {
  let verified = false;
  if (integrity) {
    for (const token of integrity.split(/\s+/).filter(Boolean)) {
      const idx = token.indexOf("-");
      if (idx <= 0) continue;
      const algo = token.slice(0, idx).toLowerCase();
      if (algo !== "sha512" && algo !== "sha256") continue;
      const exp = Buffer.from(token.slice(idx + 1), "base64");
      const act = crypto.createHash(algo).update(bytes).digest();
      if (exp.length > 0 && exp.length === act.length && crypto.timingSafeEqual(exp, act)) {
        verified = true;
        break;
      }
      console.error("Tarball " + algo + " integrity check failed");
      process.exit(3);
    }
  }
  if (!verified && shasum) {
    const exp = Buffer.from(shasum, "hex");
    const act = crypto.createHash("sha1").update(bytes).digest();
    if (exp.length === act.length && crypto.timingSafeEqual(exp, act)) {
      verified = true;
    } else {
      console.error("Tarball shasum check failed");
      process.exit(3);
    }
  }
  if (!verified) {
    console.error("Missing verifiable integrity digest; aborted");
    process.exit(3);
  }
}

const tar = zlib.gunzipSync(bytes, { maxOutputLength: MAX_TAR_BYTES });
const readStr = (b, s, l) => {
  let e = s;
  const m = Math.min(b.length, s + l);
  while (e < m && b[e] !== 0) e += 1;
  return Buffer.from(b.subarray(s, e)).toString("utf8");
};
const readNum = (b, s, l) => {
  const first = b[s] || 0;
  if (first >= 128) {
    let v = first - 128;
    for (let i = 1; i < l; i += 1) v = v * 256 + (b[s + i] || 0);
    return v;
  }
  const raw = readStr(b, s, l).trim();
  if (!raw) return 0;
  const p = Number.parseInt(raw, 8);
  if (!Number.isFinite(p) || p < 0) throw new Error("Invalid octal: " + raw);
  return p;
};
const checksumOk = (h) => {
  const exp = readNum(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += (i >= 148 && i < 156) ? 0x20 : (h[i] || 0);
  return sum === exp;
};
const parsePax = (d) => {
  const out = {};
  const txt = Buffer.from(d).toString("utf8");
  let c = 0;
  while (c < txt.length) {
    const sp = txt.indexOf(" ", c);
    if (sp <= c) break;
    const len = Number.parseInt(txt.slice(c, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = txt.slice(sp + 1, c + len);
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1).replace(/\n$/, "");
    c += len;
  }
  return out;
};
const cleanRel = (raw) => {
  if (raw.includes("\0")) throw new Error("NUL byte in tar path");
  const norm = raw.replaceAll("\\", "/").replace(/^\.\//, "");
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) throw new Error("Unsafe absolute path: " + raw);
  const segs = norm.split("/").filter((x) => x !== "" && x !== ".");
  if (segs.includes("..")) throw new Error("Unsafe traversal path: " + raw);
  if (segs.length <= 1) return null;
  return segs.slice(1).join("/") || null;
};

fs.mkdirSync(destDir, { recursive: true });
const absRoot = path.resolve(destDir);
const rootPrefix = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
let off = 0, pax = null, longName = null, entryCount = 0, totalWritten = 0;
while (off + 512 <= tar.length) {
  const hdr = tar.subarray(off, off + 512);
  let zero = true;
  for (let i = 0; i < 512; i += 1) { if (hdr[i] !== 0) { zero = false; break; } }
  if (zero) break;
  if (!checksumOk(hdr)) throw new Error("Corrupt tar header at " + off);
  const tb = hdr[156] || 0;
  const tf = tb === 0 ? "0" : String.fromCharCode(tb);
  const mode = readNum(hdr, 100, 8);
  let size = readNum(hdr, 124, 12);
  const base = readStr(hdr, 0, 100);
  const prefix = readStr(hdr, 345, 155);
  let name = prefix ? prefix + "/" + base : base;
  const isMeta = tf === "x" || tf === "g" || tf === "L" || tf === "K";
  if (!isMeta && pax && typeof pax.size === "string") {
    const ps = Number.parseInt(pax.size, 10);
    if (Number.isFinite(ps) && ps >= 0) size = ps;
  }
  off += 512;
  if (off + size > tar.length) throw new Error("Truncated tar payload");
  const data = tar.subarray(off, off + size);
  off += Math.ceil(size / 512) * 512;
  if (tf === "x") { pax = parsePax(data); continue; }
  if (tf === "g" || tf === "K") continue;
  if (tf === "L") { longName = Buffer.from(data).toString("utf8").replace(/\0+$/, ""); continue; }
  if (pax) { if (pax.path) name = pax.path; pax = null; }
  if (longName !== null) { name = longName; longName = null; }
  if (name === "pax_global_header") continue;
  if (tf !== "0" && tf !== "5") throw new Error("Unsafe tar entry type: " + tf + " (" + name + ")");
  const rel = cleanRel(name);
  if (!rel) continue;
  entryCount += 1;
  if (entryCount > MAX_ENTRIES) throw new Error("Archive entry count exceeds safety limit");
  const target = path.resolve(absRoot, rel);
  if (!target.startsWith(rootPrefix)) throw new Error("Zip-Slip blocked: " + rel);
  if (tf === "5") {
    fs.mkdirSync(target, { recursive: true });
    continue;
  }
  totalWritten += data.byteLength;
  if (totalWritten > MAX_TAR_BYTES) throw new Error("Archive extracted size exceeds safety limit");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  const perm = mode % 512;
  const hasX = (Math.floor(perm / 64) % 2 === 1) || (Math.floor(perm / 8) % 2 === 1) || (perm % 2 === 1);
  try { fs.chmodSync(target, hasX ? 0o755 : 0o644); } catch {}
}

const pkgPath = path.join(absRoot, "package.json");
if (!fs.existsSync(pkgPath)) throw new Error("Missing package.json in tarball");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
if (pkg.name !== expectedPkg) {
  throw new Error("Package name mismatch: expected " + expectedPkg + ", got " + String(pkg.name));
}
const distTarget = path.join(absRoot, "dist", distFile);
if (
  !fs.existsSync(path.join(absRoot, "bin", entryFile)) ||
  !fs.existsSync(path.join(absRoot, "bin", "bunfig.toml")) ||
  !fs.existsSync(distTarget)
) {
  throw new Error("Incomplete CLI package archive (missing bin/" + entryFile + ", bin/bunfig.toml, or dist/" + distFile + ")");
}
const manifestPath = path.join(absRoot, "dist", "manifest.json");
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.cliSha256 !== "string") {
    throw new Error("Invalid dist/manifest.json schema");
  }
  const actualCliSha = crypto.createHash("sha256").update(fs.readFileSync(distTarget)).digest("hex");
  if (actualCliSha !== manifest.cliSha256) {
    throw new Error("Artifact SHA-256 mismatch with dist/manifest.json");
  }
}
const hasDeps = pkg.dependencies && typeof pkg.dependencies === "object" && Object.keys(pkg.dependencies).length > 0;
console.log((pkg.version || "0.0.0") + "\n" + (hasDeps ? "1" : "0"));
'@
  Write-Utf8NoBom -Path $ScriptPath -Text $js
}

function Write-WindowsCmdShim {
  param(
    [string]$BinDir,
    [string]$BinPath,
    [string]$AppDir,
    [string]$RuntimeDir,
    [string]$EntryFile,
    [string]$BinName
  )
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  $cmdBody = @"
@echo off
setlocal EnableExtensions

set "CLIS_APP_DIR=$AppDir"
set "CLIS_ENTRY=%CLIS_APP_DIR%\bin\$EntryFile"
set "CLIS_BUNFIG=%CLIS_APP_DIR%\bin\bunfig.toml"
set "CLIS_PRIVATE_BUN=$RuntimeDir\bun.exe"

if not exist "%CLIS_ENTRY%" (
  >&2 echo ${BinName}: entry not found ^("%CLIS_ENTRY%"^). Please re-run installer.
  exit /b 1
)

if not exist "%CLIS_BUNFIG%" (
  >&2 echo ${BinName}: isolated bunfig missing ^("%CLIS_BUNFIG%"^). Refusing to run.
  exit /b 1
)

set "CLIS_SYS_BUN="
for %%I in (bun.exe bun.com) do (
  if not defined CLIS_SYS_BUN (
    for %%F in ("%%~`$PATH:I") do (
      if exist "%%~fF" set "CLIS_SYS_BUN=%%~fF"
    )
  )
)
if defined CLIS_SYS_BUN (
  "%CLIS_SYS_BUN%" --version >nul 2>nul
  if not errorlevel 1 (
    set "CLIS_BUN_ISOLATED=1"
    "%CLIS_SYS_BUN%" "--config=%CLIS_BUNFIG%" --no-env-file "%CLIS_ENTRY%" %*
    exit /b %ERRORLEVEL%
  )
)

set "CLIS_SYS_NODE="
for %%I in (node.exe node.com) do (
  if not defined CLIS_SYS_NODE (
    for %%F in ("%%~`$PATH:I") do (
      if exist "%%~fF" set "CLIS_SYS_NODE=%%~fF"
    )
  )
)
if defined CLIS_SYS_NODE (
  "%CLIS_SYS_NODE%" -e "var p=process.versions.node.split('.');var a=parseInt(p[0],10),b=parseInt(p[1],10);process.exit((a>22||(a===22&&b>=18))?0:1)" >nul 2>nul
  if not errorlevel 1 (
    "%CLIS_SYS_NODE%" "%CLIS_ENTRY%" %*
    exit /b %ERRORLEVEL%
  )
)

if exist "%CLIS_PRIVATE_BUN%" (
  "%CLIS_PRIVATE_BUN%" --version >nul 2>nul
  if not errorlevel 1 (
    set "CLIS_BUN_ISOLATED=1"
    "%CLIS_PRIVATE_BUN%" "--config=%CLIS_BUNFIG%" --no-env-file "%CLIS_ENTRY%" %*
    exit /b %ERRORLEVEL%
  )
)

>&2 echo ${BinName}: requires bun or node ^(^>= 22.18.0^); private Bun missing ^("%CLIS_PRIVATE_BUN%"^).
exit /b 1
"@
  $crlf = ($cmdBody -replace "`r?`n", "`r`n")
  $shimRand = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $tmpShim = "$BinPath.tmp.$shimRand.cmd"
  Write-Utf8NoBom -Path $tmpShim -Text $crlf
  Move-Item -LiteralPath $tmpShim -Destination $BinPath -Force
}

function Add-ToUserPathIfNeeded {
  param([string]$BinDir, [bool]$SkipPathModify)
  if ($SkipPathModify) { return $false }
  $normalizedTarget = $BinDir.TrimEnd('\', '/').ToLowerInvariant()
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $existing = @()
  if ($userPath) {
    $existing = $userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  }
  foreach ($item in $existing) {
    if ($item.Trim().Trim('"').TrimEnd('\', '/').ToLowerInvariant() -eq $normalizedTarget) {
      return $false
    }
  }
  $newUserPath = if ($existing.Count -gt 0) { "$BinDir;" + ($existing -join ';') } else { $BinDir }
  [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')

  $procPath = [Environment]::GetEnvironmentVariable('PATH')
  if ($procPath) {
    $env:PATH = "$BinDir;$procPath"
  } else {
    $env:PATH = $BinDir
  }
  return $true
}

function Invoke-ClisInstall {
  if ($Help) {
    Write-Help
    exit 0
  }

  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.ServicePointManager]::SecurityProtocol
  } catch {}

  $hintUrl = if (-not [string]::IsNullOrWhiteSpace($InstallerUrl)) { $InstallerUrl.Trim() } elseif (-not [string]::IsNullOrWhiteSpace($env:CLIS_INSTALLER_URL)) { $env:CLIS_INSTALLER_URL.Trim() } else { 'https://raw.githubusercontent.com/iyowei/clis/main/install.ps1' }
  $chosenTool = Prompt-ToolIfNeeded -CurrentTool $Tool -ScriptUrl $hintUrl -AutoYes:$Yes
  $spec = Resolve-ToolSpec -RawTool $chosenTool
  $prefix = $spec.EnvPrefix

  if ($spec.OnlyOs -ne 'all') {
    Fail-Install "$($spec.PackageName) ($($spec.BinName)) 仅支持 macOS (需访问 AppleSMC 传感器与风扇硬件接口), Windows 不受支持。"
  }

  if ($Uninstall) {
    if ((-not [string]::IsNullOrWhiteSpace($Version)) -or (-not [string]::IsNullOrWhiteSpace($FromTarball)) -or (-not [string]::IsNullOrWhiteSpace($BunUrl)) -or (-not [string]::IsNullOrWhiteSpace($Registry))) {
      Fail-Install '参数冲突: -Uninstall 仅用于卸载, 不能与 -Version / -FromTarball / -BunUrl / -Registry 同时使用'
    }
  } else {
    $envInstaller = Get-ToolEnv -EnvPrefix $prefix -Suffix 'INSTALLER_URL'
    $scriptUrlVal = if (-not [string]::IsNullOrWhiteSpace($InstallerUrl)) { $InstallerUrl.Trim() } elseif ($envInstaller) { $envInstaller } else { 'https://raw.githubusercontent.com/iyowei/clis/main/install.ps1' }
    Assert-HttpUrl -FlagName '-InstallerUrl' -UrlValue $scriptUrlVal
    if ((-not [string]::IsNullOrWhiteSpace($InstallerUrl)) -and ($env:CLIS_INVOKED_BY_WRAPPER -ne '1')) {
      [Console]::Error.WriteLine("警告: 当前已在主安装脚本内运行, -InstallerUrl ($scriptUrlVal) 仅在通过包入口脚本拉取主脚本时生效")
    }

    $envBunUrl = Get-ToolEnv -EnvPrefix $prefix -Suffix 'BUN_URL'
    $bunUrlVal = if (-not [string]::IsNullOrWhiteSpace($BunUrl)) { $BunUrl.Trim() } else { $envBunUrl }
    Assert-HttpUrl -FlagName '-BunUrl' -UrlValue $bunUrlVal

    $bunVersionVal = Get-ToolEnv -EnvPrefix $prefix -Suffix 'BUN_VERSION'

    $envVer = Get-ToolEnv -EnvPrefix $prefix -Suffix 'VERSION'
    if (-not [string]::IsNullOrWhiteSpace($FromTarball)) {
      if (-not [string]::IsNullOrWhiteSpace($Version)) {
        Fail-Install '参数冲突: -FromTarball 与 -Version 不能同时指定 (压缩包内版本已由 package.json 决定)'
      }
      if ($envVer) {
        [Console]::Error.WriteLine("警告: 已指定 -FromTarball, 将以压缩包内版本为准, 忽略环境变量 ${prefix}_VERSION=$envVer")
      }
      $resolvedVersion = 'tarball'
    } else {
      $resolvedVersion = if (-not [string]::IsNullOrWhiteSpace($Version)) { $Version.Trim() } elseif ($envVer) { $envVer } else { 'latest' }
      if ($resolvedVersion -notmatch '^[A-Za-z0-9._+-]+$') {
        Fail-Install "非法的版本号或 dist-tag: $resolvedVersion"
      }
    }

    $defaultRegistry = 'https://registry.npmjs.org'
    $envRegistry = Get-ToolEnv -EnvPrefix $prefix -Suffix 'REGISTRY'
    $userRegistryVal = if (-not [string]::IsNullOrWhiteSpace($Registry)) { $Registry.Trim() } else { $envRegistry }
    $userSetRegistry = -not [string]::IsNullOrWhiteSpace($userRegistryVal)
    $rawRegistry = if ($userSetRegistry) { $userRegistryVal } else { $defaultRegistry }
    $rawRegistry = $rawRegistry.TrimEnd('/')
    Assert-HttpUrl -FlagName '-Registry' -UrlValue $rawRegistry
    if ($rawRegistry -match '[@?#\s"'']') {
      Fail-Install "非法的 registry 地址: $rawRegistry"
    }

    $fromTarballIsUrl = $false
    if (-not [string]::IsNullOrWhiteSpace($FromTarball)) {
      if ($FromTarball -match '^https?://') {
        Assert-HttpUrl -FlagName '-FromTarball' -UrlValue $FromTarball
        $fromTarballIsUrl = $true
        if ($FromTarball -match '^http://' -and $FromTarball -notmatch '^http://(127\.0\.0\.1|localhost|\[::1\])(?::|/|$)') {
          [Console]::Error.WriteLine("警告: 正在通过非加密 HTTP 下载远程压缩包且无注册表完整性摘要, 请确认网络链路可信: $FromTarball")
        }
      } elseif (-not (Test-Path -LiteralPath $FromTarball -PathType Leaf)) {
        Fail-Install "指定的本地 tarball 不存在: $FromTarball"
      }
    }
  }

  $envDataDir = Get-ToolEnv -EnvPrefix $prefix -Suffix 'INSTALL_HOME'
  $resolvedDataDir = if (-not [string]::IsNullOrWhiteSpace($DataDir)) { $DataDir } else { $envDataDir }
  $envBinDir = Get-ToolEnv -EnvPrefix $prefix -Suffix 'BIN_DIR'
  $resolvedBinDir = if (-not [string]::IsNullOrWhiteSpace($BinDir)) { $BinDir } else { $envBinDir }
  $envNoPath = Get-ToolEnv -EnvPrefix $prefix -Suffix 'NO_MODIFY_PATH'

  $localAppData = $env:LOCALAPPDATA
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  }
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    $localAppData = Join-Path $homeDir 'AppData\Local'
  }

  if ([string]::IsNullOrWhiteSpace($resolvedDataDir)) {
    $DataDir = Join-Path $localAppData 'clis'
  } else {
    $DataDir = $resolvedDataDir
  }
  if ([string]::IsNullOrWhiteSpace($resolvedBinDir)) {
    $BinDir = Join-Path $DataDir 'bin'
  } else {
    $BinDir = $resolvedBinDir
  }
  $DataDir = [System.IO.Path]::GetFullPath($DataDir)
  $BinDir = [System.IO.Path]::GetFullPath($BinDir)
  $RuntimeDir = Join-Path $DataDir 'runtime'
  $AppsDir = Join-Path $DataDir 'apps'
  $AppDir = Join-Path $AppsDir $spec.BinName
  $BinPath = Join-Path $BinDir "$($spec.BinName).cmd"

  if ($Uninstall) {
    $removed = $false
    if (Test-Path -LiteralPath $BinPath -PathType Leaf) {
      Remove-Item -LiteralPath $BinPath -Force
      Write-Output "✓ 已删除命令入口: $BinPath"
      $removed = $true
    }
    if (Test-Path -LiteralPath $AppDir -PathType Container) {
      Remove-Item -LiteralPath $AppDir -Recurse -Force
      Write-Output "✓ 已删除应用目录: $AppDir"
      $removed = $true
    }
    if (Test-Path -LiteralPath $AppsDir -PathType Container) {
      $left = Get-ChildItem -LiteralPath $AppsDir -Force | Select-Object -First 1
      if (-not $left) {
        Remove-Item -LiteralPath $AppsDir -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $RuntimeDir -PathType Container) {
          Remove-Item -LiteralPath $RuntimeDir -Recurse -Force
          Write-Output "✓ 已回收不再使用的私有隔离 Bun 运行时: $RuntimeDir"
        }
        Remove-Item -LiteralPath $DataDir -Force -ErrorAction SilentlyContinue
      }
    } elseif (Test-Path -LiteralPath $RuntimeDir -PathType Container) {
      Remove-Item -LiteralPath $RuntimeDir -Recurse -Force
      Remove-Item -LiteralPath $DataDir -Force -ErrorAction SilentlyContinue
    }
    if (-not $removed) {
      Write-Output "$($spec.BinName) 尚未通过一键脚本安装在 $AppDir / $BinPath"
    } else {
      Write-Output "完成: $($spec.PackageName) ($($spec.BinName)) 已卸载。"
    }
    exit 0
  }

  if ($DataDir -match '[\r\n"%!;]' -or $BinDir -match '[\r\n"%!;]') {
    Fail-Install "安装目录路径不可包含引号、分号、百分号、感叹号或换行符: $DataDir"
  }

  $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("clis-install-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null

  try {
    Write-Output "准备安装 $($spec.PackageName) ($($spec.BinName))..."
    $rt = Detect-ExistingRuntime -RuntimeDir $RuntimeDir -ExplicitBunUrl $(if (-not [string]::IsNullOrWhiteSpace($BunUrl)) { $BunUrl.Trim() } else { '' })
    if (-not $rt.ActiveRuntime) {
      $privExe = Install-PrivateBun -RuntimeDir $RuntimeDir -TmpRoot $tmpRoot -CustomBunUrl $bunUrlVal -BunVer $bunVersionVal -EnvPrefix $prefix
      $rt.PrivateBun = $privExe
      $rt.ActiveRuntime = $privExe
      $rt.ActiveKind = 'private-bun'
    }

    $integrity = ''
    $shasum = ''
    if (-not [string]::IsNullOrWhiteSpace($FromTarball)) {
      if ($fromTarballIsUrl) {
        $tgzFile = Join-Path $tmpRoot 'pkg.tgz'
        Write-Output "→ 正在从自定义直链下载压缩包: $FromTarball..."
        try {
          Invoke-WebRequest -Uri $FromTarball -OutFile $tgzFile -TimeoutSec 180 -UseBasicParsing
        } catch {
          Fail-Install "下载自定义 tarball 失败 ($FromTarball): $($_.Exception.Message)"
        }
      } else {
        $tgzFile = [System.IO.Path]::GetFullPath($FromTarball)
        Write-Output "→ 使用本地离线压缩包: $tgzFile"
      }
    } else {
      $encodedPkg = [Uri]::EscapeDataString($spec.PackageName)
      $metaUrl = "$rawRegistry/$encodedPkg/$resolvedVersion"
      Write-Output "→ 正在查询包注册表: $rawRegistry ($($spec.PackageName)@$resolvedVersion)..."
      try {
        $meta = Invoke-RestMethod -Uri $metaUrl -Headers @{ Accept = 'application/vnd.npm.install-v1+json, application/json' } -TimeoutSec 20 -UseBasicParsing
      } catch {
        $statusCode = $null
        try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
        if ($statusCode -eq 404) {
          Fail-Install "$($spec.PackageName) ($resolvedVersion) 在 $rawRegistry 尚未公开发布 (HTTP 404)。若使用私有源或自定义压缩包，请传 -Registry <url> 或 -FromTarball <path|url>。"
        } elseif ($statusCode -eq 401 -or $statusCode -eq 403) {
          Fail-Install "访问 $rawRegistry 鉴权失败 (HTTP $statusCode)"
        } else {
          Fail-Install "查询包元数据失败 ($metaUrl): $($_.Exception.Message) (如需切换源可传 -Registry <url> 或设 ${prefix}_REGISTRY / NPM_CONFIG_REGISTRY)"
        }
      }

      if (-not $meta.version -or -not $meta.dist -or -not $meta.dist.tarball) {
        Fail-Install "注册表响应缺少合法 version 或 dist.tarball 字段"
      }
      if ($meta.dist.integrity) { $integrity = [string]$meta.dist.integrity }
      if ($meta.dist.shasum) { $shasum = [string]$meta.dist.shasum }
      if (-not $integrity -and -not $shasum) {
        Fail-Install "注册表响应缺少 dist.integrity 与 dist.shasum，已拒绝安装"
      }

      $tarballUrlStr = [string]$meta.dist.tarball
      Assert-HttpUrl -FlagName 'dist.tarball' -UrlValue $tarballUrlStr
      $tgzFile = Join-Path $tmpRoot 'pkg.tgz'
      Write-Output "→ 正在下载 $($spec.PackageName)@$($meta.version)..."
      try {
        Invoke-WebRequest -Uri $tarballUrlStr -OutFile $tgzFile -TimeoutSec 180 -UseBasicParsing
      } catch {
        Fail-Install "下载安装包失败 ($tarballUrlStr): $($_.Exception.Message)"
      }
    }

    New-Item -ItemType Directory -Path $AppsDir -Force | Out-Null
    $swapId = [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $stagingDir = Join-Path $AppsDir ".staging-$($spec.BinName)-$swapId"
    $backupDir = Join-Path $AppsDir ".backup-$($spec.BinName)-$swapId"
    if (Test-Path -LiteralPath $stagingDir) { Remove-Item -LiteralPath $stagingDir -Recurse -Force }
    if (Test-Path -LiteralPath $backupDir) { Remove-Item -LiteralPath $backupDir -Recurse -Force }

    $extractJs = Join-Path $tmpRoot 'extract.cjs'
    Write-ExtractScript -ScriptPath $extractJs
    $extractLines = & $rt.ActiveRuntime $extractJs $tgzFile $stagingDir $integrity $shasum $spec.PackageName $spec.EntryFile $spec.DistFile
    if ($LASTEXITCODE -ne 0) {
      Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
      Fail-Install "校验或解包 $($spec.PackageName) 失败"
    }
    $pkgVer = ($extractLines | Select-Object -Index 0).Trim()
    $hasDeps = ($extractLines | Select-Object -Index 1).Trim()

    if ((-not [string]::IsNullOrWhiteSpace($FromTarball)) -and (-not [string]::IsNullOrWhiteSpace($Registry))) {
      if ($hasDeps -eq '1') {
        Write-Output "→ 已指定 -FromTarball, 本次 -Registry ($rawRegistry) 仅用于安装运行时依赖"
      } else {
        [Console]::Error.WriteLine("警告: 已指定 -FromTarball 且 $($spec.PackageName) 无运行时依赖, -Registry ($rawRegistry) 未被使用")
      }
    }

    if ($hasDeps -eq '1') {
      Write-Output '→ 正在补装运行时依赖 (ignore-scripts)...'
      $depExe = ''
      $depKind = ''
      if ($rt.HostBun) {
        $depExe = $rt.HostBun; $depKind = 'bun'
      } elseif ($rt.PrivateBun) {
        $depExe = $rt.PrivateBun; $depKind = 'bun'
      } elseif ($rt.HostNpm) {
        $depExe = $rt.HostNpm; $depKind = 'npm'
      } else {
        $privExe = Install-PrivateBun -RuntimeDir $RuntimeDir -TmpRoot $tmpRoot -CustomBunUrl $bunUrlVal -BunVer $bunVersionVal -EnvPrefix $prefix
        $rt.PrivateBun = $privExe
        $depExe = $privExe; $depKind = 'bun'
      }

      Push-Location -LiteralPath $stagingDir
      try {
        if ($depKind -eq 'bun') {
          $depArgs = @('install', '--production', '--ignore-scripts', '--no-save', '--no-cache')
          if ($userSetRegistry) { $depArgs += "--registry=$rawRegistry" }
          & $depExe @depArgs
        } else {
          $depArgs = @('install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund')
          if ($userSetRegistry) { $depArgs += "--registry=$rawRegistry" }
          & $depExe @depArgs
        }
        if ($LASTEXITCODE -ne 0) {
          Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
          Fail-Install "使用 $depKind 安装运行时依赖失败 (退出码 $LASTEXITCODE)"
        }
      } finally {
        Pop-Location
      }
    }

    $markerObj = [ordered]@{
      schemaVersion = 1
      method = 'script'
      tool = $spec.Key
      packageName = $spec.PackageName
      dataDir = $DataDir
      appDir = $AppDir
      runtimeDir = $RuntimeDir
      binPath = $BinPath
      version = $pkgVer
      updatedAt = [DateTime]::UtcNow.ToString('o')
    }
    $markerJson = ($markerObj | ConvertTo-Json -Depth 4) + "`n"
    Write-Utf8NoBom -Path (Join-Path $stagingDir '.clis-install.json') -Text $markerJson

    if (Test-Path -LiteralPath $AppDir) {
      Move-Item -LiteralPath $AppDir -Destination $backupDir -Force
    }
    try {
      Move-Item -LiteralPath $stagingDir -Destination $AppDir -Force
    } catch {
      if (Test-Path -LiteralPath $backupDir) {
        Move-Item -LiteralPath $backupDir -Destination $AppDir -Force -ErrorAction SilentlyContinue
      }
      Fail-Install "切换安装目录失败 ($AppDir): $($_.Exception.Message)"
    }
    if (Test-Path -LiteralPath $backupDir) {
      Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-WindowsCmdShim -BinDir $BinDir -BinPath $BinPath -AppDir $AppDir -RuntimeDir $RuntimeDir -EntryFile $spec.EntryFile -BinName $spec.BinName

    $skipPath = $NoPath.IsPresent -or ($envNoPath -in @('1', 'true', 'TRUE', 'yes', 'YES'))
    $pathAdded = Add-ToUserPathIfNeeded -BinDir $BinDir -SkipPathModify $skipPath

    Write-Output ''
    Write-Output "✓ 已完成安装: $($spec.PackageName)@$pkgVer"
    Write-Output "  入口命令: $BinPath"
    Write-Output "  安装目录: $AppDir"
    if ($rt.ActiveKind -eq 'private-bun') {
      Write-Output "  运行引擎: 隔离私有 Bun ($($rt.PrivateBun))"
    } else {
      Write-Output "  运行引擎: 系统 $($rt.ActiveKind) ($($rt.ActiveRuntime))"
    }
    Write-Output "  后续升级: $($spec.BinName) update"
    if ($pathAdded) {
      Write-Output "  环境提示: 已将 $BinDir 添加到用户 PATH (当前终端可直接使用；其他已开终端重开后生效)。"
    }
  } finally {
    if (Test-Path -LiteralPath $tmpRoot) {
      Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

Invoke-ClisInstall
