$ErrorActionPreference = 'Stop'
$qqPluginRoot = Split-Path -Parent $PSScriptRoot
$qqDataRoot = if ($env:QQ_BRIDGE_HOME) { [IO.Path]::GetFullPath($env:QQ_BRIDGE_HOME) } else { $qqPluginRoot }
$qqPidFile = Join-Path $qqDataRoot '.private\service.pid'
if (-not (Test-Path -LiteralPath $qqPidFile)) { Write-Output 'No managed QQ bridge process found.'; exit 0 }
$qqServicePid = [int](Get-Content -LiteralPath $qqPidFile -Raw).Trim()
$qqProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $qqServicePid"
if ($null -eq $qqProcess) { Remove-Item -LiteralPath $qqPidFile; Write-Output 'QQ bridge is already stopped.'; exit 0 }
$qqExpectedServer = Join-Path $qqPluginRoot 'src\server.mjs'
if ($qqProcess.Name -ne 'node.exe' -or -not $qqProcess.CommandLine.Contains('"' + $qqExpectedServer + '"')) { throw 'Process identity changed; refusing to stop another process.' }
Stop-Process -Id $qqServicePid -ErrorAction Stop
Remove-Item -LiteralPath $qqPidFile
Write-Output 'QQ bridge stopped.'
