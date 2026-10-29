$ErrorActionPreference = 'Stop'
$qqRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $qqRoot '.private\cloud-mode.json'))) { throw 'Cloud mode is not activated.' }
$qqNode = (Get-Command node.exe -ErrorAction Stop).Source
& $qqNode (Join-Path $qqRoot 'ops\cloud-tunnel.mjs') run
exit $LASTEXITCODE
