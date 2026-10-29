$ErrorActionPreference = 'Stop'
$qqRoot = Split-Path -Parent $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $qqRoot '.private\cloud-mode.json')) {
    & (Join-Path $PSScriptRoot 'install-cloud-tunnel.ps1')
    exit $LASTEXITCODE
}
$qqNode = (Get-Command node.exe -ErrorAction Stop).Source
$qqUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$qqAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'run-morning-service.ps1') + '"') -WorkingDirectory $qqRoot
$qqTrigger = New-ScheduledTaskTrigger -AtLogOn -User $qqUser
$qqPrincipal = New-ScheduledTaskPrincipal -UserId $qqUser -LogonType Interactive -RunLevel Limited
$qqSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'AlexQQ-Morning-Service' -Action $qqAction -Trigger $qqTrigger -Principal $qqPrincipal -Settings $qqSettings -Description 'Start Alex QQ service after user login; send Beijing weather once daily at/after 08:00 Asia/Shanghai.' -Force | Out-Null
Start-ScheduledTask -TaskName 'AlexQQ-Morning-Service'
Get-ScheduledTask -TaskName 'AlexQQ-Morning-Service' | Select-Object TaskName,State
