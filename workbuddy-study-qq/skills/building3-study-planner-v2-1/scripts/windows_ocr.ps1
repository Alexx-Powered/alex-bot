param(
    [Parameter(Mandatory=$true)][string]$InputJson,
    [Parameter(Mandatory=$true)][string]$OutputJson
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
$taskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await-Result($operation, [Type]$resultType) {
    $task = $taskMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait()
    return $task.Result
}
$available = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
$preferred = $available | Where-Object { $_.LanguageTag -like 'zh*' } | Select-Object -First 1
if ($null -eq $preferred) { throw 'Chinese Windows OCR language is not installed.' }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($preferred)
if ($null -eq $engine) { throw 'Windows OCR engine could not be created.' }
$inputData = Get-Content -LiteralPath $InputJson -Raw -Encoding UTF8 | ConvertFrom-Json
$results = @()
foreach ($item in $inputData.images) {
    $activeEngine = $engine
    if ($item.language) {
        $resolvedLanguage = $available | Where-Object { $_.LanguageTag -like ($item.language + '*') } | Select-Object -First 1
        if ($null -eq $resolvedLanguage) { throw ('Windows OCR language is not installed: ' + $item.language) }
        $requestedLanguage = New-Object Windows.Globalization.Language($resolvedLanguage.LanguageTag)
        $activeEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($requestedLanguage)
        if ($null -eq $activeEngine) { throw ('OCR language unavailable: ' + $item.language) }
    }
    $file = Await-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync($item.path)) ([Windows.Storage.StorageFile])
    $stream = Await-Result ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await-Result ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        try {
            if ($bitmap.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $bitmap.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { throw 'Image exceeds Windows OCR maximum dimensions; tile the image first.' }
            $ocr = Await-Result ($activeEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            $lines = @()
            foreach ($line in $ocr.Lines) {
                $words = @()
                foreach ($word in $line.Words) {
                    $rect = $word.BoundingRect
                    $words += @{text=$word.Text; x=$rect.X; y=$rect.Y; width=$rect.Width; height=$rect.Height}
                }
                $lines += @{text=$line.Text; words=$words}
            }
            $results += @{path=$item.path; language=$activeEngine.RecognizerLanguage.LanguageTag; width=$bitmap.PixelWidth; height=$bitmap.PixelHeight; lines=$lines}
        } finally { $bitmap.Dispose() }
    } finally { $stream.Dispose() }
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($OutputJson, (ConvertTo-Json -InputObject @{images=$results} -Depth 12), $utf8)
