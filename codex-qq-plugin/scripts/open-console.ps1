param([switch]$Diagnostic)
$ErrorActionPreference = 'Stop'
$qqRoot = Split-Path -Parent $PSScriptRoot
$qqPhase = 'service'
try {
    # Separate process: start-service uses exit, so it must not terminate this launcher.
    & powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File (Join-Path $PSScriptRoot 'start-service.ps1') -AutoConnect | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '本地服务未能启动。请检查 .private/service.stderr.log。' }
    $qqPhase = 'scheduler'
    $qqTask = Get-ScheduledTask -TaskName 'AlexQQ-Morning-Service' -ErrorAction SilentlyContinue
    if ($qqTask -and $qqTask.State -eq 'Ready') { Start-ScheduledTask -TaskName 'AlexQQ-Morning-Service' }
    $qqPhase = 'browser'
    & (Join-Path $PSScriptRoot 'open-setup.ps1')
} catch {
    if ($Diagnostic) { Write-Output ($qqPhase + ': ' + $_.Exception.GetType().Name + ' / ' + $_.FullyQualifiedErrorId); exit 1 }
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show('控制台未能打开。请在项目 scripts 目录运行 open-console.ps1 检查本地服务。','亚历克斯 Bot') | Out-Null
    exit 1
}
