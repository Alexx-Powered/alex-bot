param(
    [Parameter(Mandatory=$true)][string]$InputJson,
    [Parameter(Mandatory=$true)][string]$OutDir,
    [switch]$Reviewed,
    [switch]$NoSend,
    [switch]$Demo,
    [string]$PythonPath = (Join-Path $env:USERPROFILE '.workbuddy\binaries\python\envs\default\Scripts\python.exe')
)
$ErrorActionPreference='Stop'
if(-not $Reviewed -and -not $NoSend){throw '请先核对 review.json 与本次输入，再使用 -Reviewed；仅预览请使用 -NoSend。'}
$wbArgs=@('-B','-X','utf8',(Join-Path $PSScriptRoot 'briefing.py'),$InputJson,'--out-dir',$OutDir)
if($Reviewed){$wbArgs+='--reviewed'}
if($Demo){$wbArgs+='--demo'}
& $PythonPath @wbArgs
if($LASTEXITCODE -ne 0){throw '简报生成失败；未发送 QQ。'}
if($NoSend){return}
$wbSenderPython='D:\Projects\Alex Bot\codex-qq-plugin\.venv\Scripts\python.exe'
if(-not(Test-Path -LiteralPath $wbSenderPython)){throw '本机 QQ Bot Python 环境不存在；简报已保存，未发送。'}
& $wbSenderPython -B -X utf8 (Join-Path $PSScriptRoot 'send_qq.py') (Join-Path $OutDir 'briefing-manifest.json')
if($LASTEXITCODE -ne 0){throw 'QQ 发送未确认成功，请按输出状态处理；本次不自动重试；再次明确调用可重新发送。'}
