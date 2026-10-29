param(
    [Parameter(Mandatory=$true)][string[]]$Images,
    [Parameter(Mandatory=$true)][string]$OutDir,
    [string]$Date,
    [switch]$AssumeBuilding,
    [string]$PythonPath
)
$ErrorActionPreference = 'Stop'
$candidates = @()
if ($PythonPath) { $candidates += $PythonPath }
$candidates += (Join-Path $env:USERPROFILE '.workbuddy\binaries\python\envs\default\Scripts\python.exe')
$found = Get-Command python -ErrorAction SilentlyContinue
if ($found) { $candidates += $found.Source }
$selected = $null
foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        & $candidate -B -c 'import PIL, numpy' 2>$null
        if ($LASTEXITCODE -eq 0) { $selected = $candidate; break }
    }
}
if (-not $selected) { throw 'No Python with Pillow and NumPy was found. Use -PythonPath with an existing environment.' }
$paths = @()
foreach ($item in $Images) {
    $paths += (Resolve-Path -LiteralPath $item).Path
}
$cliArgs = @('-B', '-X', 'utf8', (Join-Path $PSScriptRoot 'extract.py')) + $paths + @('--out-dir', $OutDir)
if ($Date) { $cliArgs += @('--date', $Date) }
if ($AssumeBuilding) { $cliArgs += '--assume-building' }
& $selected @cliArgs
if ($LASTEXITCODE -ne 0) { throw "Classroom extraction failed (exit $LASTEXITCODE). Review the diagnostic message above." }

& $selected -B -X utf8 (Join-Path $PSScriptRoot 'briefing.py') (Join-Path $OutDir 'input.json') --out-dir $OutDir
if ($LASTEXITCODE -ne 0) { Write-Warning '完整查询结果已生成，但简报图片生成失败，未发送 QQ。' }
