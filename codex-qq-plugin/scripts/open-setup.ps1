param([ValidateSet('/','/social')][string]$Page = '/')
$ErrorActionPreference = 'Stop'
& python.exe (Join-Path $PSScriptRoot 'open-console-page.py') $Page
if ($LASTEXITCODE -ne 0) { throw '浏览器未能打开已授权的控制台页面。' }

