param([switch]$Disable)
$ErrorActionPreference = 'Stop'
$qqRoot = Split-Path -Parent $PSScriptRoot
$qqConfig = Join-Path $qqRoot 'config\morning-report.json'
[IO.File]::WriteAllText($qqConfig,(@{enabled=(-not $Disable.IsPresent)} | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Output ('Enhanced morning report enabled=' + (-not $Disable.IsPresent) + '. No restart required; the next scheduled delivery uses this setting.')
