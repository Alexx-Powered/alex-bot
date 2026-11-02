# Run after the candidate and its gateway package have been staged on ECS.
# -QrOnly retrieves the current QR without initiating another login.
param([switch]$QrOnly)
$ErrorActionPreference = 'Stop'
$pluginDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$privateDir = (Resolve-Path -LiteralPath (Join-Path $pluginDir '.private\migration')).Path
$wb = Join-Path (Split-Path -Parent $pluginDir) 'tools\workbench\bin\workbench-windows-amd64\workbench.exe'
$wbArgs = @('--profile','alex-bot','-r','cn-beijing','-i','i-2ze8xb72xeng0xzu02bb')
function Invoke-GatewayOperator([string]$Mode, [string]$Envelope) {
    if ($Mode -notin @('key','start','qr')) { throw 'Invalid operator mode.' }
    if ($Mode -eq 'start' -and $Envelope -notmatch '^[A-Za-z0-9+/]{342}==$') { throw 'Invalid encrypted envelope.' }
    $remote = 'python3 /opt/alex-qq-gateway/ops/onebot-login.py ' + $Mode
    if ($Mode -eq 'start') { $remote = "printf '%s' '$Envelope' | " + $remote }
    $reply = (& $wb exec @wbArgs --command $remote --timeout 30) -join [Environment]::NewLine
    if ($LASTEXITCODE -ne 0) { throw 'ECS gateway request failed. Return to Codex for status.' }
    return ($reply | ConvertFrom-Json)
}
if ((& $wb daemon status --profile alex-bot) -match 'not running') {
    Start-Process -FilePath $wb -ArgumentList @('daemon','start','--profile','alex-bot') -WindowStyle Hidden
    for ($i = 0; $i -lt 16; $i++) {
        Start-Sleep -Milliseconds 250
        if ((& $wb daemon status --profile alex-bot) -notmatch 'not running') { break }
    }
}
if (-not $QrOnly) {
    $saved = [IO.File]::ReadAllText((Join-Path $privateDir 'onebot-account.dpapi'))
    $secret = ConvertTo-SecureString $saved
    $parameters = New-Object Security.Cryptography.RSAParameters
    $parameters.Modulus = [Convert]::FromBase64String((Invoke-GatewayOperator 'key').modulus)
    $parameters.Exponent = [byte[]](1,0,1)
    $rsa = [Security.Cryptography.RSACng]::new()
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try {
        $rsa.ImportParameters($parameters)
        $bytes = [Text.Encoding]::ASCII.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))
        $envelope = [Convert]::ToBase64String($rsa.Encrypt($bytes,[Security.Cryptography.RSAEncryptionPadding]::OaepSHA256))
    } finally {
        if ($bytes) { [Array]::Clear($bytes,0,$bytes.Length) }
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
        $secret.Dispose()
        $rsa.Dispose()
    }
    if (-not (Invoke-GatewayOperator 'start' $envelope).started) { throw 'Gateway did not start.' }
}
$qrPath = Join-Path $privateDir 'onebot-login.png'
for ($i = 0; $i -lt 20; $i++) {
    $qr = Invoke-GatewayOperator 'qr'
    if ($qr.png) {
        [IO.File]::WriteAllBytes($qrPath,[Convert]::FromBase64String($qr.png))
        Write-Output ('Open this local QR image with your dedicated QQ account: ' + $qrPath)
        return
    }
    Start-Sleep -Seconds 2
}
throw 'No fresh QR is available. Return to Codex for the gateway and memory status.'
