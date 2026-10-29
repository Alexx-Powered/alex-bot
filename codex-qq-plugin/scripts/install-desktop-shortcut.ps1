$ErrorActionPreference = 'Stop'
$qqRoot = Split-Path -Parent $PSScriptRoot
$qqDesktop = [Environment]::GetFolderPath('Desktop')
if (-not $qqDesktop) { throw '无法找到当前用户的桌面目录。' }
$qqShortcutPath = Join-Path $qqDesktop '亚历克斯 Bot.lnk'
$qqShell = New-Object -ComObject WScript.Shell
if (Test-Path -LiteralPath $qqShortcutPath) {
    $qqExisting = $qqShell.CreateShortcut($qqShortcutPath)
    if ($qqExisting.Arguments -notlike ('*' + (Join-Path $qqRoot 'scripts\open-console.ps1') + '*')) { throw '桌面存在同名的其他快捷方式，未覆盖。' }
}
$qqLink = $qqShell.CreateShortcut($qqShortcutPath)
$qqLink.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$qqLink.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + (Join-Path $qqRoot 'scripts\open-console.ps1') + '"'
$qqLink.WorkingDirectory = $qqRoot
$qqLink.IconLocation = (Join-Path $qqRoot 'public\logo.ico') + ',0'
$qqLink.Description = '亚历克斯本机控制台：配置、功能说明与 LangChain 开发指南'
$qqLink.WindowStyle = 7
$qqLink.Save()
Write-Output ('Created: ' + $qqShortcutPath)
