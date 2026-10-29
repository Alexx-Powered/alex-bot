# Resolve the actual listener; a stale PID file must never identify a deployment.
function Get-QQBridgeListener {
    param([string]$ServerFile)
    $qqListeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 19327 })
    $qqListenerIds = @($qqListeners | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($qqListenerIds.Count -eq 0) { return $null }
    if ($qqListenerIds.Count -ne 1) { throw 'Ambiguous port ownership; refusing to manage processes.' }
    $qqLive = Get-CimInstance Win32_Process -Filter "ProcessId = $($qqListenerIds[0])" -ErrorAction Stop
    if ($null -eq $qqLive -or $qqLive.Name -ne 'node.exe' -or
        $qqLive.CommandLine.IndexOf('"' + [IO.Path]::GetFullPath($ServerFile) + '"', [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'Port 19327 is occupied by another service; refusing to manage it.'
    }
    return $qqLive
}

function Lock-QQBridgeLifecycle {
    param([string]$PrivateDirectory)
    $qqLockFile = Join-Path $PrivateDirectory 'service-lifecycle.lock'
    for ($qqLockTry = 0; $qqLockTry -lt 100; $qqLockTry++) {
        try { return [IO.File]::Open($qqLockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] { Start-Sleep -Milliseconds 100 }
    }
    throw 'Another service lifecycle operation is still running.'
}
