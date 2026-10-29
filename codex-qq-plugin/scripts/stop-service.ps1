$ErrorActionPreference = 'Stop'
$qqPluginRoot = Split-Path -Parent $PSScriptRoot
$qqDataRoot = if ($env:QQ_BRIDGE_HOME) { [IO.Path]::GetFullPath($env:QQ_BRIDGE_HOME) } else { $qqPluginRoot }
$qqPidFile = Join-Path $qqDataRoot '.private\service.pid'
$qqExpectedServer = Join-Path $qqPluginRoot 'src\server.mjs'
. (Join-Path $PSScriptRoot 'service-process.ps1')
New-Item -ItemType Directory -Path (Split-Path -Parent $qqPidFile) -Force | Out-Null
$qqLifecycleLock = Lock-QQBridgeLifecycle -PrivateDirectory (Split-Path -Parent $qqPidFile)
try {
$qqProcess = Get-QQBridgeListener -ServerFile $qqExpectedServer
if ($null -eq $qqProcess -and (Test-Path -LiteralPath $qqPidFile)) {
    $qqStoredPid = 0
    if ([int]::TryParse((Get-Content -LiteralPath $qqPidFile -Raw).Trim(), [ref]$qqStoredPid)) {
        $qqProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $qqStoredPid" -ErrorAction Stop
    }
}
if ($null -eq $qqProcess) {
    if (Test-Path -LiteralPath $qqPidFile) { Remove-Item -LiteralPath $qqPidFile }
    Write-Output 'QQ bridge is already stopped.'; exit 0
}
if ($qqProcess.Name -ne 'node.exe' -or -not $qqProcess.CommandLine.Contains('"' + $qqExpectedServer + '"')) { throw 'Process identity changed; refusing to stop another process.' }
$qqServicePid = $qqProcess.ProcessId
Stop-Process -Id $qqServicePid -ErrorAction Stop
Wait-Process -Id $qqServicePid -Timeout 10 -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $qqPidFile) { Remove-Item -LiteralPath $qqPidFile }
Write-Output 'QQ bridge stopped.'
} finally { $qqLifecycleLock.Dispose() }
