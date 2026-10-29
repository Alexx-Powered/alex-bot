$ErrorActionPreference = 'Stop'
$qqPluginRoot = Split-Path -Parent $PSScriptRoot
$qqDataRoot = if ($env:QQ_BRIDGE_HOME) { [IO.Path]::GetFullPath($env:QQ_BRIDGE_HOME) } else { $qqPluginRoot }
$qqTokenPath = Join-Path $qqDataRoot '.private\admin-token'
if (-not (Test-Path -LiteralPath $qqTokenPath)) { throw '请先启动本地服务。' }
$qqLocalToken = (Get-Content -LiteralPath $qqTokenPath -Raw).Trim()
if ($qqLocalToken -notmatch '^[0-9a-f]{64}$') { throw '本地访问口令格式不正确。' }
Start-Process -FilePath "http://127.0.0.1:19327/#token=$qqLocalToken" -WindowStyle Hidden

