$ErrorActionPreference = 'Stop'
$qqRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $qqRoot '.private\cloud-mode.json'))) { throw 'Cloud mode is not activated.' }
$qqUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$qqAction = New-ScheduledTaskAction -Execute (Get-Command pythonw.exe -ErrorAction Stop).Source -Argument ('-I "' + (Join-Path $PSScriptRoot 'windows-launcher.py') + '" tunnel') -WorkingDirectory $qqRoot
$qqTrigger = New-ScheduledTaskTrigger -AtLogOn -User $qqUser
$qqPrincipal = New-ScheduledTaskPrincipal -UserId $qqUser -LogonType Interactive -RunLevel Limited
$qqSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'AlexQQ-Cloud-Tunnel' -Action $qqAction -Trigger $qqTrigger -Principal $qqPrincipal -Settings $qqSettings -Description 'Loopback SSH tunnel to the ECS QQ Bot; does not start a local Bot or morning scheduler.' -Force | Out-Null
Start-ScheduledTask -TaskName 'AlexQQ-Cloud-Tunnel'
Get-ScheduledTask -TaskName 'AlexQQ-Cloud-Tunnel' | Select-Object TaskName,State
