$ErrorActionPreference = 'Stop'
$Tool = 'create-clis'
$AllowedTools = @('create-clis')
$InstallerUrl = 'https://raw.githubusercontent.com/iyowei/clis/main/install.ps1'
$HasCustomInstaller = $false
if ($env:CREATE_CLIS_INSTALLER_URL) {
  $InstallerUrl = $env:CREATE_CLIS_INSTALLER_URL.Trim()
  $HasCustomInstaller = $true
}

$wantHelp = $false
$forwardArgs = @()
for ($i = 0; $i -lt $args.Count; $i += 1) {
  $a = [string]$args[$i]
  if ($a -in @('-Help', '-h', '--help')) {
    $wantHelp = $true
    $forwardArgs += '-Help'
    continue
  }
  if ($a -eq '-Tool') {
    if (($i + 1) -ge $args.Count) {
      [Console]::Error.WriteLine('错误: -Tool 需要参数值')
      exit 1
    }
    $tVal = ([string]$args[$i + 1]).Trim()
    if ($tVal -notin $AllowedTools) {
      [Console]::Error.WriteLine("错误: 当前是 $Tool 专属安装脚本, 不能指定其他工具 ($tVal); 如需安装其他工具请使用根安装脚本")
      exit 1
    }
    $i += 1
    continue
  }
  if ($a -like '-Tool:*') {
    $tVal = $a.Substring('-Tool:'.Length).Trim()
    if ($tVal -notin $AllowedTools) {
      [Console]::Error.WriteLine("错误: 当前是 $Tool 专属安装脚本, 不能指定其他工具 ($tVal); 如需安装其他工具请使用根安装脚本")
      exit 1
    }
    continue
  }
  if ($a -eq '-InstallerUrl') {
    if (($i + 1) -ge $args.Count -or [string]::IsNullOrWhiteSpace([string]$args[$i + 1])) {
      [Console]::Error.WriteLine('错误: -InstallerUrl 需要参数值')
      exit 1
    }
    $InstallerUrl = ([string]$args[$i + 1]).Trim()
    $HasCustomInstaller = $true
    $forwardArgs += $args[$i]
    $forwardArgs += $args[$i + 1]
    $i += 1
    continue
  }
  if ($a -like '-InstallerUrl:*') {
    $InstallerUrl = $a.Substring('-InstallerUrl:'.Length).Trim()
    if ([string]::IsNullOrWhiteSpace($InstallerUrl)) {
      [Console]::Error.WriteLine('错误: -InstallerUrl 需要参数值')
      exit 1
    }
    $HasCustomInstaller = $true
  }
  $forwardArgs += $args[$i]
}

if ($InstallerUrl -notmatch '^https?://' -or $InstallerUrl -match '[\s"'']') {
  [Console]::Error.WriteLine("错误: 非法的安装脚本 URL (仅支持无空白与引号的 http/https URL): $InstallerUrl")
  exit 1
}

$prevWrap = $env:CLIS_INVOKED_BY_WRAPPER
try {
  $env:CLIS_INVOKED_BY_WRAPPER = '1'
  $localRoot = if ($PSScriptRoot) { Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'install.ps1' } else { '' }
  if (-not $HasCustomInstaller -and $localRoot -and (Test-Path -LiteralPath $localRoot -PathType Leaf)) {
    & $localRoot -Tool $Tool @forwardArgs
    return
  }

  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::SecurityProtocol
  } catch {}

  if (-not $wantHelp) {
    Write-Output "→ 正在获取 $Tool 主安装脚本 ($InstallerUrl)..."
  }
  try {
    $scriptText = (Invoke-WebRequest -Uri $InstallerUrl -TimeoutSec 30 -UseBasicParsing).Content
  } catch {
    [Console]::Error.WriteLine("错误: 下载安装脚本失败 ($InstallerUrl)，可传 -InstallerUrl <url> 或设 CREATE_CLIS_INSTALLER_URL 自定义地址: $($_.Exception.Message)")
    exit 1
  }

  if (-not ($scriptText -is [string] -and $scriptText.Contains('Invoke-ClisInstall'))) {
    [Console]::Error.WriteLine("错误: $InstallerUrl 返回内容不是有效的安装脚本，请检查地址或 CREATE_CLIS_INSTALLER_URL 设置")
    exit 1
  }

  & ([scriptblock]::Create($scriptText)) -Tool $Tool @forwardArgs
} finally {
  $env:CLIS_INVOKED_BY_WRAPPER = $prevWrap
}
