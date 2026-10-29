param([switch]$AutoConnect)
$ErrorActionPreference = 'Stop'
$qqPluginRoot = Split-Path -Parent $PSScriptRoot
$qqServerFile = Join-Path $qqPluginRoot 'src\server.mjs'
$qqDataRoot = if ($env:QQ_BRIDGE_HOME) { [IO.Path]::GetFullPath($env:QQ_BRIDGE_HOME) } else { $qqPluginRoot }
$qqPrivate = Join-Path $qqDataRoot '.private'
New-Item -ItemType Directory -Path $qqPrivate -Force | Out-Null
. (Join-Path $PSScriptRoot 'service-process.ps1')
$qqLifecycleLock = Lock-QQBridgeLifecycle -PrivateDirectory $qqPrivate
try {
$qqExisting = Get-QQBridgeListener -ServerFile $qqServerFile
if ($null -ne $qqExisting) {
    Set-Content -LiteralPath (Join-Path $qqPrivate 'service.pid') -Value $qqExisting.ProcessId -Encoding ascii
    Write-Output 'QQ bridge is already running: http://127.0.0.1:19327'
    exit 0
}
try {
    $qqHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:19327/health' -TimeoutSec 2
    if ($qqHealth.service -eq 'alex-codex-qq') { Write-Output 'QQ bridge is already running: http://127.0.0.1:19327'; exit 0 }
    throw 'Port 19327 is occupied by another service.'
} catch {
    if ($_.Exception.Message -like '*occupied*') { throw }
}
$qqNode = (Get-Command node.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $qqPrivate -Force | Out-Null
$qqArguments=@('"' + $qqServerFile + '"')
if($AutoConnect){$qqArguments+='--connect'}
$qqProcess = Start-Process -FilePath $qqNode -ArgumentList $qqArguments -WorkingDirectory $qqPluginRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $qqPrivate 'service.stdout.log') -RedirectStandardError (Join-Path $qqPrivate 'service.stderr.log')
for ($qqAttempt=0; $qqAttempt -lt 20; $qqAttempt++) {
    Start-Sleep -Milliseconds 250
    if ($qqProcess.HasExited) { throw 'QQ bridge exited. Check .private/service.stderr.log (contains no credentials).' }
    try {
        $qqHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:19327/health' -TimeoutSec 1
        if ($qqHealth.service -eq 'alex-codex-qq') {
            $qqListener = Get-QQBridgeListener -ServerFile $qqServerFile
            if ($null -eq $qqListener) { throw 'Service listener could not be verified.' }
            Set-Content -LiteralPath (Join-Path $qqPrivate 'service.pid') -Value $qqListener.ProcessId -Encoding ascii
            Write-Output 'QQ bridge is running: http://127.0.0.1:19327'; exit 0
        }
    } catch {}
}
throw 'QQ bridge did not become ready. Check .private/service.stderr.log.'
} finally { $qqLifecycleLock.Dispose() }
