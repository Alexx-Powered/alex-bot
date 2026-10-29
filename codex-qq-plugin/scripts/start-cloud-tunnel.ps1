$ErrorActionPreference = 'Stop'
$qqRoot = Split-Path -Parent $PSScriptRoot
$qqPrivate = Join-Path $qqRoot '.private'
. (Join-Path $PSScriptRoot 'service-process.ps1')
$qqLock = Lock-QQBridgeLifecycle -PrivateDirectory $qqPrivate
try {
    $qqListeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 19327 })
    if ($qqListeners.Count) {
        $qqIds = @($qqListeners | Select-Object -ExpandProperty OwningProcess -Unique)
        if ($qqIds.Count -ne 1) { throw 'Ambiguous tunnel listener.' }
        $qqProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($qqIds[0])"
        if ($qqProcess.Name -ne 'ssh.exe' -or $qqProcess.CommandLine -notlike '*127.0.0.1:19327:127.0.0.1:19327*' -or $qqProcess.CommandLine -notlike '*alexbridge@182.92.164.251*') { throw 'Port 19327 belongs to another process.' }
    } else {
        $qqNode = (Get-Command node.exe -ErrorAction Stop).Source
        $qqArguments = @('"' + (Join-Path $qqRoot 'ops\cloud-tunnel.mjs') + '"', 'run')
        Start-Process -FilePath $qqNode -ArgumentList $qqArguments -WorkingDirectory $qqRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $qqPrivate 'tunnel.stdout.log') -RedirectStandardError (Join-Path $qqPrivate 'tunnel.stderr.log') | Out-Null
    }
    for ($qqAttempt=0; $qqAttempt -lt 40; $qqAttempt++) {
        try {
            $qqHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:19327/health' -TimeoutSec 1
            if ($qqHealth.service -eq 'alex-codex-qq') { Write-Output 'Cloud QQ bridge connected through SSH: http://127.0.0.1:19327'; exit 0 }
        } catch {}
        Start-Sleep -Milliseconds 250
    }
    throw 'Cloud tunnel or remote service did not become ready.'
} finally { $qqLock.Dispose() }
