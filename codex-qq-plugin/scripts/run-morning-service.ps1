$ErrorActionPreference = 'Stop'
$qqRoot = Split-Path -Parent $PSScriptRoot
$qqNode = 'D:\Program Files\nodejs\node.exe'
if (-not (Test-Path -LiteralPath $qqNode)) { $qqNode = (Get-Command node.exe -ErrorAction Stop).Source }
Set-Location -LiteralPath $qqRoot
& $qqNode (Join-Path $PSScriptRoot 'morning-scheduler.mjs')
exit $LASTEXITCODE
