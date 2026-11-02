# Run interactively as the Windows user who manages this bridge.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows DPAPI is required.' }
$privateDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\.private\migration')).Path
$identity = Read-Host 'Robot QQ number (dedicated account)' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($identity)
try {
    $number = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    if ($number -cnotmatch '^[1-9][0-9]{4,11}$') { throw 'Enter a 5 to 12 digit robot QQ number.' }
    $ciphertext = ConvertFrom-SecureString $identity
    $file = Join-Path $privateDir 'onebot-account.dpapi'
    $temporary = Join-Path $privateDir ('onebot-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($temporary, $ciphertext)
    if ([IO.File]::Exists($file)) { [IO.File]::Replace($temporary, $file, $null) }
    else { [IO.File]::Move($temporary, $file) }
    Write-Host 'Robot account saved locally. Return to Codex and confirm it is ready.'
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    $number = $null
    $identity.Dispose()
}
